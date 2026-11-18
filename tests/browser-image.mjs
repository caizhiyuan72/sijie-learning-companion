/*
 * Browser QA for the mobile image path.
 *
 * Usage:
 *   PLAYWRIGHT_MODULE_PATH=/tmp/sijie-qa-tools/node_modules/playwright \
 *   node tests/browser-image.mjs
 *
 * The script starts a static-only test server and intercepts API calls in the
 * browser, so it does not need a model key or a running application server.
 * Playwright is the only external dependency; set PLAYWRIGHT_MODULE_PATH to
 * its package directory (or an index.mjs file) when it is not installed here.
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deflateSync } from "node:zlib";

async function loadPlaywright() {
  const configured = process.env.PLAYWRIGHT_MODULE_PATH;
  const candidates = configured
    ? [configured]
    : ["/tmp/sijie-qa-tools/node_modules/playwright", "playwright"];
  for (const candidate of candidates) {
    try {
      const target = candidate.startsWith("/")
        ? (candidate.endsWith(".mjs") || candidate.endsWith(".js") ? candidate : join(candidate, "index.mjs"))
        : candidate;
      return await import(target.startsWith("/") ? pathToFileURL(target).href : target);
    } catch {
      // Try the next configured/default location.
    }
  }
  throw new Error("找不到Playwright。请设置 PLAYWRIGHT_MODULE_PATH=/path/to/node_modules/playwright。");
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const value of buffer) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const payload = Buffer.concat([name, data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(payload));
  const size = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  return Buffer.concat([size, payload, checksum]);
}

function makePng(width, height, color) {
  const row = Buffer.alloc(1 + width * 4);
  row[0] = 0;
  for (let x = 0; x < width; x += 1) color.copy(row, 1 + x * 4);
  const raw = Buffer.alloc(row.length * height);
  for (let y = 0; y < height; y += 1) row.copy(raw, y * row.length);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw, { level: 6 })),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

const root = fileURLToPath(new URL("..", import.meta.url));
const staticTypes = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
  if (pathname.startsWith("/api/")) {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "test route should be intercepted" }));
    return;
  }
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\//u, "");
  const filePath = join(root, relative);
  if (!filePath.startsWith(root) || !existsSync(filePath)) {
    response.writeHead(404);
    response.end("Not found");
    return;
  }
  response.writeHead(200, { "content-type": staticTypes[extname(filePath)] || "application/octet-stream" });
  response.end(await readFile(filePath));
});

function json(route, payload, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(payload) });
}

const task = {
  id: "task-ui-qa",
  grade: "八年级",
  subject: "初中数学",
  problemType: "equation",
  isMathProblem: true,
  isGeometryProof: false,
  title: "方程题",
  problemText: "2x=4",
  proofGoal: "求x",
  learningGoal: "整理等量关系",
  knownFacts: ["2x=4"],
  hints: [{ level: 1, kind: "question", content: "先找等量关系" }],
  judgmentCard: { statement: "把两边同时除以2可以得到x。", correctVerdict: "合理", reason: "等式两边同时进行同一运算。" }
};

async function installApiMocks(page, { judgmentRetry = false } = {}) {
  const calls = [];
  await page.route("**/api/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    calls.push({ path: url.pathname, method: request.method(), body: request.postDataJSON?.() || null });
    if (url.pathname === "/api/status") return json(route, { configured: true, available: true, model: "ui-qa", mode: "test" });
    if (url.pathname === "/api/problem/analyze") {
      return json(route, {
        draftId: "draft-ui-qa",
        draft: { ...task, known: "2x=4", goal: "求x" },
        analysis: { ...task, needsClarification: false, clarification: "" },
        decision: "pass",
        needsClarification: false,
        confidence: 0.95
      });
    }
    if (url.pathname === "/api/session" && request.method() === "POST") {
      return json(route, { session: { id: "session-ui-qa", stage: "initial_thinking", answers: {}, completedHints: [] }, task });
    }
    if (url.pathname.endsWith("/initial")) {
      return json(route, { session: { id: "session-ui-qa", stage: "judgment", answers: {}, completedHints: [] }, task, evaluation: { decision: "pass", feedback: "先思已记录。" } });
    }
    if (url.pathname.endsWith("/judgment")) {
      return json(route, {
        session: { id: "session-ui-qa", stage: judgmentRetry ? "judgment" : "transfer", answers: {}, completedHints: [] },
        task: { ...task, transferTask: { text: "3x=6，求x", knowledgePoint: "等式" } },
        evaluation: { decision: judgmentRetry ? "retry" : "pass", feedback: judgmentRetry ? "请再核对等式两边的同一运算。" : "判断已记录。", nextPrompt: "写出同一运算。" }
      });
    }
    return json(route, { error: "未配置的UI测试接口", code: "TEST_ROUTE_MISSING", retryable: false }, 404);
  });
  return calls;
}

