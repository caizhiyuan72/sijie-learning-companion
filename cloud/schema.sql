-- 思阶 Cloudflare D1 schema.
-- JSON payloads preserve the existing FileStore shapes while D1 provides
-- durable, atomic row-level upserts for multiple Worker instances.

CREATE TABLE IF NOT EXISTS drafts (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  payload TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS drafts_created_at_idx ON drafts(created_at);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  updated_at INTEGER NOT NULL,
  payload TEXT NOT NULL
);

-- Immutable knowledge-card versions. Only the newest published version for an
-- id is active; older rows remain as history and can be audited or restored.
CREATE TABLE IF NOT EXISTS knowledge_cards (
  id TEXT NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (id, version)
);

CREATE INDEX IF NOT EXISTS knowledge_cards_status_idx ON knowledge_cards(status, updated_at);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  payload TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_task_id_idx ON sessions(task_id);
CREATE INDEX IF NOT EXISTS sessions_updated_at_idx ON sessions(updated_at);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  task_id TEXT,
  stage TEXT,
  type TEXT NOT NULL,
  payload TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS events_session_id_idx ON events(session_id, at);
CREATE INDEX IF NOT EXISTS events_at_idx ON events(at);

-- The current application accepts PNG/JPEG/WebP uploads. D1 rows are limited
-- to roughly 2 MiB, so d1-store.mjs splits each image into 512 KiB chunks.
-- An optional R2 binding remains supported, but is not required.
CREATE TABLE IF NOT EXISTS uploads (
  filename TEXT PRIMARY KEY,
  extension TEXT NOT NULL,
  content_type TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  -- Kept for compatibility with the first deployed schema. New D1 uploads
  -- leave this empty and store actual bytes in upload_chunks.
  data BLOB NOT NULL DEFAULT X'',
  byte_length INTEGER NOT NULL,
  chunk_size INTEGER NOT NULL,
  chunk_count INTEGER NOT NULL,
  storage TEXT NOT NULL DEFAULT 'd1'
);

CREATE INDEX IF NOT EXISTS uploads_created_at_idx ON uploads(created_at);

CREATE TABLE IF NOT EXISTS upload_chunks (
  filename TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY (filename, chunk_index),
  FOREIGN KEY (filename) REFERENCES uploads(filename) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS upload_chunks_filename_idx ON upload_chunks(filename, chunk_index);
