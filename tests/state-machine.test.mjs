import test from "node:test";
import assert from "node:assert/strict";
import {
  STAGES,
  applyInitialEvaluation,
  availableHint,
  createSession,
  finishHelp,
  normalizeStudentAnswer,
  sanitizeSession,
  submitInitial,
  submitJudgment,
  submitReflection,
  submitTransfer,
  unlockHint
} from "../lib/state-machine.mjs";
import { classifyStudentInput, detectLeak } from "../lib/guardrails.mjs";

const IMAGE_DATA = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const task = {
  id: "state-geometry-001",
  problemText: "在△ABC中，AB=AC，D是BC的中点，求证AD⊥BC。",
  proofGoal: "证明AD垂直BC",
  diagramDescription: "A在上方，B、D、C共线，连接AD。",
  hints: [
    { id: "h1", level: 1, dependencies: [], content: "先找AD两侧的三角形。" },
    { id: "h2", level: 2, dependencies: ["h1"], content: "列出两组已知边和公共边。" },
    { id: "h3", level: 3, dependencies: ["h1", "h2"], content: "全等后能得到什么角关系？" }
  ]
};

function initial(text = "找AD两侧的三角形") {
  return { text };
}

function judgmentSession() {
  const session = createSession(task.id, "state-test");
  submitInitial(session, initial());
  finishHelp(session, { text: "AD是公共边，所以AD等于AD。", evaluation: { decision: "pass" } });
  return session;
}

test("四步状态路径按顺序完成，先思支持宽松表达", () => {
  const session = createSession(task.id, "模拟-001");
  submitInitial(session, { text: "我觉得比较两个三角形" });
  applyInitialEvaluation(session, {
    decision: "pass",
    feedback: "核心入口正确",
    matchedIdeas: ["比较两个三角形"],
    confidence: 0.86
  });
  assert.equal(session.stage, STAGES.HINT_1);
  finishHelp(session, { text: "AD是公共边，所以AD等于AD。", evaluation: { decision: "pass" } });
  submitJudgment(session, { verdict: "不合理", reason: "只看图形还不够，需要条件。" }, { decision: "pass" });
  assert.equal(session.stage, STAGES.TRANSFER);
  submitTransfer(session, { text: "换个图形也先找相等边" }, { decision: "pass" });
  assert.equal(session.stage, STAGES.REFLECTION);
  submitReflection(session, { text: "以后先整理已知关系。" });
  assert.equal(session.stage, STAGES.COMPLETED);
  assert.equal(session.attemptCounts.initial, 1);
  assert.equal(session.attemptCounts.judgment, 1);
  assert.equal(session.attemptCounts.transfer, 1);
  assert.equal(session.attemptCounts.reflection, 1);
});

test("先思只拦截空白、占位词和明显无关内容", () => {
  const blank = createSession(task.id, "模拟-002");
  assert.throws(() => submitInitial(blank, { text: "  " }), /写出一点|输入/);
  const placeholder = createSession(task.id, "模拟-003");
  assert.throws(() => submitInitial(placeholder, { text: "不会" }), /具体的已知条件或求证内容/);
  const irrelevant = createSession(task.id, "模拟-004");
  assert.throws(() => submitInitial(irrelevant, { text: "天气真好" }), /数学题信息/);
});

test("先思用结构化的已知和求证替代第一步想法", () => {
  const session = createSession(task.id, "模拟-结构化先思");
  submitInitial(session, { known: "AB=AC；D是BC的中点", goal: "AD⊥BC" });
  assert.equal(session.stage, STAGES.HINT_1);
  assert.equal(session.answers.initial.known, "AB=AC；D是BC的中点");
  assert.equal(session.answers.initial.goal, "AD⊥BC");
  assert.match(session.answers.initial.text, /已知：AB=AC/);
  assert.match(session.answers.initial.text, /求证：AD⊥BC/);

  const incomplete = createSession(task.id, "模拟-结构化缺项");
  assert.throws(() => submitInitial(incomplete, { known: "AB=AC" }), /分别填写/);
});

test("文字很短或只有图片也不会被固定字数门槛拦截", () => {
  const short = createSession(task.id, "模拟-005");
  submitInitial(short, { text: "角" });
  assert.equal(short.stage, STAGES.HINT_1);
  const image = createSession(task.id, "模拟-006");
  submitInitial(image, { imageData: IMAGE_DATA });
  assert.deepEqual(image.answers.initial.image, { provided: true, mimeType: "image/png", bytes: 68 });
});

test("提示严格遵循一级到三级依赖", () => {
  const session = createSession(task.id, "模拟-007");
  submitInitial(session, initial());
  assert.equal(availableHint(task, session).id, "h1");
  assert.throws(() => unlockHint(session, task.hints[1]), /不能执行/);
  unlockHint(session, task.hints[0]);
  assert.equal(session.stage, STAGES.HINT_2);
  unlockHint(session, task.hints[1]);
  assert.equal(session.stage, STAGES.HINT_3);
  unlockHint(session, task.hints[2]);
  assert.deepEqual(session.completedHints, ["h1", "h2", "h3"]);
  assert.equal(availableHint(task, session), null);
});

