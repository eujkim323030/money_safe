import { createHmac, randomBytes, scrypt as nativeScrypt, timingSafeEqual } from 'node:crypto';

function derivePassword(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    nativeScrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 }, (error, derived) => {
      if (error) reject(error); else resolve(derived);
    });
  });
}
export const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const COOKIE = 'salary_guardians';

export function validateCredentials(body: unknown): { email: string; password: string } | null {
  if (!body || typeof body !== 'object') return null;
  const { email, password } = body as Record<string, unknown>;
  if (typeof email !== 'string' || typeof password !== 'string') return null;
  const normalized = email.trim().toLowerCase();
  if (normalized.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) return null;
  if (password.length < 10 || password.length > 128) return null;
  return { email: normalized, password };
}

/** The Node backend's original secure work factor and stored hash format are retained. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('base64url');
  const derived = await derivePassword(password, salt);
  return `scrypt:${salt}:${derived.toString('base64url')}`;
}

export async function verifyPassword(password: unknown, stored: string): Promise<boolean> {
  if (typeof password !== 'string' || password.length < 10 || password.length > 128) return false;
  const [algorithm, salt, encoded] = stored.split(':');
  if (algorithm !== 'scrypt' || !/^[A-Za-z0-9_-]{22}$/.test(salt ?? '') || !encoded) return false;
  const expected = Buffer.from(encoded, 'base64url');
  if (expected.length !== 64) return false;
  const derived = await derivePassword(password, salt);
  return timingSafeEqual(expected, derived);
}

export function newSessionToken(): string { return randomBytes(32).toString('base64url'); }

export function sessionHash(token: string, secret: string): string {
  return createHmac('sha256', secret).update(token).digest('hex');
}

export function requestSessionToken(request: Request): string | null {
  const part = request.headers.get('Cookie')?.split(';').map(value => value.trim()).find(value => value.startsWith(`${COOKIE}=`));
  const token = part?.slice(COOKIE.length + 1);
  return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}

export function sessionCookie(token: string, secure: boolean): string {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_LIFETIME_MS / 1000}${secure ? '; Secure' : ''}`;
}

export function clearSessionCookie(secure: boolean): string {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
}

export function isLocalUrl(url: URL): boolean {
  return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

export function publicOrigin(requestUrl: URL, configured?: string): string {
  const url = configured ? new URL(configured) : requestUrl;
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocalUrl(url))) {
    throw new Error('HTTPS is required outside local development.');
  }
  return url.origin;
}

/** Hash IP addresses so persistent abuse controls do not retain raw client addresses. */
export function rateLimitKey(request: Request, secret: string): string {
  return `auth:${createHmac('sha256', secret).update(request.headers.get('CF-Connecting-IP') ?? 'local').digest('hex')}`;
}

export function withSecurityHeaders(response: Response, requestUrl: URL, api = false): Response {
  const headers = new Headers(response.headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Referrer-Policy', 'same-origin');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
  if (requestUrl.protocol === 'https:') headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (api) headers.set('Cache-Control', 'no-store');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
