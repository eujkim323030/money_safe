import { activeBudget, variableSpent } from '../shared/domain.ts';
import { createCipheriv, createDecipheriv, createECDH, createHash, randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Express, RequestHandler } from 'express';
import webpush from 'web-push';
import type { AppState, Config, NotificationPayload } from '../shared/types.ts';
import type { AppDatabase } from './db.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const KST = 9 * HOUR;
const CATCH_UP = 12 * HOUR;
const LEASE = 60_000;
const MAX_ATTEMPTS = 8;

export interface PushConfiguration {
  publicKey: string;
  privateKey: string;
  subject: string;
  encryptionKey: Buffer;
}
export interface BrowserSubscription { endpoint: string; keys: { p256dh: string; auth: string } }
export type PushSender = (subscription: BrowserSubscription, payload: NotificationPayload) => Promise<unknown>;
export interface DeliveryLog {
  event: 'push_delivery'; userId: string; deliveryId: string; timestamp: string;
  result: 'accepted' | 'retry' | 'expired_subscription' | 'failed' | 'cancelled'; attempt: number; statusCode?: number;
}

function decodeKey(value: string, length: number): Buffer {
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) throw new Error('Invalid push key encoding');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== length) throw new Error('Invalid push key length');
  return bytes;
}

export function loadPushConfiguration(env: NodeJS.ProcessEnv = process.env): PushConfiguration | null {
  const { VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: privateKey, VAPID_SUBJECT: subject, DATA_ENCRYPTION_KEY: encryptionKey } = env;
  if (!publicKey || !privateKey || !subject || !encryptionKey) return null;
  const publicBytes = decodeKey(publicKey, 65);
  const privateBytes = decodeKey(privateKey, 32);
  const curve = createECDH('prime256v1');
  curve.setPrivateKey(privateBytes);
  if (!curve.getPublicKey().equals(publicBytes)) throw new Error('VAPID public/private keys do not match');
  const contact = new URL(subject);
  if (!['mailto:', 'https:'].includes(contact.protocol) || !contact.pathname) throw new Error('VAPID_SUBJECT must be a valid mailto or HTTPS contact');
  return { publicKey, privateKey, subject, encryptionKey: decodeKey(encryptionKey, 32) };
}

export function isPushConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  try { return loadPushConfiguration(env) !== null; } catch { return false; }
}

export function validateSubscription(input: unknown): BrowserSubscription {
  const value = input as Partial<BrowserSubscription> | null;
  if (!value || typeof value.endpoint !== 'string' || value.endpoint.length > 4096) throw new Error('올바른 푸시 구독이 필요합니다.');
  const endpoint = new URL(value.endpoint);
  const host = endpoint.hostname.toLowerCase();
  const allowed = host === 'fcm.googleapis.com' || host === 'android.googleapis.com'
    || host === 'push.apple.com' || host.endsWith('.push.apple.com')
    || host === 'push.services.mozilla.com' || host.endsWith('.push.services.mozilla.com')
    || host.endsWith('.notify.windows.com');
  if (!allowed || endpoint.protocol !== 'https:' || (endpoint.port && endpoint.port !== '443') || endpoint.username || endpoint.password || endpoint.hash) {
    throw new Error('지원되는 HTTPS 푸시 서비스 주소가 필요합니다.');
  }
  if (typeof value.keys?.p256dh !== 'string' || typeof value.keys.auth !== 'string') throw new Error('푸시 구독 키가 필요합니다.');
  const p256dh = decodeKey(value.keys.p256dh, 65);
  const auth = decodeKey(value.keys.auth, 16);
  if (p256dh[0] !== 4) throw new Error('올바른 푸시 구독 키가 필요합니다.');
  // Validate that the public point is actually on P-256, before persisting any data.
  const verifier = createECDH('prime256v1');
  verifier.generateKeys();
  verifier.computeSecret(p256dh);
  return { endpoint: endpoint.href, keys: { p256dh: p256dh.toString('base64url'), auth: auth.toString('base64url') } };
}

export function encryptSubscription(subscription: BrowserSubscription, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from('salary-guardians:push:v1'));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(subscription), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.');
}

