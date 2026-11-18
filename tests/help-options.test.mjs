import test from "node:test";
import assert from "node:assert/strict";
import {
  GENERIC_HELP_OPTIONS,
  advanceHelpOptions,
  helpOptionsForTask,
  helpOptionsForSession,
  normalizeHelpOptions,
  resolveHelpSelection
} from "../lib/help-options.mjs";
import { taskToPublic, normalizeTaskInput } from "../lib/task-schema.mjs";
import { DeepSeekClient } from "../lib/deepseek.mjs";

const task = {
  problemText: "解方程2x+1=5。",
  proofGoal: "求方程的解",
  isMathProblem: true,
  isGeometryProof: false,
  protectedPhrases: ["x=2"]
};

test("AI卡点会去重、限制数量并由服务端分配point id", () => {
  const options = normalizeHelpOptions([
    { id: "model-a", label: "我不知道题目给了哪些条件" },
    { id: "model-b", label: "我不知道题目给了哪些条件" },
    { id: "model-c", label: "我不知道该用哪个公式或关系" },
    { id: "model-d", label: "我不知道从哪一步开始" },
    { id: "model-e", label: "我不知道如何检查结果" },
    { id: "model-f", label: "多余选项不应进入公开列表" }
  ], task);
  assert.deepEqual(options.map(item => item.id), ["point-1", "point-2", "point-3", "point-4", "point-5"]);
  assert.equal(options.length, 5);
});

test("卡点过滤完整答案、连续步骤和受保护结论", () => {
  const options = normalizeHelpOptions([
    { label: "直接给我完整答案" },
    { label: "先列式，所以x=2" },
    { label: "我不知道如何得到x=2" },
    { label: "我不知道怎样把题目条件变成方程" },
    { label: "我不知道从哪里开始" },
    { label: "我不确定自己具体卡在哪一步" }
  ], task);
  assert.deepEqual(options.map(item => item.label), [
    "我不知道怎样把题目条件变成方程",
    "我不知道从哪里开始",
    "我不确定自己具体卡在哪一步"
  ]);
});

test("缺少或不合格的AI卡点安全回退到通用卡点", () => {
  const fallback = helpOptionsForTask({ ...task, helpOptions: [{ label: "只有一个" }] });
  assert.equal(fallback.source, "generic");
  assert.deepEqual(fallback.options, GENERIC_HELP_OPTIONS);
});

test("空选择表示没有选择，非空非法选择返回400错误", () => {
  assert.equal(resolveHelpSelection({ ...task, helpOptions: [] }, ""), null);
  assert.equal(resolveHelpSelection({ ...task, helpOptions: [] }, undefined), null);
  assert.equal(resolveHelpSelection({ ...task, helpOptions: [] }, null), null);
  assert.throws(
    () => resolveHelpSelection({ ...task, helpOptions: [] }, { label: "point-1" }),
    error => error.code === "INVALID_HELP_SELECTION" && error.status === 400
  );
  assert.throws(
    () => resolveHelpSelection({ ...task, helpOptions: [{ label: "条件" }, { label: "方法" }, { label: "起点" }] }, "point-9"),
    error => error.code === "INVALID_HELP_SELECTION" && error.status === 400
  );
});

test("AI输入即使携带通用id也统一改为唯一point id，审核中的旧任务回退通用卡点", () => {
  const options = normalizeHelpOptions([
    { id: "conditions", label: "我不知道题目给了哪些条件" },
    { id: "method", label: "我不知道该用哪个公式" },
    { id: "start", label: "我不知道从哪里开始" }
  ]);
  assert.deepEqual(options.map(item => item.id), ["point-1", "point-2", "point-3"]);
  const review = helpOptionsForTask({ helpOptions: options, taskReview: { status: "structure_only" } });
  assert.equal(review.source, "generic");
  assert.deepEqual(review.options, GENERIC_HELP_OPTIONS);
  const legacy = helpOptionsForTask({ helpOptions: options, taskReview: { status: "needsTeacherReview" } });
  assert.equal(legacy.source, "generic");
});

test("任务仅在求助阶段公开卡点，先思阶段不泄露", () => {
  const normalized = normalizeTaskInput({
    ...task,
    helpOptions: [
      { label: "我不知道条件之间的关系" },
      { label: "我不知道使用哪个公式" },
      { label: "我不知道从哪里开始" }
    ],
    hints: ["先找一个条件", "说出一个关系", "写出一个公式"],
    judgmentCard: { statement: "建议", correctVerdict: "信息不足", reason: "需要条件" },
    transferTask: { text: "另一题", knowledgePoint: "方程", referenceProof: "列方程" },
    learningContract: { coreIdea: "列式", acceptableEvidence: ["关系"], commonMisconceptions: [], knowledgePoints: ["方程"] }
  });
  const initial = taskToPublic(normalized, { stage: "initial_thinking" });
  const help = taskToPublic(normalized, { stage: "help", knowledgeCards: [] });
  assert.equal(Object.hasOwn(initial, "helpOptions"), false);
  assert.equal(help.helpOptions.length, 3);
  assert.equal(help.helpOptionsSource, "ai");
});

