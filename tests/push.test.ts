import assert from 'node:assert/strict';
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import express from 'express';
import request from 'supertest';
import webpush from 'web-push';
import { AppDatabase } from '../server/db.ts';
import { createInitialState } from '../shared/domain.ts';
import type { AppState, NotificationPayload } from '../shared/types.ts';
import {
  decryptSubscription, encryptSubscription, enqueueBudgetAlert, initializePushSchema, isPushConfigured,
  loadPushConfiguration, PushScheduler, registerPushRoutes, scheduledCandidates, storeSubscription, validateSubscription,
  type BrowserSubscription, type DeliveryLog, type PushConfiguration, type PushSender,
} from '../server/push.ts';

const keys = webpush.generateVAPIDKeys();
const configuration: PushConfiguration = { ...keys, subject: 'mailto:test@example.com', encryptionKey: randomBytes(32) };
const BASE = Date.parse('2026-10-13T03:00:00Z'); // Tuesday 12:00 KST; no periodic notification.
const DAY = 86_400_000;

function subscription(id = 'device'): BrowserSubscription {
  const curve = createECDH('prime256v1');
  const publicKey = curve.generateKeys();
  return { endpoint: `https://web.push.apple.com/${id}`, keys: { p256dh: publicKey.toString('base64url'), auth: randomBytes(16).toString('base64url') } };
}
function insertUser(database: AppDatabase, id: string, now = BASE, state = createInitialState()): AppState {
  state.config.push.enabled = true;
  database.db.prepare('INSERT INTO users (id,email,password_hash,created_at,last_expense_at) VALUES (?,?,?,?,?)').run(id, `${id}@example.com`, 'test-only', now, now);
  database.db.prepare('INSERT INTO states (user_id,json,revision) VALUES (?,?,0)').run(id, JSON.stringify(state));
  return state;
}
function save(database: AppDatabase, userId: string, state: AppState): void { database.db.prepare('UPDATE states SET json=? WHERE user_id=?').run(JSON.stringify(state), userId); }
function threshold(state: AppState, date = '2026-10-13'): void {
  state.expenses = [{ id: 'threshold', amount: 1_094_400, date, category: 'food', note: 'private transaction', emotion: '', createdAt: new Date(BASE).toISOString() }];
}
function count(database: AppDatabase, table: string, where = ''): number {
  return (database.db.prepare(`SELECT COUNT(*) AS n FROM ${table} ${where}`).get() as { n: number }).n;
}
function fixture(context: TestContext) {
  const database = new AppDatabase(':memory:');
  initializePushSchema(database.db);
  context.after(() => database.close());
  const state = insertUser(database, 'alice');
  const device = subscription('alice');
  storeSubscription(database, 'alice', device, configuration, BASE);
  let time = BASE;
  const received: { device: BrowserSubscription; payload: NotificationPayload }[] = [];
  const logs: DeliveryLog[] = [];
  const options = { configuration, now: () => time, log: (entry: DeliveryLog) => logs.push(entry) };
  const sender: PushSender = async (sub, payload) => { received.push({ device: sub, payload }); return { statusCode: 201 }; };
  return { database, state, device, received, logs, options, sender, setTime: (next: number) => { time = next; } };
}

test('VAPID configuration checks matching P-256 keys and encryption key, without exposing values', () => {
  const env = { VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey, VAPID_SUBJECT: configuration.subject, DATA_ENCRYPTION_KEY: configuration.encryptionKey.toString('base64') };
  assert.equal(loadPushConfiguration({}), null);
  assert.equal(isPushConfigured({}), false);
  assert.equal(isPushConfigured(env), true);
  assert.deepEqual(loadPushConfiguration(env)?.encryptionKey, configuration.encryptionKey);
  assert.equal(isPushConfigured({ ...env, VAPID_PRIVATE_KEY: webpush.generateVAPIDKeys().privateKey }), false);
  assert.throws(() => loadPushConfiguration({ ...env, DATA_ENCRYPTION_KEY: 'short' }));
  assert.equal(isPushConfigured({ ...env, VAPID_SUBJECT: 'http://example.com' }), false);
});

