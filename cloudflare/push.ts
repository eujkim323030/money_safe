import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { kstDate, salaryCycle, variableSpent } from '../shared/domain.ts';
import type { AppState, Config, NotificationPayload, User } from '../shared/types.ts';
import type { Env } from './types.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const KST = 9 * HOUR;
const encoder = new TextEncoder();
export interface BrowserSubscription { endpoint: string; keys: { p256dh: string; auth: string } }
export interface PushConfiguration { publicKey: string; subject: string; signingKey: CryptoKey; encryptionKey: CryptoKey }
type Secrets = Pick<Env, 'VAPID_PUBLIC_KEY' | 'VAPID_PRIVATE_KEY' | 'VAPID_SUBJECT' | 'DATA_ENCRYPTION_KEY'>;
const configurations = new WeakMap<object, Promise<PushConfiguration | null>>();

export function base64url(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, ''); }
export function unbase64(value: string, size?: number): Uint8Array {
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) throw new Error('Invalid key encoding');
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(normalized);
  const output = Uint8Array.from(binary, char => char.charCodeAt(0));
  if (size !== undefined && output.length !== size) throw new Error('Invalid key length');
  return output;
}
function source(bytes: Uint8Array): ArrayBuffer { return Uint8Array.from(bytes).buffer; }
function concat(...values: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(values.reduce((sum, value) => sum + value.length, 0));
  let offset = 0;
  for (const value of values) { output.set(value, offset); offset += value.length; }
  return output;
}
async function hash(value: string): Promise<string> { return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', source(encoder.encode(value))))); }

export async function loadPushConfiguration(env: Partial<Secrets>): Promise<PushConfiguration | null> {
  let pending = configurations.get(env);
  if (!pending) {
    pending = (async () => {
      const { VAPID_PUBLIC_KEY: publicValue, VAPID_PRIVATE_KEY: privateValue, VAPID_SUBJECT: subject, DATA_ENCRYPTION_KEY: encryptionValue } = env;
      if (!publicValue || !privateValue || !subject || !encryptionValue) return null;
      const pub = unbase64(publicValue, 65);
      const priv = unbase64(privateValue, 32);
      if (pub[0] !== 4) throw new Error('Invalid VAPID public key');
      const contact = new URL(subject);
      if (!['mailto:', 'https:'].includes(contact.protocol) || !contact.pathname) throw new Error('Invalid VAPID contact');
      const jwk = { kty: 'EC', crv: 'P-256', x: base64url(pub.slice(1, 33)), y: base64url(pub.slice(33, 65)) };
      const signingKey = await crypto.subtle.importKey('jwk', { ...jwk, d: base64url(priv), ext: false }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
      const verificationKey = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      const challenge = source(encoder.encode('salary-guardians:vapid-key-pair-check'));
      const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signingKey, challenge);
      if (!await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, verificationKey, signature, challenge)) throw new Error('VAPID keys do not match');
      const encryptionKey = await crypto.subtle.importKey('raw', source(unbase64(encryptionValue, 32)), 'AES-GCM', false, ['encrypt', 'decrypt']);
      return { publicKey: base64url(pub), subject, signingKey, encryptionKey };
    })();
    configurations.set(env, pending);
  }
  return pending;
}
export async function isPushConfigured(env: Partial<Secrets>): Promise<boolean> { try { return await loadPushConfiguration(env) !== null; } catch { return false; } }

export async function validateSubscription(value: unknown): Promise<BrowserSubscription> {
  const input = value as Partial<BrowserSubscription> | null;
  if (!input || typeof input.endpoint !== 'string' || input.endpoint.length > 4096) throw new Error('Invalid subscription');
  const endpoint = new URL(input.endpoint);
  const host = endpoint.hostname.toLowerCase();
  const allowed = host === 'fcm.googleapis.com' || host === 'android.googleapis.com'
    || host === 'push.apple.com' || host.endsWith('.push.apple.com')
    || host === 'push.services.mozilla.com' || host.endsWith('.push.services.mozilla.com') || host.endsWith('.notify.windows.com');
  if (!allowed || endpoint.protocol !== 'https:' || (endpoint.port && endpoint.port !== '443') || endpoint.username || endpoint.password || endpoint.hash) throw new Error('Unsupported push service');
  if (typeof input.keys?.p256dh !== 'string' || typeof input.keys.auth !== 'string') throw new Error('Missing subscription keys');
  const p256dh = unbase64(input.keys.p256dh, 65);
  const auth = unbase64(input.keys.auth, 16);
  await crypto.subtle.importKey('raw', source(p256dh), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  return { endpoint: endpoint.href, keys: { p256dh: base64url(p256dh), auth: base64url(auth) } };
}

export async function encryptSubscription(subscription: BrowserSubscription, key: CryptoKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode('salary-guardians:push:v1') }, key, source(encoder.encode(JSON.stringify(subscription))));
  return `v2.${base64url(iv)}.${base64url(new Uint8Array(encrypted))}`;
}
export async function decryptSubscription(encrypted: string, key: CryptoKey): Promise<BrowserSubscription> {
  const [version, iv, ciphertext] = encrypted.split('.');
  if (version !== 'v2' || !iv || !ciphertext) throw new Error('Invalid encrypted subscription');
  const clear = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: source(unbase64(iv, 12)), additionalData: encoder.encode('salary-guardians:push:v1') }, key, source(unbase64(ciphertext)));
  return validateSubscription(JSON.parse(new TextDecoder().decode(clear)));
}

