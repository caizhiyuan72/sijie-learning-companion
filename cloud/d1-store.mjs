const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CONTENT_TYPES = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp"
};
// D1 rows are limited to roughly 2 MiB. 512 KiB chunks keep each write well
// below that limit while supporting the app's existing 8 MiB image limit.
const IMAGE_CHUNK_BYTES = 512 * 1024;
const MAX_D1_IMAGE_BYTES = 8 * 1024 * 1024;

function nowMs() {
  return Date.now();
}

function json(value) {
  return JSON.stringify(value ?? null);
}

function parsePayload(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function rowPayload(row, fallback = null) {
  return parsePayload(row?.payload, fallback);
}

function timestamp(value, fallback = nowMs()) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : fallback;
}

function fileName(extension) {
  const safe = String(extension || "bin").toLowerCase().replace(/[^a-z0-9]/g, "") || "bin";
  const id = globalThis.crypto?.randomUUID?.() || `${nowMs()}-${Math.random().toString(16).slice(2)}`;
  return `${id}.${safe}`;
}

function toBytes(buffer) {
  if (buffer instanceof Uint8Array) return buffer;
  if (buffer instanceof ArrayBuffer) return new Uint8Array(buffer);
  if (ArrayBuffer.isView(buffer)) return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  // Wrangler's local D1 adapter has returned BLOB values as number[] in some
  // versions, while production D1 normally returns Uint8Array/ArrayBuffer.
  if (Array.isArray(buffer)) return Uint8Array.from(buffer);
  throw new TypeError("图片数据必须是 Uint8Array 或 ArrayBuffer。");
}

/**
 * D1-backed replacement for lib/store.mjs's FileStore.
 *
 * `db` is a Cloudflare D1Database binding. The optional `bucket` may be an R2
 * bucket; when provided, image bytes are kept in R2 and D1 stores only the
 * metadata. Without it, small image bytes are stored as D1 BLOBs.
 */
export class D1Store {
  constructor(db, { bucket = null, imagePrefix = "sijie/uploads/" } = {}) {
    if (!db) throw new TypeError("D1Store 需要 Cloudflare D1 binding。");
    this.db = db;
    this.bucket = bucket;
    this.imagePrefix = imagePrefix;
  }

  async init() {
    // `exec` is available on the D1 binding and is convenient for first-time
    // setup. Production deployments should also apply schema.sql in CI.
    if (typeof this.db.exec === "function") {
      await this.db.exec(SCHEMA_SQL);
    } else {
      for (const statement of SCHEMA_STATEMENTS) await this.db.prepare(statement).run();
    }
    await this._ensureUploadSchema();
  }

  async _ensureUploadSchema() {
    const rows = await this._all("PRAGMA table_info(uploads)");
    const columns = new Set(rows.map(row => row.name));
    // The first deployed database used a single `data` BLOB column. Add the
    // manifest columns in place so existing uploads remain readable.
    const additions = [
      ["byte_length", "INTEGER NOT NULL DEFAULT 0"],
      ["chunk_size", "INTEGER NOT NULL DEFAULT 0"],
      ["chunk_count", "INTEGER NOT NULL DEFAULT 0"],
      ["storage", "TEXT NOT NULL DEFAULT 'legacy'"]
    ];
    for (const [name, definition] of additions) {
      if (!columns.has(name)) await this._run(`ALTER TABLE uploads ADD COLUMN ${name} ${definition}`);
    }
    // Backfill the size for rows from the old schema. These rows stay marked
    // `legacy` and are served from their original data BLOB.
    await this._run("UPDATE uploads SET byte_length = length(data) WHERE storage = 'legacy' AND byte_length = 0");
  }

  async _all(sql, ...values) {
    const result = await this.db.prepare(sql).bind(...values).all();
    return result?.results || [];
  }

  async _first(sql, ...values) {
    const statement = this.db.prepare(sql).bind(...values);
    if (typeof statement.first === "function") return statement.first();
    const rows = await statement.all();
    return rows?.results?.[0] || null;
  }

  async _run(sql, ...values) {
    return this.db.prepare(sql).bind(...values).run();
  }

  async _batch(statements) {
    if (!statements.length) return [];
    if (typeof this.db.batch === "function") return this.db.batch(statements);
    // This fallback is useful for local test doubles. Cloudflare D1 uses
    // batch() in production, so the manifest and all chunks are one transaction.
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }

