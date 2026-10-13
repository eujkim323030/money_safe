import type { D1Database, Fetcher } from '@cloudflare/workers-types';
export type { User } from '../shared/types';

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
  DATA_ENCRYPTION_KEY?: string;
  SESSION_SECRET?: string;
  PUBLIC_ORIGIN?: string;
}

export interface CloudUserRow {
  id: string;
  email: string;
  password_hash: string;
  created_at: number;
  last_expense_at: number;
}
export interface CloudStateRow {
  json: string;
  revision: number;
  write_id: string;
}
