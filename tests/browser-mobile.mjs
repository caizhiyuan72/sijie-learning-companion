/*
 * Browser QA for the mobile two-screen flow.
 *
 * Usage:
 *   PLAYWRIGHT_MODULE_PATH=/tmp/sijie-qa-tools/node_modules/playwright \
 *   node tests/browser-mobile.mjs
 *
 * The page is served statically and all API calls are intercepted in the
 * browser. No model key or running backend is needed.
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

const root = fileURLToPath(new URL("..", import.meta.url));
const staticTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml"
};
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

const task = {
  id: "task-mobile-qa",
  grade: "八年级",
  subject: "初中数学",
  title: "方程题",
  problemText: "2x=4",
  goal: "求x",
  learningGoal: "整理等量关系"
};

function json(route, payload, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(payload) });
}

async function installApiMocks(page, { completed = true } = {}) {
  await page.route("**/api/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/status") return json(route, { configured: true, available: true, model: "mobile-qa" });
    if (url.pathname === "/api/problem/analyze") {
      return json(route, { draftId: "draft-mobile-qa", draft: { ...task, known: "2x=4" }, decision: "pass", confidence: 0.95 });
    }
    if (url.pathname === "/api/session" && request.method() === "POST") {
      return json(route, {
        session: { id: "session-mobile-qa", stage: completed ? "completed" : "initial_thinking", answers: {} },
        task,
        learningOutcome: {
          flowCompleted: true,
          status: "review_required",
          label: "本轮已完成，建议复核",
          description: "五个阶段均已留下记录。",
          needsTeacherReview: true,
          taskReview: { reason: "题目条件仍需要人工核对。" },
          stages: [
            { key: "initial", label: "先思", status: "independent" },
            { key: "help", label: "求助", status: "assisted" },
            { key: "judgment", label: "判别", status: "pending" },
            { key: "transfer", label: "迁移", status: "review_required", reason: "迁移题还需要老师复核。" }
          ]
        }
      });
    }
    return json(route, { error: "未配置的UI测试接口", code: "TEST_ROUTE_MISSING", retryable: false }, 404);
  });
}

async function dispatchTouchSwipe(client, start, end) {
  await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: start.x, y: start.y, radiusX: 4, radiusY: 4, id: 71 }] });
  const steps = 4;
  for (let index = 1; index <= steps; index += 1) {
    const progress = index / steps;
    await client.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: start.x + (end.x - start.x) * progress, y: start.y + (end.y - start.y) * progress, radiusX: 4, radiusY: 4, id: 71 }]
    });
  }
  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

