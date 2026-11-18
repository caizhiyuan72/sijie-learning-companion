/*
 * Browser QA for the dynamic point-and-choose help flow.
 *
 * Usage:
 *   PLAYWRIGHT_MODULE_PATH=/tmp/sijie-help-qa-tools/node_modules/playwright \
 *   node tests/browser-help.mjs
 *
 * Set HELP_QA_BASE_URL to inspect a deployed static page while keeping API
 * calls intercepted. Set HELP_QA_OUTPUT_DIR to choose the screenshot folder.
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

async function loadPlaywright() {
  const configured = process.env.PLAYWRIGHT_MODULE_PATH;
  const candidates = configured
    ? [configured]
    : ["/tmp/sijie-help-qa-tools/node_modules/playwright", "playwright"];
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
  throw new Error("找不到Playwright。请设置PLAYWRIGHT_MODULE_PATH。 ");
}

const root = fileURLToPath(new URL("..", import.meta.url));
const outputDir = process.env.HELP_QA_OUTPUT_DIR
  ? resolve(process.env.HELP_QA_OUTPUT_DIR)
  : join(root, "output", "help-qa", "dynamic-local");
const staticTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2"
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

const initialHelpOptions = [
  { id: "point-1", label: "不知道土壤表面温度是怎样传给青路面的" },
  { id: "point-2", label: "不知道青路面和草坪温度的先后关系" },
  { id: "point-3", label: "不知道应该先算哪一个温度" },
  { id: "point-4", label: "不确定自己卡在条件还是计算" }
];
const roundHelpOptions = [
  initialHelpOptions,
  [
    { id: "r1-point-1", label: "提示后仍不明白土壤温度与青路面的比例" },
    { id: "r1-point-2", label: "提示后仍不明白为什么先算青路面" },
    { id: "r1-point-3", label: "提示后仍不会把11/8写成计算式" },
    { id: "r1-point-4", label: "提示后仍不确定下一步" }
  ],
  [
    { id: "r2-point-1", label: "仍不明白青路面温度怎样传给草坪" },
    { id: "r2-point-2", label: "仍不明白第二个比例应该乘在哪里" },
    { id: "r2-point-3", label: "仍不会检查计算顺序" },
    { id: "r2-point-4", label: "仍不确定自己的算式" }
  ],
  [
    { id: "r3-point-1", label: "第三次提示后仍不会说出数量关系" },
    { id: "r3-point-2", label: "第三次提示后仍不明白单位变化" },
    { id: "r3-point-3", label: "第三次提示后仍想核对结果" },
    { id: "r3-point-4", label: "第三次提示后仍不确定卡点" }
  ]
];
const task = {
  id: "task-help-qa",
  grade: "八年级",
  subject: "初中数学",
  title: "温度比例题",
  problemText: "土壤表面约40℃，青路面的温度是土壤表面的11/8，草坪表面的温度是青路面的3/5。",
  proofGoal: "求草坪表面的温度",
  knownFacts: ["土壤表面约40℃", "青路面是土壤表面的11/8", "草坪是青路面的3/5"],
  learningGoal: "整理数量关系"
};

function taskForRound(round = 0) {
  const safeRound = Math.max(0, Math.min(roundHelpOptions.length - 1, Number(round) || 0));
  return { ...task, helpOptions: roundHelpOptions[safeRound], helpOptionsRound: safeRound, helpOptionsSource: "ai" };
}

function json(route, payload, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(payload) });
}

function sessionFor(state, stage = state.initialStage, completedHints = state.completedHints) {
  return {
    id: "session-help-qa",
    anonymousId: "测试会话-01",
    stage,
    completedHints: [...completedHints],
    answers: { hints: structuredClone(state.hints), helpSelections: structuredClone(state.helpSelections) },
    helpExhausted: completedHints.length >= 3,
    hintsExhausted: completedHints.length >= 3
  };
}

async function installApiMocks(page, config = {}) {
  const requests = [];
  const state = {
    initialStage: config.initialStage || "initial_thinking",
    completedHints: [...(config.completedHints || [])],
    currentRound: Number(config.currentRound || 0),
    failNextHint: Boolean(config.failNextHint),
    invalidSelectionOnce: Boolean(config.invalidSelectionOnce),
    invalidSelectionTriggered: false,
    hintDelayMs: Number(config.hintDelayMs || 0),
    hints: [],
    helpSelections: []
  };
  await page.route("**/api/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    let body = {};
    try { body = request.postDataJSON() || {}; } catch {}
    requests.push({ path: url.pathname, body });
    if (url.pathname === "/api/status") return json(route, { configured: true, available: true, model: "help-qa" });
    if (url.pathname === "/api/problem/analyze") return json(route, { draftId: "draft-help-qa", draft: { ...task, known: "土壤表面约40℃" }, decision: "pass", confidence: 0.95 });
    if (url.pathname === "/api/session" && request.method() === "POST") return json(route, { session: sessionFor(state), task: taskForRound(0) });
    if (url.pathname === "/api/session/session-help-qa" && request.method() === "GET") {
      return json(route, { session: sessionFor(state, "help", state.completedHints), task: taskForRound(state.currentRound), events: [] });
    }
    if (url.pathname === "/api/session/session-help-qa/initial") {
      state.initialStage = "help";
      return json(route, { session: sessionFor(state, "help", []), task: taskForRound(0), evaluation: { decision: "retry", feedback: "先从一个小点开始。" } });
    }
    if (url.pathname === "/api/session/session-help-qa/help") {
      if (body.action === "hint") {
        if (state.hintDelayMs > 0) await new Promise(resolve => setTimeout(resolve, state.hintDelayMs));
        if (state.failNextHint) {
          state.failNextHint = false;
          return json(route, { error: "模拟提示服务暂时失败", code: "MODEL_TIMEOUT", retryable: true }, 504);
        }
        if (state.invalidSelectionOnce && !state.invalidSelectionTriggered) {
          state.invalidSelectionTriggered = true;
          const externalSelection = initialHelpOptions[3];
          state.completedHints = ["h1"];
          state.currentRound = 1;
          state.helpSelections = [{ hintLevel: 1, selectedStuckPoint: externalSelection, at: new Date().toISOString() }];
          state.hints = [{ level: 1, student: { selectedStuckPoint: externalSelection }, reply: { action: "hint", message: "另一标签页已经获得了提示。" }, at: new Date().toISOString() }];
          return json(route, { error: "请选择当前题目中的一个卡点。", code: "INVALID_HELP_SELECTION", retryable: false }, 400);
        }
        const level = state.completedHints.length + 1;
        const currentOptions = roundHelpOptions[state.currentRound] || initialHelpOptions;
        const selected = currentOptions.find(item => item.id === body.selectedStuckPointId) || null;
        state.completedHints.push(`h${level}`);
        state.helpSelections.push({ hintLevel: level, selectedStuckPoint: selected, at: new Date().toISOString() });
        state.hints.push({ level, student: { ...(selected ? { selectedStuckPoint: selected } : {}), ...(body.text ? { text: body.text } : {}) }, reply: { action: "hint", message: `提示${level}：先找出题目中相邻的两个数量关系。` }, at: new Date().toISOString() });
        state.currentRound = Math.min(state.currentRound + 1, roundHelpOptions.length - 1);
        return json(route, { session: sessionFor(state, "help", state.completedHints), task: taskForRound(state.currentRound), evaluation: { decision: "retry", feedback: "先看清你选择的这个关系。", nextPrompt: "请解释这个关系为什么成立。" }, reply: { action: "hint", message: `提示${level}：先找出题目中相邻的两个数量关系。` } });
      }
      if (body.action === "finish") return json(route, { session: sessionFor(state, "judgment", state.completedHints), task: taskForRound(state.currentRound), evaluation: { decision: "pass", feedback: "理解说明已通过。" } });
      if (body.action === "understood") return json(route, { session: sessionFor(state, "judgment", state.completedHints), task: taskForRound(state.currentRound), evaluation: { decision: "assisted", feedback: "已进入判别。" } });
      if (body.action === "teacher") return json(route, { session: sessionFor(state, "help", state.completedHints), task: taskForRound(state.currentRound), evaluation: { decision: "retry", feedback: "已提交给老师。" } });
    }
    return json(route, { error: `未配置的UI测试接口：${url.pathname}`, code: "TEST_ROUTE_MISSING", retryable: false }, 404);
  });
  return requests;
}

