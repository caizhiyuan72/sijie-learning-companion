// A learning-flow completion is not the same thing as independent mastery.
// Keep this reducer deliberately conservative: it only reports the evidence
// recorded in a session and never infers a student's ability from completion
// alone.

const STAGE_LABELS = Object.freeze({
  initial_thinking: "先思",
  help: "求助",
  judgment: "判别",
  transfer: "迁移",
  reflection: "反思"
});

const STATUS_LABELS = Object.freeze({
  independent: "独立通过",
  assisted: "辅助继续",
  pending: "尚未验证",
  review_required: "需教师复核"
});

const CORE_STAGE_KEYS = Object.freeze(["initial_thinking", "help", "judgment", "transfer"]);
const STAGE_KEYS = Object.freeze([...CORE_STAGE_KEYS, "reflection"]);
const PUBLIC_TASK_REVIEW_REASONS = Object.freeze({
  model_checked: "任务已完成结构与语义核对。",
  structure_only: "任务已完成结构核对，但内容仍需教师复核。",
  not_recorded: "任务核验状态未记录，需要教师复核。",
  unknown: "任务核验状态未知，需要教师复核。"
});

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function decision(value) {
  const source = record(value);
  const raw = typeof value === "string" ? value : source.decision || source.outcome || source.status;
  return clean(raw).toLowerCase();
}

function number(value, fallback = 0) {
  const result = Number(value);
  return Number.isFinite(result) && result >= 0 ? result : fallback;
}

function hasValue(value) {
  if (typeof value === "string") return Boolean(value.trim());
  if (value && typeof value === "object") return Object.values(value).some(item => hasValue(item));
  return Boolean(value);
}

function label(status) {
  return STATUS_LABELS[status] || STATUS_LABELS.pending;
}

function stageResult(key, status, reason, extra = {}) {
  const safeStatus = STATUS_LABELS[status] ? status : "pending";
  return {
    key,
    label: STAGE_LABELS[key] || key,
    status: safeStatus,
    statusLabel: label(safeStatus),
    ...(reason ? { reason } : {}),
    ...extra
  };
}

function normalizeTaskReview(value) {
  const source = record(value);
  if (!Object.keys(source).length) {
    return {
      status: "unknown",
      needsTeacherReview: true,
      reason: "旧会话未记录任务核验状态。"
    };
  }
  let status = clean(source.status).toLowerCase();
  if (!status && source.verified === true) status = "model_checked";
  if (!status && source.verified === false) status = "structure_only";
  if (!["model_checked", "structure_only", "not_recorded", "unknown"].includes(status)) status = "unknown";
  const needsTeacherReview = source.needsTeacherReview === true || status !== "model_checked";
  const reason = clean(source.reason || source.reviewReason);
  return {
    status,
    needsTeacherReview,
    ...(reason ? { reason } : {})
  };
}

function taskReview(session) {
  return normalizeTaskReview(session?.taskReview || session?.task_review);
}

/**
 * Return task-review metadata safe for a student-facing response. The
 * verifier's diagnostic text may contain a candidate's mathematical details,
 * so public responses retain only the state and a fixed explanation.
 */
export function publicTaskReview(value = {}) {
  const normalized = normalizeTaskReview(value);
  return {
    status: normalized.status,
    needsTeacherReview: normalized.needsTeacherReview,
    reason: PUBLIC_TASK_REVIEW_REASONS[normalized.status] || PUBLIC_TASK_REVIEW_REASONS.unknown
  };
}

function initialOutcome(session, answers) {
  const source = record(answers.initial);
  const evaluation = record(source.evaluation);
  const lastDecision = decision(evaluation);
  const attempts = number(session?.attemptCounts?.initial);
  const hadRetry = lastDecision === "retry" || source.hadRetry === true || source.retry === true || attempts > 1;
  const hadClearerInput = lastDecision === "clearer_input" || source.hadClearerInput === true || source.clearerInput === true;
  const extra = { attempts, lastDecision: lastDecision || "", hadRetry, hadClearerInput };
  if (lastDecision === "assisted" || session?.assistance?.initial === true) {
    return stageResult("initial_thinking", "assisted", "先思在辅助下继续。", extra);
  }
  if (lastDecision === "pass") {
    return stageResult("initial_thinking", "independent", hadRetry || hadClearerInput ? "补充或重试后通过先思核验。" : "先思已通过核验。", extra);
  }
  if (hadClearerInput) return stageResult("initial_thinking", "pending", "先思图片或表达未能辨认，等待补充后再核验。", extra);
  if (hadRetry) return stageResult("initial_thinking", "pending", "先思核验需要重试，尚未形成通过记录。", extra);
  if (Object.keys(source).length) return stageResult("initial_thinking", "pending", "已提交先思，但尚未记录通过核验。", extra);
  return stageResult("initial_thinking", "pending", "尚未提交先思。", extra);
}

