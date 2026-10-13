import assert from 'node:assert/strict';
import { createECDH, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { CloudClient, cloudflareFixture } from './cloudflare-fixture';
import { createInitialState, kstDate } from '../shared/domain';
import type { StateResponse, User } from '../shared/types';

const password = 'a-safe-test-password-123';
const auth = (email: string) => ({ email, password });

test('Cloudflare Worker registration uses native secure password derivation and secure account sessions', async context => {
  const { mf, db } = await cloudflareFixture(context);
  const client = new CloudClient(mf);
  assert.equal((await client.fetch('/api/health')).response.status, 200);
  assert.equal((await client.fetch('/api/state')).response.status, 401);
  const registered = await client.fetch('/api/auth/register', auth(' ALICE@example.com '));
  assert.equal(registered.response.status, 201);
  assert.deepEqual((registered.data.user as User).email, 'alice@example.com');
  assert.match(registered.response.headers.get('Set-Cookie')!, /HttpOnly/);
  assert.match(registered.response.headers.get('Set-Cookie')!, /Secure/);
  const row = await db.prepare('SELECT password_hash FROM users').first<{ password_hash: string }>();
  assert.match(row!.password_hash, /^scrypt:[A-Za-z0-9_-]{22}:/);
  assert.ok(!row!.password_hash.includes(password));
  const storedSession = await db.prepare('SELECT hash FROM sessions').first<{ hash: string }>();
  assert.match(storedSession!.hash, /^[a-f0-9]{64}$/);
  assert.ok(!client.cookie.includes(storedSession!.hash));
  assert.equal((await client.fetch('/api/auth/me')).response.status, 200);
  const state = await client.fetch('/api/state');
  assert.equal(state.response.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(state.data, { state: createInitialState(), revision: 0 });
  assert.equal((await client.fetch('/api/auth/register', auth('alice@example.com'))).response.status, 409);
  assert.equal((await client.fetch('/api/auth/logout', {})).response.status, 200);
  assert.equal((await client.fetch('/api/state')).response.status, 401);
  assert.equal((await client.fetch('/api/auth/login', { email: 'alice@example.com', password: 'wrong-password-123' })).response.status, 401);
  assert.equal((await client.fetch('/api/auth/login', auth('alice@example.com'))).response.status, 200);
  await db.prepare('UPDATE sessions SET expires_at=0').run();
  assert.equal((await client.fetch('/api/state')).response.status, 401);
});

test('Cloudflare API rejects cross-origin mutations, invalid JSON and weak credentials', async context => {
  const { mf } = await cloudflareFixture(context);
  const missing = await mf.dispatchFetch('https://app.example/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(auth('alice@example.com')),
  });
  assert.equal(missing.status, 403);
  const client = new CloudClient(mf);
  assert.equal((await client.fetch('/api/auth/register', auth('alice@example.com'), 'POST', { Origin: 'https://attacker.example' })).response.status, 403);
  assert.equal((await client.fetch('/api/auth/register', { email: 'alice@example.com', password: 'short' })).response.status, 400);
  const malformed = await mf.dispatchFetch('https://app.example/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'salary-guardians' }, body: '{broken',
  });
  assert.equal(malformed.status, 400);
  assert.equal((await client.fetch('/api/auth/register', auth('alice@example.com'), 'POST', { Origin: 'https://app.example' })).response.status, 201);
});

test('Cloudflare D1 state writes isolate users, enforce server timestamps and compare-and-swap revisions', async context => {
  const { mf, db } = await cloudflareFixture(context);
  const alice = new CloudClient(mf, '192.0.2.1');
  const bob = new CloudClient(mf, '192.0.2.2');
  const aliceUser = (await alice.fetch('/api/auth/register', auth('alice@example.com'))).data.user as User;
  const bobUser = (await bob.fetch('/api/auth/register', auth('bob@example.com'))).data.user as User;
  const state = createInitialState();
  state.expenses.push({ id: 'private-expense', amount: 5_000, date: kstDate(), category: 'food', note: 'alice-private-note', emotion: '', createdAt: '2020-01-01T00:00:00.000Z' });
  const saved = await alice.fetch('/api/state', { userId: aliceUser.id, state, revision: 0 }, 'PUT');
  assert.equal(saved.response.status, 200);
  const current = saved.data as unknown as StateResponse;
  assert.equal(current.revision, 1);
  assert.notEqual(current.state.expenses[0].createdAt, '2020-01-01T00:00:00.000Z');
  const activity = await db.prepare('SELECT last_expense_at FROM users WHERE id=?').bind(aliceUser.id).first<{ last_expense_at: number }>();
  assert.ok(activity!.last_expense_at > Date.now() - 10_000);
  assert.equal((await alice.fetch('/api/state', { state: current.state, revision: 0 }, 'PUT')).response.status, 409);
  const changed = structuredClone(current.state); changed.expenses[0].createdAt = '2021-01-01T00:00:00.000Z';
  assert.equal((await alice.fetch('/api/state', { state: changed, revision: 1 }, 'PUT')).response.status, 400);
  assert.equal((await bob.fetch('/api/state', { userId: aliceUser.id, state, revision: 0 }, 'PUT')).response.status, 403);
  const exported = await bob.fetch(`/api/export?userId=${aliceUser.id}`);
  assert.equal((exported.data.user as User).id, bobUser.id);
  assert.ok(!JSON.stringify(exported.data).includes('alice-private-note'));
  const bobState = (await bob.fetch('/api/state')).data as unknown as StateResponse;
  assert.equal(bobState.state.expenses.length, 0);
  const left = structuredClone(current.state); left.preferences.nagIntensity = 'normal';
  const right = structuredClone(current.state); right.preferences.nagIntensity = 'firm';
  const raced = await Promise.all([
    alice.fetch('/api/state', { state: left, revision: 1 }, 'PUT'),
    alice.fetch('/api/state', { state: right, revision: 1 }, 'PUT'),
  ]);
  assert.deepEqual(raced.map(item => item.response.status).sort(), [200, 409]);
  assert.equal(((await alice.fetch('/api/state')).data as unknown as StateResponse).revision, 2);
});

test('Cloudflare account deletion confirms password and cascades financial and push records', async context => {
  const { mf, db } = await cloudflareFixture(context);
  const client = new CloudClient(mf);
  const user = (await client.fetch('/api/auth/register', auth('alice@example.com'))).data.user as User;
  await db.batch([
    db.prepare('INSERT INTO push_subscriptions(id,user_id,endpoint_hash,encrypted,created_at,updated_at) VALUES(?,?,?,?,?,?)')
      .bind('device', user.id, 'endpoint-hash', 'opaque-encrypted-subscription', Date.now(), Date.now()),
    db.prepare('INSERT INTO push_events(id,user_id,event_key,payload,created_at,expires_at) VALUES(?,?,?,?,?,?)')
      .bind('event', user.id, 'test:event', '{}', Date.now(), Date.now() + 60_000),
    db.prepare('INSERT INTO push_deliveries(id,event_id,subscription_id,next_attempt_at) VALUES(?,?,?,?)')
      .bind('delivery', 'event', 'device', Date.now()),
  ]);
  assert.equal((await client.fetch('/api/account', { password: 'wrong-password-123' }, 'DELETE')).response.status, 401);
  assert.equal((await client.fetch('/api/account', { password }, 'DELETE')).response.status, 200);
  assert.equal((await client.fetch('/api/state')).response.status, 401);
  for (const table of ['users', 'sessions', 'states', 'push_subscriptions', 'push_events', 'push_deliveries']) {
    const row = await db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{ count: number }>();
    assert.equal(row!.count, 0);
  }
});

test('Cloudflare auth abuse caps persist atomically despite parallel requests and forged XFF values', async context => {
  const { mf, db } = await cloudflareFixture(context);
  const client = new CloudClient(mf);
  const attempts = await Promise.all(Array.from({ length: 35 }, (_, index) =>
    client.fetch('/api/auth/login', { email: 'invalid', password: 'short' }, 'POST', { 'X-Forwarded-For': `192.0.2.${index}` })));
  assert.equal(attempts.filter(item => item.response.status === 400).length, 30);
  assert.equal(attempts.filter(item => item.response.status === 429).length, 5);
  const row = await db.prepare('SELECT key,count FROM rate_limits').first<{ key: string; count: number }>();
  assert.equal(row!.count, 30);
  assert.ok(!row!.key.includes('192.0.2.1'));
});

test('Cloudflare cannot enable push without server keys', async context => {
  const { mf } = await cloudflareFixture(context);
  const client = new CloudClient(mf);
  await client.fetch('/api/auth/register', auth('alice@example.com'));
  const state = createInitialState(); state.config.push.enabled = true;
  assert.equal((await client.fetch('/api/state', { state, revision: 0 }, 'PUT')).response.status, 503);
  assert.equal((await client.fetch('/api/push/status')).data.configured, false);
  assert.equal((await client.fetch('/api/push/subscribe', { subscription: {} })).response.status, 503);
  assert.equal(((await client.fetch('/api/state')).data as unknown as StateResponse).revision, 0);
});

test('Cloudflare API encrypts device subscriptions and captures threshold events in the state transaction', async context => {
  const vapid = createECDH('prime256v1');
  const publicKey = vapid.generateKeys().toString('base64url');
  const { mf, db } = await cloudflareFixture(context, {
    VAPID_PUBLIC_KEY: publicKey,
    VAPID_PRIVATE_KEY: vapid.getPrivateKey().toString('base64url'),
    VAPID_SUBJECT: 'mailto:owner@example.com',
    DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  });
  const client = new CloudClient(mf);
  const user = (await client.fetch('/api/auth/register', auth('alice@example.com'))).data.user as User;
  const device = createECDH('prime256v1');
  const subscription = { endpoint: 'https://web.push.apple.com/device', keys: {
    p256dh: device.generateKeys().toString('base64url'), auth: randomBytes(16).toString('base64url'),
  } };
  const subscribed = await client.fetch('/api/push/subscribe', { subscription });
  assert.equal(subscribed.response.status, 201);
  const stored = await db.prepare('SELECT encrypted FROM push_subscriptions').first<{ encrypted: string }>();
  assert.ok(!stored!.encrypted.includes(subscription.endpoint));
  assert.ok(!stored!.encrypted.includes(subscription.keys.auth));
  const state = createInitialState(); state.config.push.enabled = true;
  state.expenses.push({ id: 'threshold', amount: 1_094_400, date: kstDate(), category: 'food', note: 'private-transaction', emotion: '', createdAt: new Date().toISOString() });
  const crossing = await client.fetch('/api/state', { userId: user.id, state, revision: 0 }, 'PUT');
  assert.equal(crossing.response.status, 200);
  const after = crossing.data as unknown as StateResponse;
  after.state.expenses = [];
  assert.equal((await client.fetch('/api/state', after, 'PUT')).response.status, 200);
  const events = await db.prepare("SELECT payload FROM push_events WHERE event_key LIKE 'budget:%'").all<{ payload: string }>();
  assert.equal(events.results.length, 1);
  assert.ok(!events.results[0].payload.includes('private-transaction'));
  const pending = await db.prepare("SELECT COUNT(*) AS count FROM push_deliveries WHERE status='pending'").first<{ count: number }>();
  assert.equal(pending!.count, 1);
  const status = await client.fetch('/api/push/status');
  assert.equal(status.data.configured, true);
  assert.equal(status.data.deviceCount, 1);
  assert.ok(!JSON.stringify(status.data).includes(subscription.endpoint));

  // A losing concurrent update must never change activity or queue its threshold event.
  const bob = new CloudClient(mf, '192.0.2.2');
  const bobUser = (await bob.fetch('/api/auth/register', auth('bob@example.com'))).data.user as User;
  const otherDevice = createECDH('prime256v1');
  await bob.fetch('/api/push/subscribe', { subscription: { endpoint: 'https://web.push.apple.com/other-device', keys: {
    p256dh: otherDevice.generateKeys().toString('base64url'), auth: randomBytes(16).toString('base64url'),
  } } });
  await db.prepare('UPDATE users SET last_expense_at=0 WHERE id=?').bind(bobUser.id).run();
  const quiet = createInitialState(); quiet.config.push.enabled = true;
  const racing = await Promise.all([
    bob.fetch('/api/state', { state: quiet, revision: 0 }, 'PUT'),
    bob.fetch('/api/state', { state, revision: 0 }, 'PUT'),
  ]);
  assert.deepEqual(racing.map(item => item.response.status).sort(), [200, 409]);
  const winner = racing[1].response.status === 200;
  const bobEvents = await db.prepare('SELECT COUNT(*) AS count FROM push_events WHERE user_id=?').bind(bobUser.id).first<{ count: number }>();
  const activity = await db.prepare('SELECT last_expense_at FROM users WHERE id=?').bind(bobUser.id).first<{ last_expense_at: number }>();
  assert.equal(bobEvents!.count, winner ? 1 : 0);
  assert.equal(activity!.last_expense_at > 0, winner);
});
