import { kstDate } from '../shared/domain.ts';
import type { AppState, NotificationPayload } from '../shared/types.ts';
import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import type { Env } from './types.ts';
import { budgetAlertStatements, decryptSubscription, eventStatements, loadPushConfiguration, scheduledCandidates, sendWebPush, type BrowserSubscription, type PushConfiguration } from './push.ts';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const LEASE = 60_000;
const MAX_ATTEMPTS = 8;
export const MAX_DELIVERIES_PER_TICK = 8;
export const MAX_D1_QUERIES_PER_TICK = 50;
export const MAX_USERS_CHECKED_PER_TICK = 2;
export interface DeliveryLog {
  event: 'push_delivery'; userId: string; deliveryId: string; timestamp: string; attempt: number;
  result: 'accepted' | 'retry' | 'expired_subscription' | 'failed' | 'cancelled'; statusCode?: number;
}
interface StateRow { id: string; created_at: number; last_expense_at: number; json: string; write_id: string }
interface Claim { id: string; event_id: string; subscription_id: string; attempts: number; lease_until: number }
interface Detail { user_id: string; payload: string; expires_at: number; event_key: string; encrypted: string; json: string; created_at: number; last_expense_at: number }
export type Sender = (subscription: BrowserSubscription, payload: NotificationPayload, configuration: PushConfiguration, leaseUntil: number, ttlSeconds: number) => Promise<{ statusCode?: number } | void>;