async function main() {
  const { chromium } = await loadPlaywright();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const executablePath = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const browser = await chromium.launch({ ...(existsSync(executablePath) ? { executablePath } : {}), headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await installApiMocks(page);
    await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: "networkidle" });

    assert.equal(await page.locator("#mobileFlow").getAttribute("data-screen"), "topic");
    assert.equal(await page.locator("#topicImportContent #problemForm").isVisible(), true, "第一屏应直接显示导题表单");
    assert.equal(await page.locator("#mobileLearning #studentContent").isVisible(), false, "未建会话时第二屏不应出现空作答区");
    const formTop = await page.locator("#topicImportContent #importCard").evaluate(element => element.getBoundingClientRect().top);
    assert.ok(formTop < 300, `首次导题表单应在手机首屏靠前位置（当前${formTop}px）`);
    const textTop = await page.locator("#problemTextInput").evaluate(element => element.getBoundingClientRect().top);
    assert.ok(textTop < 844, `题目文字输入应在手机首屏可见范围（当前${textTop}px）`);
    const imageTop = await page.locator("#problemImage-gallery").evaluate(element => element.closest(".file-button")?.getBoundingClientRect().top);
    assert.ok(imageTop < 844, `选图入口应在手机首屏可见范围（当前${imageTop}px）`);
    assert.ok(await page.evaluate(() => {
      const label = document.querySelector('label[for="problemGrade"]').getBoundingClientRect();
      const select = document.querySelector('#problemGrade').getBoundingClientRect();
      return select.top >= label.bottom && select.top - label.bottom < 30;
    }), "年级标签与选择框应保持相邻，不能被文字输入分开");
    assert.ok(await page.evaluate(() => document.body.scrollWidth <= innerWidth), "手机不应出现横向溢出");
    console.log("✓ 手机第一屏直接导题，未建会话时不显示空作答区");

    await page.fill("#problemTextInput", "2x=4");
    await page.click("#problemForm button[type=submit]");
    await page.waitForSelector("#draftForm");
    await page.click("#draftForm button[type=submit]");
    await page.waitForSelector("#mobileFlow[data-screen=learning]");
    await page.waitForTimeout(50);
    assert.equal(await page.locator("#mobileTopic").evaluate(element => element.inert), true, "作答页激活时题目页应从键盘焦点顺序移除");
    assert.equal(await page.locator("#mobileLearning").evaluate(element => element.inert), false, "作答页激活时当前页应可访问");
    assert.ok(await page.evaluate(() => {
      const track = document.querySelector("#mobileTrack").getBoundingClientRect().height;
      const active = document.querySelector("#mobileLearning").getBoundingClientRect().height;
      return Math.abs(track - active) < 3;
    }), "切到较短作答页时不应保留题目页的巨大空白高度");
    assert.equal(await page.locator("#studentContent .completed-card").isVisible(), true, "建会话后第二屏应显示当前阶段内容");
    assert.equal(await page.locator("#topicImportContent").innerText(), "", "已确认后第一屏不应重复显示导题表单");
    console.log("✓ 确认题目后自动进入第二屏并显示当前阶段");

    await page.click("#mobileHome");
    await page.waitForSelector("#mobileFlow[data-screen=topic]");
    assert.equal(await page.locator("#mobileTopic").evaluate(element => element.inert), false, "题目页激活时应可访问");
    assert.equal(await page.locator("#mobileLearning").evaluate(element => element.inert), true, "题目页激活时作答页应从键盘焦点顺序移除");
    assert.match(await page.locator("#taskTitle").innerText(), /方程题/u);
    assert.equal(await page.locator("#mobileTopicNext").isVisible(), true, "已建会话的题目页应提供进入作答按钮");
    await page.click("#mobileTopicNext");
    await page.waitForSelector("#mobileFlow[data-screen=learning]");
    console.log("✓ 按钮可在题目页与作答页之间切换并保留题目");

    await page.click("#mobileHome");
    await dispatchTouchSwipe(cdp, { x: 260, y: 330 }, { x: 100, y: 330 });
    await page.waitForSelector("#mobileFlow[data-screen=learning]");
    await page.click("#mobileHome");
    await dispatchTouchSwipe(cdp, { x: 190, y: 220 }, { x: 200, y: 610 });
    assert.equal(await page.locator("#mobileFlow").getAttribute("data-screen"), "topic", "垂直滚动手势不应切屏");
    console.log("✓ 左滑切到作答，垂直手势不误触发切屏");

    await page.click("#mobileTopicNext");
    await page.waitForSelector("#mobileFlow[data-screen=learning]");
    assert.match(await page.locator("#studentContent").innerText(), /完成本轮流程/u);
    assert.match(await page.locator("#studentContent").innerText(), /独立通过/u);
    assert.match(await page.locator("#studentContent").innerText(), /辅助继续/u);
    assert.match(await page.locator("#studentContent").innerText(), /尚未验证/u);
    assert.match(await page.locator("#studentContent").innerText(), /需老师复核/u);
    assert.match(await page.locator("#studentContent").innerText(), /本题建议由老师复核/u);
    console.log("✓ 完成页展示本轮结果与各阶段状态，不宣称掌握");

    await context.close();

    const draftContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    const draftPage = await draftContext.newPage();
    await installApiMocks(draftPage, { completed: false });
    await draftPage.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: "networkidle" });
    await draftPage.fill("#problemTextInput", "2x=4");
    await draftPage.click("#problemForm button[type=submit]");
    await draftPage.waitForSelector("#draftForm");
    await draftPage.click("#draftForm button[type=submit]");
    await draftPage.waitForSelector("#initialForm");
    assert.match(await draftPage.locator("#studentContent").innerText(), /本题建议由老师复核/u, "非完成阶段也应展示学生可理解的复核提示");
    await draftPage.waitForFunction(() => window.scrollY === 0);
    const initialKnownTop = await draftPage.locator("#initialKnown").evaluate(element => element.getBoundingClientRect().top);
    assert.ok(initialKnownTop >= 0 && initialKnownTop < 780, `先思输入应在手机首屏显示至少一部分（当前${initialKnownTop}px）`);
    await draftPage.fill("#initialKnown", "2x=4");
    await draftPage.fill("#initialGoal", "求x");
    await draftPage.click("#mobileHome");
    await draftPage.click("#mobileTopicNext");
    assert.equal(await draftPage.locator("#initialKnown").inputValue(), "2x=4", "切屏后应保留先思文字草稿");
    assert.equal(await draftPage.locator("#initialGoal").inputValue(), "求x", "切屏后应保留先思目标草稿");
    console.log(`✓ 先思输入首屏可见（top=${Math.round(initialKnownTop)}px），切换题目页/作答页不丢失阶段文字草稿`);
    const draftTouch = await draftContext.newCDPSession(draftPage);
    await draftPage.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
    await draftPage.evaluate(() => window.scrollTo({ top: 320, behavior: "instant" }));
    await draftPage.waitForFunction(() => Math.abs(window.scrollY - 320) < 3);
    await dispatchTouchSwipe(draftTouch, { x: 30, y: 320 }, { x: 270, y: 320 });
    await draftPage.waitForSelector("#mobileFlow[data-screen=topic]");
    await draftPage.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
    await draftPage.evaluate(() => window.scrollTo({ top: 40, behavior: "instant" }));
    await draftPage.waitForFunction(() => Math.abs(window.scrollY - 40) < 3);
    await dispatchTouchSwipe(draftTouch, { x: 270, y: 290 }, { x: 80, y: 290 });
    await draftPage.waitForSelector("#mobileFlow[data-screen=learning]");
    await draftPage.waitForFunction(() => Math.abs(window.scrollY - 320) < 3);
    await dispatchTouchSwipe(draftTouch, { x: 30, y: 320 }, { x: 270, y: 320 });
    await draftPage.waitForSelector("#mobileFlow[data-screen=topic]");
    await draftPage.waitForFunction(() => Math.abs(window.scrollY - 40) < 3);
    console.log("✓ 题目页与作答页分别恢复滚动位置，不被切屏时的高度变化覆盖");
    await draftContext.close();

    const desktopContext = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
    const desktopPage = await desktopContext.newPage();
    await installApiMocks(desktopPage);
    await desktopPage.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: "networkidle" });
    await desktopPage.fill("#problemTextInput", "2x=4");
    await desktopPage.click("#problemForm button[type=submit]");
    await desktopPage.waitForSelector("#draftForm");
    await desktopPage.click("#draftForm button[type=submit]");
    await desktopPage.waitForSelector("#studentContent .completed-card");
    const desktopRects = await desktopPage.evaluate(() => {
      const taskRect = document.querySelector(".task-panel")?.getBoundingClientRect();
      const workspaceRect = document.querySelector(".workspace")?.getBoundingClientRect();
      return { taskRect, workspaceRect, overflow: document.body.scrollWidth > innerWidth };
    });
    assert.ok(desktopRects.taskRect && desktopRects.workspaceRect && Math.abs(desktopRects.taskRect.y - desktopRects.workspaceRect.y) < 2, "桌面题目栏和作答栏应在同一行");
    assert.equal(desktopRects.overflow, false, "桌面不应出现横向溢出");
    console.log("✓ 桌面题目栏与五阶段作答栏保持双栏同一行");
    await desktopContext.close();
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
