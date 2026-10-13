import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import { createInitialState, validateState } from '../shared/domain.js';
import type { AppState, User } from '../shared/types.js';
import { AppDatabase } from './db.js';
import { enqueueBudgetAlert, loadPushConfiguration, registerPushRoutes, type PushConfiguration } from './push.js';
import {
  clearSessionCookie, hashPassword, issueSessionCookie, mutationProtection,
  rateLimit, sessionHash, sessionToken, SESSION_LIFETIME_MS, validateCredentials, verifyPassword,
} from './security.js';

interface UserRow { id: string; email: string; password_hash: string }
interface StateRow { json: string; revision: number }
interface AppOptions {
  database?: AppDatabase;
  publicOrigin?: string;
  sessionSecret?: string;
  production?: boolean;
  enableRateLimits?: boolean;
  staticDirectory?: string;
  pushConfiguration?: PushConfiguration | null;
}

export function createApp(options: AppOptions = {}) {
  const production = options.production ?? process.env.NODE_ENV === 'production';
  const configuredSecret = options.sessionSecret ?? process.env.SESSION_SECRET;
  if (production && (!configuredSecret || Buffer.byteLength(configuredSecret) < 32)) {
    throw new Error('Production requires SESSION_SECRET with at least 32 bytes.');
  }
  const secret = configuredSecret ?? randomBytes(48).toString('base64url');
  const publicOrigin = new URL(options.publicOrigin ?? process.env.PUBLIC_ORIGIN ?? 'http://localhost:5173').origin;
  if (production && !publicOrigin.startsWith('https://')) {
    throw new Error('Production requires an HTTPS PUBLIC_ORIGIN.');
  }
  const database = options.database ?? new AppDatabase();
  const pushConfiguration = options.pushConfiguration === undefined
    ? (() => { try { return loadPushConfiguration(); } catch { return null; } })()
    : options.pushConfiguration;
  const app = express();
  const dummyPasswordHash = hashPassword(randomBytes(32).toString('base64url'));
  app.locals.database = database;
  app.disable('x-powered-by');
  // Set only when a controlled reverse proxy is the sole path to this server.
  if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
  app.use((_request, response, next) => {
    response.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    });
    if (production) response.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  });
  app.use('/api', (_request, response, next) => {
    response.set('Cache-Control', 'no-store');
    next();
  });
  app.use('/api', mutationProtection(publicOrigin));
  app.use(express.json({ limit: '2mb', strict: true }));

  const authenticate: RequestHandler = (request, response, next) => {
    const token = sessionToken(request);
    if (!token) {
      response.status(401).json({ error: '로그인이 필요합니다.' });
      return;
    }
    const user = database.db.prepare(`
      SELECT users.id, users.email FROM sessions
      JOIN users ON users.id = sessions.user_id
      WHERE sessions.hash = ? AND sessions.expires_at > ?
    `).get(sessionHash(token, secret), Date.now()) as unknown as User | undefined;
    if (!user) {
      clearSessionCookie(response, production);
      response.status(401).json({ error: '세션이 만료되었습니다. 다시 로그인해 주세요.' });
      return;
    }
    response.locals.user = { id: user.id, email: user.email };
    next();
  };
  const createSession = (userId: string): string => {
    const token = randomBytes(32).toString('base64url');
    database.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
    database.db.prepare('INSERT INTO sessions(hash,user_id,expires_at) VALUES(?,?,?)')
      .run(sessionHash(token, secret), userId, Date.now() + SESSION_LIFETIME_MS);
    return token;
  };
  const authLimit = rateLimit({ limit: 30, windowMs: 15 * 60 * 1000, enabled: options.enableRateLimits });
  app.get('/api/health', (_request, response) => response.json({ ok: true }));
  app.post('/api/auth/register', authLimit, async (request, response) => {
    const credentials = validateCredentials(request.body);
    if (!credentials) {
      response.status(400).json({ error: '유효한 이메일과 10~128자 비밀번호를 입력해 주세요.' });
      return;
    }
    if (database.db.prepare('SELECT id FROM users WHERE email = ?').get(credentials.email)) {
      response.status(409).json({ error: '이미 가입된 이메일입니다.' });
      return;
    }
    const passwordHash = await hashPassword(credentials.password);
    const user: User = { id: randomUUID(), email: credentials.email };
    let token: string;
    try {
      token = database.transaction(() => {
        const now = Date.now();
        database.db.prepare('INSERT INTO users(id,email,password_hash,created_at,last_expense_at) VALUES(?,?,?,?,?)')
          .run(user.id, user.email, passwordHash, now, now);
        database.db.prepare('INSERT INTO states(user_id,json,revision) VALUES(?,?,0)')
          .run(user.id, JSON.stringify(createInitialState()));
        return createSession(user.id);
      });
    } catch (error) {
      if (database.db.prepare('SELECT id FROM users WHERE email = ?').get(credentials.email)) {
        response.status(409).json({ error: '이미 가입된 이메일입니다.' });
        return;
      }
      throw error;
    }
    issueSessionCookie(response, token, production);
    response.status(201).json({ user });
  });
  app.post('/api/auth/login', authLimit, async (request, response) => {
    const credentials = validateCredentials(request.body);
    if (!credentials) {
      response.status(400).json({ error: '유효한 이메일과 10~128자 비밀번호를 입력해 주세요.' });
      return;
    }
    const user = database.db.prepare('SELECT id,email,password_hash FROM users WHERE email = ?')
      .get(credentials.email) as unknown as UserRow | undefined;
    // Do comparable password work even for unknown emails.
    const stored = user?.password_hash ?? await dummyPasswordHash;
    const matches = await verifyPassword(credentials.password, stored);
    if (!user || !matches) {
      response.status(401).json({ error: '이메일 또는 비밀번호를 확인해 주세요.' });
      return;
    }
    const token = createSession(user.id);
    issueSessionCookie(response, token, production);
    response.json({ user: { id: user.id, email: user.email } });
  });
  app.get('/api/auth/me', authenticate, (_request, response) => response.json({ user: response.locals.user }));
  app.post('/api/auth/logout', (request, response) => {
    const token = sessionToken(request);
    if (token) database.db.prepare('DELETE FROM sessions WHERE hash = ?').run(sessionHash(token, secret));
    clearSessionCookie(response, production);
    response.json({ ok: true });
  });

  app.get('/api/state', authenticate, (_request, response) => {
    const row = database.db.prepare('SELECT json,revision FROM states WHERE user_id = ?')
      .get(response.locals.user.id) as unknown as StateRow;
    response.json({ state: JSON.parse(row.json), revision: row.revision });
  });
  app.put('/api/state', authenticate, (request, response) => {
    // A client queue is bound to the account that created it, even after the browser cookie changes.
    if (request.body?.userId !== undefined && request.body.userId !== response.locals.user.id) {
      response.status(403).json({ error: '기록을 만든 계정으로 다시 로그인해 주세요.' });
      return;
    }
    const revision: unknown = request.body?.revision;
    const state: unknown = request.body?.state;
    if (!Number.isSafeInteger(revision) || (revision as number) < 0) {
      response.status(400).json({ error: '올바른 데이터 버전이 필요합니다.' });
      return;
    }
    const errors = validateState(state);
    if (errors.length) {
      response.status(400).json({ error: `데이터를 확인해 주세요: ${errors.slice(0, 3).join(' / ')}` });
      return;
    }
    const incoming = state as AppState;
    if (incoming.config.push.enabled && !pushConfiguration) {
      response.status(503).json({ error: '서버 푸시 설정이 필요합니다. 알림을 활성화할 수 없습니다.' });
      return;
    }
    const userId: string = response.locals.user.id;
    const result = database.transaction(() => {
      const previous = database.db.prepare('SELECT json,revision FROM states WHERE user_id = ?')
        .get(userId) as unknown as StateRow;
      if (previous.revision !== revision) return { conflict: true as const };
      const previousState = JSON.parse(previous.json) as AppState;
      const previousExpenses = new Map(previousState.expenses.map((expense) => [expense.id, expense]));
      const now = Date.now();
      let hasNewExpense = false;
      for (const expense of incoming.expenses) {
        const existing = previousExpenses.get(expense.id);
        if (existing && existing.createdAt !== expense.createdAt) return { invalidTimestamp: true as const };
        if (!existing) {
          expense.createdAt = new Date(now).toISOString();
          hasNewExpense = true;
        }
      }
      const nextRevision = previous.revision + 1;
      database.db.prepare('UPDATE states SET json = ?, revision = ? WHERE user_id = ?')
        .run(JSON.stringify(incoming), nextRevision, userId);
      if (hasNewExpense) database.db.prepare('UPDATE users SET last_expense_at = ? WHERE id = ?').run(now, userId);
      // Keep the first threshold crossing durable even if an expense is removed before the worker's next tick.
      enqueueBudgetAlert(database, userId, incoming, now, true);
      return { state: incoming, revision: nextRevision };
    });
    if ('conflict' in result) {
      response.status(409).json({ error: '다른 기기에서 데이터가 변경되었습니다. 최신 데이터를 불러와 비교해 주세요.' });
      return;
    }
    if ('invalidTimestamp' in result) {
      response.status(400).json({ error: '기존 지출의 기록 시각은 변경할 수 없습니다.' });
      return;
    }
    response.json(result);
  });

  app.get('/api/export', authenticate, (_request, response) => {
    const row = database.db.prepare('SELECT json,revision FROM states WHERE user_id = ?')
      .get(response.locals.user.id) as unknown as StateRow;
    response.set('Content-Disposition', 'attachment; filename="salary-guardians-export.json"');
    response.json({ exportedAt: new Date().toISOString(), user: response.locals.user, state: JSON.parse(row.json), revision: row.revision });
  });
  app.delete('/api/account', authenticate, authLimit, async (request, response) => {
    const password: unknown = request.body?.password;
    const user = database.db.prepare('SELECT password_hash FROM users WHERE id = ?')
      .get(response.locals.user.id) as unknown as Pick<UserRow, 'password_hash'>;
    if (typeof password !== 'string' || !await verifyPassword(password, user.password_hash)) {
      response.status(401).json({ error: '계정 삭제를 위해 비밀번호를 확인해 주세요.' });
      return;
    }
    database.transaction(() => {
      database.db.prepare('DELETE FROM users WHERE id = ?').run(response.locals.user.id);
    });
    clearSessionCookie(response, production);
    response.json({ ok: true });
  });

  registerPushRoutes(app, database, authenticate, { configuration: pushConfiguration });
  app.use('/api', (_request, response) => response.status(404).json({ error: 'API를 찾을 수 없습니다.' }));
  const staticDirectory = options.staticDirectory ?? resolve('dist');
  if (existsSync(staticDirectory)) {
    app.use(express.static(staticDirectory, {
      setHeaders(response, filename) {
        if (filename.endsWith('sw.js') || filename.endsWith('manifest.webmanifest') || filename.endsWith('index.html')) {
          response.set('Cache-Control', 'no-cache');
        }
      },
    }));
    app.use((request, response, next) => {
      if (request.method !== 'GET' || !request.accepts('html')) return next();
      response.sendFile(resolve(staticDirectory, 'index.html'));
    });
  }
  const handleError: ErrorRequestHandler = (error, _request, response, _next) => {
    if (error instanceof SyntaxError && 'body' in error) {
      response.status(400).json({ error: '올바른 JSON 요청이 필요합니다.' });
      return;
    }
    if (error?.type === 'entity.too.large') {
      response.status(413).json({ error: '데이터가 너무 큽니다.' });
      return;
    }
    console.error('API request failed:', error instanceof Error ? error.message : 'unknown error');
    response.status(500).json({ error: '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.' });
  };
  app.use(handleError);
  return app;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
  createApp().listen(port, '0.0.0.0', () => console.log(`월급수비대 API is listening on port ${port}.`));
}
