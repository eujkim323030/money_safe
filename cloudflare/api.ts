import { randomUUID } from 'node:crypto';
import type { D1PreparedStatement } from '@cloudflare/workers-types';
import { createInitialState, validateState } from '../shared/domain';
import type { AppState, User } from '../shared/types';
import { consumeRateLimit, findAuthenticatedUser, findUserByEmail, getState } from './db';
import { budgetAlertStatements, handlePushRequest, isPushConfigured } from './push';
import {
  clearSessionCookie, hashPassword, newSessionToken, publicOrigin, rateLimitKey,
  requestSessionToken, sessionCookie, sessionHash, SESSION_LIFETIME_MS, validateCredentials,
  verifyPassword, withSecurityHeaders,
} from './security';
import type { Env } from './types';
export { withSecurityHeaders } from './security';

interface ApiOptions { now?: () => number; disableRateLimits?: boolean }
class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const RATE_WINDOW = 15 * 60 * 1000;

function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  const resultHeaders = new Headers(headers);
  resultHeaders.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(value), { status, headers: resultHeaders });
}
function sessionSecret(env: Env): string {
  if (!env.SESSION_SECRET || Buffer.byteLength(env.SESSION_SECRET) < 32) throw new HttpError(503, '서버 세션 비밀키 설정이 필요합니다.');
  return env.SESSION_SECRET;
}
async function readBody(request: Request): Promise<Record<string, unknown>> {
  const declared = request.headers.get('Content-Length');
  if (declared && Number(declared) > MAX_BODY_BYTES) throw new HttpError(413, '데이터가 너무 큽니다.');
  if (!request.body) return {};
  const type = request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') throw new HttpError(400, '올바른 JSON 요청이 필요합니다.');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_BODY_BYTES) { await reader.cancel(); throw new HttpError(413, '데이터가 너무 큽니다.'); }
    chunks.push(value);
  }
  if (length === 0) return {};
  const bytes = new Uint8Array(length);
  let position = 0;
  for (const chunk of chunks) { bytes.set(chunk, position); position += chunk.byteLength; }
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected JSON object');
    return value as Record<string, unknown>;
  } catch { throw new HttpError(400, '올바른 JSON 요청이 필요합니다.'); }
}

/** Same-origin API for the free Workers + D1 deployment. Non-API requests return null. */
export async function handleApiRequest(request: Request, env: Env, options: ApiOptions = {}): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== '/api' && !url.pathname.startsWith('/api/')) return null;
  let result: Response;
  try { result = await route(request, env, url, options); }
  catch (error) {
    if (error instanceof HttpError) result = json({ error: error.message }, error.status);
    else {
      // Do not log incoming bodies, secrets, subscription endpoints, or provider responses.
      console.error('Cloudflare API operation failed.');
      result = json({ error: '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.' }, 500);
    }
  }
  return withSecurityHeaders(result, url, true);
}