function helpOutcome(session, answers) {
  const source = record(answers.helpExit);
  const exitEvaluation = record(source.evaluation);
  const lastDecision = decision(source) || decision(exitEvaluation);
  const hintCount = Math.max(
    Array.isArray(session?.completedHints) ? session.completedHints.length : 0,
    number(source.completedHintCount),
    number(answers.hintUses)
  );
  const selfDeclared = source.reason === "self_declared"
    || source.action === "understood"
    || source.allowSelfDeclaration === true
    || /(?:我懂了|懂了|会了|明白了)/u.test(clean(source.text || source.studentText));
  const assisted = session?.assistance?.help === true || lastDecision === "assisted" || selfDeclared || (hintCount > 0 && lastDecision === "pass");
  const extra = { hintsUsed: hintCount, lastDecision: lastDecision || "", selfDeclared };
  if (assisted) {
    const reason = selfDeclared ? "学生自声明理解，未形成独立核验记录。" : hintCount > 0 ? "使用过提示后继续。" : "求助阶段在辅助下继续。";
    return stageResult("help", "assisted", reason, extra);
  }
  if (lastDecision === "pass") return stageResult("help", "independent", "求助阶段已通过核验，未记录提示或自声明替代核验。", extra);
  if (lastDecision === "clearer_input") return stageResult("help", "pending", "求助作答未能辨认，等待补充后再核验。", extra);
  if (lastDecision === "retry") return stageResult("help", "pending", "求助核验需要重试，尚未通过。", extra);
  if (Object.keys(source).length || hintCount > 0) return stageResult("help", "pending", "求助已开始，但尚未记录通过核验。", extra);
  return stageResult("help", "pending", "尚未完成求助核验。", extra);
}

function evaluatedStageOutcome(key, session, answer) {
  const source = record(answer);
  const evaluation = record(source.evaluation);
  const lastDecision = decision(evaluation);
  const attempts = number(session?.attemptCounts?.[key]);
  const extra = { attempts, lastDecision: lastDecision || "" };
  if (lastDecision === "assisted" || session?.assistance?.[key] === true) {
    return stageResult(key, "assisted", `${STAGE_LABELS[key]}在辅助下继续，不计为独立掌握。`, extra);
  }
  if (lastDecision === "pass") return stageResult(key, "independent", `${STAGE_LABELS[key]}已通过核验。`, extra);
  if (lastDecision === "clearer_input") return stageResult(key, "pending", `${STAGE_LABELS[key]}作答未能辨认，未计入失败或独立通过。`, extra);
  if (lastDecision === "retry") return stageResult(key, "pending", `${STAGE_LABELS[key]}核验需要重试，尚未通过。`, extra);
  if (Object.keys(source).length || attempts > 0) return stageResult(key, "pending", `已提交${STAGE_LABELS[key]}，但尚未记录通过核验。`, extra);
  return stageResult(key, "pending", `尚未提交${STAGE_LABELS[key]}。`, extra);
}

function reflectionOutcome(session, answers) {
  const source = record(answers.reflection);
  const evaluation = record(source.evaluation);
  const lastDecision = decision(evaluation);
  const hasReflection = hasValue(source.selfWork) || hasValue(source.aiHelp) || hasValue(source.nextTime)
    || hasValue(source.text) || hasValue(source.image) || hasValue(source.selfWorkImage)
    || hasValue(source.aiHelpImage) || hasValue(source.nextTimeImage);
  const extra = { lastDecision: lastDecision || "" };
  if (lastDecision === "assisted") return stageResult("reflection", "assisted", "反思在辅助下继续；反思本身不作为数学掌握证明。", extra);
  if (lastDecision === "clearer_input" || lastDecision === "retry") return stageResult("reflection", "pending", "反思尚未形成可辨认记录。", extra);
  if (hasReflection) return stageResult("reflection", "independent", "已留下反思记录；这不等同于独立掌握数学知识。", { ...extra, countsTowardMastery: false });
  return stageResult("reflection", "pending", "尚未留下反思记录。", { ...extra, countsTowardMastery: false });
}

function overallDescription(status, flowCompleted, review, stages) {
  if (status === "independent") return "流程已完成，判别和迁移均有独立通过记录；这只是本次过程证据，不代表长期学习效果。";
  if (status === "assisted") return `${flowCompleted ? "流程已完成" : "流程尚未完成"}，至少一个阶段在辅助下继续，不计为独立掌握。`;
  if (status === "review_required") return review.reason || "任务内容未完成模型语义核验，需要教师复核后再解释学习结果。";
  const pending = stages.filter(stage => stage.status === "pending").map(stage => stage.label).join("、");
  return pending ? `流程尚未完成或${pending}尚未通过核验。` : "关键学习动作尚未形成可核验记录。";
}

/**
 * Summarize only the learning evidence already recorded in a session.
 * `flowCompleted` is intentionally independent from `status`: a completed
 * workflow may still be assisted, pending, or awaiting teacher review.
 */
export function summarizeLearningOutcome(session = {}, { publicView = false } = {}) {
  const source = record(session);
  const answers = record(source.answers);
  const stages = [
    initialOutcome(source, answers),
    helpOutcome(source, answers),
    evaluatedStageOutcome("judgment", source, answers.judgment),
    evaluatedStageOutcome("transfer", source, answers.transfer),
    reflectionOutcome(source, answers)
  ];
  const flowCompleted = source.stage === "completed" || Boolean(clean(source.completedAt));
  const taskReviewResult = taskReview(source);
  const core = stages.filter(stage => CORE_STAGE_KEYS.includes(stage.key));
  const assisted = core.some(stage => stage.status === "assisted");
  const pending = core.some(stage => stage.status === "pending") || !flowCompleted;
  const allCoreIndependent = core.length === CORE_STAGE_KEYS.length && core.every(stage => stage.status === "independent");
  let status = "pending";
  if (assisted) status = "assisted";
  else if (!pending && allCoreIndependent && taskReviewResult.needsTeacherReview) status = "review_required";
  else if (!pending && allCoreIndependent) status = "independent";
  const exposedTaskReview = publicView ? publicTaskReview(taskReviewResult) : taskReviewResult;
  return {
    flowCompleted,
    status,
    label: label(status),
    description: overallDescription(status, flowCompleted, exposedTaskReview, stages),
    needsTeacherReview: exposedTaskReview.needsTeacherReview,
    taskReview: exposedTaskReview,
    stages
  };
}

export { CORE_STAGE_KEYS, STAGE_KEYS, STATUS_LABELS };

