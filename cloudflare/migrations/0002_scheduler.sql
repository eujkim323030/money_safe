ALTER TABLE users ADD COLUMN push_checked_at INTEGER NOT NULL DEFAULT 0;
CREATE INDEX users_push_checked ON users(push_checked_at, id);
