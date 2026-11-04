-- Lightline Compare — D1 schema
-- Apply with:  npx wrangler d1 execute lightline --remote --file=./schema.sql

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE,     -- stored lowercase; this is what keeps accounts separate
  name        TEXT NOT NULL,
  pw_salt     TEXT NOT NULL,
  pw_hash     TEXT NOT NULL,            -- PBKDF2-SHA256, never the password itself
  pw_iter     INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,         -- SHA-256 of the cookie value, not the value
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_exp  ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS folders (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_folders_user ON folders(user_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_folders_name ON folders(user_id, name);

CREATE TABLE IF NOT EXISTS items (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  folder_id   TEXT REFERENCES folders(id),
  title       TEXT NOT NULL,
  before_key  TEXT NOT NULL,            -- R2 key, namespaced u/{user_id}/{item_id}/before
  after_key   TEXT NOT NULL,
  before_type TEXT NOT NULL,
  after_type  TEXT NOT NULL,
  before_name TEXT,
  after_name  TEXT,
  w           INTEGER,                 -- after image pixel size (defines the frame)
  h           INTEGER,
  bw          INTEGER,                 -- before image pixel size
  bh          INTEGER,
  fit         TEXT DEFAULT 'cover',    -- 'cover' (match edges) or 'contain' (show all)
  pos         REAL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_user   ON items(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_items_folder ON items(user_id, folder_id, created_at DESC);