export function decryptSubscription(encrypted: string, key: Buffer): BrowserSubscription {
  const [version, iv, tag, data] = encrypted.split('.');
  if (version !== 'v1' || !iv || !tag || !data) throw new Error('Unsupported encrypted subscription');
  const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  cipher.setAAD(Buffer.from('salary-guardians:push:v1'));
  cipher.setAuthTag(Buffer.from(tag, 'base64url'));
  const decoded = Buffer.concat([cipher.update(Buffer.from(data, 'base64url')), cipher.final()]).toString('utf8');
  return validateSubscription(JSON.parse(decoded));
}

export function initializePushSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      endpoint_hash TEXT NOT NULL UNIQUE, encrypted TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS push_subscriptions_user ON push_subscriptions(user_id);
    CREATE TABLE IF NOT EXISTS push_events (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      event_key TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL, UNIQUE(user_id, event_key)
    );
    CREATE TABLE IF NOT EXISTS push_deliveries (
      id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES push_events(id) ON DELETE CASCADE,
      subscription_id TEXT REFERENCES push_subscriptions(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL, lease_until INTEGER, sent_at INTEGER, last_status INTEGER,
      UNIQUE(event_id, subscription_id)
    );
    CREATE INDEX IF NOT EXISTS push_delivery_due ON push_deliveries(status, next_attempt_at, lease_until);
  `);
}

function endpointHash(endpoint: string): string { return createHash('sha256').update(endpoint).digest('hex'); }

export function storeSubscription(database: AppDatabase, userId: string, subscription: BrowserSubscription, configuration: PushConfiguration, now = Date.now()): void {
  initializePushSchema(database.db);
  const encrypted = encryptSubscription(subscription, configuration.encryptionKey);
  const hash = endpointHash(subscription.endpoint);
  database.transaction(() => {
    // A browser endpoint belongs to its latest authenticated account; cancel the prior account's queued sends.
    const existing = database.db.prepare('SELECT id, user_id FROM push_subscriptions WHERE endpoint_hash = ?').get(hash) as { id: string; user_id: string } | undefined;
    if (existing && existing.user_id !== userId) {
      database.db.prepare("UPDATE push_deliveries SET status = 'cancelled' WHERE subscription_id = ? AND status IN ('pending','sending')").run(existing.id);
      database.db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(existing.id);
    }
    database.db.prepare(`INSERT INTO push_subscriptions (id,user_id,endpoint_hash,encrypted,created_at,updated_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(endpoint_hash) DO UPDATE SET encrypted=excluded.encrypted, updated_at=excluded.updated_at`).run(randomUUID(), userId, hash, encrypted, now, now);
  });
}

function removeSubscriptions(database: AppDatabase, userId: string, endpoint?: string): void {
  database.transaction(() => {
    if (endpoint) {
      database.db.prepare(`UPDATE push_deliveries SET status='cancelled' WHERE subscription_id IN
        (SELECT id FROM push_subscriptions WHERE user_id=? AND endpoint_hash=?) AND status IN ('pending','sending')`).run(userId, endpointHash(endpoint));
      database.db.prepare('DELETE FROM push_subscriptions WHERE user_id=? AND endpoint_hash=?').run(userId, endpointHash(endpoint));
    } else {
      database.db.prepare(`UPDATE push_deliveries SET status='cancelled' WHERE subscription_id IN
        (SELECT id FROM push_subscriptions WHERE user_id=?) AND status IN ('pending','sending')`).run(userId);
      database.db.prepare('DELETE FROM push_subscriptions WHERE user_id=?').run(userId);
    }
  });
}

function enqueue(database: AppDatabase, userId: string, eventKey: string, payload: Omit<NotificationPayload, 'tag'>, now: number, expiresAt = now + DAY, insideTransaction = false): boolean {
  const operation = () => {
    const id = randomUUID();
    const tag = createHash('sha256').update(`${userId}:${eventKey}`).digest('base64url').slice(0, 32);
    const inserted = database.db.prepare('INSERT OR IGNORE INTO push_events (id,user_id,event_key,payload,created_at,expires_at) VALUES (?,?,?,?,?,?)')
      .run(id, userId, eventKey, JSON.stringify({ ...payload, tag }), now, expiresAt);
    if (!inserted.changes) return false;
    const devices = database.db.prepare('SELECT id FROM push_subscriptions WHERE user_id=?').all(userId) as { id: string }[];
    const statement = database.db.prepare('INSERT INTO push_deliveries (id,event_id,subscription_id,next_attempt_at) VALUES (?,?,?,?)');
    for (const device of devices) statement.run(randomUUID(), id, device.id, now);
    return true;
  };
  return insideTransaction ? operation() : database.transaction(operation);
}

export function registerPushRoutes(app: Express, database: AppDatabase, authenticate: RequestHandler, options: { configuration?: PushConfiguration | null; now?: () => number } = {}): void {
  initializePushSchema(database.db);
  const configuration = options.configuration === undefined ? (() => { try { return loadPushConfiguration(); } catch { return null; } })() : options.configuration;
  const now = options.now ?? Date.now;
  app.get('/api/push/status', authenticate, (_req, res) => {
    const userId = res.locals.user.id as string;
    const row = database.db.prepare('SELECT COUNT(*) AS count FROM push_subscriptions WHERE user_id=?').get(userId) as { count: number };
    res.json({ configured: configuration !== null, publicKey: configuration?.publicKey ?? null, subscribed: row.count > 0, deviceCount: row.count });
  });
  app.post('/api/push/subscribe', authenticate, (req, res) => {
    if (!configuration) { res.status(503).json({ error: '서버 푸시 키와 암호화 키 설정이 필요합니다.' }); return; }
    let subscription: BrowserSubscription;
    try { subscription = validateSubscription(req.body?.subscription); } catch { res.status(400).json({ error: '올바른 푸시 구독과 지원되는 HTTPS 서비스 주소가 필요합니다.' }); return; }
    storeSubscription(database, res.locals.user.id as string, subscription, configuration, now());
    res.status(201).json({ subscribed: true });
  });
  app.post('/api/push/unsubscribe', authenticate, (req, res) => {
    const endpoint = req.body?.endpoint as unknown;
    if (req.body?.all !== true && (typeof endpoint !== 'string' || endpoint.length > 4096)) { res.status(400).json({ error: '해제할 기기 또는 전체 해제를 선택하세요.' }); return; }
    removeSubscriptions(database, res.locals.user.id as string, req.body?.all === true ? undefined : endpoint as string);
    res.json({ unsubscribed: true });
  });
  app.post('/api/push/test', authenticate, (_req, res) => {
    if (!configuration) { res.status(503).json({ error: '서버 푸시 설정이 필요합니다.' }); return; }
    const userId = res.locals.user.id as string;
    const state = database.db.prepare('SELECT json FROM states WHERE user_id=?').get(userId) as { json: string } | undefined;
    if (!state || !(JSON.parse(state.json) as AppState).config.push.enabled) { res.status(409).json({ error: '설정에서 알림을 먼저 켜주세요.' }); return; }
    const device = database.db.prepare('SELECT id FROM push_subscriptions WHERE user_id=? LIMIT 1').get(userId);
    if (!device) { res.status(409).json({ error: '홈 화면 앱에서 알림을 허용하고 기기를 등록하세요.' }); return; }
    const time = now();
    const queued = database.transaction(() => {
      const tests = database.db.prepare("SELECT COUNT(*) AS count FROM push_events WHERE user_id=? AND event_key LIKE 'test:%' AND created_at>?")
        .get(userId, time - 60_000) as { count: number };
      if (tests.count >= 5) return false;
      return enqueue(database, userId, `test:${randomUUID()}`, { title: '월급수비대 테스트 알림', body: '수비대가 도착했어요! 앱을 열어 알림 설정을 확인해보세요.', url: '/#settings' }, time, time + DAY, true);
    });
    if (!queued) { res.setHeader('Retry-After', '60'); res.status(429).json({ error: '테스트 알림은 1분에 5회까지 보낼 수 있어요.' }); return; }
    res.status(202).json({ queued: true });
  });
}

function localDate(now: number): string { return new Date(now + KST).toISOString().slice(0, 10); }
function localParts(date: string): [number, number, number] { return date.split('-').map(Number) as [number, number, number]; }
function localMidnight(date: string): number { const [year, month, day] = localParts(date); return Date.UTC(year, month - 1, day) - KST; }
function monthDay(year: number, month: number, day: number): number { return Math.min(day, new Date(Date.UTC(year, month, 0)).getUTCDate()); }
function paydayDate(year: number, month: number, day: number): string { return new Date(Date.UTC(year, month - 1, monthDay(year, month, day))).toISOString().slice(0, 10); }


/** Called in the state-write transaction, so a short-lived first crossing cannot be missed by polling. */
export function enqueueBudgetAlert(database: AppDatabase, userId: string, state: AppState, now = Date.now(), insideTransaction = false): boolean {
  const cycle = activeBudget(state, new Date(now));
  if (!state.config.push.enabled || cycle.budget <= 0) return false;
  if (!database.db.prepare('SELECT id FROM push_subscriptions WHERE user_id=? LIMIT 1').get(userId)) return false;
  const start = cycle.key;
  const spent = variableSpent(state, cycle);
  if (spent < Math.ceil(cycle.budget * state.config.push.budgetThreshold)) return false;
  return enqueue(database, userId, `budget:${start}`, { title: '생활비 예산을 확인해볼까요?', body: '기록한 지출이 설정한 예산 알림 기준에 도달했어요. 남은 계획을 가볍게 살펴보세요.', url: '/#home' }, now, now + DAY, insideTransaction);
}

export interface ScheduleCandidate { key: string; payload: Omit<NotificationPayload, 'tag'>; scheduledAt: number }
export function scheduledCandidates(now: number, config: Config): ScheduleCandidate[] {
  const output: ScheduleCandidate[] = [];
  for (const offset of [0, -DAY]) {
    const date = localDate(now + offset);
    const [year, month] = localParts(date);
    const nextDate = localDate(localMidnight(date) + DAY);
    const [nextYear, nextMonth] = localParts(nextDate);
    const add = (condition: boolean, key: string, hour: number, minute: number | undefined, payload: Omit<NotificationPayload, 'tag'>) => {
      const scheduledAt = localMidnight(date) + hour * HOUR + (minute ?? 0) * 60_000;
      if (condition && now >= scheduledAt && now - scheduledAt < CATCH_UP) output.push({ key: `${key}:${date}`, payload, scheduledAt });
    };
    add(date === paydayDate(year, month, config.salary.payday), 'payday', config.push.payday.hour, config.push.payday.minute,
      { title: '월급요정이 왔어요', body: '새 급여 주기의 돈을 나눌 시간이에요. 월급 분배 미션을 확인하세요.', url: '/#missions' });
    add(new Date(localMidnight(date) + KST).getUTCDay() === config.push.weeklyReview.dayOfWeek, 'weekly', config.push.weeklyReview.hour, config.push.weeklyReview.minute,
      { title: '이번 주 수비 기록', body: '기록한 지출을 가볍게 돌아보고 다음 주를 준비해요.', url: '/#stats' });
    // The saved legacy day fields never override the actual edited payday; month-end clamping is respected.
    add(nextDate === paydayDate(nextYear, nextMonth, config.salary.payday), 'cycle-end', config.push.cycleEnd.hour, config.push.cycleEnd.minute,
      { title: '이번 급여 주기 마무리', body: '한 주기를 지켜냈어요. 기록과 미션을 함께 정리해볼까요?', url: '/#stats' });
  }
  return output;
}

interface UserStateRow { id: string; created_at: number; last_expense_at: number | null; json: string }
interface ClaimedDelivery {
  id: string; attempts: number; subscription_id: string | null; event_id: string;
}
interface DeliveryDetail {
  user_id: string; encrypted: string; payload: string; expires_at: number; json: string;
  event_key: string; created_at: number; last_expense_at: number | null;
}

export class PushScheduler {
  private running = false;
  private stopping = false;
  readonly configuration: PushConfiguration | null;
  private readonly sender: PushSender;
  private readonly now: () => number;
  private readonly log: (entry: DeliveryLog) => void;

  constructor(private readonly database: AppDatabase, options: { configuration?: PushConfiguration | null; sender?: PushSender; now?: () => number; log?: (entry: DeliveryLog) => void } = {}) {
    initializePushSchema(database.db);
    this.configuration = options.configuration === undefined ? loadPushConfiguration() : options.configuration;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (entry => console.info(JSON.stringify(entry)));
    this.sender = options.sender ?? (async (subscription, payload) => {
      if (!this.configuration) throw new Error('Push is not configured');
      return webpush.sendNotification(subscription, JSON.stringify(payload), {
        vapidDetails: { subject: this.configuration.subject, publicKey: this.configuration.publicKey, privateKey: this.configuration.privateKey },
        TTL: 3600, urgency: 'normal', topic: payload.tag, contentEncoding: 'aes128gcm', timeout: 15_000,
        proxy: process.env.HTTPS_PROXY ?? process.env.https_proxy,
      });
    });
  }

  async tick(): Promise<void> {
    if (this.running || this.stopping || !this.configuration) return;
    this.running = true;
    try {
      this.schedule();
      // Bounded work keeps a large queue from preventing graceful shutdown.
      for (let count = 0; count < 100; count += 1) {
        if (this.stopping) break;
        const claimed = this.claim();
        if (!claimed) break;
        await this.deliver(claimed);
      }
    } finally { this.running = false; }
  }

  stop(): void { this.stopping = true; }

  private schedule(): void {
    const now = this.now();
    const rows = this.database.db.prepare(`SELECT u.id,u.created_at,u.last_expense_at,s.json FROM users u JOIN states s ON s.user_id=u.id
      WHERE EXISTS (SELECT 1 FROM push_subscriptions p WHERE p.user_id=u.id)`).all() as unknown as UserStateRow[];
    for (const user of rows) {
      const state = JSON.parse(user.json) as AppState;
      if (!state.config.push.enabled) continue;
      for (const candidate of scheduledCandidates(now, state.config)) {
        enqueue(this.database, user.id, candidate.key, candidate.payload, now, candidate.scheduledAt + DAY);
      }
      const today = localDate(now);
      enqueueBudgetAlert(this.database, user.id, state, now);
      const activity = user.last_expense_at ?? user.created_at;
      const reminderHour = state.config.push.inactivityHour ?? 20;
      if (now - activity >= state.config.push.inactivityDays * DAY && now >= localMidnight(today) + reminderHour * HOUR) {
        enqueue(this.database, user.id, `inactivity:${activity}`, { title: '수비대 기록을 이어가요', body: '최근 지출 기록이 없어요. 실제 소비는 알 수 없으니 기억나는 내역이 있다면 편하게 남겨주세요.', url: '/#expenses' }, now);
      }
    }
  }

  private claim(): ClaimedDelivery | undefined {
    const now = this.now();
    return this.database.db.prepare(`UPDATE push_deliveries SET status='sending', lease_until=?, attempts=attempts+1
      WHERE id=(SELECT id FROM push_deliveries WHERE subscription_id IS NOT NULL AND
        ((status='pending' AND next_attempt_at<=?) OR (status='sending' AND lease_until<=?))
        ORDER BY next_attempt_at,id LIMIT 1)
      AND ((status='pending' AND next_attempt_at<=?) OR (status='sending' AND lease_until<=?))
      RETURNING id,attempts,subscription_id,event_id`).get(now + LEASE, now, now, now, now) as unknown as ClaimedDelivery | undefined;
  }

  private async deliver(delivery: ClaimedDelivery): Promise<void> {
    const now = this.now();
    const row = this.database.db.prepare(`SELECT e.user_id,e.payload,e.expires_at,e.event_key,p.encrypted,s.json,u.created_at,u.last_expense_at FROM push_events e
      JOIN push_subscriptions p ON p.id=? AND p.user_id=e.user_id JOIN states s ON s.user_id=e.user_id
      JOIN users u ON u.id=e.user_id WHERE e.id=?`)
      .get(delivery.subscription_id, delivery.event_id) as unknown as DeliveryDetail | undefined;
    if (!row) { this.finish(delivery, 'cancelled'); return; }
    const log = (result: DeliveryLog['result'], statusCode?: number) => this.log({ event: 'push_delivery', userId: row.user_id, deliveryId: delivery.id, result, attempt: delivery.attempts, timestamp: new Date(now).toISOString(), ...(statusCode ? { statusCode } : {}) });
    const state = JSON.parse(row.json) as AppState;
    const activity = row.last_expense_at ?? row.created_at;
    const staleInactivity = row.event_key.startsWith('inactivity:') && (
      Number(row.event_key.slice('inactivity:'.length)) !== activity
      || now - activity < state.config.push.inactivityDays * DAY
      || now < localMidnight(localDate(now)) + (state.config.push.inactivityHour ?? 20) * HOUR
    );
    if (!state.config.push.enabled || row.expires_at <= now || staleInactivity) {
      this.finish(delivery, 'cancelled'); log('cancelled'); return;
    }
    if (delivery.attempts > MAX_ATTEMPTS) { this.finish(delivery, 'failed'); log('failed'); return; }
    try {
      const subscription = decryptSubscription(row.encrypted, this.configuration!.encryptionKey);
      const response = await this.sender(subscription, JSON.parse(row.payload) as NotificationPayload) as { statusCode?: number } | undefined;
      const acceptedStatus = response?.statusCode ?? 201;
      this.database.db.prepare("UPDATE push_deliveries SET status='sent', sent_at=?, lease_until=NULL, last_status=? WHERE id=? AND status='sending' AND attempts=?").run(this.now(), acceptedStatus, delivery.id, delivery.attempts);
      log('accepted', acceptedStatus);
    } catch (error) {
      // An older worker must not overwrite the state of a worker that reclaimed its expired lease.
      if (!this.ownsClaim(delivery)) return;
      const candidate = error as { statusCode?: unknown; headers?: Record<string, string> };
      const statusCode = typeof candidate.statusCode === 'number' ? candidate.statusCode : undefined;
      if (statusCode === 404 || statusCode === 410) {
        this.database.transaction(() => {
          if (!this.ownsClaim(delivery)) return;
          this.finish(delivery, 'dead', statusCode);
          this.database.db.prepare("UPDATE push_deliveries SET status='cancelled', lease_until=NULL WHERE subscription_id=? AND id<>? AND status IN ('pending','sending')").run(delivery.subscription_id, delivery.id);
          this.database.db.prepare('DELETE FROM push_subscriptions WHERE id=? AND user_id=?').run(delivery.subscription_id, row.user_id);
        });
        log('expired_subscription', statusCode);
      } else if ((statusCode === undefined || statusCode === 429 || statusCode >= 500) && delivery.attempts < MAX_ATTEMPTS) {
        const backoff = Math.min(HOUR, 30_000 * 2 ** (delivery.attempts - 1));
        const retryAfter = candidate.headers?.['retry-after'];
        const requested = retryAfter ? (/^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - now) : 0;
        const delay = Math.max(backoff, Math.min(DAY, Number.isFinite(requested) ? requested : 0));
        this.database.db.prepare("UPDATE push_deliveries SET status='pending', next_attempt_at=?, lease_until=NULL, last_status=? WHERE id=? AND status='sending' AND attempts=?").run(now + delay, statusCode ?? null, delivery.id, delivery.attempts);
        log('retry', statusCode);
      } else { this.finish(delivery, 'failed', statusCode); log('failed', statusCode); }
    }
  }

  private finish(delivery: ClaimedDelivery, status: string, code?: number): void {
    this.database.db.prepare("UPDATE push_deliveries SET status=?, lease_until=NULL, last_status=? WHERE id=? AND status='sending' AND attempts=?").run(status, code ?? null, delivery.id, delivery.attempts);
  }

  private ownsClaim(delivery: ClaimedDelivery): boolean {
    return Boolean(this.database.db.prepare("SELECT id FROM push_deliveries WHERE id=? AND status='sending' AND attempts=?").get(delivery.id, delivery.attempts));
  }
}
