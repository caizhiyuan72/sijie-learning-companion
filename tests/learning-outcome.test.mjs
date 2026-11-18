import test from "node:test";
import assert from "node:assert/strict";
import { publicTaskReview, summarizeLearningOutcome } from "../lib/learning-outcome.mjs";
import { summarizeSession } from "../lib/teacher-summary.mjs";

function completedSession(overrides = {}) {
  return {
    stage: "completed",
    completedAt: "2026-11-11T00:00:00.000Z",
    attemptCounts: { initial: 1, judgment: 1, transfer: 1, reflection: 1 },
    completedHints: [],
    assistance: { initial: false, help: false, judgment: false, transfer: false },
    taskReview: { status: "model_checked", needsTeacherReview: false },
    answers: {
      initial: { text: "已知条件和求证目标", evaluation: { decision: "pass" } },
      helpExit: { text: "我先找对应关系", decision: "pass" },
      judgment: { latest: { verdict: "合理", text: "理由" }, evaluation: { decision: "pass" } },
      transfer: { latest: { text: "换一个数据仍先核对条件" }, evaluation: { decision: "pass" } },
      reflection: { nextTime: "下次先核对适用条件" }
    },
    ...overrides
  };
}

test("流程完成与独立掌握分开返回", () => {
  const outcome = summarizeLearningOutcome(completedSession());
  assert.equal(outcome.flowCompleted, true);
  assert.equal(outcome.status, "independent");
  assert.equal(outcome.label, "独立通过");
  assert.deepEqual(outcome.stages.map(stage => stage.key), ["initial_thinking", "help", "judgment", "transfer", "reflection"]);
  assert.equal(outcome.stages.find(stage => stage.key === "reflection").countsTowardMastery, false);
});

test("判别或迁移在辅助下继续时不能计为独立掌握", () => {
  const session = completedSession({
    assistance: { initial: false, help: false, judgment: true, transfer: false },
    answers: {
      ...completedSession().answers,
      judgment: { latest: { verdict: "合理", text: "理由" }, evaluation: { decision: "assisted" } }
    }
  });
  const outcome = summarizeLearningOutcome(session);
  assert.equal(outcome.status, "assisted");
  assert.equal(outcome.stages.find(stage => stage.key === "judgment").status, "assisted");
  assert.match(outcome.stages.find(stage => stage.key === "judgment").reason, /不计为独立掌握/);
});

test("没有提示的我懂了自声明也标为辅助继续", () => {
  const session = completedSession({
    completedHints: [],
    assistance: { initial: false, help: false, judgment: false, transfer: false },
    answers: {
      ...completedSession().answers,
      helpExit: { text: "我懂了", reason: "self_declared", decision: "pass" }
    }
  });
  const outcome = summarizeLearningOutcome(session);
  const help = outcome.stages.find(stage => stage.key === "help");
  assert.equal(help.status, "assisted");
  assert.equal(help.selfDeclared, true);
  assert.equal(outcome.status, "assisted");
});

test("先思retry和clearer_input保留且不被误报为通过", () => {
  const retry = summarizeLearningOutcome({
    stage: "hint_level_1",
    attemptCounts: { initial: 1 },
    answers: { initial: { text: "看不出来", evaluation: { decision: "retry" } } }
  });
  const retryStage = retry.stages.find(stage => stage.key === "initial_thinking");
  assert.equal(retryStage.status, "pending");
  assert.equal(retryStage.hadRetry, true);

  const unclear = summarizeLearningOutcome({
    stage: "initial_thinking",
    attemptCounts: { initial: 0 },
    answers: { initial: { image: { provided: true }, evaluation: { decision: "clearer_input" } } }
  });
  const unclearStage = unclear.stages.find(stage => stage.key === "initial_thinking");
  assert.equal(unclearStage.status, "pending");
  assert.equal(unclearStage.hadClearerInput, true);
});

test("结构化恢复或旧会话需要教师复核，但不覆盖已有辅助证据", () => {
  const recovered = summarizeLearningOutcome(completedSession({
    taskReview: { status: "structure_only", needsTeacherReview: true, reason: "候选任务未通过语义核验" }
  }));
  assert.equal(recovered.status, "review_required");
  assert.equal(recovered.needsTeacherReview, true);
  assert.equal(recovered.taskReview.status, "structure_only");

  const oldAssisted = summarizeLearningOutcome(completedSession({
    taskReview: undefined,
    assistance: { initial: false, help: false, judgment: false, transfer: true },
    answers: {
      ...completedSession().answers,
      transfer: { latest: { text: "在帮助下继续" }, evaluation: { decision: "assisted" } }
    }
  }));
  assert.equal(oldAssisted.status, "assisted");
  assert.equal(oldAssisted.needsTeacherReview, true);
  assert.equal(oldAssisted.taskReview.status, "unknown");
});

test("公开学习结果隐藏语义核验原文，内部教师摘要仍保留诊断", () => {
  const secret = "参考解析：SECRET_REFERENCE_ANSWER；迁移答案不应返回学生端";
  const session = completedSession({
    taskReview: { status: "structure_only", needsTeacherReview: true, reason: secret }
  });
  const internal = summarizeLearningOutcome(session);
  const publicView = summarizeLearningOutcome(session, { publicView: true });
  assert.equal(internal.taskReview.reason, secret);
  assert.equal(publicView.taskReview.status, "structure_only");
  assert.equal(publicView.taskReview.needsTeacherReview, true);
  assert.equal(publicView.taskReview.reason, "任务已完成结构核对，但内容仍需教师复核。");
  assert.doesNotMatch(JSON.stringify(publicView), /SECRET_REFERENCE_ANSWER|迁移答案/);
  assert.match(publicTaskReview({ status: "unknown", needsTeacherReview: true, reason: secret }).reason, /状态未知/);
  assert.doesNotMatch(JSON.stringify(publicTaskReview({ status: "unknown", needsTeacherReview: true, reason: secret })), /SECRET_REFERENCE_ANSWER|迁移答案/);
});

test("教师摘要包含统一学习结果字段", () => {
  const summary = summarizeSession(completedSession(), { problemText: "解方程" });
  assert.equal(summary.learningOutcome.status, "independent");
  assert.equal(summary.learningOutcome.flowCompleted, true);
});