  async drafts() {
    const rows = await this._all("SELECT payload FROM drafts WHERE created_at >= ? ORDER BY created_at ASC", nowMs() - DAY_MS);
    return rows.map(row => rowPayload(row)).filter(Boolean);
  }

  async draft(id) {
    const row = await this._first("SELECT payload FROM drafts WHERE id = ?", String(id || ""));
    return rowPayload(row);
  }

  async saveDraft(draft) {
    const value = draft || {};
    const id = String(value.id || "");
    if (!id) throw new TypeError("草稿缺少 id。");
    const createdAt = timestamp(value.createdAt);
    const cutoff = nowMs() - DAY_MS;
    await this._run("DELETE FROM drafts WHERE created_at < ? OR id = ?", cutoff, id);
    await this._run(
      "INSERT INTO drafts (id, created_at, payload) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET created_at = excluded.created_at, payload = excluded.payload",
      id,
      createdAt,
      json(value)
    );
    return value;
  }

  async tasks() {
    const rows = await this._all("SELECT payload FROM tasks ORDER BY updated_at ASC");
    return rows.map(row => rowPayload(row)).filter(Boolean);
  }

  async taskById(id) {
    const row = await this._first("SELECT payload FROM tasks WHERE id = ?", String(id || ""));
    return rowPayload(row);
  }

  async saveTask(task) {
    const value = task || {};
    const id = String(value.id || "");
    if (!id) throw new TypeError("任务缺少 id。");
    await this._run(
      "INSERT INTO tasks (id, updated_at, payload) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, payload = excluded.payload",
      id,
      timestamp(value.updatedAt),
      json(value)
    );
    return value;
  }

  async knowledgeCards({ id = "" } = {}) {
    const rows = id
      ? await this._all("SELECT payload FROM knowledge_cards WHERE id = ? ORDER BY version ASC", String(id))
      : await this._all("SELECT payload FROM knowledge_cards ORDER BY id ASC, version ASC");
    return rows.map(row => rowPayload(row)).filter(Boolean);
  }

  async knowledgeCard(id, version = null) {
    const row = version === null || version === undefined
      ? await this._first("SELECT payload FROM knowledge_cards WHERE id = ? ORDER BY version DESC LIMIT 1", String(id || ""))
      : await this._first("SELECT payload FROM knowledge_cards WHERE id = ? AND version = ?", String(id || ""), Number(version));
    return rowPayload(row);
  }

  async saveKnowledgeCard(card) {
    const value = card || {};
    const id = String(value.id || "");
    const version = Number(value.version);
    if (!id || !Number.isFinite(version) || !value.status) throw new TypeError("知识卡缺少 id、version 或 status。");
    const payload = json(value);
    const existing = await this.knowledgeCard(id, version);
    if (existing) {
      if (json(existing) !== payload) {
        const error = new Error("知识卡版本已存在且内容不同，不能覆盖历史版本。");
        error.code = "KNOWLEDGE_VERSION_CONFLICT";
        error.status = 409;
        throw error;
      }
      return value;
    }
    try {
      await this._run(
        "INSERT INTO knowledge_cards (id, version, status, updated_at, payload) VALUES (?, ?, ?, ?, ?)",
        id,
        version,
        String(value.status),
        timestamp(value.updatedAt),
        payload
      );
    } catch (cause) {
      // A concurrent writer may have inserted the same immutable key after
      // the read above. Treat an identical retry as idempotent, otherwise
      // expose a conflict rather than letting one writer replace history.
      const raced = await this.knowledgeCard(id, version);
      if (raced && json(raced) === payload) return value;
      const error = new Error("知识卡版本已存在且内容不同，不能覆盖历史版本。");
      error.code = "KNOWLEDGE_VERSION_CONFLICT";
      error.status = 409;
      error.cause = cause;
      throw error;
    }
    return value;
  }

  async archiveKnowledgeCards(id, exceptVersion = null) {
    // Compatibility hook only. Knowledge-card rows are immutable and the
    // active state is selected from the newest published/disabled version.
    return { id: String(id || ""), exceptVersion: exceptVersion === null ? null : Number(exceptVersion), changed: false };
  }