/** D1 counts every SQL statement in a batch toward its per-invocation query limit. */
function queryBudget(database: D1Database) {
  let used = 0;
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const reserve = (count: number) => {
    if (used + count > MAX_D1_QUERIES_PER_TICK) throw new Error('D1 cron query budget exceeded');
    used += count;
  };
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const wrapped = new Proxy(statement, {
      get(target, property) {
        if (property === 'bind') return (...bindings: unknown[]) => wrap(target.bind(...bindings));
        const value = Reflect.get(target, property);
        if (['first', 'all', 'run', 'raw'].includes(String(property))) return (...args: unknown[]) => { reserve(1); return Reflect.apply(value, target, args); };
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    originals.set(wrapped, statement);
    return wrapped;
  };
  const db = new Proxy(database, {
    get(target, property) {
      if (property === 'prepare') return (sql: string) => wrap(target.prepare(sql));
      if (property === 'batch') return (statements: D1PreparedStatement[]) => { reserve(statements.length); return target.batch(statements.map(statement => originals.get(statement) ?? statement)); };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { db, used: () => used, remaining: () => MAX_D1_QUERIES_PER_TICK - used };
}

/** The D1 ledger survives isolate disposal, deployment, crashes, and duplicate cron invocations. */
export async function runPushCron(env: Env, options: { now?: () => number; sender?: Sender; log?: (entry: DeliveryLog) => void } = {}): Promise<{ processed: number; queriesUsed: number; checkedUsers: number }> {
  const configuration = await loadPushConfiguration(env);
  if (!configuration) return { processed: 0, queriesUsed: 0, checkedUsers: 0 };
  const clock = options.now ?? Date.now;
  const now = clock();
  const logger = options.log ?? (entry => console.log(JSON.stringify(entry)));
  const sender = options.sender ?? ((subscription, payload, config, leaseUntil, ttlSeconds) => sendWebPush(subscription, payload, config, clock(), fetch, leaseUntil, ttlSeconds));
  const budget = queryBudget(env.DB);
  const db = budget.db;
  const rows = await db.prepare(`SELECT u.id,u.created_at,u.last_expense_at,s.json,s.write_id FROM users u JOIN states s ON s.user_id=u.id
    WHERE json_extract(s.json,'$.config.push.enabled')=1 AND EXISTS (SELECT 1 FROM push_subscriptions p WHERE p.user_id=u.id)
    ORDER BY u.push_checked_at,u.id LIMIT ?`).bind(MAX_USERS_CHECKED_PER_TICK).all<StateRow>();
  let checkedUsers = 0;
  // Conditional and periodic inserts use the state version fence; concurrent edits cannot enqueue stale state.
  for (const user of rows.results) {
    const state = JSON.parse(user.json) as AppState;
    if (!state.config.push.enabled) continue;
    const statements = await budgetAlertStatements(db, user.id, state, now, user.write_id);
    for (const candidate of scheduledCandidates(now, state.config)) statements.push(...await eventStatements(db, user.id, candidate.key, candidate.payload, now, candidate.scheduledAt + DAY, user.write_id));
    const today = kstDate(new Date(now));
    if (now - user.last_expense_at >= state.config.push.inactivityDays * DAY && now >= Date.parse(`${today}T00:00:00+09:00`) + (state.config.push.inactivityHour ?? 20) * HOUR) {
      statements.push(...await eventStatements(db, user.id, `inactivity:${user.last_expense_at}`, { title: '수비대 기록을 이어가요', body: '최근 지출 기록이 없어요. 실제 소비는 알 수 없으니 기억나는 내역이 있다면 편하게 남겨주세요.', url: '/#expenses' }, now, now + DAY, user.write_id));
    }
    // Preserve capacity for at least one delivery, and leave an unchecked user eligible for the next invocation.
    if (statements.length + 1 > budget.remaining() - 5) break;
    statements.push(db.prepare('UPDATE users SET push_checked_at=MAX(push_checked_at,?) WHERE id=?').bind(now, user.id));
    await db.batch(statements);
    checkedUsers++;
  }

  let processed = 0;
  for (; processed < MAX_DELIVERIES_PER_TICK; processed++) {
    // Claim + detail + the worst-case three-statement expired-subscription prune require five queries.
    if (budget.remaining() < 5) break;
    const time = clock();
    const claimed = await db.prepare(`UPDATE push_deliveries SET status='sending',lease_until=?,attempts=attempts+1
      WHERE id=(SELECT id FROM push_deliveries WHERE subscription_id IS NOT NULL AND
        ((status='pending' AND next_attempt_at<=?) OR (status='sending' AND lease_until<=?)) ORDER BY next_attempt_at,id LIMIT 1)
      AND ((status='pending' AND next_attempt_at<=?) OR (status='sending' AND lease_until<=?))
      RETURNING id,event_id,subscription_id,attempts,lease_until`).bind(time + LEASE, time, time, time, time).first<Claim>();
    if (!claimed) break;
    const row = await db.prepare(`SELECT e.user_id,e.payload,e.expires_at,e.event_key,p.encrypted,s.json,u.created_at,u.last_expense_at FROM push_events e
      JOIN push_deliveries d ON d.event_id=e.id AND d.id=? AND d.status='sending' AND d.attempts=?
      JOIN push_subscriptions p ON p.id=d.subscription_id AND p.user_id=e.user_id JOIN states s ON s.user_id=e.user_id
      JOIN users u ON u.id=e.user_id WHERE e.id=?`).bind(claimed.id, claimed.attempts, claimed.event_id).first<Detail>();
    const finish = (status: string, code?: number) => db.prepare("UPDATE push_deliveries SET status=?,lease_until=NULL,last_status=? WHERE id=? AND status='sending' AND attempts=?")
      .bind(status, code ?? null, claimed.id, claimed.attempts).run();
    if (!row) { await finish('cancelled'); continue; }
    const log = (result: DeliveryLog['result'], statusCode?: number) => logger({ event: 'push_delivery', userId: row.user_id, deliveryId: claimed.id, result, attempt: claimed.attempts, timestamp: new Date(time).toISOString(), ...(statusCode ? { statusCode } : {}) });
    const state = JSON.parse(row.json) as AppState;
    const currentReminderTime = Date.parse(`${kstDate(new Date(time))}T00:00:00+09:00`) + (state.config.push.inactivityHour ?? 20) * HOUR;
    const staleInactivity = row.event_key.startsWith('inactivity:') && (
      Number(row.event_key.slice('inactivity:'.length)) !== row.last_expense_at
      || time - row.last_expense_at < state.config.push.inactivityDays * DAY
      || time < currentReminderTime
    );
    if (!state.config.push.enabled || row.expires_at <= time || staleInactivity) { await finish('cancelled'); log('cancelled'); continue; }
    if (claimed.attempts > MAX_ATTEMPTS) { await finish('failed'); log('failed'); continue; }
    try {
      const sub = await decryptSubscription(row.encrypted, configuration.encryptionKey);
      const freshTime = clock();
      const ttlSeconds = Math.min(3600, Math.floor((row.expires_at - freshTime) / 1000));
      if (ttlSeconds <= 0) { await finish('cancelled'); log('cancelled'); continue; }
      if (freshTime + 15_000 >= claimed.lease_until) {
        // A slow database response must not initiate a request under an expired or nearly expired lease.
        await db.prepare("UPDATE push_deliveries SET status='pending',next_attempt_at=?,lease_until=NULL WHERE id=? AND status='sending' AND attempts=? AND lease_until=?")
          .bind(freshTime, claimed.id, claimed.attempts, claimed.lease_until).run();
        continue;
      }
      const result = await sender(sub, JSON.parse(row.payload) as NotificationPayload, configuration, claimed.lease_until, ttlSeconds);
      const code = result?.statusCode ?? 201;
      await db.prepare("UPDATE push_deliveries SET status='sent',sent_at=?,lease_until=NULL,last_status=? WHERE id=? AND status='sending' AND attempts=?")
        .bind(clock(), code, claimed.id, claimed.attempts).run();
      log('accepted', code);
    } catch (error) {
      const candidate = error as { statusCode?: unknown; headers?: Record<string, string> };
      const code = typeof candidate.statusCode === 'number' ? candidate.statusCode : undefined;
      const fence = "EXISTS (SELECT 1 FROM push_deliveries d WHERE d.id=? AND d.status='sending' AND d.attempts=?)";
      if (code === 404 || code === 410) {
        // Pruning precedes finishing: every statement independently checks ownership of this lease.
        const result = await db.batch([
          db.prepare(`UPDATE push_deliveries SET status='cancelled',lease_until=NULL WHERE subscription_id=? AND id<>? AND status IN ('pending','sending') AND ${fence}`)
            .bind(claimed.subscription_id, claimed.id, claimed.id, claimed.attempts),
          db.prepare(`DELETE FROM push_subscriptions WHERE id=? AND user_id=? AND ${fence}`).bind(claimed.subscription_id, row.user_id, claimed.id, claimed.attempts),
          db.prepare("UPDATE push_deliveries SET status='dead',lease_until=NULL,last_status=? WHERE id=? AND status='sending' AND attempts=?").bind(code, claimed.id, claimed.attempts),
        ]);
        if (result[2].meta.changes) log('expired_subscription', code);
      } else if ((code === undefined || code === 429 || code >= 500) && claimed.attempts < MAX_ATTEMPTS) {
        const retryAfter = candidate.headers?.['retry-after'];
        const requested = retryAfter ? (/^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - time) : 0;
        const delay = Math.max(Math.min(HOUR, 30_000 * 2 ** (claimed.attempts - 1)), Math.min(DAY, Number.isFinite(requested) ? requested : 0));
        const result = await db.prepare("UPDATE push_deliveries SET status='pending',next_attempt_at=?,lease_until=NULL,last_status=? WHERE id=? AND status='sending' AND attempts=?")
          .bind(time + delay, code ?? null, claimed.id, claimed.attempts).run();
        if (result.meta.changes) log('retry', code);
      } else { if ((await finish('failed', code)).meta.changes) log('failed', code); }
    }
  }
  return { processed, queriesUsed: budget.used(), checkedUsers };
}
