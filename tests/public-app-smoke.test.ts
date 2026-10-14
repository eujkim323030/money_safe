import assert from 'node:assert/strict';
import { createECDH, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createApp } from '../server/app.js';
import { AppDatabase } from '../server/db.js';
import type { PushConfiguration } from '../server/push.js';
import { createInitialState } from '../shared/domain.js';
import type { AppState } from '../shared/types.js';

interface SmokeReport {
  url: string;
  startedAt: string;
  finishedAt: string;
  success: boolean;
  assertions: Array<{ name: string; status: 'passed' | 'failed' | 'skipped'; httpStatus?: number }>;
  testAccountCleanup: boolean;
  error?: { kind: string; message: string; httpStatus?: number };
  cleanupEmail?: string;
}

interface SmokeOptions {
  baseUrl: string;
  fetcher?: typeof fetch;
  reportPath?: string;
  allowLocalHttp?: boolean;
  pollDelayMs?: number;
  healthAttempts?: number;
  log?: (message: string) => void;
}

const helperUrl = new URL('../scripts/smoke-public-app.mjs', import.meta.url).href;
const { runPublicSmoke } = await import(helperUrl) as {
  runPublicSmoke: (options: SmokeOptions) => Promise<SmokeReport>;
};

const publicOrigin = 'https://app.example';
const sessionSecret = 'smoke-test-only-session-secret-at-least-32-bytes';
const privateTables = ['users', 'states', 'sessions', 'push_subscriptions', 'push_events', 'push_deliveries'];

function validPushConfiguration(): PushConfiguration {
  const vapid = createECDH('prime256v1');
  const publicKey = vapid.generateKeys().toString('base64url');
  return {
    publicKey,
    privateKey: vapid.getPrivateKey().toString('base64url'),
    subject: 'mailto:smoke@example.com',
    encryptionKey: randomBytes(32),
  };
}

function assertPrivateTablesEmpty(database: AppDatabase) {
  for (const table of privateTables) {
    const row = database.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
    assert.equal(row.count, 0, `Temporary smoke data remains in ${table}`);
  }
}

async function actualAppFixture(context: TestContext, pushConfiguration: PushConfiguration | null) {
  const database = new AppDatabase(':memory:');
  const app = createApp({
    database, production: true, publicOrigin, sessionSecret, pushConfiguration,
    enableRateLimits: false, staticDirectory: resolve('public'),
  });
  const server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const localOrigin = `http://127.0.0.1:${address.port}`;
  const reportDirectory = await mkdtemp(join(tmpdir(), 'salary-guardians-smoke-test-'));
  context.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    database.close();
    await rm(reportDirectory, { recursive: true, force: true });
  });

  const requests: Array<{ pathname: string; method: string; authenticated: boolean; origin: string | null }> = [];
  const sensitiveValues = [sessionSecret];
  let registeredEmail = '';
  let initialState: AppState | undefined;
  let savedState: AppState | undefined;
  let exportedState: AppState | undefined;
  let registrationSecureCookie = false;
  let seededPushRows = false;

  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const requestedUrl = new URL(request.url);
    assert.equal(requestedUrl.origin, publicOrigin);
    requests.push({
      pathname: requestedUrl.pathname,
      method: request.method,
      authenticated: request.headers.has('Cookie'),
      origin: request.headers.get('Origin'),
    });
    if (requestedUrl.pathname === '/api/auth/register' && request.method === 'POST') {
      const credentials = await request.clone().json() as { email: string; password: string };
      registeredEmail = credentials.email;
      sensitiveValues.push(credentials.password);
    }
    const localUrl = new URL(requestedUrl.pathname + requestedUrl.search, localOrigin);
    // Exercise the actual HTTP server without TLS while preserving the production
    // Origin and Secure cookie contract that the smoke helper enforces itself.
    const response = await fetch(new Request(localUrl, request));
    for (const cookie of response.headers.getSetCookie()) {
      const value = cookie.split(';')[0].split('=').slice(1).join('=');
      if (value) sensitiveValues.push(value, cookie);
      if (requestedUrl.pathname === '/api/auth/register' && response.status === 201) {
        registrationSecureCookie = /;\s*Secure(?:;|$)/i.test(cookie);
      }
    }
    if (requestedUrl.pathname === '/api/auth/register' && response.status === 201) {
      const { user } = await response.clone().json() as { user: { id: string } };
      // A failed or successful smoke must clean up all linked notification data,
      // including rows that a scheduler could create while its account exists.
      const now = Date.now();
      database.db.prepare('INSERT INTO push_subscriptions(id,user_id,endpoint_hash,encrypted,created_at,updated_at) VALUES(?,?,?,?,?,?)')
        .run('smoke-device', user.id, 'smoke-endpoint-hash', 'opaque-test-subscription', now, now);
      database.db.prepare('INSERT INTO push_events(id,user_id,event_key,payload,created_at,expires_at) VALUES(?,?,?,?,?,?)')
        .run('smoke-event', user.id, 'smoke:cleanup', '{}', now, now + 60_000);
      database.db.prepare('INSERT INTO push_deliveries(id,event_id,subscription_id,next_attempt_at) VALUES(?,?,?,?)')
        .run('smoke-delivery', 'smoke-event', 'smoke-device', now);
      seededPushRows = true;
    }
    if (requestedUrl.pathname === '/api/state' && request.method === 'PUT' && response.ok) {
      savedState = (await response.clone().json() as { state: AppState }).state;
    }
    if (requestedUrl.pathname === '/api/state' && request.method === 'GET' && response.ok && !initialState) {
      initialState = (await response.clone().json() as { state: AppState }).state;
    }
    if (requestedUrl.pathname === '/api/export' && response.ok) {
      exportedState = (await response.clone().json() as { state: AppState }).state;
    }
    return response;
  };

  return {
    database, fetcher, requests, sensitiveValues,
    reportPath: join(reportDirectory, 'smoke-report.json'),
    observations: () => ({ registeredEmail, initialState, savedState, exportedState, registrationSecureCookie, seededPushRows }),
  };
}

