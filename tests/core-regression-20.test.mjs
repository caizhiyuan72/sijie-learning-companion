import test from "node:test";
import assert from "node:assert/strict";
import {
  STAGES,
  applyInitialEvaluation,
  availableHint,
  createSession,
  finishHelp,
  submitInitial,
  submitJudgment,
  submitReflection,
  submitTransfer,
  unlockHint
} from "../lib/state-machine.mjs";
import { classifyStudentInput, detectLeak, redactPersonalInfo } from "../lib/guardrails.mjs";

const IMAGE_DATA = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

const task = {
  id: "student-geometry-001",
  grade: "八年级",
  title: "等腰三角形底边中线",
  problemText: "在△ABC中，AB=AC，D是BC的中点，求证AD⊥BC。",
  proofGoal: "证明AD垂直BC",
  diagramDescription: "A在上方，B、D、C在同一直线上，连接AD。",
  learningGoal: "用全等三角形说明目标关系。",
  hints: [
    { id: "h1", level: 1, dependencies: [], content: "先找出AD两侧的两个三角形。" },
    { id: "h2", level: 2, dependencies: ["h1"], content: "把已知的两组边和公共边列出来。" },
    { id: "h3", level: 3, dependencies: ["h1", "h2"], content: "想想全等后能得到哪一组角关系。" }
  ],
  protectedPhrases: ["△ABD≌△ACD", "AD⊥BC"],
  referenceProof: "证明两三角形全等，再结合邻补角得到直角。"
};

const initialIdea = { text: "找AD两侧的三角形，比较它们的边。" };

function toJudgment() {
  const session = createSession(task.id, "回归测试");
  submitInitial(session, initialIdea);
  finishHelp(session, { text: "AD是公共边，所以AD等于AD。", evaluation: { decision: "pass" } });
  return session;
}

function throughAllHints() {
  const session = createSession(task.id, "三级提示测试");
  submitInitial(session, initialIdea);
  for (const hint of task.hints) unlockHint(session, hint);
  return session;
}