test("学生表示理解后可以提前结束求助", () => {
  const session = createSession(task.id, "模拟-008");
  submitInitial(session, initial());
  unlockHint(session, task.hints[0]);
  finishHelp(session, { text: "AD是公共边，所以AD等于AD。", evaluation: { decision: "pass" } });
  assert.equal(session.stage, STAGES.JUDGMENT);
  assert.equal(session.completedHints.length, 1);
  assert.equal(session.answers.helpExit.text, "AD是公共边，所以AD等于AD。");
  assert.equal(session.assistance.help, false);
});

test("三级提示后仍需理解核验，通过后记录帮助程度", () => {
  const session = createSession(task.id, "模拟-009");
  submitInitial(session, initial());
  for (const hint of task.hints) unlockHint(session, hint);
  assert.throws(() => finishHelp(session, { reason: "hints_exhausted", assisted: true }), /核验/);
  assert.equal(session.stage, STAGES.HINT_3);
  finishHelp(session, { text: "AD是公共边，所以AD等于AD。", evaluation: { decision: "pass" } });
  assert.equal(session.stage, STAGES.JUDGMENT);
  assert.equal(session.answers.helpExit.decision, "assisted");
  assert.equal(session.assistance.help, true);
});

test("判别第一次retry仍留在判别，第二次后转为assisted", () => {
  const session = judgmentSession();
  submitJudgment(session, { verdict: "不合理", reason: "还不确定" }, { decision: "retry", nextPrompt: "补充关键条件" });
  assert.equal(session.stage, STAGES.JUDGMENT);
  assert.equal(session.attemptCounts.judgment, 1);
  assert.equal(session.answers.judgment.evaluation.decision, "retry");
  submitJudgment(session, { verdict: "不合理", reason: "缺少已知条件支持" }, { decision: "retry" });
  assert.equal(session.stage, STAGES.TRANSFER);
  assert.equal(session.attemptCounts.judgment, 2);
  assert.equal(session.answers.judgment.evaluation.decision, "assisted");
  assert.equal(session.assistance.judgment, true);
});

test("判别选择必须合法且依据可用图片提交", () => {
  const session = judgmentSession();
  assert.throws(() => submitJudgment(session, { verdict: "不知道", reason: "看不清" }), /合理.*不合理.*信息不足/);
  submitJudgment(session, { verdict: "信息不足", imageData: IMAGE_DATA }, { decision: "pass" });
  assert.equal(session.stage, STAGES.TRANSFER);
  assert.equal(session.answers.judgment.latest.image.provided, true);
});

test("迁移第一次retry可重试，第二次后进入反思并标记assisted", () => {
  const session = judgmentSession();
  submitJudgment(session, { verdict: "合理", reason: "条件看起来够用" }, { decision: "pass" });
  submitTransfer(session, { text: "我试着找对应边" }, { decision: "retry", nextPrompt: "再写一条关系" });
  assert.equal(session.stage, STAGES.TRANSFER);
  assert.equal(session.attemptCounts.transfer, 1);
  submitTransfer(session, { imageData: IMAGE_DATA }, { decision: "retry", feedback: "展示解析" });
  assert.equal(session.stage, STAGES.REFLECTION);
  assert.equal(session.attemptCounts.transfer, 2);
  assert.equal(session.answers.transfer.evaluation.decision, "assisted");
  assert.equal(session.assistance.transfer, true);
});

test("反思没有固定字数门槛，任一字段或图片即可完成", () => {
  const textSession = judgmentSession();
  submitJudgment(textSession, { verdict: "合理", reason: "可以" }, { decision: "pass" });
  submitTransfer(textSession, { text: "对应关系" }, { decision: "pass" });
  submitReflection(textSession, { nextTime: "记条件" });
  assert.equal(textSession.stage, STAGES.COMPLETED);

  const imageSession = judgmentSession();
  submitJudgment(imageSession, { verdict: "合理", reason: "可以" }, { decision: "pass" });
  submitTransfer(imageSession, { text: "对应关系" }, { decision: "pass" });
  submitReflection(imageSession, { aiHelpImageData: IMAGE_DATA });
  assert.equal(imageSession.stage, STAGES.COMPLETED);
  assert.equal(imageSession.answers.reflection.aiHelpImage.provided, true);
});

test("阶段不能跳过，状态中的图片原文会被安全清除", () => {
  const session = createSession(task.id, "模拟-010");
  assert.throws(() => finishHelp(session), /不能执行/);
  assert.throws(() => submitTransfer(session, { text: "直接跳过" }), /不能执行/);
  submitInitial(session, { text: "找角", imageData: IMAGE_DATA });
  const safe = sanitizeSession(session);
  assert.equal(JSON.stringify(safe).includes(IMAGE_DATA), false);
  assert.equal(safe.answers.initial.image.provided, true);
});