async function route(request: Request, env: Env, url: URL, options: ApiOptions): Promise<Response> {
  const path = url.pathname;
  const method = request.method;
  const now = options.now?.() ?? Date.now();
  const secure = url.protocol === 'https:';
  const expectedOrigin = publicOrigin(url, env.PUBLIC_ORIGIN);
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    if (request.headers.get('X-Requested-With') !== 'salary-guardians') throw new HttpError(403, '요청 출처를 확인할 수 없습니다.');
    const origin = request.headers.get('Origin');
    if (origin && origin !== expectedOrigin) throw new HttpError(403, '허용되지 않은 출처입니다.');
  }
  if (path === '/api/health' && method === 'GET') return json({ ok: true });
  const secret = sessionSecret(env);
  const body = ['GET', 'HEAD', 'OPTIONS'].includes(method) ? {} : await readBody(request);
  const limited = async () => {
    if (!options.disableRateLimits && !await consumeRateLimit(env.DB, rateLimitKey(request, secret), 30, RATE_WINDOW, now)) {
      return json({ error: '시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.' }, 429, { 'Retry-After': '900' });
    }
    return null;
  };
  const createSessionStatements = (userId: string, token: string): D1PreparedStatement[] => [
    env.DB.prepare('DELETE FROM sessions WHERE user_id=? AND expires_at<=?').bind(userId, now),
    env.DB.prepare('INSERT INTO sessions(hash,user_id,expires_at) VALUES(?,?,?)')
      .bind(sessionHash(token, secret), userId, now + SESSION_LIFETIME_MS),
  ];
  if (path === '/api/auth/register' && method === 'POST') {
    const rate = await limited(); if (rate) return rate;
    const credentials = validateCredentials(body);
    if (!credentials) throw new HttpError(400, '유효한 이메일과 10~128자 비밀번호를 입력해 주세요.');
    if (await findUserByEmail(env.DB, credentials.email)) throw new HttpError(409, '이미 가입된 이메일입니다.');
    const user: User = { id: randomUUID(), email: credentials.email };
    const token = newSessionToken();
    const passwordHash = await hashPassword(credentials.password);
    try {
      await env.DB.batch([
        env.DB.prepare('INSERT INTO users(id,email,password_hash,created_at,last_expense_at) VALUES(?,?,?,?,?)')
          .bind(user.id, user.email, passwordHash, now, now),
        env.DB.prepare('INSERT INTO states(user_id,json,revision,write_id) VALUES(?,?,0,?)')
          .bind(user.id, JSON.stringify(createInitialState()), randomUUID()),
        ...createSessionStatements(user.id, token),
      ]);
    } catch (error) {
      if (await findUserByEmail(env.DB, credentials.email)) throw new HttpError(409, '이미 가입된 이메일입니다.');
      throw error;
    }
    return json({ user }, 201, { 'Set-Cookie': sessionCookie(token, secure) });
  }
  if (path === '/api/auth/login' && method === 'POST') {
    const rate = await limited(); if (rate) return rate;
    const credentials = validateCredentials(body);
    if (!credentials) throw new HttpError(400, '유효한 이메일과 10~128자 비밀번호를 입력해 주세요.');
    const user = await findUserByEmail(env.DB, credentials.email);
    // Unknown identities still perform the same secure native password derivation.
    const matches = user ? await verifyPassword(credentials.password, user.password_hash) : (await hashPassword(credentials.password), false);
    if (!user || !matches) throw new HttpError(401, '이메일 또는 비밀번호를 확인해 주세요.');
    const token = newSessionToken();
    await env.DB.batch(createSessionStatements(user.id, token));
    return json({ user: { id: user.id, email: user.email } }, 200, { 'Set-Cookie': sessionCookie(token, secure) });
  }
  if (path === '/api/auth/logout' && method === 'POST') {
    const token = requestSessionToken(request);
    if (token) await env.DB.prepare('DELETE FROM sessions WHERE hash=?').bind(sessionHash(token, secret)).run();
    return json({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie(secure) });
  }

  const token = requestSessionToken(request);
  const user = token ? await findAuthenticatedUser(env.DB, sessionHash(token, secret), now) : null;
  if (!user) return json({ error: token ? '세션이 만료되었습니다. 다시 로그인해 주세요.' : '로그인이 필요합니다.' }, 401, { 'Set-Cookie': clearSessionCookie(secure) });
  if (path === '/api/auth/me' && method === 'GET') return json({ user });
  if (path === '/api/state' && method === 'GET') {
    const stored = await getState(env.DB, user.id);
    if (!stored) throw new HttpError(404, '기록을 찾을 수 없습니다.');
    return json({ state: JSON.parse(stored.json), revision: stored.revision });
  }
  if (path === '/api/state' && method === 'PUT') {
    if (body.userId !== undefined && body.userId !== user.id) throw new HttpError(403, '기록을 만든 계정으로 다시 로그인해 주세요.');
    if (!Number.isSafeInteger(body.revision) || Number(body.revision) < 0) throw new HttpError(400, '올바른 데이터 버전이 필요합니다.');
    const errors = validateState(body.state);
    if (errors.length) throw new HttpError(400, `데이터를 확인해 주세요: ${errors.slice(0, 3).join(' / ')}`);
    const state = body.state as AppState;
    if (state.config.push.enabled && !await isPushConfigured(env)) throw new HttpError(503, '서버 푸시 설정이 필요합니다. 알림을 활성화할 수 없습니다.');
    const stored = await getState(env.DB, user.id);
    if (!stored || stored.revision !== body.revision) throw new HttpError(409, '다른 기기에서 데이터가 변경되었습니다. 최신 데이터를 불러와 비교해 주세요.');
    const previous = JSON.parse(stored.json) as AppState;
    const existing = new Map(previous.expenses.map(expense => [expense.id, expense]));
    let activity = false;
    for (const expense of state.expenses) {
      const old = existing.get(expense.id);
      if (old && old.createdAt !== expense.createdAt) throw new HttpError(400, '기존 지출의 기록 시각은 변경할 수 없습니다.');
      if (!old) { expense.createdAt = new Date(now).toISOString(); activity = true; }
    }
    const writeId = randomUUID();
    const statements = [env.DB.prepare('UPDATE states SET json=?,revision=revision+1,write_id=? WHERE user_id=? AND revision=?')
      .bind(JSON.stringify(state), writeId, user.id, body.revision)];
    if (activity) statements.push(env.DB.prepare(`UPDATE users SET last_expense_at=? WHERE id=?
      AND EXISTS(SELECT 1 FROM states WHERE user_id=? AND write_id=?)`).bind(now, user.id, user.id, writeId));
    statements.push(...await budgetAlertStatements(env.DB, user.id, state, now, writeId));
    const committed = await env.DB.batch(statements);
    if (!committed[0].meta.changes) throw new HttpError(409, '다른 기기에서 데이터가 변경되었습니다. 최신 데이터를 불러와 비교해 주세요.');
    return json({ state, revision: Number(body.revision) + 1 });
  }
  if (path === '/api/export' && method === 'GET') {
    const stored = await getState(env.DB, user.id);
    if (!stored) throw new HttpError(404, '기록을 찾을 수 없습니다.');
    return json({ exportedAt: new Date(now).toISOString(), user, state: JSON.parse(stored.json), revision: stored.revision }, 200,
      { 'Content-Disposition': 'attachment; filename="salary-guardians-export.json"' });
  }
  if (path === '/api/account' && method === 'DELETE') {
    const rate = await limited(); if (rate) return rate;
    const row = await env.DB.prepare('SELECT password_hash FROM users WHERE id=?').bind(user.id).first<{ password_hash: string }>();
    if (!row || !await verifyPassword(body.password, row.password_hash)) throw new HttpError(401, '계정 삭제를 위해 비밀번호를 확인해 주세요.');
    await env.DB.prepare('DELETE FROM users WHERE id=?').bind(user.id).run();
    return json({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie(secure) });
  }
  const push = await handlePushRequest(request, env, user, body);
  return push ?? json({ error: 'API를 찾을 수 없습니다.' }, 404);
}