async function openHelpPage(browser, baseUrl, { viewport, mobile = false, config = {} } = {}) {
  const context = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1 });
  const page = await context.newPage();
  const requests = await installApiMocks(page, config);
  await page.goto(`${baseUrl.replace(/\/$/u, "")}/`, { waitUntil: "networkidle" });
  await page.fill("#problemTextInput", "土壤表面约40℃，求草坪表面温度");
  await page.click("#problemForm button[type=submit]");
  await page.waitForSelector("#draftForm");
  await page.fill("#studentUsername", "验收学生");
  await page.click("#draftForm button[type=submit]");
  if (config.initialStage !== "help") {
    await page.waitForSelector("#initialForm");
    await page.fill("#initialKnown", "土壤表面约40℃；青路面是它的11/8；草坪是青路面的3/5");
    await page.fill("#initialGoal", "求草坪表面的温度");
    await page.click("#initialForm button[type=submit]");
  }
  await page.waitForSelector("#helpForm");
  return { context, page, requests };
}

async function stableScreenshot(page, path) {
  await page.waitForTimeout(450);
  await page.evaluate(() => {
    const toast = document.querySelector("#toast");
    if (toast) toast.className = "toast";
    // Chromium can stitch a fixed skip link into the first full-page tile even
    // when it is outside the viewport. Hide it only for the visual artifact;
    // keyboard-focus assertions run before this helper and keep the link real.
    const skip = document.querySelector(".skip-link");
    if (skip) skip.dataset.qaHidden = "true", skip.hidden = true;
  });
  await page.waitForFunction(() => !document.querySelector("#toast") || getComputedStyle(document.querySelector("#toast")).opacity === "0");
  try {
    await page.screenshot({ path, fullPage: true, animations: "disabled" });
  } finally {
    await page.evaluate(() => {
      const skip = document.querySelector(".skip-link");
      if (skip?.dataset.qaHidden) { delete skip.dataset.qaHidden; skip.hidden = false; }
    });
  }
}