test("统一作答规范同时保留文字和非敏感图片元数据", () => {
  const answer = normalizeStudentAnswer({ text: "找公共边", imageData: IMAGE_DATA });
  assert.equal(answer.text, "找公共边");
  assert.deepEqual(answer.image, { provided: true, mimeType: "image/png", bytes: 68 });
  assert.equal(Object.hasOwn(answer, "imageData"), false);
  assert.throws(() => normalizeStudentAnswer({ text: "" }), /文字或上传/);
});

test("学习防护仍识别索要完整答案和答案泄露", () => {
  assert.equal(classifyStudentInput("不要提示，直接把完整证明写出来").directAnswerRequest, true);
  assert.equal(detectLeak("所以AD⊥BC", { protectedPhrases: ["AD⊥BC"] }).leaked, true);
  assert.equal(detectLeak("还缺少公共边吗？", { protectedPhrases: ["AD⊥BC"] }).leaked, false);
});

test("普通数学题中明显套用三角形面积公式会被识别为答非所问", () => {
  const text = "我想用三角形面积公式，但不知道这个题的高和底在哪里。";
  assert.equal(classifyStudentInput(text, {
    isGeometryProof: false,
    subject: "初中数学",
    problemText: "土壤表面温度约为40℃，沥青路面是土壤的11/8，求草坪温度。"
  }).offTopic, true);
  assert.equal(classifyStudentInput(text, {
    isGeometryProof: true,
    subject: "初中数学·几何证明",
    problemText: "在三角形ABC中求证垂直关系。"
  }).offTopic, false);
});

test("先思图片看不清会留在先思且不占用一次数学尝试", () => {
  const session = createSession(task.id, "clearer-initial");
  submitInitial(session, { imageData: IMAGE_DATA });
  applyInitialEvaluation(session, { decision: "clearer_input", feedback: "请拍清楚一些" });
  assert.equal(session.stage, STAGES.INITIAL);
  assert.equal(session.attemptCounts.initial, 0);
});

test("判别图片看不清不会触发第二次失败后的assisted", () => {
  const session = judgmentSession();
  submitJudgment(session, { verdict: "信息不足", imageData: IMAGE_DATA }, { decision: "clearer_input" });
  assert.equal(session.stage, STAGES.JUDGMENT);
  assert.equal(session.attemptCounts.judgment, 0);
  submitJudgment(session, { verdict: "信息不足", reason: "还缺少关键条件" }, { decision: "retry" });
  assert.equal(session.stage, STAGES.JUDGMENT);
  assert.equal(session.answers.judgment.evaluation.decision, "retry");
});

test("具体卡点可替代空白先思且不生成学生文字", () => {
  const session = createSession(task.id, "卡点模拟");
  submitInitial(session, { stuckPoint: "找不到相等关系" });
  assert.equal(session.answers.initial.text, undefined);
  assert.equal(session.answers.initial.source, "student");
  assert.equal(session.answers.initial.stuckPoint, "找不到相等关系");
  assert.throws(() => submitInitial(createSession(task.id), { stuckPoint: "乱填" }), /写出一点/);
});

test("完成求助必须有通过核验的具体数学解释", () => {
  const session = createSession(task.id);
  submitInitial(session, { text: "想比较三角形" });
  assert.throws(() => finishHelp(session, { text: "因为AD是公共边" }), /核验/);
  assert.throws(() => finishHelp(session, { text: "我懂了", evaluation: { decision: "pass" } }), /具体数学/);
  assert.equal(session.stage, STAGES.HINT_1);
});

test("我懂了按钮可以直接进入判别并标记为辅助完成", () => {
  const session = createSession(task.id, "模拟-我懂了按钮");
  submitInitial(session, { text: "想比较三角形" });
  finishHelp(session, {
    action: "understood",
    studentText: "我懂了",
    reason: "self_declared",
    assisted: true,
    evaluation: { decision: "assisted", feedback: "直接进入判别" }
  });
  assert.equal(session.stage, STAGES.JUDGMENT);
  assert.equal(session.answers.helpExit.reason, "self_declared");
  assert.equal(session.answers.helpExit.decision, "assisted");
  assert.equal(session.assistance.help, true);
});


test("先思手写图可代替已知文字，同时沿用确认的求解目标", () => {
  const session = createSession(task.id, "photo-conditions");
  submitInitial(session, { goal: "证明AD垂直BC", imageData: IMAGE_DATA });
  assert.equal(session.stage, STAGES.HINT_1);
  assert.equal(session.answers.initial.goal, "证明AD垂直BC");
  assert.ok(session.answers.initial.image.provided);
  assert.equal(session.answers.initial.known, undefined);
  assert.doesNotMatch(JSON.stringify(sanitizeSession(session)), /data:image/);
});