test('public smoke exercises the production app and deletes its account, state, session, and push rows', async (context) => {
  const pushConfiguration = validPushConfiguration();
  const fixture = await actualAppFixture(context, pushConfiguration);
  const logs: string[] = [];
  const report = await runPublicSmoke({
    baseUrl: publicOrigin, fetcher: fixture.fetcher, reportPath: fixture.reportPath,
    pollDelayMs: 0, healthAttempts: 1, log: (message) => logs.push(message),
  });

  assert.equal(report.success, true, report.error?.message);
  assert.equal(report.url, publicOrigin);
  assert.equal(report.testAccountCleanup, true);
  assert.equal(report.error, undefined);
  assert.ok(report.assertions.length >= 10);
  assert.ok(report.assertions.every((assertion) => assertion.status === 'passed'));
  assert.ok(Number.isFinite(Date.parse(report.startedAt)));
  assert.ok(Number.isFinite(Date.parse(report.finishedAt)));

  const observed = fixture.observations();
  assert.ok(observed.registeredEmail);
  assert.equal(observed.registrationSecureCookie, true);
  assert.equal(observed.seededPushRows, true);
  assert.deepEqual(observed.initialState, createInitialState());
  assert.equal(observed.savedState?.expenses.length, 2);
  assert.equal(observed.savedState?.expenses[0].amount, 1_000);
  assert.deepEqual(observed.exportedState, observed.savedState);
  const mutationRequests = fixture.requests.filter(({ method }) => method !== 'GET');
  assert.ok(mutationRequests.length >= 3);
  assert.ok(mutationRequests.every(({ origin }) => origin === publicOrigin));
  assert.ok(fixture.requests.some(({ pathname, authenticated }) => pathname === '/api/auth/me' && authenticated));
  assert.ok(fixture.requests.some(({ pathname, method, authenticated }) => pathname === '/api/account' && method === 'DELETE' && authenticated));
  assertPrivateTablesEmpty(fixture.database);

  const savedReportText = await readFile(fixture.reportPath, 'utf8');
  assert.deepEqual(JSON.parse(savedReportText), report);
  const outputs = JSON.stringify(report) + savedReportText + logs.join('\n');
  for (const sensitive of [...fixture.sensitiveValues, pushConfiguration.privateKey, pushConfiguration.encryptionKey.toString('base64url')]) {
    assert.ok(!outputs.includes(sensitive), 'Smoke output must not expose a password, cookie, or server key');
  }
});