  async saveImage(buffer, extension) {
    const bytes = toBytes(buffer);
    const ext = String(extension || "bin").toLowerCase().replace(/[^a-z0-9]/g, "") || "bin";
    const filename = fileName(ext);
    const contentType = DEFAULT_CONTENT_TYPES[ext] || "application/octet-stream";
    const createdAt = nowMs();
    if (!this.bucket && bytes.byteLength > MAX_D1_IMAGE_BYTES) {
      const error = new Error("图片超过 8MB 限制，请压缩后再上传。");
      error.code = "IMAGE_TOO_LARGE";
      error.status = 413;
      throw error;
    }
    if (this.bucket) {
      await this.bucket.put(`${this.imagePrefix}${filename}`, bytes, { httpMetadata: { contentType } });
      await this._run(
        "INSERT INTO uploads (filename, extension, content_type, created_at, data, byte_length, chunk_size, chunk_count, storage) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        filename,
        ext,
        contentType,
        createdAt,
        new Uint8Array(),
        bytes.byteLength,
        0,
        0,
        "r2"
      );
    } else {
      const chunks = [];
      for (let offset = 0, index = 0; offset < bytes.byteLength; offset += IMAGE_CHUNK_BYTES, index += 1) {
        chunks.push(bytes.slice(offset, Math.min(offset + IMAGE_CHUNK_BYTES, bytes.byteLength)));
      }
      const statements = [this.db.prepare(
        "INSERT INTO uploads (filename, extension, content_type, created_at, data, byte_length, chunk_size, chunk_count, storage) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).bind(filename, ext, contentType, createdAt, new Uint8Array(), bytes.byteLength, IMAGE_CHUNK_BYTES, chunks.length, "d1")];
      chunks.forEach((chunk, index) => {
        statements.push(this.db.prepare(
          "INSERT INTO upload_chunks (filename, chunk_index, data) VALUES (?, ?, ?)"
        ).bind(filename, index, chunk));
      });
      await this._batch(statements);
    }
    return `/runtime-uploads/${filename}`;
  }

  async getImage(filename) {
    const name = String(filename || "").split("/").pop();
    if (!name || name.includes("..")) return null;
    const row = await this._first("SELECT filename, content_type, created_at, data, byte_length, storage FROM uploads WHERE filename = ?", name);
    if (!row) return null;
    const createdAt = Number(row.created_at);
    if (!Number.isFinite(createdAt) || nowMs() - createdAt > DAY_MS) {
      await this._deleteImage(name, row.storage);
      return null;
    }
    if (row.storage === "legacy") {
      const body = toBytes(row.data || new Uint8Array());
      return { body, contentType: row.content_type, filename: row.filename, createdAt: row.created_at };
    }
    if (row.storage === "r2" && this.bucket) {
      const object = await this.bucket.get(`${this.imagePrefix}${name}`);
      if (!object) return null;
      return { body: object.body, contentType: row.content_type, filename: row.filename, createdAt: row.created_at };
    }
    const chunks = await this._all("SELECT data FROM upload_chunks WHERE filename = ? ORDER BY chunk_index ASC", name);
    const total = Number(row.byte_length || 0);
    const body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      const bytes = toBytes(chunk.data);
      body.set(bytes, offset);
      offset += bytes.byteLength;
    }
    if (offset !== total) return null;
    return { body, contentType: row.content_type, filename: row.filename, createdAt: row.created_at };
  }

  async _deleteImage(filename, storage = "d1") {
    if (storage === "r2" && this.bucket) await this.bucket.delete(`${this.imagePrefix}${filename}`);
    await this._batch([
      this.db.prepare("DELETE FROM upload_chunks WHERE filename = ?").bind(filename),
      this.db.prepare("DELETE FROM uploads WHERE filename = ?").bind(filename)
    ]);
  }

  async cleanupUploads(maxAgeMs = DAY_MS) {
    const cutoff = nowMs() - maxAgeMs;
    const rows = await this._all("SELECT filename, storage FROM uploads WHERE created_at < ?", cutoff);
    const statements = [];
    for (const row of rows) {
      if (row.storage === "r2" && this.bucket) await this.bucket.delete(`${this.imagePrefix}${row.filename}`);
      statements.push(this.db.prepare("DELETE FROM upload_chunks WHERE filename = ?").bind(row.filename));
      statements.push(this.db.prepare("DELETE FROM uploads WHERE filename = ?").bind(row.filename));
    }
    await this._batch(statements);
  }

  async sessions() {
    const rows = await this._all("SELECT payload FROM sessions ORDER BY updated_at ASC");
    return rows.map(row => rowPayload(row)).filter(Boolean);
  }

  async session(id) {
    const row = await this._first("SELECT payload FROM sessions WHERE id = ?", String(id || ""));
    return rowPayload(row);
  }

  async saveSession(session) {
    const value = session || {};
    const id = String(value.id || "");
    if (!id) throw new TypeError("会话缺少 id。");
    await this._run(
      "INSERT INTO sessions (id, task_id, updated_at, payload) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET task_id = excluded.task_id, updated_at = excluded.updated_at, payload = excluded.payload",
      id,
      String(value.taskId || ""),
      timestamp(value.updatedAt),
      json(value)
    );
    return value;
  }

  async event(event) {
    const value = event || {};
    const id = String(value.id || fileName("event").replace(/\.event$/, ""));
    const at = timestamp(value.at);
    const payload = { ...value };
    delete payload.id;
    delete payload.at;
    delete payload.sessionId;
    delete payload.taskId;
    delete payload.stage;
    delete payload.type;
    await this._run(
      "INSERT INTO events (id, at, session_id, task_id, stage, type, payload) VALUES (?, ?, ?, ?, ?, ?, ?)",
      id,
      at,
      String(value.sessionId || ""),
      value.taskId ? String(value.taskId) : null,
      value.stage ? String(value.stage) : null,
      String(value.type || "event"),
      json(payload)
    );
    return { id, at: new Date(at).toISOString(), ...value };
  }

  async events(sessionId = "") {
    const rows = sessionId
      ? await this._all("SELECT id, at, session_id, task_id, stage, type, payload FROM events WHERE session_id = ? ORDER BY at ASC", String(sessionId))
      : await this._all("SELECT id, at, session_id, task_id, stage, type, payload FROM events ORDER BY at ASC");
    return rows.map(row => ({
      id: row.id,
      at: new Date(Number(row.at)).toISOString(),
      sessionId: row.session_id,
      ...(row.task_id ? { taskId: row.task_id } : {}),
      ...(row.stage ? { stage: row.stage } : {}),
      type: row.type,
      ...rowPayload(row, {})
    }));
  }
}

export const SCHEMA_STATEMENTS = [
  "CREATE TABLE IF NOT EXISTS drafts (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, payload TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS drafts_created_at_idx ON drafts(created_at)",
  "CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, updated_at INTEGER NOT NULL, payload TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS knowledge_cards (id TEXT NOT NULL, version INTEGER NOT NULL, status TEXT NOT NULL, updated_at INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(id, version))",
  "CREATE INDEX IF NOT EXISTS knowledge_cards_status_idx ON knowledge_cards(status, updated_at)",
  "CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, updated_at INTEGER NOT NULL, payload TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS sessions_task_id_idx ON sessions(task_id)",
  "CREATE INDEX IF NOT EXISTS sessions_updated_at_idx ON sessions(updated_at)",
  "CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, at INTEGER NOT NULL, session_id TEXT NOT NULL, task_id TEXT, stage TEXT, type TEXT NOT NULL, payload TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS events_session_id_idx ON events(session_id, at)",
  "CREATE INDEX IF NOT EXISTS events_at_idx ON events(at)",
  "CREATE TABLE IF NOT EXISTS uploads (filename TEXT PRIMARY KEY, extension TEXT NOT NULL, content_type TEXT NOT NULL, created_at INTEGER NOT NULL, data BLOB NOT NULL DEFAULT X'', byte_length INTEGER NOT NULL, chunk_size INTEGER NOT NULL, chunk_count INTEGER NOT NULL, storage TEXT NOT NULL DEFAULT 'd1')",
  "CREATE INDEX IF NOT EXISTS uploads_created_at_idx ON uploads(created_at)",
  "CREATE TABLE IF NOT EXISTS upload_chunks (filename TEXT NOT NULL, chunk_index INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (filename, chunk_index), FOREIGN KEY (filename) REFERENCES uploads(filename) ON DELETE CASCADE)",
  "CREATE INDEX IF NOT EXISTS upload_chunks_filename_idx ON upload_chunks(filename, chunk_index)"
];

export const SCHEMA_SQL = `${SCHEMA_STATEMENTS.map(statement => `${statement};`).join("\n")}\n`;
