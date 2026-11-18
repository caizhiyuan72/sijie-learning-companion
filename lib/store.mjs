import { appendFile, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

async function readJson(path, fallback = []) {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (!Array.isArray(value)) throw new TypeError("存储内容不是数组");
    return value;
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    // Never treat unreadable existing records as an empty collection: a later
    // save would otherwise overwrite the only copy of the user's data.
    throw new Error("无法读取学习记录，已停止写入以保护原有数据，请联系管理员检查。", { cause: error });
  }
}

export class FileStore {
  constructor(root, configuredRuntimeDir = "") {
    this.runtimeDir = configuredRuntimeDir
      ? (isAbsolute(configuredRuntimeDir) ? configuredRuntimeDir : resolve(root, configuredRuntimeDir))
      : join(root, "data", "runtime");
    this.draftsPath = join(this.runtimeDir, "problem-drafts.json");
    this.tasksPath = join(this.runtimeDir, "tasks.json");
    this.knowledgePath = join(this.runtimeDir, "knowledge-cards.json");
    this.sessionsPath = join(this.runtimeDir, "sessions.json");
    this.eventsPath = join(this.runtimeDir, "events.jsonl");
    this.uploadsDir = join(this.runtimeDir, "uploads");
    this.pendingWrites = new Map();
  }

  async updateCollection(path, update) {
    // Serialize read-modify-write cycles within this process so concurrent
    // sessions cannot silently replace one another's changes.
    const previous = this.pendingWrites.get(path) || Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      const result = update(await readJson(path));
      const temporary = `${path}.${crypto.randomUUID()}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
        await rename(temporary, path);
      } finally {
        await unlink(temporary).catch(() => {});
      }
    });
    this.pendingWrites.set(path, next);
    try { await next; } finally {
      if (this.pendingWrites.get(path) === next) this.pendingWrites.delete(path);
    }
  }

  async init() {
    await mkdir(this.runtimeDir, { recursive: true });
    await mkdir(this.uploadsDir, { recursive: true });
    if (!existsSync(this.draftsPath)) await writeFile(this.draftsPath, "[]\n");
    if (!existsSync(this.tasksPath)) await writeFile(this.tasksPath, "[]\n");
    if (!existsSync(this.knowledgePath)) await writeFile(this.knowledgePath, "[]\n");
    if (!existsSync(this.sessionsPath)) await writeFile(this.sessionsPath, "[]\n");
    if (!existsSync(this.eventsPath)) await writeFile(this.eventsPath, "");
    await this.cleanupUploads();
  }

  async drafts() { return readJson(this.draftsPath); }
  async draft(id) { return (await this.drafts()).find(item => item.id === id); }
  async saveDraft(draft) {
    await this.updateCollection(this.draftsPath, drafts => {
      const next = drafts.filter(item => item.id !== draft.id && Date.parse(item.createdAt || 0) > Date.now() - 24 * 60 * 60 * 1000);
      next.push(draft);
      return next;
    });
    return draft;
  }

  async tasks() { return readJson(this.tasksPath); }
  async taskById(id) { return (await this.tasks()).find(task => task.id === id); }
  async saveTask(task) {
    await this.updateCollection(this.tasksPath, tasks => {
      const index = tasks.findIndex(item => item.id === task.id);
      if (index >= 0) tasks[index] = task; else tasks.push(task);
      return tasks;
    });
    return task;
  }

  async knowledgeCards() { return readJson(this.knowledgePath); }

  async knowledgeCard(id, version = null) {
    const records = (await this.knowledgeCards()).filter(item => item?.id === String(id || ""));
    if (version !== null && version !== undefined) return records.find(item => Number(item.version) === Number(version)) || null;
    return records.sort((a, b) => Number(b.version || 0) - Number(a.version || 0))[0] || null;
  }

  async saveKnowledgeCard(card) {
    const value = card && typeof card === "object" ? card : {};
    if (!value.id || !Number.isFinite(Number(value.version)) || !value.status) throw new TypeError("知识卡缺少 id、version 或 status。");
    await this.updateCollection(this.knowledgePath, records => {
      const index = records.findIndex(item => item?.id === value.id && Number(item.version) === Number(value.version));
      if (index >= 0) {
        // Versions are append-only. A retry of the exact same write is safe,
        // but a different payload must never overwrite audit history.
        if (JSON.stringify(records[index]) !== JSON.stringify(value)) {
          const error = new Error("知识卡版本已存在且内容不同，不能覆盖历史版本。");
          error.code = "KNOWLEDGE_VERSION_CONFLICT";
          error.status = 409;
          throw error;
        }
        return records;
      }
      records.push(value);
      return records;
    });
    return value;
  }

  async archiveKnowledgeCards(id, exceptVersion = null) {
    // Kept as a compatibility hook for older callers. Published history is
    // immutable; publish/disable append a new effective version instead.
    return { id: String(id || ""), exceptVersion: exceptVersion === null ? null : Number(exceptVersion), changed: false };
  }

  async saveImage(buffer, extension) {
    const filename = `${crypto.randomUUID()}.${extension}`;
    await writeFile(join(this.uploadsDir, filename), buffer);
    return `/runtime-uploads/${filename}`;
  }

  async cleanupUploads(maxAgeMs = 24 * 60 * 60 * 1000) {
    const now = Date.now();
    for (const filename of await readdir(this.uploadsDir).catch(() => [])) {
      const path = join(this.uploadsDir, filename);
      const info = await stat(path).catch(() => null);
      if (info?.isFile() && now - info.mtimeMs > maxAgeMs) await unlink(path).catch(() => {});
    }
  }

  async sessions() { return readJson(this.sessionsPath); }
  async session(id) { return (await this.sessions()).find(item => item.id === id); }
  async saveSession(session) {
    await this.updateCollection(this.sessionsPath, sessions => {
      const index = sessions.findIndex(item => item.id === session.id);
      if (index >= 0) sessions[index] = session; else sessions.push(session);
      return sessions;
    });
    return session;
  }

  async event(event) {
    const record = { id: crypto.randomUUID(), at: new Date().toISOString(), ...event };
    await appendFile(this.eventsPath, `${JSON.stringify(record)}\n`);
    return record;
  }

  async events(sessionId = "") {
    if (!existsSync(this.eventsPath)) return [];
    const raw = await readFile(this.eventsPath, "utf8");
    const rows = raw.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    return sessionId ? rows.filter(row => row.sessionId === sessionId) : rows;
  }
}