async function waitProcessed(page, selector = "#problemUploadStatus") {
  await page.waitForFunction(sel => /已处理/u.test(document.querySelector(sel)?.textContent || ""), selector);
}

async function newPage(browser) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, deviceScaleFactor: 2 });
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: "networkidle" });
  return page;
}

async function main() {
  const { chromium } = await loadPlaywright();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const executablePath = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const browser = await chromium.launch({ ...(existsSync(executablePath) ? { executablePath } : {}), headless: true });
  const high = makePng(4032, 3024, Buffer.from([245, 245, 245, 255]));
  const red = makePng(1600, 900, Buffer.from([220, 80, 70, 255]));
  const blue = makePng(800, 600, Buffer.from([60, 110, 220, 255]));

  try {
    {
      const page = await newPage(browser);
      const calls = await installApiMocks(page);
      await page.selectOption("#problemGrade", "八年级");
      assert.equal(await page.locator('input[capture]').count(), 0, "不再显示不可靠的直接拍照入口");
      const [chooser] = await Promise.all([
        page.waitForEvent("filechooser"),
        page.locator('.drop-zone[for="problemImage-gallery"]').click()
      ]);
      assert.equal(await chooser.element().getAttribute("capture"), null);
      await chooser.setFiles({ name: "phone-4032x3024.png", mimeType: "image/png", buffer: high });
      await waitProcessed(page);
      const status = await page.locator("#problemUploadStatus").innerText();
      assert.match(status, /2048×1536/u, "4032×3024图片应缩放到长边2048");
      assert.ok(Number(status.match(/·\s*(\d+)KB/u)?.[1] || 0) <= 2048, "输出应达到2MB目标");
      assert.equal(calls.filter(call => call.path === "/api/problem/analyze").length, 0);
      console.log("✓ 已移除拍照入口，点击选择图片可打开选图并完成高分辨率压缩");
      await page.close();
    }

    {
      const page = await newPage(browser);
      await installApiMocks(page);
      await page.setInputFiles("#problemImage-gallery", { name: "first.png", mimeType: "image/png", buffer: red });
      await waitProcessed(page);
      const first = await page.locator("#problemImagePreview").getAttribute("src");
      await page.setInputFiles("#problemImage-gallery", { name: "second.png", mimeType: "image/png", buffer: blue });
      await waitProcessed(page);
      const second = await page.locator("#problemImagePreview").getAttribute("src");
      assert.notEqual(first, second, "替换图片后预览应更新");
      assert.match(await page.locator("#problemUploadStatus").innerText(), /800×600/u);
      await page.locator("#problemImageClear").click();
      assert.notEqual(await page.locator("#problemImagePreview").getAttribute("hidden"), null, "移除后预览应隐藏");
      assert.match(await page.locator("#problemUploadStatus").innerText(), /尚未选择图片/u);
      console.log("✓ 图片快速替换与移除");
      await page.close();
    }

    {
      const page = await newPage(browser);
      const calls = await installApiMocks(page);
      await page.addInitScript(() => {
        const original = HTMLCanvasElement.prototype.toBlob;
        HTMLCanvasElement.prototype.toBlob = function delayedToBlob(callback, type, quality) {
          setTimeout(() => original.call(this, callback, type, quality), 120);
        };
      });
      await page.setInputFiles("#problemImage-gallery", { name: "slow.png", mimeType: "image/png", buffer: high });
      await page.locator("#problemForm button[type=submit]").click();
      await page.waitForTimeout(40);
      assert.match(await page.locator("#toast").innerText(), /处理中/u, "处理中提交应被拦截");
      assert.equal(calls.filter(call => call.path === "/api/problem/analyze").length, 0, "处理中不应发识题请求");
      console.log("✓ 图片处理中提交拦截");
      await page.close();
    }

    {
      const page = await newPage(browser);
      await installApiMocks(page);
      await page.setInputFiles("#problemImage-gallery", { name: "good.png", mimeType: "image/png", buffer: red });
      await waitProcessed(page);
      const previous = await page.locator("#problemImagePreview").getAttribute("src");
      await page.setInputFiles("#problemImage-gallery", { name: "bad.heic", mimeType: "image/heic", buffer: Buffer.from("not-a-real-heic") });
      await page.waitForTimeout(500);
      assert.equal(await page.locator("#problemImagePreview").getAttribute("src"), previous, "HEIC无法解码时应保留上一张");
      assert.match(await page.locator("#problemUploadStatus").innerText(), /保留上一张/u);
      console.log("✓ 无法解码HEIC保留上一张");
      await page.close();
    }

    {
      const page = await newPage(browser);
      const calls = await installApiMocks(page, { judgmentRetry: true });
      await page.selectOption("#problemGrade", "八年级");
      await page.fill("#problemTextInput", "2x=4");
      await page.click("#problemForm button[type=submit]");
      await page.waitForSelector("#draftForm");
      await page.click("#draftForm button[type=submit]");
      await page.waitForSelector("#initialForm");
      await page.fill("#initialKnown", "2x=4");
      await page.click("#initialForm button[type=submit]");
      await page.waitForSelector("#judgmentForm");
      await page.locator("#judgmentForm input[value=不合理]").check({ force: true });
      await page.fill("#judgment-answer-text", "这一步需要再核对");
      await page.setInputFiles("#judgment-answer-gallery", { name: "reason.png", mimeType: "image/png", buffer: blue });
      await page.waitForFunction(() => /已处理/u.test(document.querySelector("#judgment-answer-status")?.textContent || ""));
      await page.click("#judgmentForm button[type=submit]");
      await page.waitForSelector("#judgmentForm");
      assert.equal(await page.locator("#judgmentForm input[value=不合理]").isChecked(), true, "retry后应保留判断选项");
      assert.equal(await page.locator("#judgment-answer-text").inputValue(), "这一步需要再核对", "retry后应保留学生文字");
      assert.equal(await page.locator("#judgment-answer-preview").getAttribute("hidden"), null, "retry后应保留学生图片");
      console.log("✓ clearer_input/retry保留图文与判断");
      await page.close();
    }

    {
      const page = await newPage(browser);
      const calls = await installApiMocks(page);
      await page.setInputFiles("#problemImage-gallery", { name: "original.png", mimeType: "image/png", buffer: red });
      await waitProcessed(page);
      await page.fill("#problemTextInput", "2x=4");
      await page.click("#problemForm button[type=submit]");
      await page.waitForSelector("#draftForm");
      await page.click("#draftForm button[type=submit]");
      await page.waitForSelector("#initialForm");
      assert.notEqual(await page.locator("#initial-answer-preview").getAttribute("hidden"), null, "原题图不能出现在先思作答图片中");
      await page.click("#initialForm button[type=submit]");
      assert.match(await page.locator("#toast").innerText(), /已知|手写|目标/u, "原题图不应被当作先思答案放行");
      assert.equal(calls.some(call => call.path.endsWith("/initial")), false, "原题图不应触发先思提交");
      console.log("✓ 原题图片不计入先思作答");
      await page.close();
    }
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
