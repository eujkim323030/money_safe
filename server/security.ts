import { createHmac, randomBytes, scrypt as nodeScrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { Request, RequestHandler, Response } from 'express';

const scrypt = promisify(nodeScrypt);
export const SESSION_COOKIE = 'salary_guardians';
export const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

export function validateCredentials(body: unknown): { email: string; password: string } | null {
  if (!body || typeof body !== 'object') return null;
  const { email, password } = body as Record<string, unknown>;
  if (typeof email !== 'string' || typeof password !== 'string') return null;
  const normalized = email.trim().toLowerCase();
  if (normalized.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) return null;
  if (password.length < 10 || password.length > 128) return null;
  return { email: normalized, password };
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('base64url');
  const derived = await scrypt(password, salt, 64) as Buffer;
  return `scrypt:${salt}:${derived.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (typeof password !== 'string' || password.length > 128) return false;
  const [algorithm, salt, encoded] = stored.split(':');
  if (algorithm !== 'scrypt' || !salt || !encoded) return false;
  const expected = Buffer.from(encoded, 'base64url');
  if (expected.length !== 64) return false;
  const derived = await scrypt(password, salt, 64) as Buffer;
  return timingSafeEqual(expected, derived);
}

export function sessionHash(token: string, secret: string): string {
  return createHmac('sha256', secret).update(token).digest('hex');
}

export function sessionToken(request: Request): string | null {
  const cookie = request.headers.cookie?.split(';').map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`));
  if (!cookie) return null;
  const token = cookie.slice(SESSION_COOKIE.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}

export function issueSessionCookie(response: Response, token: string, secure: boolean): void {
  response.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_LIFETIME_MS,
  });
}

export function clearSessionCookie(response: Response, secure: boolean): void {
  response.clearCookie(SESSION_COOKIE, { httpOnly: true, secure, sameSite: 'lax', path: '/' });
}

/** Browsers cannot add this custom header from another origin without CORS permission. */
export function mutationProtection(publicOrigin: string): RequestHandler {
  return (request, response, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return next();
    if (request.get('X-Requested-With') !== 'salary-guardians') {
      response.status(403).json({ error: '요청 출처를 확인할 수 없습니다.' });
      return;
    }
    const origin = request.get('Origin');
    if (origin && origin !== publicOrigin) {
      response.status(403).json({ error: '허용되지 않은 출처입니다.' });
      return;
    }
    next();
  };
}

export function rateLimit(options: { limit: number; windowMs: number; enabled?: boolean }): RequestHandler {
  const attempts = new Map<string, { count: number; until: number }>();
  return (request, response, next) => {
    if (options.enabled === false) return next();
    const now = Date.now();
    if (attempts.size > 10_000) {
      for (const [key, value] of attempts) if (value.until <= now) attempts.delete(key);
      if (attempts.size > 10_000) {
        response.status(429).json({ error: '잠시 후 다시 시도해 주세요.' });
        return;
      }
    }
    const key = request.ip ?? 'unknown';
    const previous = attempts.get(key);
    const current = !previous || previous.until <= now ? { count: 0, until: now + options.windowMs } : previous;
    current.count += 1;
    attempts.set(key, current);
    if (current.count > options.limit) {
      response.set('Retry-After', String(Math.ceil((current.until - now) / 1000)));
      response.status(429).json({ error: '시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.' });
      return;
    }
    next();
  };
}