async function choose(page, index = 0) {
  await page.locator(".help-option").nth(index).click();
  assert.equal(await page.locator(".help-option input").nth(index).isChecked(), true, "点选卡点应保留选中状态");
}

async function main() {
  const { chromium } = await loadPlaywright();
  await mkdir(outputDir, { recursive: true });
  const remoteBaseUrl = String(process.env.HELP_QA_BASE_URL || "").trim().replace(/\/$/u, "");
  let baseUrl = remoteBaseUrl;
  if (!baseUrl) {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  }
  const executablePath = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const browser = await chromium.launch({ ...(existsSync(executablePath) ? { executablePath } : {}), headless: true });
  try {
    const mobile = await openHelpPage(browser, baseUrl, { viewport: { width: 390, height: 844 }, mobile: true, config: { hintDelayMs: 250 } });
    const { page, context, requests } = mobile;
    assert.equal(await page.locator("#helpPrimarySubmit").isDisabled(), true, "未选卡点时主按钮应禁用");
    assert.equal(await page.locator(".help-option").count(), 4, "初始应显示四个卡点");
    assert.equal(await page.evaluate(() => document.body.scrollWidth <= innerWidth), true, "手机求助页不应横向溢出");
    for (const option of await page.locator(".help-option > span").all()) assert.ok((await option.boundingBox()).height >= 48, "卡点点击区域至少48px");
    await stableScreenshot(page, join(outputDir, "mobile-help-initial.png"));
    await page.locator(".help-option input").first().focus();
    await page.keyboard.press("ArrowDown");
    assert.equal(await page.locator(".help-option input").nth(1).isChecked(), true, "键盘方向键应可选择卡点");
    const pendingHint = page.click("#helpPrimarySubmit");
    await page.waitForTimeout(50);
    assert.equal(await page.locator("#helpPrimarySubmit").isDisabled(), true, "提示请求期间主按钮应禁用");
    await pendingHint;
    await page.waitForSelector(".help-latest");
    assert.equal(await page.evaluate(() => document.activeElement?.id), "helpStageHeading", "提示成功重绘后键盘焦点应回到本轮主标题");
    assert.equal(await page.locator(".help-option input:checked").count(), 0, "第一轮提示成功后不应预选新卡点");
    assert.equal(await page.locator("#helpPrimarySubmit").isDisabled(), true, "等待新卡点时主按钮应禁用");
    assert.equal(await page.locator(".help-options-meta").innerText(), "根据刚才的提示整理 · 已用 1/3 次提示");
    assert.equal(await page.locator(".help-latest").evaluate(element => Boolean(element.compareDocumentPosition(document.querySelector(".help-options-field")) & Node.DOCUMENT_POSITION_FOLLOWING)), true, "最新提示应位于新卡点之前");
    assert.equal(requests.at(-1)?.body.selectedStuckPointId, "point-2");
    assert.equal(requests.at(-1)?.body.action, "hint", "主按钮始终请求提示模式");
    await stableScreenshot(page, join(outputDir, "mobile-help-round-1.png"));
    await choose(page, 0);
    await page.click("#helpPrimarySubmit");
    await page.waitForFunction(() => document.querySelector(".help-options-meta")?.textContent?.includes("2/3"));
    assert.equal(await page.locator(".help-option input:checked").count(), 0, "第二轮提示成功后仍不应预选");
    assert.match(await page.locator(".help-option").first().innerText(), /仍/u, "第二轮应显示新一轮的卡点文案");
    await choose(page, 1);
    await page.click("#helpPrimarySubmit");
    await page.waitForFunction(() => document.querySelector(".help-options-meta")?.textContent?.includes("3/3"));
    assert.equal(await page.locator("#requestTeacherHelp").isVisible(), true, "三级提示后应显示提交教师按钮");
    assert.equal(await page.locator(".help-option input:checked").count(), 0, "第三轮新卡点也不应预选");
    await page.click("details:has(.hint-history) summary");
    const historyText = await page.locator(".hint-history").innerText();
    assert.match(historyText, /土壤表面温度是怎样传给青路面|提示后仍不明白/u, "旧卡点应只保留在历史记录");
    await choose(page, 2);
    await page.click("#requestTeacherHelp");
    assert.equal(requests.at(-1)?.body.action, "teacher");
    assert.equal(requests.at(-1)?.body.selectedStuckPointId, "r3-point-3");
    await stableScreenshot(page, join(outputDir, "mobile-help-teacher.png"));
    await context.close();
    console.log("✓ 三轮动态卡点、历史记录、提示次数与教师提交通过");

    const failed = await openHelpPage(browser, baseUrl, { viewport: { width: 390, height: 844 }, mobile: true, config: { failNextHint: true } });
    await choose(failed.page, 0);
    await failed.page.click("#helpInputPanel summary");
    await failed.page.fill("#help-answer-text", "我先看两个温度之间的关系。");
    await failed.page.click("#mobileHome");
    await failed.page.click("#mobileTopicNext");
    await failed.page.setViewportSize({ width: 768, height: 900 });
    await failed.page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await failed.page.locator(".help-option input").first().isChecked(), true, "切页和调整窗口应保留当前轮卡点");
    assert.equal(await failed.page.locator("#help-answer-text").inputValue(), "我先看两个温度之间的关系。", "切页和调整窗口应保留补充文字");
    await failed.page.click("#helpPrimarySubmit");
    await failed.page.waitForSelector("[data-request-error]");
    assert.equal(await failed.page.locator(".help-option input").first().isChecked(), true, "提示失败后应保留当前轮点选");
    assert.equal(await failed.page.locator("#help-answer-text").inputValue(), "我先看两个温度之间的关系。", "提示失败后应保留补充文字");
    await stableScreenshot(failed.page, join(outputDir, "mobile-help-error.png"));
    await failed.page.click(".retry-button");
    await failed.page.waitForSelector(".help-latest");
    assert.equal(await failed.page.locator(".help-option input:checked").count(), 0, "重试成功后应清空本轮点选");
    await failed.context.close();
    console.log("✓ 失败保留当前轮输入，重试成功后更新卡点");

    const stale = await openHelpPage(browser, baseUrl, { viewport: { width: 390, height: 844 }, mobile: true, config: { invalidSelectionOnce: true } });
    await choose(stale.page, 0);
    await stale.page.click("#helpInputPanel summary");
    await stale.page.fill("#help-answer-text", "我还想保留这句补充说明。");
    await stale.page.click("#helpPrimarySubmit");
    await stale.page.waitForFunction(() => document.querySelector(".help-options-meta")?.textContent?.includes("1/3"));
    assert.equal(await stale.page.evaluate(() => document.activeElement?.id), "helpStageHeading", "旧轮次同步后键盘焦点应回到当前轮主标题");
    assert.equal(await stale.page.locator(".help-option input:checked").count(), 0, "旧轮次ID失败后应清空失效选中项");
    assert.equal(await stale.page.locator("#help-answer-text").inputValue(), "我还想保留这句补充说明。", "旧轮次同步不得丢失补充文字");
    assert.equal(await stale.page.locator(".help-option").first().locator("input").getAttribute("value"), "r1-point-1", "旧轮次失败后应展示服务端新卡点");
    assert.equal(stale.requests.some(item => item.path === "/api/session/session-help-qa" && !item.body.action), true, "旧轮次失败后应GET同步当前会话");
    assert.match(await stale.page.locator("#toast").innerText(), /这轮卡点已更新，请重新选择/u);
    await choose(stale.page, 0);
    await stale.page.click("#helpPrimarySubmit");
    await stale.page.waitForFunction(() => document.querySelector(".help-options-meta")?.textContent?.includes("2/3"));
    await stale.context.close();
    console.log("✓ 旧轮次卡点拒绝后同步新选项，并保留补充草稿");

    for (const mode of ["finish", "understood"]) {
      const compatibility = await openHelpPage(browser, baseUrl, { viewport: { width: 390, height: 844 }, mobile: true });
      await choose(compatibility.page, 0);
      await compatibility.page.click("#helpPrimarySubmit");
      await compatibility.page.waitForSelector(".help-latest");
      if (mode === "finish") {
        await compatibility.page.click("#checkHelp");
        await compatibility.page.fill("#help-answer-text", "我知道先把土壤温度乘以第一段比例。");
        await compatibility.page.click("#finishHelp");
      } else await compatibility.page.click("#understoodHelp");
      await compatibility.page.waitForSelector("#judgmentForm");
      await compatibility.context.close();
    }
    console.log("✓ 理解核验与我懂了兼容");

    const desktopDynamic = await openHelpPage(browser, baseUrl, { viewport: { width: 1280, height: 900 } });
    await choose(desktopDynamic.page, 0);
    await desktopDynamic.page.click("#helpPrimarySubmit");
    await desktopDynamic.page.waitForFunction(() => document.querySelector(".help-options-meta")?.textContent?.includes("1/3"));
    assert.equal(await desktopDynamic.page.locator(".help-option input:checked").count(), 0, "电脑端第一轮更新后不应预选新卡点");
    assert.equal(await desktopDynamic.page.evaluate(() => document.body.scrollWidth <= innerWidth), true, "电脑端第一轮更新不应横向溢出");
    await choose(desktopDynamic.page, 1);
    await desktopDynamic.page.click("#helpPrimarySubmit");
    await desktopDynamic.page.waitForFunction(() => document.querySelector(".help-options-meta")?.textContent?.includes("2/3"));
    assert.equal(await desktopDynamic.page.locator(".help-option input:checked").count(), 0, "电脑端第二轮更新后不应预选新卡点");
    assert.equal(await desktopDynamic.page.evaluate(() => document.body.scrollWidth <= innerWidth), true, "电脑端第二轮更新不应横向溢出");
    assert.equal(await desktopDynamic.page.locator(".skip-link").evaluate(element => getComputedStyle(element).top), "-60px", "截图前跳转链接不应覆盖桌面页头");
    await stableScreenshot(desktopDynamic.page, join(outputDir, "desktop-help-round-2.png"));
    await desktopDynamic.context.close();
    console.log("✓ 1280px连续两轮点选、选项更新与桌面布局通过");

    for (const width of [375, 768, 1024, 1280, 1440]) {
      const mobileViewport = width <= 700;
      const smoke = await openHelpPage(browser, baseUrl, { viewport: { width, height: mobileViewport ? 844 : 900 }, mobile: mobileViewport });
      assert.equal(await smoke.page.evaluate(() => document.body.scrollWidth <= innerWidth), true, `${width}px不应横向溢出`);
      const rect = await smoke.page.locator(".help-stage-card").boundingBox();
      assert.ok(rect && rect.width <= width, `${width}px求助卡片应适应视口`);
      await stableScreenshot(smoke.page, join(outputDir, `help-${width}.png`));
      await smoke.context.close();
    }
    const landscape = await openHelpPage(browser, baseUrl, { viewport: { width: 844, height: 390 }, mobile: true });
    assert.equal(await landscape.page.evaluate(() => document.body.scrollWidth <= innerWidth), true, "手机横屏不应横向溢出");
    await landscape.context.close();
    const zoomed = await openHelpPage(browser, baseUrl, { viewport: { width: 390, height: 844 }, mobile: true });
    const beforeFont = await zoomed.page.locator(".help-option > span").first().evaluate(element => parseFloat(getComputedStyle(element).fontSize));
    await zoomed.page.evaluate(() => { document.querySelectorAll("body *").forEach(element => { const size = parseFloat(getComputedStyle(element).fontSize); if (Number.isFinite(size)) element.style.fontSize = `${size * 1.25}px`; }); });
    const afterFont = await zoomed.page.locator(".help-option > span").first().evaluate(element => parseFloat(getComputedStyle(element).fontSize));
    assert.ok(afterFont >= beforeFont * 1.24, "应实际放大卡点文字");
    assert.equal(await zoomed.page.evaluate(() => document.body.scrollWidth <= innerWidth), true, "文字放大后不应横向溢出");
    await zoomed.context.close();
    const textOnly = await openHelpPage(browser, baseUrl, { viewport: { width: 1280, height: 900 } });
    await textOnly.page.click("#helpInputPanel summary");
    await textOnly.page.fill("#help-answer-text", "我想了解这个比例是什么意思。");
    await textOnly.page.click("#helpPrimarySubmit");
    await textOnly.page.waitForSelector(".help-latest");
    assert.equal(textOnly.requests.at(-1).body.action, "hint", "仅补充文字也必须请求提示模式");
    assert.equal(textOnly.requests.at(-1).body.selectedStuckPointId, undefined);
    await textOnly.page.click("#understoodHelp");
    await textOnly.page.waitForSelector("#judgmentForm");
    await textOnly.context.close();
    console.log("✓ 草稿切页、改窗口、48px目标、真实文字放大及仅文字求助通过");
    console.log("✓ 375/768/1024/1280/1440px布局无横向溢出");
  } finally {
    await browser.close();
    if (!remoteBaseUrl) await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