async function hkdf(secret: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', source(secret), 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: source(salt), info: source(info) }, key, length * 8));
}

/** RFC 8291 payload encryption + RFC 8292 VAPID. Uses only the Workers Web Crypto API. */
export async function createPushRequest(subscription: BrowserSubscription, payload: NotificationPayload, configuration: PushConfiguration, now = Date.now(), ttlSeconds = 3600): Promise<{ endpoint: string; headers: Record<string, string>; body: Uint8Array }> {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 3600) throw new Error('Invalid push retention duration');
  const checked = await validateSubscription(subscription);
  const plaintext = encoder.encode(JSON.stringify(payload));
  if (plaintext.length > 2048) throw new Error('Push payload too large');
  const recipientPublic = unbase64(checked.keys.p256dh, 65);
  const recipient = await crypto.subtle.importKey('raw', source(recipientPublic), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ephemeral = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const senderPublic = new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey));
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: recipient }, ephemeral.privateKey, 256));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const inputKey = await hkdf(secret, unbase64(checked.keys.auth, 16), concat(encoder.encode('WebPush: info\0'), recipientPublic, senderPublic), 32);
  const contentKey = await hkdf(inputKey, salt, encoder.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(inputKey, salt, encoder.encode('Content-Encoding: nonce\0'), 12);
  const aes = await crypto.subtle.importKey('raw', source(contentKey), 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: source(nonce) }, aes, source(concat(plaintext, new Uint8Array([2])))));
  const prefix = new Uint8Array(21);
  prefix.set(salt);
  new DataView(prefix.buffer).setUint32(16, 4096, false);
  prefix[20] = senderPublic.length;
  const jwtHeader = base64url(encoder.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const jwtPayload = base64url(encoder.encode(JSON.stringify({ aud: new URL(checked.endpoint).origin, exp: Math.floor(now / 1000) + 12 * 60 * 60, sub: configuration.subject })));
  const unsigned = `${jwtHeader}.${jwtPayload}`;
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, configuration.signingKey, source(encoder.encode(unsigned))));
  if (signature.length !== 64) throw new Error('Unexpected ES256 signature encoding');
  return { endpoint: checked.endpoint, body: concat(prefix, senderPublic, ciphertext), headers: {
    Authorization: `vapid t=${unsigned}.${base64url(signature)}, k=${configuration.publicKey}`,
    'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: String(ttlSeconds), Urgency: 'normal', Topic: payload.tag,
  } };
}

export async function sendWebPush(subscription: BrowserSubscription, payload: NotificationPayload, configuration: PushConfiguration, now = Date.now(), fetcher: typeof fetch = fetch, leaseUntil?: number, ttlSeconds = 3600): Promise<{ statusCode: number }> {
  const request = await createPushRequest(subscription, payload, configuration, now, ttlSeconds);
  const remaining = leaseUntil === undefined ? 15_000 : leaseUntil - Date.now();
  if (remaining <= 0) throw new Error('Push delivery lease expired before request');
  const response = await fetcher(request.endpoint, { method: 'POST', headers: request.headers, body: source(request.body), redirect: 'error', signal: AbortSignal.timeout(Math.min(15_000, remaining)) });
  if (response.status < 200 || response.status >= 300) throw Object.assign(new Error('Push service rejected request'), { statusCode: response.status, headers: { 'retry-after': response.headers.get('Retry-After') ?? '' } });
  return { statusCode: response.status };
}

