import assert from 'node:assert/strict';
import { createECDH, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import request from 'supertest';
import { createApp } from '../server/app.js';
import { AppDatabase } from '../server/db.js';
import { createInitialState, kstDate } from '../shared/domain.js';
import type { AppState } from '../shared/types.js';

const header = { 'X-Requested-With': 'salary-guardians' };
const password = 'a-safe-test-password-123';

function fixture(options: Parameters<typeof createApp>[0] = {}) {
  const database = new AppDatabase(':memory:');
  const app = createApp({ database, sessionSecret: 'test-secret-at-least-32-bytes-long', enableRateLimits: false, ...options });
  return { database, app, client: request.agent(app) };
}

test('registration protects browser mutations, normalizes email, and hashes passwords and sessions', async (context) => {
  const { database, app, client } = fixture();
  context.after(() => database.close());
  await request(app).get('/api/health').expect(200, { ok: true });
  await client.get('/api/state').expect(401);
  await client.post('/api/auth/register').send({ email: 'alice@example.com', password }).expect(403);
  await client.post('/api/auth/register').set(header).set('Origin', 'https://attacker.example')
    .send({ email: 'alice@example.com', password }).expect(403);
  const registered = await client.post('/api/auth/register').set(header).set('Origin', 'http://localhost:5173')
    .send({ email: ' ALICE@example.com ', password }).expect(201);
  assert.equal(registered.body.user.email, 'alice@example.com');
  assert.equal(typeof registered.body.user.id, 'string');
  const cookies = registered.headers['set-cookie'] as unknown as string[];
  assert.match(cookies[0], /HttpOnly/);
  assert.match(cookies[0], /SameSite=Lax/);
  const stored = database.db.prepare('SELECT password_hash FROM users').get() as { password_hash: string };
  assert.match(stored.password_hash, /^scrypt:/);
  assert.ok(!stored.password_hash.includes(password));
  const session = database.db.prepare('SELECT hash FROM sessions').get() as { hash: string };
  assert.match(session.hash, /^[a-f0-9]{64}$/);
  assert.ok(!cookies[0].includes(session.hash));
  const me = await client.get('/api/auth/me').expect(200);
  assert.deepEqual(me.body.user, registered.body.user);
  const initial = await client.get('/api/state').expect(200);
  assert.deepEqual(initial.body, { state: createInitialState(), revision: 0 });
  assert.equal(initial.headers['cache-control'], 'no-store');
});

test('authentication rejects bad credentials, revokes logout, and expires sessions', async (context) => {
  const { database, client } = fixture();
  context.after(() => database.close());
  await client.post('/api/auth/register').set(header).send({ email: 'alice@example.com', password: 'short' }).expect(400);
  await client.post('/api/auth/register').set(header).send({ email: 'alice@example.com', password }).expect(201);
  await client.post('/api/auth/register').set(header).send({ email: 'alice@example.com', password }).expect(409);
  await client.post('/api/auth/logout').set(header).expect(200);
  await client.get('/api/state').expect(401);
  await client.post('/api/auth/login').set(header).send({ email: 'alice@example.com', password: 'wrong-password123' }).expect(401);
  await client.post('/api/auth/login').set(header).send({ email: 'missing@example.com', password }).expect(401);
  await client.post('/api/auth/login').set(header).send({ email: 'alice@example.com', password }).expect(200);
  database.db.prepare('UPDATE sessions SET expires_at = 0').run();
  await client.get('/api/auth/me').expect(401);
});

test('state writes validate money and revisions and timestamp new records on the server', async (context) => {
  const { database, client } = fixture();
  context.after(() => database.close());
  const registered = await client.post('/api/auth/register').set(header).send({ email: 'alice@example.com', password }).expect(201);
  const state = createInitialState();
  state.expenses.push({ id: 'expense-1', amount: 5_000, date: '2026-10-13', category: 'food', note: '점심', emotion: '', createdAt: '2020-01-01T00:00:00.000Z' });
  const saved = await client.put('/api/state').set(header).send({ state, revision: 0 }).expect(200);
  assert.equal(saved.body.revision, 1);
  assert.equal(saved.body.state.expenses[0].amount, 5_000);
  assert.notEqual(saved.body.state.expenses[0].createdAt, '2020-01-01T00:00:00.000Z');
  const activity = database.db.prepare('SELECT last_expense_at FROM users WHERE id = ?').get(registered.body.user.id) as { last_expense_at: number };
  assert.ok(activity.last_expense_at > Date.now() - 5000);
  await client.put('/api/state').set(header).send({ state: saved.body.state, revision: 0 }).expect(409);
  await client.put('/api/state').set(header).send({ state: saved.body.state, revision: -1 }).expect(400);
  const invalid = structuredClone(saved.body.state) as AppState;
  invalid.expenses[0].amount = 0.5;
  await client.put('/api/state').set(header).send({ state: invalid, revision: 1 }).expect(400);
  invalid.expenses[0].amount = -5;
  await client.put('/api/state').set(header).send({ state: invalid, revision: 1 }).expect(400);
  const changedTimestamp = structuredClone(saved.body.state) as AppState;
  changedTimestamp.expenses[0].createdAt = '2021-01-01T00:00:00.000Z';
  await client.put('/api/state').set(header).send({ state: changedTimestamp, revision: 1 }).expect(400);
  database.db.prepare('UPDATE users SET last_expense_at = 100 WHERE id = ?').run(registered.body.user.id);
  const edited = structuredClone(saved.body.state) as AppState;
  edited.expenses[0].note = '수정';
  await client.put('/api/state').set(header).send({ state: edited, revision: 1 }).expect(200);
  assert.equal((database.db.prepare('SELECT last_expense_at FROM users WHERE id = ?').get(registered.body.user.id) as { last_expense_at: number }).last_expense_at, 100);
});

test('users cannot read or overwrite another user state or export', async (context) => {
  const { database, app, client: alice } = fixture();
  context.after(() => database.close());
  const bob = request.agent(app);
  const aliceRegistration = await alice.post('/api/auth/register').set(header).send({ email: 'alice@example.com', password }).expect(201);
  await bob.post('/api/auth/register').set(header).send({ email: 'bob@example.com', password }).expect(201);
  const privateState = createInitialState();
  privateState.expenses.push({ id: 'private', amount: 7_000, date: '2026-10-13', category: 'cafe', note: 'alice-only-secret', emotion: '', createdAt: new Date().toISOString() });
  await alice.put('/api/state').set(header).send({ state: privateState, revision: 0 }).expect(200);
  const bobState = await bob.get(`/api/state?userId=${aliceRegistration.body.user.id}`).expect(200);
  assert.equal(bobState.body.state.expenses.length, 0);
  const exported = await bob.get(`/api/export?userId=${aliceRegistration.body.user.id}`).expect(200);
  assert.equal(exported.body.user.email, 'bob@example.com');
  assert.ok(!JSON.stringify(exported.body).includes('alice-only-secret'));
  bobState.body.state.preferences.nagIntensity = 'gentle';
  await bob.put('/api/state').set(header).send({ ...bobState.body, userId: aliceRegistration.body.user.id }).expect(403);
  await bob.put('/api/state').set(header).send(bobState.body).expect(200);
  const aliceState = await alice.get('/api/state').expect(200);
  assert.equal(aliceState.body.state.expenses[0].note, 'alice-only-secret');
  assert.equal(aliceState.body.revision, 1);
});

test('a queued state snapshot cannot switch accounts when the session cookie changes', async (context) => {
  const { database, app, client: alice } = fixture();
  context.after(() => database.close());
  const bob = request.agent(app);
  const aliceRegistration = await alice.post('/api/auth/register').set(header).send({ email: 'alice@example.com', password }).expect(201);
  const bobRegistration = await bob.post('/api/auth/register').set(header).send({ email: 'bob@example.com', password }).expect(201);
  const queuedState = createInitialState();
  queuedState.expenses.push({ id: 'private', amount: 1_000, date: kstDate(), category: 'food', note: 'alice-private-data', emotion: '', createdAt: new Date().toISOString() });
  await bob.put('/api/state').set(header).send({ userId: aliceRegistration.body.user.id, state: queuedState, revision: 0 }).expect(403);
  const stillBob = await bob.get('/api/state').expect(200);
  assert.equal(stillBob.body.revision, 0);
  assert.equal(stillBob.body.state.expenses.length, 0);
  await bob.put('/api/state').set(header).send({ userId: bobRegistration.body.user.id, ...stillBob.body }).expect(200);
});

test('account deletion requires the password and cascades private state and sessions', async (context) => {
  const { database, client } = fixture();
  context.after(() => database.close());
  const registered = await client.post('/api/auth/register').set(header).send({ email: 'alice@example.com', password }).expect(201);
  const userId = registered.body.user.id as string;
  database.db.prepare('INSERT INTO push_subscriptions(id,user_id,endpoint_hash,encrypted,created_at,updated_at) VALUES(?,?,?,?,?,?)')
    .run('device', userId, 'endpoint-hash', 'opaque-encrypted-subscription', Date.now(), Date.now());
  database.db.prepare('INSERT INTO push_events(id,user_id,event_key,payload,created_at,expires_at) VALUES(?,?,?,?,?,?)')
    .run('event', userId, 'test:event', '{}', Date.now(), Date.now() + 60_000);
  database.db.prepare('INSERT INTO push_deliveries(id,event_id,subscription_id,next_attempt_at) VALUES(?,?,?,?)')
    .run('delivery', 'event', 'device', Date.now());
  await client.delete('/api/account').set(header).send({ password: 'wrong-password123' }).expect(401);
  await client.get('/api/state').expect(200);
  await client.delete('/api/account').set(header).send({ password }).expect(200);
  await client.get('/api/auth/me').expect(401);
  for (const table of ['users', 'sessions', 'states', 'push_subscriptions', 'push_events', 'push_deliveries']) {
    assert.equal((database.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count, 0);
  }
});

test('simultaneous writes to the same revision commit once and return one explicit conflict', async (context) => {
  const { database, client } = fixture();
  context.after(() => database.close());
  await client.post('/api/auth/register').set(header).send({ email: 'alice@example.com', password }).expect(201);
  const left = createInitialState();
  const right = createInitialState();
  left.preferences.nagIntensity = 'normal';
  right.preferences.nagIntensity = 'firm';
  const responses = await Promise.all([
    client.put('/api/state').set(header).send({ state: left, revision: 0 }),
    client.put('/api/state').set(header).send({ state: right, revision: 0 }),
  ]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  const persisted = await client.get('/api/state').expect(200);
  const winner = responses.find((response) => response.status === 200)!;
  assert.equal(persisted.body.revision, 1);
  assert.equal(persisted.body.state.preferences.nagIntensity, winner.body.state.preferences.nagIntensity);
});

test('the first 80 percent crossing is queued atomically even if the expense is immediately removed', async (context) => {
  const vapid = createECDH('prime256v1');
  const publicKey = vapid.generateKeys().toString('base64url');
  const { database, client } = fixture({ pushConfiguration: {
    publicKey, privateKey: vapid.getPrivateKey().toString('base64url'), subject: 'mailto:owner@example.com', encryptionKey: randomBytes(32),
  } });
  context.after(() => database.close());
  await client.post('/api/auth/register').set(header).send({ email: 'alice@example.com', password }).expect(201);
  const device = createECDH('prime256v1');
  const subscription = {
    endpoint: 'https://web.push.apple.com/test-device',
    keys: { p256dh: device.generateKeys().toString('base64url'), auth: randomBytes(16).toString('base64url') },
  };
  await client.post('/api/push/subscribe').set(header).send({ subscription }).expect(201);
  const encrypted = database.db.prepare('SELECT encrypted FROM push_subscriptions').get() as { encrypted: string };
  assert.ok(!encrypted.encrypted.includes(subscription.endpoint));
  assert.ok(!encrypted.encrypted.includes(subscription.keys.auth));
  const state = createInitialState();
  state.config.push.enabled = true;
  state.expenses.push({ id: 'threshold', amount: 1_094_400, date: kstDate(), category: 'food', note: 'private detail', emotion: '', createdAt: new Date().toISOString() });
  const crossed = await client.put('/api/state').set(header).send({ state, revision: 0 }).expect(200);
  crossed.body.state.expenses = [];
  await client.put('/api/state').set(header).send({ state: crossed.body.state, revision: 1 }).expect(200);
  const events = database.db.prepare("SELECT payload FROM push_events WHERE event_key LIKE 'budget:%'").all() as { payload: string }[];
  assert.equal(events.length, 1);
  assert.ok(!events[0].payload.includes('private detail'));
  assert.equal((database.db.prepare("SELECT COUNT(*) AS count FROM push_deliveries WHERE status = 'pending'").get() as { count: number }).count, 1);
});

test('push cannot be enabled when server keys are unconfigured', async (context) => {
  const { database, client } = fixture({ pushConfiguration: null });
  context.after(() => database.close());
  await client.post('/api/auth/register').set(header).send({ email: 'alice@example.com', password }).expect(201);
  const state = createInitialState();
  state.config.push.enabled = true;
  await client.put('/api/state').set(header).send({ state, revision: 0 }).expect(503);
  const persisted = await client.get('/api/state').expect(200);
  assert.equal(persisted.body.state.config.push.enabled, false);
  assert.equal(persisted.body.revision, 0);
  await client.post('/api/push/subscribe').set(header).send({ subscription: {} }).expect(503);
});

test('production requires HTTPS and a strong session secret and sets Secure cookies', async (context) => {
  const database = new AppDatabase(':memory:');
  context.after(() => database.close());
  assert.throws(() => createApp({ database, production: true, sessionSecret: 'short', publicOrigin: 'https://app.example' }), /SESSION_SECRET/);
  assert.throws(() => createApp({ database, production: true, sessionSecret: 'a'.repeat(32), publicOrigin: 'http://app.example' }), /HTTPS/);
  const app = createApp({ database, production: true, sessionSecret: 'a'.repeat(32), publicOrigin: 'https://app.example' });
  const response = await request(app).post('/api/auth/register').set(header).set('Origin', 'https://app.example')
    .send({ email: 'secure@example.com', password }).expect(201);
  assert.match((response.headers['set-cookie'] as unknown as string[])[0], /Secure/);
  assert.match(response.headers['strict-transport-security'], /max-age/);
});

test('authentication rate limiting works and untrusted proxy headers do not bypass it', async (context) => {
  const { database, app } = fixture({ enableRateLimits: true });
  context.after(() => database.close());
  for (let i = 0; i < 30; i += 1) {
    await request(app).post('/api/auth/login').set(header).set('X-Forwarded-For', `192.0.2.${i}`)
      .send({ email: 'invalid', password: 'short' }).expect(400);
  }
  const limited = await request(app).post('/api/auth/login').set(header).send({ email: 'invalid', password: 'short' }).expect(429);
  assert.ok(Number(limited.headers['retry-after']) > 0);
});

test('malformed JSON fails safely and API responses never cache financial data', async (context) => {
  const { database, app } = fixture();
  context.after(() => database.close());
  const response = await request(app).post('/api/auth/register').set(header).set('Content-Type', 'application/json').send('{broken').expect(400);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.body.error, '올바른 JSON 요청이 필요합니다.');
  await request(app).get('/api/missing').expect(404);
});
