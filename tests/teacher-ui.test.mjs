import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { cardMarkup, filterSummaries, recurringFeedback, sortSummaries } from "../teacher.js";

function summary(outcome) {
  return {
    anonymousId: "匿名测试",
    taskTitle: "测试题",
    stage: "completed",
    learningOutcome: outcome,
    helpStatus: {},
    helpRequests: [],
    hintsGiven: [],
    judgment: {},
    transfer: {},
    reflection: {},
    studentQuotes: [],
    trace: []
  };
}

test("教师卡片明确区分独立通过、辅助继续和需复核", () => {
  assert.match(cardMarkup(summary({ status: "independent", label: "独立通过", description: "判别和迁移均有独立通过记录。" }), 0), /独立通过/u);
  assert.match(cardMarkup(summary({ status: "assisted", label: "辅助继续", description: "至少一个阶段在辅助下继续。" }), 0), /辅助继续/u);
  assert.match(cardMarkup(summary({ status: "review_required", label: "需教师复核", description: "任务只通过结构校验。" }), 0), /需教师复核/u);
});

test("缺少统一结果标记时，教师卡片不把完成态当成掌握", () => {
  const html = cardMarkup(summary(undefined), 0);
  assert.match(html, /完成态不等于掌握/u);
  assert.match(html, /需复核/u);
});

test("教师卡片显示五阶段状态、理由和独立结果的复核降级", () => {
  const stages = [
    { key: "initial_thinking", label: "先思", status: "independent", statusLabel: "独立通过", reason: "条件和目标已说明。" },
    { key: "help", label: "求助", status: "assisted", statusLabel: "辅助继续", reason: "使用过一级提示。" },
    { key: "judgment", label: "判别", status: "pending", statusLabel: "尚未验证", reason: "等待补充依据。" },
    { key: "transfer", label: "迁移", status: "review_required", statusLabel: "需教师复核", reason: "任务只通过结构校验。" },
    { key: "reflection", label: "反思", status: "independent", statusLabel: "独立通过", reason: "已留下反思。" }
  ];
  const html = cardMarkup(summary({
    status: "independent",
    label: "独立通过",
    needsTeacherReview: true,
    taskReview: { needsTeacherReview: true, reason: "任务只通过结构校验，需教师复核。" },
    description: "核心阶段有记录。",
    stages
  }), 0);
  assert.match(html, /学习结果标记（不等同掌握）<\/h4><p><strong>需教师复核/u);
  assert.match(html, /五阶段核验/u);
  assert.match(html, /先思/u);
  assert.match(html, /辅助继续/u);
  assert.match(html, /尚未验证/u);
  assert.match(html, /任务只通过结构校验，需教师复核/u);
});

test("教师卡片把点选卡点和学生原话分开显示", () => {
  const html = cardMarkup({
    ...summary(undefined),
    stuckPoint: "不知道用哪个公式",
    helpSelections: [{ id: "point-1", label: "不知道用哪个公式", at: "2026-09-06T08:05:00.000Z" }],
    studentQuotes: [{ source: "求助核验时学生", text: "我先找题目给的数量。" }],
    hintsGiven: [{
      level: 1,
      selectedStuckPoint: { id: "point-1", label: "不知道用哪个公式" },
      reply: { text: "先找出题目中的数量关系。" }
    }],
    trace: [
      { stage: "求助", type: "point_selection", selectedStuckPoint: { id: "point-1", label: "不知道用哪个公式" } },
      { stage: "求助", type: "hint", student: { text: "我先找题目给的数量。" }, reply: { text: "先找出题目中的数量关系。" } }
    ]
  }, 0);

  assert.match(html, /学生点选的卡点/u);
  assert.match(html, /不知道用哪个公式/u);
  assert.match(html, /学生原话/u);
  assert.match(html, /我先找题目给的数量/u);
  assert.match(html, /点选卡点/u);
  assert.doesNotMatch(html, /point_selection|>hint</u);
  assert.equal(html.match(/我先找题目给的数量/gu).length, 1);
});

test("教师卡片主区域只显示最新点选，完整历史留在轨迹", () => {
  const html = cardMarkup({
    ...summary(undefined),
    stuckPoint: "最后一次卡点",
    helpSelections: [
      { id: "point-a", label: "第一次卡点", at: "2026-09-06T08:01:00.000Z" },
      { id: "point-b", label: "最后一次卡点", at: "2026-09-06T08:03:00.000Z" }
    ],
    trace: [
      { stage: "求助", type: "point_selection", selectedStuckPoint: { id: "point-a", label: "第一次卡点" } },
      { stage: "求助", type: "point_selection", selectedStuckPoint: { id: "point-b", label: "最后一次卡点" } }
    ]
  }, 0);
  const main = html.match(/<section class="teacher-focus"><h4>学生点选的卡点<\/h4>([\s\S]*?)<\/section>/u)?.[1] || "";
  assert.match(main, /最后一次卡点/u);
  assert.doesNotMatch(main, /第一次卡点/u);
  assert.match(html, /展开原始轨迹/u);
  assert.match(html, /第一次卡点/u);
});