interface Candidate { key: string; scheduledAt: number; payload: Omit<NotificationPayload, 'tag'> }
const midnight = (date: string) => Date.parse(`${date}T00:00:00+09:00`);
export function scheduledCandidates(now: number, config: Config): Candidate[] {
  const output: Candidate[] = [];
  for (const offset of [0, -DAY]) {
    const date = kstDate(new Date(now + offset));
    const day = Number(date.slice(8));
    const nextDay = Number(kstDate(new Date(midnight(date) + DAY)).slice(8));
    const add = (due: boolean, key: string, hour: number, minute: number | undefined, payload: Omit<NotificationPayload, 'tag'>) => {
      const scheduledAt = midnight(date) + hour * HOUR + (minute ?? 0) * 60_000;
      if (due && now >= scheduledAt && now - scheduledAt < 12 * HOUR) output.push({ key: `${key}:${date}`, scheduledAt, payload });
    };
    add(day === config.salary.payday, 'payday', config.push.payday.hour, config.push.payday.minute, { title: '월급요정이 왔어요', body: '새 급여 주기의 돈을 나눌 시간이에요. 월급 분배 미션을 확인하세요.', url: '/#missions' });
    add(new Date(midnight(date) + KST).getUTCDay() === config.push.weeklyReview.dayOfWeek, 'weekly', config.push.weeklyReview.hour, config.push.weeklyReview.minute, { title: '이번 주 수비 기록', body: '기록한 지출을 가볍게 돌아보고 다음 주를 준비해요.', url: '/#stats' });
    add(nextDay === config.salary.payday, 'cycle-end', config.push.cycleEnd.hour, config.push.cycleEnd.minute, { title: '이번 급여 주기 마무리', body: '한 주기를 지켜냈어요. 기록과 미션을 함께 정리해볼까요?', url: '/#stats' });
  }
  return output;
}

export async function eventStatements(db: D1Database, userId: string, key: string, payload: Omit<NotificationPayload, 'tag'>, now: number, expiresAt = now + DAY, writeId?: string, testCap = false): Promise<D1PreparedStatement[]> {
  const id = crypto.randomUUID();
  const complete: NotificationPayload = { ...payload, tag: (await hash(`${userId}:${key}`)).slice(0, 32) };
  const fence = writeId === undefined ? '' : ' AND EXISTS (SELECT 1 FROM states WHERE user_id=? AND write_id=?)';
  const bindings = writeId === undefined ? [] : [userId, writeId];
  const cap = testCap ? " AND (SELECT COUNT(*) FROM push_events WHERE user_id=? AND event_key LIKE 'test:%' AND created_at>?)<5" : '';
  const capBindings = testCap ? [userId, now - 60_000] : [];
  return [
    db.prepare(`INSERT OR IGNORE INTO push_events (id,user_id,event_key,payload,created_at,expires_at)
      SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM push_subscriptions WHERE user_id=?)${fence}${cap}`)
      .bind(id, userId, key, JSON.stringify(complete), now, expiresAt, userId, ...bindings, ...capBindings),
    db.prepare(`INSERT OR IGNORE INTO push_deliveries (id,event_id,subscription_id,next_attempt_at)
      SELECT lower(hex(randomblob(16))),?,id,? FROM push_subscriptions WHERE user_id=?
      AND EXISTS (SELECT 1 FROM push_events WHERE id=? AND user_id=?)${fence}`)
      .bind(id, now, userId, id, userId, ...bindings),
  ];
}

