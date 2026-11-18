import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStore } from "../lib/store.mjs";

test("并发保存不同学习会话时保留每条记录", async t => {
  const dir = await mkdtemp(join(tmpdir(), "sijie-store-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new FileStore(dir);
  await store.init();
  await Promise.all(Array.from({ length: 25 }, (_, i) => store.saveSession({ id: `session-${i}`, value: i })));
  const sessions = await store.sessions();
  assert.equal(sessions.length, 25);
  assert.equal(new Set(sessions.map(item => item.id)).size, 25);
});

test("学习记录损坏时停止写入并保留原始文件", async t => {
  const dir = await mkdtemp(join(tmpdir(), "sijie-store-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new FileStore(dir);
  await store.init();
  const broken = '{"unfinished":';
  await writeFile(store.sessionsPath, broken);
  await assert.rejects(store.saveSession({ id: "new-session" }), /停止写入/);
  assert.equal(await readFile(store.sessionsPath, "utf8"), broken);
});