test("看板先展示题目和具体反馈，完整题干、学习证据与原始轨迹默认收起", () => {
  const html = cardMarkup({
    ...summary(undefined),
    task: { problemType: "geometry_proof", problemText: `在等腰三角形中${"，请根据题目条件证明。".repeat(20)}全文结尾`, knownFacts: ["AB＝AC"], proofGoal: "证明两底角相等", diagramDescription: "A 在底边 BC 上方" },
    needsHelp: true,
    stage: "hint_level_2",
    stuckPoint: "找不到对应边",
    retryNotes: [{ stage: "求助", feedback: "尚未说明 AB＝AC 在证明里的用法。" }],
    suggestedFollowUp: "AB＝AC 能给出哪一组对应边？"
  }, 0);
  const beforeEvidence = html.split('<details class="teacher-later-evidence">')[0];
  assert.match(beforeEvidence, /题目<\/h4><p>在等腰三角形中/u);
  assert.match(beforeEvidence, /查看完整题干和题目条件[\s\S]+全文结尾[\s\S]+已知条件<\/strong> AB＝AC/u);
  assert.match(beforeEvidence, /几何证明[\s\S]+找不到对应边[\s\S]+尚未说明 AB＝AC/u);
  assert.doesNotMatch(html, /<details[^>]*\bopen\b|geometry_proof|hint_level_2/u);
});

test("待关注过滤保留当前求助，重复反馈按题型和阶段逐条计数", () => {
  const note = { stage: "迁移", feedback: "等式两边应做相同运算。" };
  const baseline = { stage: "hint_level_1", needsHelp: true, task: { problemType: "equation" }, helpSelections: [{ label: "移项" }] };
  const first = { ...baseline, retryNotes: [note, note] };
  const second = { ...baseline, retryNotes: [note], helpRequested: true };
  const historical = { ...baseline, needsHelp: false, stage: "completed", retryNotes: [note] };
  const geometry = { ...baseline, task: { problemType: "geometry_proof" }, retryNotes: [note] };
  const all = [first, historical, geometry, second];
  const attention = filterSummaries(sortSummaries(all), { attention: "needed", problemType: "方程", stuckPoint: "移项" });
  assert.deepEqual(attention, [second, first]);
  assert.deepEqual(recurringFeedback(attention), [{ ...note, topic: "方程", count: 2 }]);
  assert.equal(recurringFeedback(all)[0].count, 3);
});

test("紧凑列表支持分页、跨页查看详情和筛选归位", async t => {
  const documentMarkup = await readFile(new URL("../teacher.html", import.meta.url), "utf8");
  const nodes = new Map([...documentMarkup.matchAll(/id="([^"]+)"/g)].map(([, id]) => [id, {
    listeners: {},
    dataset: {},
    addEventListener(type, listener) { this.listeners[type] = listener; },
    setAttribute() {},
    focus() { document.activeElement = this; },
    replaceChildren() { this.innerHTML = ""; }
  }]));
  const get = id => nodes.get(id);
  const button = { dataset: {}, textContent: "查看学习记录" };
  const preview = { dataset: { sessionIndex: "11" }, focus() { document.activeElement = this; } };
  const dialog = get("teacherDetail");
  dialog.showModal = () => { dialog.open = true; get("teacherCloseDetail").focus(); };
  dialog.close = () => { dialog.open = false; dialog.listeners.close(); };
  get("teacherApiStatus").querySelector = () => ({});
  globalThis.document = {
    readyState: "complete",
    querySelector(selector) {
      if (selector === "#teacherAuthForm button[type=submit]") return button;
      if (selector.startsWith("#sessionList [data-session-index=")) {
        preview.dataset.sessionIndex = selector.match(/\d+/u)[0];
        return preview;
      }
      return get(selector.slice(1));
    }
  };
  t.after(() => { delete globalThis.document; });
  const sessions = Array.from({ length: 25 }, (_, index) => ({
    ...summary(undefined),
    taskTitle: `图形题 ${index + 1}`,
    username: index === 1 ? "小周" : "小林",
    task: { problemText: "在△ABC 中，AB＝AC。", problemType: "geometry_proof" },
    stuckPoint: "找不到对应角",
    needsHelp: index < 2
  }));
  t.mock.method(globalThis, "fetch", async () => ({ ok: true, json: async () => ({ sessions }) }));
  await import("../teacher.js?navigation-test");
  get("teacherAuthForm").listeners.submit({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));

  const list = get("sessionList");
  assert.equal(list.innerHTML.match(/data-session-index=/gu).length, 12);
  assert.match(list.innerHTML, /在△ABC 中，AB＝AC。/u);
  assert.match(list.innerHTML, /teacher-student-name">小周<\/strong>/u);
  assert.doesNotMatch(list.innerHTML, /原始轨迹|查看学习结果/u);
  assert.equal(get("teacherPageNumber").textContent, "第 1 / 3 页");
  list.listeners.click({ target: { closest: () => preview } });
  assert.equal(dialog.open, true);
  assert.match(get("teacherDetailBody").innerHTML, /图形题 12[\s\S]+展开原始轨迹/u);
  get("teacherNextDetail").listeners.click();
  assert.match(get("teacherDetailBody").innerHTML, /图形题 13/u);
  assert.equal(get("teacherDetailPosition").textContent, "第 13 / 25 条");
  get("teacherCloseDetail").listeners.click();
  assert.equal(get("teacherPageNumber").textContent, "第 2 / 3 页");
  assert.equal(get("teacherDetailBody").innerHTML, "");
  assert.equal(document.activeElement.dataset.sessionIndex, "12");
  get("teacherNextPage").listeners.click();
  assert.equal(get("teacherPageNumber").textContent, "第 3 / 3 页");
  assert.equal(get("teacherNextPage").disabled, true);
  get("teacherAttentionFilter").listeners.click();
  assert.equal(list.innerHTML.match(/data-session-index=/gu).length, 2);
  assert.equal(get("teacherPagination").hidden, true);
  get("teacherUsernameFilter").listeners.input({ currentTarget: { value: "周" } });
  assert.equal(list.innerHTML.match(/data-session-index=/gu).length, 1);
  assert.match(list.innerHTML, /小周/u);
  get("clearTeacherSession").listeners.click();
  assert.doesNotMatch(list.innerHTML, /图形题/u);
});
