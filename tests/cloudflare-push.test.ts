import assert from 'node:assert/strict';
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import webpush from 'web-push';
import type { D1Database } from '@cloudflare/workers-types';
import { createInitialState } from '../shared/domain.ts';
import type { AppState, NotificationPayload } from '../shared/types.ts';
import { scheduledCandidates as nodeCandidates } from '../server/push.ts';
import { MAX_D1_QUERIES_PER_TICK, MAX_DELIVERIES_PER_TICK, MAX_USERS_CHECKED_PER_TICK, runPushCron } from '../cloudflare/cron.ts';
import { budgetAlertStatements, createPushRequest, decryptSubscription, encryptSubscription, handlePushRequest, isPushConfigured, loadPushConfiguration, scheduledCandidates, sendWebPush, validateSubscription, type BrowserSubscription } from '../cloudflare/push.ts';
import { cloudflareFixture } from './cloudflare-fixture.ts';
import type { Env } from '../cloudflare/types.ts';

const keys = webpush.generateVAPIDKeys();
const secrets = { VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey, VAPID_SUBJECT: 'mailto:test@example.com', DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64') };
const BASE = Date.parse('2026-10-13T03:00:00Z');
const DAY = 86_400_000;
function sub(id: string): BrowserSubscription { const curve = createECDH('prime256v1'); return { endpoint: `https://web.push.apple.com/${id}`, keys: { p256dh: curve.generateKeys().toString('base64url'), auth: randomBytes(16).toString('base64url') } }; }
async function insertUser(db: D1Database, id: string, now = BASE): Promise<AppState> {
  const state = createInitialState(); state.config.push.enabled = true;
  await db.batch([
    db.prepare('INSERT INTO users (id,email,password_hash,created_at,last_expense_at) VALUES (?,?,?,?,?)').bind(id, `${id}@example.com`, 'test-only', now, now),
    db.prepare('INSERT INTO states (user_id,json,revision,write_id) VALUES (?,?,0,?)').bind(id, JSON.stringify(state), `${id}-initial`),
  ]);
  return state;
}
async function save(db: D1Database, id: string, state: AppState, writeId = crypto.randomUUID()): Promise<void> { await db.prepare('UPDATE states SET json=?,write_id=? WHERE user_id=?').bind(JSON.stringify(state), writeId, id).run(); }
function reach(state: AppState, date = '2026-10-13'): void { state.expenses = [{ id: 'threshold', amount: 1_094_400, date, category: 'food', note: 'never put this transaction in push', emotion: '', createdAt: new Date(BASE).toISOString() }]; }
async function count(db: D1Database, table: string, where = ''): Promise<number> { return (await db.prepare(`SELECT COUNT(*) AS count FROM ${table} ${where}`).first<{ count: number }>())!.count; }
async function push(env: Env, id: string, path: string, body?: unknown): Promise<Response> {
  const response = await handlePushRequest(new Request(`https://salary.example/api/push/${path}`, { method: path === 'status' ? 'GET' : 'POST' }), env, { id, email: `${id}@example.com` }, body);
  assert.ok(response); return response;
}
async function fixture(context: TestContext) {
  const data = await cloudflareFixture(context);
  const env: Env = { ...data.env, ...secrets };
  const state = await insertUser(data.db, 'alice');
  const device = sub('alice');
  assert.equal((await push(env, 'alice', 'subscribe', { subscription: device })).status, 201);
  let time = BASE;
  const received: NotificationPayload[] = [];
  const options = { now: () => time, log: () => {}, sender: async (_device: BrowserSubscription, payload: NotificationPayload) => { received.push(payload); return { statusCode: 201 }; } };
  return { ...data, env, state, device, received, options, setTime: (next: number) => { time = next; } };
}

function decryptPayload(body: Uint8Array, recipient: ReturnType<typeof createECDH>, auth: Buffer): string {
  const bytes = Buffer.from(body);
  const senderPublic = bytes.subarray(21, 21 + bytes[20]);
  const secret = recipient.computeSecret(senderPublic);
  const info = Buffer.concat([Buffer.from('WebPush: info\0'), recipient.getPublicKey(), senderPublic]);
  const key = Buffer.from(hkdfSync('sha256', secret, auth, info, 32));
  const cek = Buffer.from(hkdfSync('sha256', key, bytes.subarray(0, 16), Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', key, bytes.subarray(0, 16), Buffer.from('Content-Encoding: nonce\0'), 12));
  const encrypted = bytes.subarray(21 + senderPublic.length);
  const aes = createDecipheriv('aes-128-gcm', cek, nonce);
  aes.setAuthTag(encrypted.subarray(-16));
  const clear = Buffer.concat([aes.update(encrypted.subarray(0, -16)), aes.final()]);
  assert.equal(clear.at(-1), 2);
  return clear.subarray(0, -1).toString();
}

test('native Workers Web Crypto payloads match RFC8291/web-push receiver format and valid ES256 VAPID', async () => {
  const configuration = await loadPushConfiguration(secrets); assert.ok(configuration);
  const recipient = createECDH('prime256v1'); const recipientPublic = recipient.generateKeys(); const auth = randomBytes(16);
  const subscription = { endpoint: 'https://web.push.apple.com/native-worker', keys: { p256dh: recipientPublic.toString('base64url'), auth: auth.toString('base64url') } };
  const payload: NotificationPayload = { title: '월급수비대', body: 'generic safe content', url: '/#settings', tag: 'test-topic' };
  const native = await createPushRequest(subscription, payload, configuration, BASE);
  const reference = webpush.generateRequestDetails(subscription, JSON.stringify(payload), { vapidDetails: { ...keys, subject: secrets.VAPID_SUBJECT }, contentEncoding: 'aes128gcm' });
  assert.equal(decryptPayload(native.body, recipient, auth), JSON.stringify(payload));
  assert.ok(reference.body);
  assert.equal(decryptPayload(reference.body, recipient, auth), JSON.stringify(payload));
  assert.equal(native.headers['Content-Encoding'], 'aes128gcm');
  assert.equal(Buffer.from(native.body).readUInt32BE(16), 4096);
  const jwt = /t=([^,\s]+)/.exec(native.headers.Authorization)![1];
  const [header, claims, signature] = jwt.split('.');
  const details = JSON.parse(Buffer.from(claims, 'base64url').toString());
  assert.equal(details.aud, 'https://web.push.apple.com');
  assert.equal(details.exp, Math.floor(BASE / 1000) + 12 * 3600);
  assert.equal(details.sub, secrets.VAPID_SUBJECT);
  const pub = Buffer.from(keys.publicKey, 'base64url');
  const publicKey = createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') } });
  assert.equal(verify('sha256', Buffer.from(`${header}.${claims}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')), true);
  await sendWebPush(subscription, payload, configuration, BASE, async (_url, init) => { assert.equal(init?.redirect, 'error'); assert.equal(init?.method, 'POST'); return new Response(null, { status: 201 }); });
  await assert.rejects(() => sendWebPush(subscription, payload, configuration, BASE, async () => new Response(null, { status: 429, headers: { 'Retry-After': '120' } })), (error: any) => error.statusCode === 429 && error.headers['retry-after'] === '120');
  assert.equal((await createPushRequest(subscription, payload, configuration, BASE, 37)).headers.TTL, '37');
  await assert.rejects(() => createPushRequest(subscription, payload, configuration, BASE, 0));
  let expiredRequestSent = false;
  await assert.rejects(() => sendWebPush(subscription, payload, configuration, Date.now(), async () => { expiredRequestSent = true; return new Response(null, { status: 201 }); }, Date.now() - 1));
  assert.equal(expiredRequestSent, false);
});

test('Worker subscription validation and AES-GCM storage reject arbitrary endpoints, tampering, and mismatched VAPID', async () => {
  const configuration = await loadPushConfiguration(secrets); assert.ok(configuration);
  const device = sub('encrypted');
  for (const endpoint of ['http://web.push.apple.com/id', 'https://localhost/private', 'https://web.push.apple.com.evil.example/id', 'https://user:pass@web.push.apple.com/id', 'https://web.push.apple.com:444/id']) await assert.rejects(() => validateSubscription({ ...device, endpoint }));
  const encrypted = await encryptSubscription(device, configuration.encryptionKey);
  assert.ok(!encrypted.includes(device.endpoint)); assert.ok(!encrypted.includes(device.keys.auth));
  assert.deepEqual(await decryptSubscription(encrypted, configuration.encryptionKey), device);
  const components = encrypted.split('.'); const bytes = Buffer.from(components[2], 'base64url'); bytes[0] ^= 1; components[2] = bytes.toString('base64url');
  await assert.rejects(() => decryptSubscription(components.join('.'), configuration.encryptionKey));
  assert.equal(await isPushConfigured({}), false);
  assert.equal(await isPushConfigured({ ...secrets, VAPID_PRIVATE_KEY: webpush.generateVAPIDKeys().privateKey }), false);
});

test('Cloudflare KST schedules preserve Node behavior at payday, Sunday, month-end, catch-up and DST boundaries', () => {
  const config = createInitialState().config;
  for (const stamp of ['2026-10-24T10:59:59Z', '2026-10-24T11:00:00Z', '2026-10-25T00:00:00Z', '2026-10-18T11:00:00Z', '2026-10-18T22:59:59Z', '2026-10-18T23:00:00Z', '2026-11-01T11:00:00Z']) assert.deepEqual(scheduledCandidates(Date.parse(stamp), config), nodeCandidates(Date.parse(stamp), config));
  config.salary.payday = 1;
  for (const stamp of ['2026-02-28T11:00:00Z', '2026-02-28T15:00:00Z', '2026-03-01T00:00:00Z']) assert.deepEqual(scheduledCandidates(Date.parse(stamp), config), nodeCandidates(Date.parse(stamp), config));
  config.salary.payday = 5; config.push.payday.minute = 45;
  for (const stamp of ['2026-10-05T00:44:59Z', '2026-10-05T00:45:00Z', '2026-10-04T11:00:00Z', '2026-10-24T11:00:00Z']) assert.deepEqual(scheduledCandidates(Date.parse(stamp), config), nodeCandidates(Date.parse(stamp), config));
});

test('D1 write-id fences capture first budget crossing atomically and prevent conflicts from creating notifications', async context => {
  const f = await fixture(context); reach(f.state);
  const losing = await budgetAlertStatements(f.db, 'alice', f.state, BASE, 'losing-write');
  await f.db.batch([f.db.prepare('UPDATE states SET json=?,write_id=? WHERE user_id=? AND revision=?').bind(JSON.stringify(f.state), 'losing-write', 'alice', 99), ...losing]);
  assert.equal(await count(f.db, 'push_events'), 0);
  const winning = await budgetAlertStatements(f.db, 'alice', f.state, BASE, 'winning-write');
  await f.db.batch([f.db.prepare('UPDATE states SET json=?,write_id=?,revision=revision+1 WHERE user_id=? AND revision=?').bind(JSON.stringify(f.state), 'winning-write', 'alice', 0), ...winning]);
  assert.equal(await count(f.db, 'push_events'), 1);
  f.state.expenses = []; await save(f.db, 'alice', f.state);
  await runPushCron(f.env, f.options);
  assert.equal(f.received.length, 1);
  reach(f.state); await save(f.db, 'alice', f.state); await runPushCron({ ...f.env }, f.options);
  assert.equal(f.received.length, 1);
  assert.ok(!JSON.stringify(f.received).includes('1094400')); assert.ok(!JSON.stringify(f.received).includes('never put'));
  const later = Date.parse('2026-10-27T03:00:00Z'); f.setTime(later);
  await f.db.prepare('UPDATE users SET last_expense_at=?').bind(later).run();
  reach(f.state, '2026-10-27'); await save(f.db, 'alice', f.state); await runPushCron(f.env, f.options);
  assert.equal(f.received.length, 2); assert.notEqual(f.received[0].tag, f.received[1].tag);
  f.state.config.allocation.variableBudget = 0; f.state.expenses = [];
  assert.deepEqual(await budgetAlertStatements(f.db, 'alice', f.state, later), []);
});

test('D1 inactivity reminder deduplicates each episode and honors configured days and new activity', async context => {
  const f = await fixture(context);
  const time = Date.parse('2026-10-13T11:00:00Z'); f.setTime(time);
  await f.db.prepare('UPDATE users SET last_expense_at=?').bind(time - 3 * DAY).run();
  await runPushCron(f.env, f.options); assert.equal(f.received.length, 1);
  f.setTime(time + DAY); await runPushCron({ ...f.env }, f.options); assert.equal(f.received.length, 1);
  await f.db.prepare('UPDATE users SET last_expense_at=?').bind(time + DAY).run();
  f.state.config.push.inactivityDays = 1; await save(f.db, 'alice', f.state);
  await runPushCron(f.env, f.options); assert.equal(f.received.length, 1);
  f.setTime(time + 2 * DAY); await runPushCron(f.env, f.options);
  assert.equal(f.received.length, 2); assert.notEqual(f.received[0].tag, f.received[1].tag);
});

test('D1 leases, restart-safe deduplication, provider backoff and per-device delivery progress', async context => {
  const f = await fixture(context); reach(f.state); await save(f.db, 'alice', f.state);
  assert.equal((await push(f.env, 'alice', 'subscribe', { subscription: sub('second') })).status, 201);
  let failures = 0; const calls: string[] = []; const tags: string[] = [];
  const options = { ...f.options, sender: async (device: BrowserSubscription, payload: NotificationPayload) => { calls.push(device.endpoint); tags.push(payload.tag); if (device.endpoint === f.device.endpoint && failures++ === 0) throw Object.assign(new Error('limited'), { statusCode: 429, headers: { 'retry-after': '120' } }); } };
  await runPushCron(f.env, options);
  assert.equal(await count(f.db, 'push_deliveries', "WHERE status='sent'"), 1);
  f.setTime(BASE + 119_999); await runPushCron({ ...f.env }, options); assert.equal(calls.length, 2);
  f.setTime(BASE + 120_000); await runPushCron({ ...f.env }, options);
  assert.equal(calls.length, 3); assert.equal(new Set(tags).size, 1);
  assert.equal(await count(f.db, 'push_deliveries', "WHERE status='sent'"), 2);
  await runPushCron({ ...f.env }, options); assert.equal(calls.length, 3);
});

test('D1 atomic claims and lease fences survive concurrent cron invocations and obsolete errors', async context => {
  const f = await fixture(context); reach(f.state); await save(f.db, 'alice', f.state);
  let release: () => void = () => {}; const gate = new Promise<void>(resolve => { release = resolve; });
  let started: () => void = () => {}; const start = new Promise<void>(resolve => { started = resolve; });
  let calls = 0;
  const first = runPushCron(f.env, { ...f.options, sender: async () => { calls++; started(); await gate; throw Object.assign(new Error('obsolete expired'), { statusCode: 410 }); } });
  await start;
  await runPushCron({ ...f.env }, { ...f.options, sender: async () => { calls++; } }); assert.equal(calls, 1);
  f.setTime(BASE + 60_001);
  await runPushCron({ ...f.env }, { ...f.options, sender: async () => { calls++; } }); assert.equal(calls, 2);
  release(); await first;
  assert.equal(await count(f.db, 'push_subscriptions'), 1);
  assert.equal(await count(f.db, 'push_deliveries', "WHERE status='sent'"), 1);
});

test('a delayed D1 detail snapshot cannot send after another worker finishes or without provider time remaining', async context => {
  for (const reclaim of [true, false]) {
    const f = await fixture(context); reach(f.state); await save(f.db, 'alice', f.state);
    let release: () => void = () => {}; const gate = new Promise<void>(resolve => { release = resolve; });
    let loaded: () => void = () => {}; const load = new Promise<void>(resolve => { loaded = resolve; });
    let paused = false;
    const delayed = {
      prepare(sql: string) {
        const statement = f.db.prepare(sql);
        if (!sql.startsWith('SELECT e.user_id')) return statement;
        return { bind(...bindings: unknown[]) {
          const bound = statement.bind(...bindings);
          return { async first() {
            const snapshot = await bound.first();
            if (!paused) { paused = true; loaded(); await gate; }
            return snapshot;
          } };
        } };
      },
      batch(statements: Parameters<D1Database['batch']>[0]) { return f.db.batch(statements); },
    } as unknown as D1Database;
    let calls = 0;
    const options = { ...f.options, sender: async () => { calls++; return { statusCode: 201 }; } };
    const original = runPushCron({ ...f.env, DB: delayed }, options);
    await load;
    f.setTime(BASE + (reclaim ? 61_000 : 46_000));
    if (reclaim) await runPushCron(f.env, options);
    release(); const result = await original;
    assert.equal(calls, 1);
    assert.equal(await count(f.db, 'push_deliveries', "WHERE status='sent'"), 1);
    assert.ok(result.queriesUsed <= MAX_D1_QUERIES_PER_TICK);
  }
});

test('provider TTL respects the remaining event lifetime and subsecond expired reminders do not send', async context => {
  const f = await fixture(context); reach(f.state); await save(f.db, 'alice', f.state);
  await f.db.batch(await budgetAlertStatements(f.db, 'alice', f.state, BASE));
  await f.db.prepare('UPDATE push_events SET expires_at=?').bind(BASE + 37_500).run();
  let calls = 0;
  const options = { ...f.options, sender: async (device: BrowserSubscription, payload: NotificationPayload, configuration: NonNullable<Awaited<ReturnType<typeof loadPushConfiguration>>>, _leaseUntil: number, ttlSeconds: number) => {
    calls++;
    const request = await createPushRequest(device, payload, configuration, BASE, ttlSeconds);
    assert.equal(request.headers.TTL, '37');
    return { statusCode: 201 };
  } };
  await runPushCron(f.env, options); assert.equal(calls, 1);
  await f.db.prepare('DELETE FROM push_events').run();
  await f.db.batch(await budgetAlertStatements(f.db, 'alice', f.state, BASE));
  await f.db.prepare('UPDATE push_events SET expires_at=?').bind(BASE + 999).run();
  await runPushCron(f.env, options);
  assert.equal(calls, 1); assert.equal(await count(f.db, 'push_deliveries', "WHERE status='cancelled'"), 1);
});

test('D1 pending inactivity cancels on new recording; opt out, expiry and permanent failures stop retries', async context => {
  const f = await fixture(context);
  const time = Date.parse('2026-10-13T11:00:00Z'); f.setTime(time);
  await f.db.prepare('UPDATE users SET last_expense_at=?').bind(time - 3 * DAY).run();
  let calls = 0; const unavailable = { ...f.options, sender: async () => { calls++; throw Object.assign(new Error('unavailable'), { statusCode: 503 }); } };
  await runPushCron(f.env, unavailable); assert.equal(calls, 1);
  await f.db.prepare('UPDATE users SET last_expense_at=?').bind(time + 1).run();
  f.setTime(time + 30_000); await runPushCron(f.env, unavailable);
  assert.equal(calls, 1); assert.equal(await count(f.db, 'push_deliveries', "WHERE status='cancelled'"), 1);
  reach(f.state); await save(f.db, 'alice', f.state); await runPushCron(f.env, unavailable);
  f.state.config.push.enabled = false; await save(f.db, 'alice', f.state);
  f.setTime(time + 60_000); await runPushCron(f.env, unavailable);
  assert.equal(calls, 2);
  f.state.config.push.enabled = true; await save(f.db, 'alice', f.state); await f.db.prepare('DELETE FROM push_events').run();
  await runPushCron(f.env, { ...f.options, sender: async () => { throw Object.assign(new Error('forbidden'), { statusCode: 403 }); } });
  assert.equal(await count(f.db, 'push_deliveries', "WHERE status='failed'"), 1);
  await f.db.prepare("UPDATE push_deliveries SET status='pending',next_attempt_at=?,attempts=7").bind(time + 60_000).run();
  await runPushCron(f.env, unavailable);
  assert.equal(await count(f.db, 'push_deliveries', "WHERE status='failed'"), 1);
  const beforeExpiry = calls;
  await f.db.batch([
    f.db.prepare('UPDATE push_events SET expires_at=?').bind(time - 1),
    f.db.prepare("UPDATE push_deliveries SET status='pending',attempts=0,next_attempt_at=?").bind(time),
  ]);
  await runPushCron(f.env, unavailable);
  assert.equal(calls, beforeExpiry); assert.equal(await count(f.db, 'push_deliveries', "WHERE status='cancelled'"), 1);
});

test('D1 inactivity retries honor edited reminder days and hours before sending', async context => {
  const f = await fixture(context);
  const time = Date.parse('2026-10-13T11:00:00Z'); f.setTime(time);
  await f.db.prepare('UPDATE users SET last_expense_at=?').bind(time - 3 * DAY).run();
  let calls = 0;
  const options = { ...f.options, sender: async () => { calls++; throw Object.assign(new Error('limited'), { statusCode: 429 }); } };
  await runPushCron(f.env, options); assert.equal(calls, 1);
  f.state.config.push.inactivityDays = 30; await save(f.db, 'alice', f.state);
  f.setTime(time + 30_000); await runPushCron(f.env, options);
  assert.equal(calls, 1); assert.equal(await count(f.db, 'push_deliveries', "WHERE status='cancelled'"), 1);
  await f.db.prepare('DELETE FROM push_events').run();
  f.state.config.push.inactivityDays = 3; f.state.config.push.inactivityHour = 20; await save(f.db, 'alice', f.state);
  await runPushCron(f.env, options); assert.equal(calls, 2);
  f.state.config.push.inactivityHour = 22; await save(f.db, 'alice', f.state);
  f.setTime(time + 60_000); await runPushCron(f.env, options);
  assert.equal(calls, 2); assert.equal(await count(f.db, 'push_deliveries', "WHERE status='cancelled'"), 1);
});

test('D1 expired subscriptions prune safely, opt-out isolates users, and test cap remains atomic', async context => {
  const f = await fixture(context); await insertUser(f.db, 'bob');
  const status = await (await push(f.env, 'alice', 'status')).json() as Record<string, unknown>;
  assert.equal(status.deviceCount, 1); assert.ok(!JSON.stringify(status).includes(f.device.endpoint)); assert.ok(!JSON.stringify(status).includes(keys.privateKey));
  await push(f.env, 'bob', 'unsubscribe', { endpoint: f.device.endpoint }); assert.equal(await count(f.db, 'push_subscriptions'), 1);
  for (let i = 0; i < 5; i++) assert.equal((await push(f.env, 'alice', 'test')).status, 202);
  assert.equal((await push({ ...f.env }, 'alice', 'test')).status, 429);
  assert.equal(await count(f.db, 'push_events'), 5);
  await push(f.env, 'bob', 'subscribe', { subscription: f.device });
  assert.equal(await count(f.db, 'push_subscriptions', "WHERE user_id='alice'"), 0);
  assert.equal(await count(f.db, 'push_deliveries', "WHERE status='cancelled'"), 5);
  assert.equal((await push(f.env, 'bob', 'subscribe', { subscription: sub('expired-404') })).status, 201);
  assert.equal((await push(f.env, 'bob', 'test')).status, 202);
  f.setTime(Date.now());
  await runPushCron(f.env, { ...f.options, sender: async device => { throw Object.assign(new Error('expired'), { statusCode: device.endpoint.endsWith('expired-404') ? 404 : 410 }); } });
  assert.equal(await count(f.db, 'push_subscriptions'), 0);
  assert.equal(await count(f.db, 'push_deliveries', "WHERE status='dead'"), 2);
  assert.equal(await count(f.db, 'push_deliveries', 'WHERE subscription_id IS NULL'), 7);
});

test('Free-tier cron bounds each delivery batch and preserves remaining jobs for the next minute', async context => {
  const f = await fixture(context); reach(f.state); await save(f.db, 'alice', f.state);
  for (let i = 1; i <= MAX_DELIVERIES_PER_TICK; i++) assert.equal((await push(f.env, 'alice', 'subscribe', { subscription: sub(`batch-${i}`) })).status, 201);
  const first = await runPushCron(f.env, f.options);
  assert.equal(first.processed, MAX_DELIVERIES_PER_TICK);
  assert.equal(f.received.length, MAX_DELIVERIES_PER_TICK);
  assert.equal(await count(f.db, 'push_deliveries', "WHERE status='pending'"), 1);
  await runPushCron(f.env, f.options);
  assert.equal(f.received.length, MAX_DELIVERIES_PER_TICK + 1);
  assert.equal(await count(f.db, 'push_deliveries', "WHERE status='pending'"), 0);
});

test('Free-tier query budget includes every batch statement in the maximum reminder and expired-device burst', async context => {
  const f = await fixture(context);
  const time = Date.parse('2026-10-25T00:05:00Z'); f.setTime(time); // Sunday 09:05 KST: payday, weekly, previous cycle end.
  f.state.config.push.payday.hour = 9;
  f.state.config.push.weeklyReview.hour = 9;
  f.state.config.push.cycleEnd.hour = 22;
  f.state.config.push.inactivityHour = 0;
  reach(f.state, '2026-10-25'); await save(f.db, 'alice', f.state);
  await f.db.prepare('UPDATE users SET last_expense_at=?').bind(time - 3 * DAY).run();
  for (let i = 1; i < MAX_DELIVERIES_PER_TICK; i++) await push(f.env, 'alice', 'subscribe', { subscription: sub(`burst-${i}`) });
  let calls = 0;
  const options = { ...f.options, sender: async () => { calls++; throw Object.assign(new Error('expired'), { statusCode: 404 }); } };
  const result = await runPushCron(f.env, options);
  assert.equal(await count(f.db, 'push_events'), 5);
  assert.equal(result.checkedUsers, 1);
  assert.equal(result.processed, 7);
  assert.equal(result.queriesUsed, 47); // 1 selection + 11 schedule/check statements + 7 × 5 delivery statements.
  assert.ok(result.queriesUsed <= MAX_D1_QUERIES_PER_TICK);
  assert.equal(calls, 7);
  assert.equal(await count(f.db, 'push_subscriptions'), 1);
  f.setTime(time + 60_000);
  const remainder = await runPushCron(f.env, options);
  assert.ok(remainder.queriesUsed <= MAX_D1_QUERIES_PER_TICK);
  assert.equal(calls, 8);
  assert.equal(await count(f.db, 'push_subscriptions'), 0);
});

test('bounded scheduling rotates fairly through enabled users while disabled users cannot block the queue', async context => {
  const f = await fixture(context);
  const total = 8;
  for (let i = 1; i < total; i++) {
    const id = `active-${i}`; await insertUser(f.db, id);
    await push(f.env, id, 'subscribe', { subscription: sub(id) });
  }
  for (let i = 0; i < 3; i++) {
    const id = `disabled-${i}`; const state = await insertUser(f.db, id); state.config.push.enabled = false;
    await save(f.db, id, state); await push(f.env, id, 'subscribe', { subscription: sub(id) });
  }
  for (let round = 0; round < total / MAX_USERS_CHECKED_PER_TICK; round++) {
    f.setTime(BASE + round * 60_000);
    const result = await runPushCron(f.env, f.options);
    assert.equal(result.checkedUsers, MAX_USERS_CHECKED_PER_TICK);
    assert.ok(result.queriesUsed <= MAX_D1_QUERIES_PER_TICK);
    assert.equal(await count(f.db, 'users', 'WHERE push_checked_at>0'), (round + 1) * MAX_USERS_CHECKED_PER_TICK);
  }
  assert.equal(await count(f.db, 'users', "WHERE id LIKE 'disabled-%' AND push_checked_at=0"), 3);
});

test('D1 budget alert uses the temporary balance and skips expenses already included in that balance', async context => {
  const f = await fixture(context);
  f.state.bridgeBudget = { id: 'bridge', amount: 550000, startDate: '2026-10-13', endDate: '2026-10-24', excludedExpenseIds: ['old'] };
  f.state.expenses = [{ id: 'old', category: 'shopping', amount: 900000, date: '2026-10-13', note: '', emotion: '', createdAt: new Date(BASE).toISOString() }];
  assert.deepEqual(await budgetAlertStatements(f.db, 'alice', f.state, BASE), []);
  f.state.expenses.push({ ...f.state.expenses[0], id: 'new', amount: 440000 });
  await save(f.db, 'alice', f.state);
  await f.db.batch(await budgetAlertStatements(f.db, 'alice', f.state, BASE));
  await f.db.batch(await budgetAlertStatements(f.db, 'alice', f.state, BASE));
  assert.equal(await count(f.db, 'push_events'), 1);
  assert.equal((await f.db.prepare('SELECT event_key FROM push_events').first<{ event_key: string }>())!.event_key, 'budget:bridge:bridge');
});

test('D1 budget alerts exclude recurring payments from the variable threshold', async context => {
  const f = await fixture(context);
  f.state.config.categories.push({ id: 'regular', name: '정기지출', budget: 0, kind: 'regular' });
  f.state.expenses = [{ id: 'bill', category: 'regular', amount: 1500000, date: '2026-10-13', note: '', emotion: '', createdAt: new Date(BASE).toISOString() }];
  assert.deepEqual(await budgetAlertStatements(f.db, 'alice', f.state, BASE), []);
  f.state.expenses.push({ ...f.state.expenses[0], id: 'living', category: 'food', amount: 1094400 });
  await save(f.db, 'alice', f.state);
  await f.db.batch(await budgetAlertStatements(f.db, 'alice', f.state, BASE));
  assert.equal(await count(f.db, 'push_events'), 1);
});