test('browser subscription validation prevents arbitrary HTTP requests and verifies real curve keys', () => {
  const valid = subscription();
  for (const endpoint of ['https://web.push.apple.com/id', 'https://fcm.googleapis.com/fcm/send/id', 'https://updates.push.services.mozilla.com/wpush/id', 'https://db5.notify.windows.com/w/?token=test']) {
    assert.equal(validateSubscription({ ...valid, endpoint }).endpoint, endpoint);
  }
  for (const endpoint of ['http://web.push.apple.com/id', 'https://127.0.0.1/private', 'https://web.push.apple.com.evil.example/id', 'https://evil.example/web.push.apple.com', 'https://web.push.apple.com:444/id', 'https://user:pass@web.push.apple.com/id', 'https://web.push.apple.com/id#fragment', 'http://169.254.169.254/latest/meta-data']) {
    assert.throws(() => validateSubscription({ ...valid, endpoint }), endpoint);
  }
  assert.throws(() => validateSubscription({ ...valid, keys: { ...valid.keys, p256dh: Buffer.alloc(65, 4).toString('base64url') } }));
  assert.throws(() => validateSubscription({ ...valid, keys: { ...valid.keys, auth: 'invalid' } }));
});

test('AES-GCM subscription storage hides endpoints and authenticates ciphertext', () => {
  const sub = subscription('sensitive-endpoint');
  const encrypted = encryptSubscription(sub, configuration.encryptionKey);
  assert.ok(!encrypted.includes(sub.endpoint));
  assert.ok(!encrypted.includes(sub.keys.auth));
  assert.deepEqual(decryptSubscription(encrypted, configuration.encryptionKey), sub);
  assert.throws(() => decryptSubscription(encrypted, randomBytes(32)));
  const parts = encrypted.split('.');
  const ciphertext = Buffer.from(parts[3], 'base64url');
  ciphertext[0] ^= 1;
  parts[3] = ciphertext.toString('base64url');
  assert.throws(() => decryptSubscription(parts.join('.'), configuration.encryptionKey));
});

