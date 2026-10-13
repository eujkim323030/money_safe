import type { D1Database } from '@cloudflare/workers-types';
import type { User } from '../shared/types';
import type { CloudStateRow, CloudUserRow } from './types';

export async function findUserByEmail(db: D1Database, email: string): Promise<CloudUserRow | null> {
  return db.prepare('SELECT id,email,password_hash,created_at,last_expense_at FROM users WHERE email=?').bind(email).first<CloudUserRow>();
}

export async function findAuthenticatedUser(db: D1Database, hash: string, now: number): Promise<User | null> {
  return db.prepare(`SELECT u.id,u.email FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.hash=? AND s.expires_at>?`).bind(hash, now).first<User>();
}

export async function getState(db: D1Database, userId: string): Promise<CloudStateRow | null> {
  return db.prepare('SELECT json,revision,write_id FROM states WHERE user_id=?').bind(userId).first<CloudStateRow>();
}

/** The conditional UPSERT admits at most limit concurrent requests in a window. */
export async function consumeRateLimit(db: D1Database, key: string, limit: number, windowMs: number, now: number): Promise<boolean> {
  const allowed = await db.prepare(`INSERT INTO rate_limits(key,count,reset_at) VALUES(?,1,?)
    ON CONFLICT(key) DO UPDATE SET
      count=CASE WHEN reset_at<=? THEN 1 ELSE count+1 END,
      reset_at=CASE WHEN reset_at<=? THEN ? ELSE reset_at END
    WHERE reset_at<=? OR count<? RETURNING count`)
    .bind(key, now + windowMs, now, now, now + windowMs, now, limit).first<{ count: number }>();
  return allowed !== null;
}