test("提示模型收到点选卡点时会标记为界面选择而非学生原话", () => {
  const client = new DeepSeekClient("");
  const messages = client.buildMessages({
    task: { ...task, problemType: "equation", subject: "初中数学" },
    session: { answers: { initial: { text: "我知道有一个未知数" } } },
    hint: { level: 1, content: "先指出一个关系" },
    selectedStuckPoint: { id: "point-1", label: "我不知道怎样把条件变成方程" }
  });
  const joined = messages.map(item => String(item.content)).join("\n");
  assert.match(joined, /学生点选的具体卡点/);
  assert.match(joined, /界面选择/);
  assert.match(joined, /我不知道怎样把条件变成方程/);
  assert.match(joined, /仅选择了卡点，没有补充文字或图片/);
});

test("每轮提示后使用带轮次的卡点白名单，旧轮ID不能继续选择", () => {
  const taskWithOptions = {
    ...task,
    helpOptions: [
      { label: "我不知道题目给了哪些条件" },
      { label: "我不知道该用哪个公式或定理" },
      { label: "我不知道从哪里开始" }
    ]
  };
  const session = { completedHints: ["h1"], answers: { helpSelections: [{ label: "我不知道从哪里开始" }] } };
  const advanced = advanceHelpOptions(taskWithOptions, session, {
    nextHelpOptions: [
      { label: "我不明白刚才提示里的数量关系" },
      { label: "我不会把提示用回原题" },
      { label: "我不知道下一步怎么检查" }
    ],
    selectedStuckPoint: { label: "我不知道从哪里开始" },
    reply: { message: "先找出题目给出的数量关系。" },
    previousOptions: helpOptionsForTask(taskWithOptions).options
  });
  assert.equal(advanced.round, 1);
  assert.deepEqual(advanced.options.map(item => item.id), ["r1-point-1", "r1-point-2", "r1-point-3"]);
  assert.equal(helpOptionsForSession(taskWithOptions, session).options[0].id, "r1-point-1");
  assert.throws(
    () => resolveHelpSelection(taskWithOptions, "point-1", session),
    error => error.code === "INVALID_HELP_SELECTION"
  );
  assert.equal(resolveHelpSelection(taskWithOptions, "r1-point-2", session).id, "r1-point-2");
  const publicRound = taskToPublic(taskWithOptions, { stage: "help", session, knowledgeCards: [] });
  assert.equal(publicRound.helpOptionsRound, 1);
  assert.equal(publicRound.helpOptions[0].id, "r1-point-1");
});

test("两个会话的后续卡点互相隔离，旧会话没有session.helpOptions时也不重放初始组", () => {
  const taskWithOptions = {
    ...task,
    helpOptions: [
      { label: "我不知道题目给了哪些条件" },
      { label: "我不知道该用哪个公式或定理" },
      { label: "我不知道从哪里开始" }
    ]
  };
  const first = { completedHints: ["h1"], answers: { helpSelections: [{ label: "我不知道从哪里开始" }] } };
  const second = { completedHints: ["h1"], answers: { helpSelections: [{ label: "我不知道该用哪个公式或定理" }] } };
  const firstOptions = helpOptionsForSession(taskWithOptions, first);
  const secondOptions = helpOptionsForSession(taskWithOptions, second);
  assert.equal(firstOptions.round, 1);
  assert.equal(secondOptions.round, 1);
  assert.notEqual(firstOptions.options[0].label, secondOptions.options[0].label);
  assert.match(firstOptions.options[0].label, /从哪里开始/);
  assert.match(secondOptions.options[0].label, /公式或定理/);
  assert.match(firstOptions.options[0].id, /^r1-point-1$/u);
  assert.equal(helpOptionsForSession(taskWithOptions, { completedHints: [] }).round, 0);
});

test("模型未给后续选项或重复上一整组时安全生成下一轮通用卡点", () => {
  const taskWithOptions = {
    ...task,
    helpOptions: [
      { label: "我不知道题目给了哪些条件" },
      { label: "我不知道该用哪个公式或定理" },
      { label: "我不知道从哪里开始" }
    ]
  };
  const session = { completedHints: ["h1", "h2"], answers: {} };
  const result = advanceHelpOptions(taskWithOptions, session, {
    nextHelpOptions: taskWithOptions.helpOptions,
    selectedStuckPoint: { label: "我不知道该用哪个公式或定理" },
    previousOptions: helpOptionsForTask(taskWithOptions).options
  });
  assert.equal(result.source, "generic");
  assert.equal(result.round, 2);
  assert.ok(result.options.some(item => /公式或定理/.test(item.label)));
  assert.ok(result.options.every(item => /^r2-point-\d+$/u.test(item.id)));
  assert.equal(session.helpOptions.round, 2);
});


test("旧页面已用过提示但尚无轮次字段时可接续一次，随后拒绝旧ID", () => {
  const legacy = { completedHints: ["h1"], answers: { hint1: { reply: { message: "先找一个数量关系。" } } } };
  const initial = helpOptionsForTask(task).options[0];
  assert.equal(resolveHelpSelection(task, initial.id, legacy).label, initial.label);
  assert.equal(helpOptionsForSession(task, legacy).round, 1);
  legacy.completedHints.push("h2");
  advanceHelpOptions(task, legacy, { selectedStuckPoint: initial, reply: { message: "看看这个关系怎样用。" } });
  assert.equal(helpOptionsForSession(task, legacy).round, 2);
  assert.throws(() => resolveHelpSelection(task, initial.id, legacy), error => error.code === "INVALID_HELP_SELECTION");
});