test('real web-push encryption and VAPID signing generate an authenticated Apple request', () => {
  const recipient = createECDH('prime256v1');
  const recipientPublic = recipient.generateKeys();
  const auth = randomBytes(16);
  const sub = { endpoint: 'https://web.push.apple.com/actual-format-test', keys: { p256dh: recipientPublic.toString('base64url'), auth: auth.toString('base64url') } };
  const payload = JSON.stringify({ title: '테스트', body: '민감한 금액 없음', url: '/#settings', tag: 'test' });
  const details = webpush.generateRequestDetails(sub, payload, { vapidDetails: configuration, contentEncoding: 'aes128gcm', TTL: 3600 });
  assert.equal(details.method, 'POST');
  assert.equal(details.headers['Content-Encoding'], 'aes128gcm');
  const jwt = /t=([^,\s]+)/.exec(details.headers.Authorization)?.[1];
  assert.ok(jwt);
  const [header, claims, signature] = jwt.split('.');
  const decoded = JSON.parse(Buffer.from(claims, 'base64url').toString());
  assert.equal(decoded.aud, 'https://web.push.apple.com');
  assert.equal(decoded.sub, configuration.subject);
  const vapidPublic = Buffer.from(configuration.publicKey, 'base64url');
  const publicKey = createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: vapidPublic.subarray(1, 33).toString('base64url'), y: vapidPublic.subarray(33).toString('base64url') } });
  assert.equal(verify('sha256', Buffer.from(`${header}.${claims}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')), true);
  assert.ok(details.body);
  const body = details.body;
  const salt = body.subarray(0, 16);
  const senderPublic = body.subarray(21, 21 + body[20]);
  const secret = recipient.computeSecret(senderPublic);
  const info = Buffer.concat([Buffer.from('WebPush: info\0'), recipientPublic, senderPublic]);
  const inputKey = Buffer.from(hkdfSync('sha256', secret, auth, info, 32));
  const contentKey = Buffer.from(hkdfSync('sha256', inputKey, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', inputKey, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const encrypted = body.subarray(21 + senderPublic.length);
  const decipher = createDecipheriv('aes-128-gcm', contentKey, nonce);
  decipher.setAuthTag(encrypted.subarray(-16));
  const plaintext = Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]);
  assert.equal(plaintext.at(-1), 2);
  assert.equal(plaintext.subarray(0, -1).toString(), payload);
});

test('payday, Sunday, and cycle end schedule use KST boundaries and finite catch-up windows', () => {
  const config = createInitialState().config;
  assert.equal(scheduledCandidates(Date.parse('2026-10-24T23:59:59Z'), config).length, 0);
  assert.ok(scheduledCandidates(Date.parse('2026-10-25T00:00:00Z'), config).some(e => e.key === 'payday:2026-10-25'));
  assert.ok(!scheduledCandidates(Date.parse('2026-10-24T10:59:59Z'), config).some(e => e.key.startsWith('cycle-end:')));
  assert.ok(scheduledCandidates(Date.parse('2026-10-24T11:00:00Z'), config).some(e => e.key === 'cycle-end:2026-10-24'));
  assert.deepEqual(scheduledCandidates(Date.parse('2026-10-18T11:00:00Z'), config).map(e => e.key), ['weekly:2026-10-18']);
  assert.deepEqual(scheduledCandidates(Date.parse('2026-10-18T22:59:59Z'), config).map(e => e.key), ['weekly:2026-10-18']);
  assert.equal(scheduledCandidates(Date.parse('2026-10-18T23:00:00Z'), config).length, 0);
  // Seoul uses the same UTC offset across the US daylight-saving transition.
  assert.deepEqual(scheduledCandidates(Date.parse('2026-11-01T11:00:00Z'), config).map(e => e.key), ['weekly:2026-11-01']);
});

test('edited payday controls salary cycle end, including month-end and minute selection', () => {
  const config = createInitialState().config;
  config.salary.payday = 1;
  config.push.cycleEnd.day = 31;
  assert.ok(scheduledCandidates(Date.parse('2026-02-28T11:00:00Z'), config).some(e => e.key === 'cycle-end:2026-02-28'));
  assert.ok(scheduledCandidates(Date.parse('2026-02-28T15:00:00Z'), config).some(e => e.key === 'cycle-end:2026-02-28'));
  config.salary.payday = 5;
  config.push.payday.minute = 45;
  assert.ok(!scheduledCandidates(Date.parse('2026-10-05T00:44:59Z'), config).some(e => e.key.startsWith('payday:')));
  assert.ok(scheduledCandidates(Date.parse('2026-10-05T00:45:00Z'), config).some(e => e.key === 'payday:2026-10-05'));
  assert.ok(scheduledCandidates(Date.parse('2026-10-04T11:00:00Z'), config).some(e => e.key === 'cycle-end:2026-10-04'));
  assert.ok(!scheduledCandidates(Date.parse('2026-10-24T11:00:00Z'), config).some(e => e.key.startsWith('cycle-end:')));
});

test('80% alert sends once per cycle despite edits, recrossing and repeated ticks; zero budget is silent', async context => {
  const f = fixture(context);
  threshold(f.state);
  save(f.database, 'alice', f.state);
  const scheduler = new PushScheduler(f.database, { ...f.options, sender: f.sender });
  await scheduler.tick();
  await scheduler.tick();
  assert.equal(f.received.length, 1);
  assert.ok(!JSON.stringify(f.received).includes('private transaction'));
  assert.ok(!JSON.stringify(f.received).includes('1094400'));
  f.state.expenses = [];
  save(f.database, 'alice', f.state);
  await scheduler.tick();
  threshold(f.state);
  save(f.database, 'alice', f.state);
  await new PushScheduler(f.database, { ...f.options, sender: f.sender }).tick();
  assert.equal(f.received.length, 1);
  f.setTime(Date.parse('2026-10-27T03:00:00Z'));
  f.database.db.prepare('UPDATE users SET last_expense_at=?').run(Date.parse('2026-10-27T03:00:00Z'));
  threshold(f.state, '2026-10-27');
  save(f.database, 'alice', f.state);
  await scheduler.tick();
  assert.equal(f.received.length, 2);
  assert.notEqual(f.received[0].payload.tag, f.received[1].payload.tag);
  f.state.config.allocation.variableBudget = 0;
  f.state.expenses = [];
  save(f.database, 'alice', f.state);
  await scheduler.tick();
  assert.equal(f.received.length, 2);
});

test('state transaction captures a short-lived threshold crossing and rolls back queued events on failure', async context => {
  const f = fixture(context);
  threshold(f.state);
  assert.throws(() => f.database.transaction(() => {
    save(f.database, 'alice', f.state);
    enqueueBudgetAlert(f.database, 'alice', f.state, BASE, true);
    throw new Error('Simulated failed state write');
  }));
  assert.equal(count(f.database, 'push_events'), 0);
  f.database.transaction(() => { save(f.database, 'alice', f.state); enqueueBudgetAlert(f.database, 'alice', f.state, BASE, true); });
  f.state.expenses = [];
  save(f.database, 'alice', f.state);
  await new PushScheduler(f.database, { ...f.options, sender: f.sender }).tick();
  assert.equal(f.received.length, 1);
});

test('inactivity is one reminder per actual recording episode, configurable and reset by new activity', async context => {
  const f = fixture(context);
  const time = Date.parse('2026-10-13T11:00:00Z');
  f.setTime(time);
  f.database.db.prepare('UPDATE users SET created_at=?,last_expense_at=?').run(time - 3 * DAY, time - 3 * DAY);
  const scheduler = new PushScheduler(f.database, { ...f.options, sender: f.sender });
  await scheduler.tick();
  assert.equal(f.received.length, 1);
  f.setTime(time + DAY);
  await scheduler.tick();
  assert.equal(f.received.length, 1);
  f.database.db.prepare('UPDATE users SET last_expense_at=?').run(time + DAY);
  f.state.config.push.inactivityDays = 1;
  save(f.database, 'alice', f.state);
  await scheduler.tick();
  assert.equal(f.received.length, 1);
  f.setTime(time + 2 * DAY);
  await scheduler.tick();
  assert.equal(f.received.length, 2);
  assert.notEqual(f.received[0].payload.tag, f.received[1].payload.tag);
});

test('an inactivity retry is cancelled when the user records a new expense before delivery', async context => {
  const f = fixture(context);
  const time = Date.parse('2026-10-13T11:00:00Z');
  f.setTime(time);
  f.database.db.prepare('UPDATE users SET last_expense_at=?').run(time - 3 * DAY);
  let calls = 0;
  const sender: PushSender = async () => { calls++; throw Object.assign(new Error('temporary failure'), { statusCode: 503 }); };
  const scheduler = new PushScheduler(f.database, { ...f.options, sender });
  await scheduler.tick();
  assert.equal(calls, 1);
  f.database.db.prepare('UPDATE users SET last_expense_at=?').run(time + 1);
  f.setTime(time + 30_000);
  await scheduler.tick();
  assert.equal(calls, 1);
  assert.equal(count(f.database, 'push_deliveries', "WHERE status='cancelled'"), 1);
});

test('inactivity retry is cancelled when edited days or reminder hour make it ineligible', async context => {
  const f = fixture(context);
  const time = Date.parse('2026-10-13T11:00:00Z'); f.setTime(time);
  f.database.db.prepare('UPDATE users SET last_expense_at=?').run(time - 3 * DAY);
  let calls = 0;
  const scheduler = new PushScheduler(f.database, { ...f.options, sender: async () => { calls++; throw Object.assign(new Error('limited'), { statusCode: 429 }); } });
  await scheduler.tick(); assert.equal(calls, 1);
  f.state.config.push.inactivityDays = 30; save(f.database, 'alice', f.state);
  f.setTime(time + 30_000); await scheduler.tick();
  assert.equal(calls, 1); assert.equal(count(f.database, 'push_deliveries', "WHERE status='cancelled'"), 1);
  f.database.db.prepare('DELETE FROM push_events').run();
  f.state.config.push.inactivityDays = 3; f.state.config.push.inactivityHour = 20; save(f.database, 'alice', f.state);
  await scheduler.tick(); assert.equal(calls, 2);
  f.state.config.push.inactivityHour = 22; save(f.database, 'alice', f.state);
  f.setTime(time + 60_000); await scheduler.tick();
  assert.equal(calls, 2); assert.equal(count(f.database, 'push_deliveries', "WHERE status='cancelled'"), 1);
});

test('429 retry respects Retry-After, keeps per-device progress, and uses the original event tag', async context => {
  const f = fixture(context);
  const second = subscription('second');
  storeSubscription(f.database, 'alice', second, configuration, BASE);
  threshold(f.state); save(f.database, 'alice', f.state);
  const calls: { endpoint: string; tag: string }[] = [];
  let rejected = false;
  const sender: PushSender = async (sub, payload) => {
    calls.push({ endpoint: sub.endpoint, tag: payload.tag });
    if (sub.endpoint === f.device.endpoint && !rejected) { rejected = true; throw Object.assign(new Error('rate limited'), { statusCode: 429, headers: { 'retry-after': '120' } }); }
  };
  const scheduler = new PushScheduler(f.database, { ...f.options, sender });
  await scheduler.tick();
  assert.equal(count(f.database, 'push_deliveries', "WHERE status='sent'"), 1);
  assert.equal(count(f.database, 'push_deliveries', "WHERE status='pending'"), 1);
  f.setTime(BASE + 119_999); await scheduler.tick(); assert.equal(calls.length, 2);
  f.setTime(BASE + 120_000); await new PushScheduler(f.database, { ...f.options, sender }).tick();
  assert.equal(calls.length, 3);
  assert.equal(count(f.database, 'push_deliveries', "WHERE status='sent'"), 2);
  assert.equal(calls.filter(call => call.endpoint === second.endpoint).length, 1);
  assert.equal(new Set(calls.map(call => call.tag)).size, 1);
  assert.ok(f.logs.some(log => log.result === 'retry' && log.statusCode === 429));
});

test('network and 5xx errors retry with exponential backoff; permanent errors and max attempts stop', async context => {
  const f = fixture(context);
  threshold(f.state); save(f.database, 'alice', f.state);
  let calls = 0;
  const sender: PushSender = async () => { calls++; if (calls === 1) throw new Error('network unavailable'); throw Object.assign(new Error('service unavailable'), { statusCode: 503 }); };
  const scheduler = new PushScheduler(f.database, { ...f.options, sender });
  await scheduler.tick();
  f.setTime(BASE + 29_999); await scheduler.tick(); assert.equal(calls, 1);
  f.setTime(BASE + 30_000); await scheduler.tick(); assert.equal(calls, 2);
  assert.equal((f.database.db.prepare('SELECT next_attempt_at FROM push_deliveries').get() as { next_attempt_at: number }).next_attempt_at, BASE + 90_000);
  f.database.db.prepare('UPDATE push_deliveries SET attempts=7,next_attempt_at=?').run(BASE + 90_000);
  f.setTime(BASE + 90_000); await scheduler.tick();
  assert.equal(calls, 3);
  assert.equal(count(f.database, 'push_deliveries', "WHERE status='failed'"), 1);
  await scheduler.tick(); assert.equal(calls, 3);
});

test('404 and 410 prune only expired devices while retaining sanitized delivery history', async context => {
  const f = fixture(context);
  storeSubscription(f.database, 'alice', subscription('410'), configuration, BASE);
  threshold(f.state); save(f.database, 'alice', f.state);
  const sender: PushSender = async sub => { throw Object.assign(new Error('expired'), { statusCode: sub.endpoint.endsWith('/410') ? 410 : 404 }); };
  await new PushScheduler(f.database, { ...f.options, sender }).tick();
  assert.equal(count(f.database, 'push_subscriptions'), 0);
  assert.equal(count(f.database, 'push_deliveries', "WHERE status='dead'"), 2);
  assert.equal(count(f.database, 'push_deliveries', 'WHERE subscription_id IS NULL'), 2);
  assert.equal(f.logs.filter(log => log.result === 'expired_subscription').length, 2);
});

test('notification opt out cancels retries and prevents new events; nonretryable HTTP failures stop', async context => {
  const f = fixture(context);
  threshold(f.state); save(f.database, 'alice', f.state);
  let calls = 0;
  const sender: PushSender = async () => { calls++; throw Object.assign(new Error('limited'), { statusCode: 429 }); };
  const scheduler = new PushScheduler(f.database, { ...f.options, sender });
  await scheduler.tick();
  f.state.config.push.enabled = false; save(f.database, 'alice', f.state);
  f.setTime(BASE + 30_000); await scheduler.tick();
  assert.equal(calls, 1);
  assert.equal(count(f.database, 'push_deliveries', "WHERE status='cancelled'"), 1);
  f.state.config.push.enabled = true; save(f.database, 'alice', f.state);
  f.database.db.prepare('DELETE FROM push_events').run();
  await new PushScheduler(f.database, { ...f.options, sender: async () => { throw Object.assign(new Error('forbidden'), { statusCode: 403 }); } }).tick();
  assert.equal(count(f.database, 'push_deliveries', "WHERE status='failed'"), 1);
});

test('scheduler persists sent events through real database reopen and recovers stale leases', async context => {
  const directory = mkdtempSync(join(tmpdir(), 'salary-push-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'db.sqlite');
  let database = new AppDatabase(path);
  initializePushSchema(database.db);
  const state = insertUser(database, 'alice'); threshold(state); save(database, 'alice', state);
  storeSubscription(database, 'alice', subscription(), configuration, BASE);
  let calls = 0;
  const options = { configuration, now: () => BASE, sender: async () => { calls++; }, log: () => {} };
  await new PushScheduler(database, options).tick();
  database.close();
  database = new AppDatabase(path);
  await new PushScheduler(database, options).tick();
  assert.equal(calls, 1);
  database.db.prepare("UPDATE push_deliveries SET status='sending', lease_until=?, attempts=1").run(BASE - 1);
  await new PushScheduler(database, options).tick();
  assert.equal(calls, 2);
  assert.equal((database.db.prepare('SELECT attempts FROM push_deliveries').get() as { attempts: number }).attempts, 2);
  await new PushScheduler(database, options).tick(); assert.equal(calls, 2);
  database.close();
});

test('atomic claims prevent two simultaneous workers from sending the same active delivery', async context => {
  const directory = mkdtempSync(join(tmpdir(), 'salary-push-workers-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'db.sqlite');
  const firstDatabase = new AppDatabase(path);
  const secondDatabase = new AppDatabase(path);
  context.after(() => { firstDatabase.close(); secondDatabase.close(); });
  initializePushSchema(firstDatabase.db);
  const state = insertUser(firstDatabase, 'alice');
  threshold(state); save(firstDatabase, 'alice', state);
  storeSubscription(firstDatabase, 'alice', subscription(), configuration, BASE);
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const sender: PushSender = async () => { calls++; await gate; };
  const options = { configuration, now: () => BASE, log: () => {}, sender };
  const first = new PushScheduler(firstDatabase, options).tick();
  await new PushScheduler(secondDatabase, options).tick();
  assert.equal(calls, 1);
  release(); await first;
  assert.equal(count(firstDatabase, 'push_deliveries', "WHERE status='sent'"), 1);
});

test('expired lease responses cannot overwrite a newer claim and event tags remain stable', async context => {
  const f = fixture(context);
  threshold(f.state); save(f.database, 'alice', f.state);
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  let firstTag = '';
  let secondTag = '';
  const original = new PushScheduler(f.database, { ...f.options, sender: async (_sub, payload) => { firstTag = payload.tag; await gate; throw Object.assign(new Error('old failure'), { statusCode: 410 }); } }).tick();
  f.setTime(BASE + 60_001);
  await new PushScheduler(f.database, { ...f.options, sender: async (_sub, payload) => { secondTag = payload.tag; } }).tick();
  release(); await original;
  assert.equal(firstTag, secondTag);
  assert.equal(count(f.database, 'push_subscriptions'), 1);
  assert.equal(count(f.database, 'push_deliveries', "WHERE status='sent'"), 1);
  assert.equal((f.database.db.prepare('SELECT attempts FROM push_deliveries').get() as { attempts: number }).attempts, 2);
});

test('expired events are cancelled instead of sending stale reminders and stop finishes only current work', async context => {
  const f = fixture(context);
  threshold(f.state); save(f.database, 'alice', f.state);
  enqueueBudgetAlert(f.database, 'alice', f.state, BASE);
  f.database.db.prepare('UPDATE push_events SET expires_at=?').run(BASE - 1);
  const scheduler = new PushScheduler(f.database, { ...f.options, sender: f.sender });
  await scheduler.tick();
  assert.equal(f.received.length, 0);
  assert.equal(count(f.database, 'push_deliveries', "WHERE status='cancelled'"), 1);
  f.database.db.prepare('DELETE FROM push_events').run();
  storeSubscription(f.database, 'alice', subscription('second'), configuration, BASE);
  const stopping = new PushScheduler(f.database, { ...f.options, sender: async (_sub, payload) => { f.received.push({ device: f.device, payload }); stopping.stop(); } });
  await stopping.tick();
  assert.equal(f.received.length, 1);
  assert.equal(count(f.database, 'push_deliveries', "WHERE status='pending'"), 1);
  await stopping.tick();
  assert.equal(f.received.length, 1);
});

test('authenticated push APIs isolate accounts, hide encrypted data, support device transfer and all-device opt out', async context => {
  const f = fixture(context);
  insertUser(f.database, 'bob');
  const app = express(); app.use(express.json());
  registerPushRoutes(app, f.database, (req, res, next) => {
    const id = req.header('X-Test-User');
    if (!id || !f.database.db.prepare('SELECT id FROM users WHERE id=?').get(id)) { res.status(401).json({ error: '인증 필요' }); return; }
    res.locals.user = { id }; next();
  }, { configuration, now: () => BASE });
  await request(app).get('/api/push/status').expect(401);
  const bobStatus = await request(app).get('/api/push/status').set('X-Test-User', 'bob').expect(200);
  assert.equal(bobStatus.body.deviceCount, 0);
  const status = await request(app).get('/api/push/status').set('X-Test-User', 'alice').expect(200);
  assert.deepEqual(status.body, { configured: true, publicKey: configuration.publicKey, subscribed: true, deviceCount: 1 });
  assert.ok(!JSON.stringify(status.body).includes(f.device.keys.auth));
  assert.ok(!JSON.stringify(status.body).includes(configuration.privateKey));
  assert.ok(!JSON.stringify(status.body).includes(f.device.endpoint));
  await request(app).post('/api/push/subscribe').set('X-Test-User', 'bob').send({ subscription: { ...f.device, endpoint: 'https://localhost/steal' } }).expect(400);
  await request(app).post('/api/push/unsubscribe').set('X-Test-User', 'bob').send({ endpoint: f.device.endpoint }).expect(200);
  assert.equal(count(f.database, 'push_subscriptions'), 1);
  await request(app).post('/api/push/test').set('X-Test-User', 'bob').expect(409);
  await request(app).post('/api/push/test').set('X-Test-User', 'alice').expect(202);
  assert.equal(count(f.database, 'push_events'), 1);
  await request(app).post('/api/push/subscribe').set('X-Test-User', 'bob').send({ subscription: f.device }).expect(201);
  assert.equal(count(f.database, 'push_subscriptions', "WHERE user_id='alice'"), 0);
  assert.equal(count(f.database, 'push_subscriptions', "WHERE user_id='bob'"), 1);
  assert.equal(count(f.database, 'push_deliveries', "WHERE status='cancelled'"), 1);
  await request(app).post('/api/push/unsubscribe').set('X-Test-User', 'bob').send({ all: true }).expect(200);
  assert.equal(count(f.database, 'push_subscriptions'), 0);
  const row = f.database.db.prepare('SELECT payload FROM push_events').get() as { payload: string };
  assert.ok(!row.payload.includes('private transaction'));
});

test('test-push throttling survives scheduler replacement and unconfigured routes remain explicit', async context => {
  const f = fixture(context);
  const app = express(); app.use(express.json());
  registerPushRoutes(app, f.database, (_req, res, next) => { res.locals.user = { id: 'alice' }; next(); }, { configuration, now: () => BASE });
  for (let i = 0; i < 5; i++) await request(app).post('/api/push/test').expect(202);
  const rateLimited = await request(app).post('/api/push/test').expect(429);
  assert.equal(rateLimited.headers['retry-after'], '60');
  assert.equal(count(f.database, 'push_events'), 5);
  const unconfigured = express(); unconfigured.use(express.json());
  registerPushRoutes(unconfigured, f.database, (_req, res, next) => { res.locals.user = { id: 'alice' }; next(); }, { configuration: null });
  const status = await request(unconfigured).get('/api/push/status').expect(200);
  assert.equal(status.body.configured, false); assert.equal(status.body.publicKey, null);
  await request(unconfigured).post('/api/push/subscribe').send({ subscription: f.device }).expect(503);
  await request(unconfigured).post('/api/push/test').expect(503);
});

test('temporary budget threshold excludes existing expenses and deduplicates its own 80% alert', context => {
  const f = fixture(context);
  f.state.bridgeBudget = { id: 'before-payday', amount: 550000, startDate: '2026-10-13', endDate: '2026-10-24', excludedExpenseIds: ['old'] };
  f.state.expenses = [{ id: 'old', category: 'food', amount: 900000, date: '2026-10-13', note: '', emotion: '', createdAt: new Date(BASE).toISOString() }];
  assert.equal(enqueueBudgetAlert(f.database, 'alice', f.state, BASE), false);
  f.state.expenses.push({ ...f.state.expenses[0], id: 'new', amount: 440000 });
  assert.equal(enqueueBudgetAlert(f.database, 'alice', f.state, BASE), true);
  assert.equal(enqueueBudgetAlert(f.database, 'alice', f.state, BASE), false);
});

test('recurring payments never trigger the variable budget threshold notification', context => {
  const f = fixture(context);
  f.state.config.categories.push({ id: 'regular', name: '정기지출', budget: 0, kind: 'regular' });
  f.state.expenses = [{ id: 'bill', category: 'regular', amount: 1500000, date: '2026-10-13', note: '', emotion: '', createdAt: new Date(BASE).toISOString() }];
  assert.equal(enqueueBudgetAlert(f.database, 'alice', f.state, BASE), false);
  f.state.expenses.push({ ...f.state.expenses[0], id: 'living', category: 'food', amount: 1094400 });
  assert.equal(enqueueBudgetAlert(f.database, 'alice', f.state, BASE), true);
});
