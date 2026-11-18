-- Upgrade the first Cloudflare D1 deployment in place.
--
-- The original schema created uploads(filename, extension, content_type,
-- created_at, data). Run this file once against that database before
-- deploying the chunked D1Store. It never drops or rewrites the existing
-- image bytes: legacy rows remain in uploads.data and are served as-is.
--
-- This migration intentionally targets the known legacy schema. A database
-- that already has these columns should use schema.sql instead of rerunning
-- this file, because SQLite/D1 does not support ADD COLUMN IF NOT EXISTS.

PRAGMA foreign_keys = ON;

ALTER TABLE uploads ADD COLUMN byte_length INTEGER NOT NULL DEFAULT 0;
ALTER TABLE uploads ADD COLUMN chunk_size INTEGER NOT NULL DEFAULT 0;
ALTER TABLE uploads ADD COLUMN chunk_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE uploads ADD COLUMN storage TEXT NOT NULL DEFAULT 'legacy';

UPDATE uploads
SET byte_length = length(data),
    storage = 'legacy'
WHERE byte_length = 0;

CREATE INDEX IF NOT EXISTS uploads_created_at_idx ON uploads(created_at);

CREATE TABLE IF NOT EXISTS upload_chunks (
  filename TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY (filename, chunk_index),
  FOREIGN KEY (filename) REFERENCES uploads(filename) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS upload_chunks_filename_idx ON upload_chunks(filename, chunk_index);