export async function budgetAlertStatements(db: D1Database, userId: string, state: AppState, now: number, writeId?: string): Promise<D1PreparedStatement[]> {
  if (!state.config.push.enabled || state.config.allocation.variableBudget <= 0) return [];
  const cycle = salaryCycle(new Date(now), state.config.salary.cycleStartDay);
  if (variableSpent(state, cycle) < Math.ceil(state.config.allocation.variableBudget * state.config.push.budgetThreshold)) return [];
  return eventStatements(db, userId, `budget:${cycle.key}`, { title: '생활비 예산을 확인해볼까요?', body: '기록한 지출이 설정한 예산 알림 기준에 도달했어요. 남은 계획을 가볍게 살펴보세요.', url: '/#home' }, now, now + DAY, writeId);
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response { return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers } }); }
export async function handlePushRequest(request: Request, env: Env, user: User, body: unknown): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (!path.startsWith('/api/push/')) return null;
  let configuration: PushConfiguration | null;
  try { configuration = await loadPushConfiguration(env); } catch { configuration = null; }
  const db = env.DB;
  const now = Date.now();
  const input = body as { subscription?: unknown; endpoint?: unknown; all?: unknown } | null;
  if (path === '/api/push/status' && request.method === 'GET') {
    const row = await db.prepare('SELECT COUNT(*) AS count FROM push_subscriptions WHERE user_id=?').bind(user.id).first<{ count: number }>();
    return json({ configured: configuration !== null, publicKey: configuration?.publicKey ?? null, subscribed: (row?.count ?? 0) > 0, deviceCount: row?.count ?? 0 });
  }
  if (path === '/api/push/subscribe' && request.method === 'POST') {
    if (!configuration) return json({ error: '서버 푸시 키와 암호화 키 설정이 필요합니다.' }, 503);
    let sub: BrowserSubscription;
    try { sub = await validateSubscription(input?.subscription); } catch { return json({ error: '올바른 푸시 구독과 지원되는 HTTPS 서비스 주소가 필요합니다.' }, 400); }
    const endpointHash = await hash(sub.endpoint);
    const encrypted = await encryptSubscription(sub, configuration.encryptionKey);
    await db.batch([
      db.prepare(`UPDATE push_deliveries SET status='cancelled',lease_until=NULL WHERE subscription_id IN
        (SELECT id FROM push_subscriptions WHERE endpoint_hash=? AND user_id<>?) AND status IN ('pending','sending')`).bind(endpointHash, user.id),
      db.prepare('DELETE FROM push_subscriptions WHERE endpoint_hash=? AND user_id<>?').bind(endpointHash, user.id),
      db.prepare(`INSERT INTO push_subscriptions (id,user_id,endpoint_hash,encrypted,created_at,updated_at) VALUES (?,?,?,?,?,?)
        ON CONFLICT(endpoint_hash) DO UPDATE SET encrypted=excluded.encrypted,updated_at=excluded.updated_at WHERE push_subscriptions.user_id=excluded.user_id`)
        .bind(crypto.randomUUID(), user.id, endpointHash, encrypted, now, now),
    ]);
    return json({ subscribed: true }, 201);
  }
  if (path === '/api/push/unsubscribe' && request.method === 'POST') {
    if (input?.all !== true && (typeof input?.endpoint !== 'string' || input.endpoint.length > 4096)) return json({ error: '해제할 기기 또는 전체 해제를 선택하세요.' }, 400);
    const endpointHash = input?.all === true ? null : await hash(input!.endpoint as string);
    const suffix = endpointHash === null ? '' : ' AND endpoint_hash=?';
    const bindings = endpointHash === null ? [user.id] : [user.id, endpointHash];
    await db.batch([
      db.prepare(`UPDATE push_deliveries SET status='cancelled',lease_until=NULL WHERE subscription_id IN (SELECT id FROM push_subscriptions WHERE user_id=?${suffix}) AND status IN ('pending','sending')`).bind(...bindings),
      db.prepare(`DELETE FROM push_subscriptions WHERE user_id=?${suffix}`).bind(...bindings),
    ]);
    return json({ unsubscribed: true });
  }
  if (path === '/api/push/test' && request.method === 'POST') {
    if (!configuration) return json({ error: '서버 푸시 설정이 필요합니다.' }, 503);
    const saved = await db.prepare('SELECT json FROM states WHERE user_id=?').bind(user.id).first<{ json: string }>();
    if (!saved || !(JSON.parse(saved.json) as AppState).config.push.enabled) return json({ error: '설정에서 알림을 먼저 켜주세요.' }, 409);
    const device = await db.prepare('SELECT id FROM push_subscriptions WHERE user_id=? LIMIT 1').bind(user.id).first();
    if (!device) return json({ error: '홈 화면 앱에서 알림을 허용하고 기기를 등록하세요.' }, 409);
    // Event insertion itself enforces the cap, including simultaneous requests and isolate restarts.
    const statements = await eventStatements(db, user.id, `test:${crypto.randomUUID()}`, { title: '월급수비대 테스트 알림', body: '수비대가 도착했어요! 앱을 열어 알림 설정을 확인해보세요.', url: '/#settings' }, now, now + DAY, undefined, true);
    const result = await db.batch(statements);
    if (!result[0].meta.changes) return json({ error: '테스트 알림은 1분에 5회까지 보낼 수 있어요.' }, 429, { 'Retry-After': '60' });
    return json({ queued: true }, 202);
  }
  return json({ error: '지원하지 않는 푸시 요청입니다.' }, 404);
}