const cases = [
  ["01 初始空白仍被拦截", () => {
    assert.throws(() => submitInitial(createSession(task.id, "A"), { text: "   " }), /写出一点|输入/);
  }],
  ["02 初始占位词仍被拦截", () => {
    assert.throws(() => submitInitial(createSession(task.id, "B"), { text: "不知道" }), /具体的已知条件或求证内容/);
  }],
  ["03 短但相关的初始思路可以通过", () => {
    const session = createSession(task.id, "C");
    submitInitial(session, { text: "角" });
    assert.equal(session.stage, STAGES.HINT_1);
    assert.equal(session.attemptCounts.initial, 1);
  }],
  ["04 题目或作答图片可以单独作为先思输入", () => {
    const session = createSession(task.id, "D");
    submitInitial(session, { imageData: IMAGE_DATA });
    assert.equal(session.stage, STAGES.HINT_1);
    assert.deepEqual(session.answers.initial.image, { provided: true, mimeType: "image/png", bytes: 68 });
    assert.equal(JSON.stringify(session).includes(IMAGE_DATA), false);
  }],
  ["05 未进入先思不能解锁提示", () => {
    const session = createSession(task.id, "E");
    assert.throws(() => unlockHint(session, task.hints[0]), /不能执行/);
  }],
  ["06 不能跳到二级提示", () => {
    const session = createSession(task.id, "F");
    submitInitial(session, initialIdea);
    assert.throws(() => unlockHint(session, task.hints[1]), /不能执行/);
  }],
  ["07 先思后可用提示是一级", () => {
    const session = createSession(task.id, "G");
    submitInitial(session, initialIdea);
    assert.equal(availableHint(task, session).id, "h1");
  }],
  ["08 完成一级后可用提示是二级", () => {
    const session = createSession(task.id, "H");
    submitInitial(session, initialIdea);
    unlockHint(session, task.hints[0]);
    assert.equal(session.stage, STAGES.HINT_2);
    assert.equal(availableHint(task, session).id, "h2");
  }],
  ["09 完成二级后可用提示是三级", () => {
    const session = createSession(task.id, "I");
    submitInitial(session, initialIdea);
    unlockHint(session, task.hints[0]);
    unlockHint(session, task.hints[1]);
    assert.equal(session.stage, STAGES.HINT_3);
    assert.equal(availableHint(task, session).id, "h3");
  }],
  ["10 三级提示完成后不再生成第四级", () => {
    const session = throughAllHints();
    assert.equal(session.stage, STAGES.HINT_3);
    assert.equal(session.completedHints.length, 3);
    assert.equal(availableHint(task, session), null);
  }],
  ["11 直接索要答案可被识别", () => {
    assert.equal(classifyStudentInput("直接告诉我完整证明").directAnswerRequest, true);
  }],
  ["12 与几何无关的输入可被识别", () => {
    assert.equal(classifyStudentInput("天气真好").irrelevant, true);
  }],
  ["13 个人手机号会被脱敏", () => {
    assert.match(redactPersonalInfo("请联系13812345678"), /手机号已隐藏/);
  }],
  ["14 最终结论命中保护片段", () => {
    assert.equal(detectLeak("所以AD⊥BC", task).leaked, true);
  }],
  ["15 完整证明片段命中保护片段", () => {
    assert.equal(detectLeak("△ABD≌△ACD", task).leaked, true);
  }],
  ["16 多步结论输出会被拦截", () => {
    assert.equal(detectLeak("先找边，所以得到角相等，因此可以证明垂直", task).leaked, true);
  }],
  ["17 局部追问不会误报为答案泄露", () => {
    assert.equal(detectLeak("还缺少哪条公共边？", task).leaked, false);
  }],
  ["18 判别允许简短但有依据的回答", () => {
    const session = toJudgment();
    submitJudgment(session, { verdict: "不合理", reason: "还缺少条件。" });
    assert.equal(session.stage, STAGES.TRANSFER);
    assert.equal(session.attemptCounts.judgment, 1);
  }],
  ["19 迁移允许简短结论并进入反思", () => {
    const session = toJudgment();
    submitJudgment(session, { verdict: "信息不足", reason: "题干没有给出角的关系。" });
    submitTransfer(session, { answer: "先看对应角" });
    assert.equal(session.stage, STAGES.REFLECTION);
    assert.equal(session.attemptCounts.transfer, 1);
  }],
  ["20 判别和迁移第二次未通过会辅助完成并可反思", () => {
    const session = toJudgment();
    submitJudgment(session, { verdict: "不合理", reason: "理由还不完整" }, { decision: "retry", feedback: "再想一步" });
    assert.equal(session.stage, STAGES.JUDGMENT);
    submitJudgment(session, { verdict: "不合理", reason: "仍然没有说明条件" }, { decision: "retry", feedback: "我来补充关键点" });
    assert.equal(session.stage, STAGES.TRANSFER);
    assert.equal(session.answers.judgment.evaluation.decision, "assisted");
    submitTransfer(session, { text: "我先找对应关系" }, { decision: "retry" });
    assert.equal(session.stage, STAGES.TRANSFER);
    submitTransfer(session, { imageData: IMAGE_DATA }, { decision: "retry" });
    assert.equal(session.stage, STAGES.REFLECTION);
    assert.equal(session.answers.transfer.evaluation.decision, "assisted");
    submitReflection(session, { nextTime: "先整理已知条件" });
    assert.equal(session.stage, STAGES.COMPLETED);
    assert.equal(session.assistance.judgment, true);
    assert.equal(session.assistance.transfer, true);
  }]
];

assert.equal(cases.length, 20, "core regression must keep exactly 20 cases");
for (const [name, fn] of cases) test(name, fn);