test('public smoke reports missing server push keys and cleans the real account on failure', async (context) => {
  const fixture = await actualAppFixture(context, null);
  const report = await runPublicSmoke({
    baseUrl: publicOrigin, fetcher: fixture.fetcher, reportPath: fixture.reportPath,
    pollDelayMs: 0, healthAttempts: 1, log: () => {},
  });

  assert.equal(report.success, false);
  assert.equal(report.error?.kind, 'missing_push');
  assert.equal(report.testAccountCleanup, true);
  assert.equal(fixture.observations().seededPushRows, true);
  assert.ok(report.assertions.some(({ status }) => status === 'failed'));
  assert.ok(fixture.requests.some(({ pathname, method }) => pathname === '/api/account' && method === 'DELETE'));
  assertPrivateTablesEmpty(fixture.database);
  const output = JSON.stringify(report);
  for (const sensitive of fixture.sensitiveValues) assert.ok(!output.includes(sensitive));
});

test('public smoke reports a temporary account that could not be deleted without exposing its password', async (context) => {
  const fixture = await actualAppFixture(context, validPushConfiguration());
  const logs: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).pathname === '/api/account' && request.method === 'DELETE') {
      return new Response(JSON.stringify({ error: 'Temporarily unavailable' }), {
        status: 503, headers: { 'Content-Type': 'application/json' },
      });
    }
    return fixture.fetcher(request);
  };
  const report = await runPublicSmoke({
    baseUrl: publicOrigin, fetcher, reportPath: fixture.reportPath,
    pollDelayMs: 0, healthAttempts: 1, log: (message) => logs.push(message),
  });

  assert.equal(report.success, false);
  assert.equal(report.testAccountCleanup, false);
  assert.equal(report.cleanupEmail, fixture.observations().registeredEmail);
  assert.ok(report.error);
  const remainingUser = fixture.database.db.prepare('SELECT email FROM users').get() as { email: string };
  assert.equal(remainingUser.email, report.cleanupEmail);
  const outputs = JSON.stringify(report) + logs.join('\n');
  for (const sensitive of fixture.sensitiveValues) assert.ok(!outputs.includes(sensitive));
});

test('public smoke classifies a missing SESSION_SECRET signup response without leaving an account', async (context) => {
  const fixture = await actualAppFixture(context, validPushConfiguration());
  const logs: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).pathname === '/api/auth/register' && request.method === 'POST') {
      const { password } = await request.clone().json() as { password: string };
      fixture.sensitiveValues.push(password);
      return new Response(JSON.stringify({ error: '서버 세션 비밀키 설정이 필요합니다.' }), {
        status: 503, headers: { 'Content-Type': 'application/json' },
      });
    }
    return fixture.fetcher(request);
  };
  const report = await runPublicSmoke({
    baseUrl: publicOrigin, fetcher, reportPath: fixture.reportPath,
    pollDelayMs: 0, healthAttempts: 1, log: (message) => logs.push(message),
  });

  assert.equal(report.success, false);
  assert.equal(report.error?.kind, 'missing_session_secret');
  assert.equal(report.error?.httpStatus, 503);
  assert.equal(report.cleanupEmail, undefined);
  assertPrivateTablesEmpty(fixture.database);
  const outputs = JSON.stringify(report) + logs.join('\n');
  for (const sensitive of fixture.sensitiveValues) assert.ok(!outputs.includes(sensitive));
});

test('public smoke classifies a Cloudflare Error 1102 HTML response without exposing its body', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'salary-guardians-smoke-1102-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const logs: string[] = [];
  const requestedPaths: string[] = [];
  const responseMarker = 'pretend-sensitive-page-marker';
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    requestedPaths.push(new URL(request.url).pathname);
    return new Response(`<html><h1><span>Error </span><span>1102</span></h1><p>Worker exceeded resource limits</p><p>${responseMarker}</p></html>`, {
      status: 500,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  };
  const report = await runPublicSmoke({
    baseUrl: publicOrigin, fetcher, reportPath: join(directory, 'report.json'),
    pollDelayMs: 0, healthAttempts: 1, log: (message) => logs.push(message),
  });

  assert.equal(report.success, false);
  assert.equal(report.error?.kind, 'cpu_limit');
  assert.equal(report.error?.httpStatus, 500);
  assert.deepEqual(requestedPaths, ['/api/health']);
  assert.equal(report.cleanupEmail, undefined);
  assert.ok(!JSON.stringify(report).includes(responseMarker));
  assert.ok(!logs.join('\n').includes(responseMarker));
});
