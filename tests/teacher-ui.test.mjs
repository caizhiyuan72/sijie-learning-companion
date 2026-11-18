import test from "node:test";
import assert from "node:assert/strict";
import { cardMarkup } from "../teacher.js";

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
    trace: [{ stage: "求助", type: "point_selection", selectedStuckPoint: { id: "point-1", label: "不知道用哪个公式" } }]
  }, 0);

  assert.match(html, /学生点选的卡点/u);
  assert.match(html, /不知道用哪个公式/u);
  assert.match(html, /学生原话/u);
  assert.match(html, /我先找题目给的数量/u);
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
  const main = html.match(/<section class="teacher-evidence"><h4>学生点选的卡点<\/h4>([\s\S]*?)<\/section>/u)?.[1] || "";
  assert.match(main, /最后一次卡点/u);
  assert.doesNotMatch(main, /第一次卡点/u);
  assert.match(html, /展开原始轨迹/u);
  assert.match(html, /第一次卡点/u);
});
