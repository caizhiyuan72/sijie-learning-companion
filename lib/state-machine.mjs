import { isHelpCompletionSignal } from "./guardrails.mjs";
import { DECISIONS, VERDICTS } from "./task-schema.mjs";

/**
 * The five learning moves stay deliberately linear:
 * initial thinking -> help -> judgment -> transfer -> reflection.
 * Hint levels are substages of help, not independent product modes.
 */
export const STAGES = Object.freeze({
  INITIAL: "initial_thinking",
  HINT_1: "hint_level_1",
  HINT_2: "hint_level_2",
  HINT_3: "hint_level_3",
  JUDGMENT: "judgment",
  TRANSFER: "transfer",
  REFLECTION: "reflection",
  COMPLETED: "completed"
});

export const STAGE_ORDER = Object.freeze([
  STAGES.INITIAL,
  STAGES.HINT_1,
  STAGES.HINT_2,
  STAGES.HINT_3,
  STAGES.JUDGMENT,
  STAGES.TRANSFER,
  STAGES.REFLECTION,
  STAGES.COMPLETED
]);

const HELP_STAGES = Object.freeze([STAGES.HINT_1, STAGES.HINT_2, STAGES.HINT_3]);

export class StageError extends Error {
  constructor(message, code = "INVALID_STAGE") {
    super(message);
    this.name = "StageError";
    this.code = code;
  }
}

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function now() {
  return new Date().toISOString();
}

function imageMetadata(value) {
  if (!value) return null;
  const raw = typeof value === "string" ? value : value?.dataUrl ?? value?.url ?? value?.imageData;
  if (typeof raw !== "string" || !raw.trim()) return null;
  const match = raw.match(/^data:(image\/(?:png|jpe?g|webp));base64,([A-Za-z0-9+/=]+)$/i);
  if (!match) throw new StageError("图片格式无法识别，请上传PNG、JPG或WebP图片。", "INVALID_IMAGE_INPUT");
  const payload = match[2];
  const bytes = Math.floor(payload.length * 3 / 4) - (payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0);
  if (!bytes || bytes > 8 * 1024 * 1024) throw new StageError("图片为空或超过8MB限制，请重新上传。", "INVALID_IMAGE_INPUT");
  // Deliberately do not return raw. A session can be serialized safely.
  return { provided: true, mimeType: match[1].toLowerCase(), bytes };
}

function answerText(input = {}, keys = ["text"]) {
  for (const key of keys) {
    const value = input?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function placeholder(text) {
  return /^(不知道|不懂|不会|无|没有|略|随便|空白|123|[。！!？?…\s]+)$/u.test(clean(text));
}

function likelyRelevant(text) {
  const value = clean(text);
  return /[A-Za-z0-9角边点线面三角形全等相等垂直平行中点等腰证明条件已知目标定理长度度数图形题目观察比较方法思路数量温度道路路面草坪分数小数百分比比例方程未知数代数函数概率统计平均数面积体积速度时间路程利润折扣单价总价计算求解关系公式单位元米千克摄氏度]/iu.test(value);
}

/**
 * Normalize any student response to text plus non-sensitive image metadata.
 * The raw data URL is accepted for an in-flight model call but never stored.
 */
export function normalizeStudentAnswer(input = {}, { allowEmpty = false } = {}) {
  const source = typeof input === "string" ? { text: input } : input || {};
  const text = answerText(source, ["text", "answer", "reason", "studentText"]);
  const image = imageMetadata(source.imageData ?? source.image ?? source.imageUrl);
  if (!allowEmpty && !text && !image) throw new StageError("请先输入文字或上传一张清晰的作答图片。", "EMPTY_INPUT");
  return {
    ...(text ? { text } : {}),
    ...(image ? { image } : {})
  };
}

function normalizeDecision(result = {}) {
  const decision = clean(result.decision || result.outcome || result.status).toLowerCase();
  return DECISIONS.includes(decision) ? decision : "retry";
}

function safeEvaluation(result = {}) {
  const decision = normalizeDecision(result);
  const confidence = Number(result.confidence);
  return {
    decision,
    feedback: clean(result.feedback || result.message).slice(0, 1600),
    matchedIdeas: Array.isArray(result.matchedIdeas) ? result.matchedIdeas.map(clean).filter(Boolean).slice(0, 12) : [],
    coreIssue: clean(result.coreIssue || result.issue).slice(0, 1000),
    nextPrompt: clean(result.nextPrompt || result.followUpQuestion).slice(0, 1000),
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence > 1 ? confidence / 100 : confidence)) : null,
    at: now()
  };
}

function ensureAttemptCounts(session) {
  session.attemptCounts ||= { initial: 0, judgment: 0, transfer: 0, reflection: 0 };
  for (const key of ["initial", "judgment", "transfer", "reflection"]) {
    if (!Number.isFinite(session.attemptCounts[key])) session.attemptCounts[key] = 0;
  }
  return session.attemptCounts;
}

function touch(session) {
  session.updatedAt = now();
  return session;
}

export function createSession(taskId, anonymousId, options = {}) {
  // Supporting an object here makes the function convenient for a server that
  // creates a session directly from confirmed recognition output.
  if (taskId && typeof taskId === "object") {
    const source = taskId;
    options = anonymousId || {};
    taskId = source.taskId ?? source.id;
    anonymousId = source.anonymousId;
  }
  const timestamp = now();
  return {
    id: crypto.randomUUID(),
    anonymousId: clean(anonymousId) || `匿名-${crypto.randomUUID().slice(0, 8)}`,
    taskId: clean(taskId),
    stage: STAGES.INITIAL,
    completedHints: [],
    answers: {},
    attemptCounts: { initial: 0, judgment: 0, transfer: 0, reflection: 0 },
    assistance: { initial: false, help: false, judgment: false, transfer: false },
    riskCounts: { directAnswerRequests: 0, blockedLeaks: 0, irrelevantInputs: 0 },
    ...(options && typeof options === "object" && options.metadata ? { metadata: options.metadata } : {}),
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

export function assertStage(session, allowed) {
  if (!session || !Array.isArray(allowed) && typeof allowed !== "string") throw new StageError("会话状态无效。", "INVALID_SESSION");
  const stages = Array.isArray(allowed) ? allowed : [allowed];
  if (!stages.includes(session.stage)) throw new StageError(`当前处于“${session.stage}”，不能执行该操作。`, "STAGE_SKIP_BLOCKED");
}

/** No fixed character threshold: only empty, pure placeholder, or unrelated input is blocked. */
export const STUCK_POINTS = Object.freeze([
  "不知道题目给了什么条件",
  "不知道用哪个公式或定理",
  "不知道从哪里开始",
  "找不到相等关系",
  "不知道用哪个定理"
]);

export function validateInitialThinking(input = {}) {
  const source = typeof input === "string" ? { text: input } : input || {};
  const image = imageMetadata(source.imageData ?? source.image ?? source.imageUrl);
  if (STUCK_POINTS.includes(source.stuckPoint)) return true;
  const known = clean(source.known);
  const goal = clean(source.goal);
  if (!image && (known || goal) && (!known || !goal)) throw new StageError("请分别填写“已知”和“求证”。", "INCOMPLETE_INITIAL_FACTS");
  const values = [source.text, known, goal, source.firstIdea].map(value => clean(value)).filter(Boolean);
  if (!values.length && !image) throw new StageError("请先写出一点题目骨架：已知条件和求证，或上传你的草稿图片。", "INSUFFICIENT_THINKING");
  if (!image && values.length && values.every(placeholder)) throw new StageError("请先写出具体的已知条件或求证内容，不能只填写“不知道”。", "INSUFFICIENT_THINKING");
  if (!image && values.length && values.every(value => !likelyRelevant(value))) {
    throw new StageError("这段内容暂时无法判断为数学题信息，请补充题目中的数量、关系、单位、公式或图形。", "INSUFFICIENT_THINKING");
  }
  return true;
}

export function availableHint(task = {}, session) {
  const hints = Array.isArray(task.hints) ? task.hints : [];
  return hints
    .map((hint, index) => ({ ...hint, id: hint.id || `h${hint.level || index + 1}`, level: hint.level || index + 1 }))
    .sort((a, b) => a.level - b.level)
    .find(hint => !session.completedHints.includes(hint.id) && (hint.dependencies || []).every(id => session.completedHints.includes(id))) || null;
}

export function submitInitial(session, input = {}) {
  // A clearer-input/retry result may be submitted again without breaking the
  // five-stage order. Other stages remain strictly protected.
  const canRetry = session?.stage === STAGES.HINT_1 && ["retry", "clearer_input"].includes(session.answers?.initial?.evaluation?.decision);
  assertStage(session, canRetry ? [STAGES.INITIAL, STAGES.HINT_1] : STAGES.INITIAL);
  validateInitialThinking(input);
  const source = typeof input === "string" ? { text: input } : input || {};
  // Keep the structured fields for the student record while also producing a
  // canonical text snapshot for model evaluation and older consumers.
  const normalized = normalizeStudentAnswer({
    ...source,
    text: source.text || [
      source.known ? `已知：${source.known}` : "",
      source.goal ? `求证：${source.goal}` : "",
      source.firstIdea || ""
    ].filter(value => typeof value === "string" && value.trim()).join("\n")
  }, { allowEmpty: STUCK_POINTS.includes(source.stuckPoint) });
  const legacy = {};
  for (const field of ["known", "goal", "firstIdea"]) {
    const value = clean(source[field]);
    if (value) legacy[field] = value;
  }
  session.answers.initial = { ...normalized, ...legacy, ...(STUCK_POINTS.includes(source.stuckPoint) ? { stuckPoint: source.stuckPoint } : {}), source: "student" };
  ensureAttemptCounts(session).initial += 1;
  session.stage = STAGES.HINT_1;
  return touch(session);
}

export function applyInitialEvaluation(session, evaluation = {}) {
  assertStage(session, [STAGES.HINT_1, STAGES.INITIAL]);
  session.answers.initial ||= {};
  session.answers.initial.evaluation = safeEvaluation(evaluation);
  if (session.answers.initial.evaluation.decision === "clearer_input") {
    session.stage = STAGES.INITIAL;
    ensureAttemptCounts(session).initial = Math.max(0, session.attemptCounts.initial - 1);
  }
  if (session.answers.initial.evaluation.decision === "assisted") session.assistance.initial = true;
  return touch(session);
}

function availableStageForHint(level) {
  return ({ 1: STAGES.HINT_1, 2: STAGES.HINT_2, 3: STAGES.HINT_3 })[Number(level)];
}

export function unlockHint(session, hint) {
  if (!hint || !Number.isInteger(Number(hint.level))) throw new StageError("提示数据无效。", "INVALID_HINT");
  const level = Number(hint.level);
  assertStage(session, availableStageForHint(level));
  const id = clean(hint.id) || `h${level}`;
  const dependencies = Array.isArray(hint.dependencies) ? hint.dependencies : level === 1 ? [] : level === 2 ? ["h1"] : ["h1", "h2"];
  if (dependencies.some(item => !session.completedHints.includes(item))) throw new StageError("上一级提示尚未完成，当前提示不能解锁。", "HINT_DEPENDENCY_BLOCKED");
  if (!session.completedHints.includes(id)) session.completedHints.push(id);
  session.answers.hintUses = Number(session.answers.hintUses || 0) + 1;
  session.stage = level === 1 ? STAGES.HINT_2 : level === 2 ? STAGES.HINT_3 : STAGES.HINT_3;
  return touch(session);
}

export function recordHintEvaluation(session, level, evaluation = {}) {
  assertStage(session, HELP_STAGES);
  const key = `hint${Number(level)}`;
  session.answers[key] ||= {};
  session.answers[key].evaluation = safeEvaluation(evaluation);
  return touch(session);
}

export const applyHelpEvaluation = recordHintEvaluation;

/** Finish help explicitly, or after the third hint. This never waits for a human operator. */
export function finishHelp(session, input = {}) {
  assertStage(session, HELP_STAGES);
  const source = typeof input === "string" ? { studentText: input } : input || {};
  const selfDeclared = source.reason === "self_declared" || source.action === "understood" || source.allowSelfDeclaration === true;
  if (!selfDeclared && source.evaluation?.decision !== "pass") throw new StageError("请先用自己的话解释一个关键关系，通过核验后再继续。", "UNDERSTANDING_CHECK_REQUIRED");
  const response = normalizeStudentAnswer({ text: source.studentText ?? source.text, imageData: source.imageData }, { allowEmpty: selfDeclared });
  if (!selfDeclared && (!response.text && !response.image || isHelpCompletionSignal(response.text))) throw new StageError("请补充具体数学理由，不能只说我懂了。", "UNDERSTANDING_CHECK_REQUIRED");
  const assisted = Boolean(selfDeclared || source.assisted || source.decision === "assisted" || source.reason === "hints_exhausted" || session.completedHints.length >= 3);
  session.answers.helpExit = {
    ...response,
    reason: selfDeclared ? "self_declared" : source.reason === "hints_exhausted" ? "hints_exhausted" : source.reason === "explicit_button" ? "explicit_button" : "understanding_signal",
    evaluation: safeEvaluation(source.evaluation),
    completedHintCount: session.completedHints.length,
    decision: assisted ? "assisted" : "pass",
    at: now()
  };
  session.assistance.help ||= assisted;
  session.stage = STAGES.JUDGMENT;
  return touch(session);
}

export const exhaustHelp = finishHelp;
export const completeHelp = finishHelp;

/** A student-facing replacement for the old teacher escalation hook. */
export function requestAssistance(session, input = {}) {
  assertStage(session, HELP_STAGES);
  const selected = input.selectedStuckPoint;
  const selection = selected && typeof selected.id === "string" && typeof selected.label === "string"
    ? { id: selected.id, label: selected.label } : null;
  const response = normalizeStudentAnswer(input, { allowEmpty: Boolean(selection) });
  session.answers.helpRequests ||= [];
  session.answers.helpRequests.push({
    ...response,
    ...(selection ? { selectedStuckPoint: selection, stuckPoint: selection.label } : {}),
    at: now()
  });
  return touch(session);
}

// Kept as a source-compatible alias for old callers; it never creates a
// teacher queue or blocks the session.
export const requestTeacherHelp = requestAssistance;

function applyAttemptEvaluation(session, type, evaluation = {}, nextStage) {
  const result = safeEvaluation(evaluation);
  const attempts = ensureAttemptCounts(session)[type];
  if (result.decision === "clearer_input") {
    session.attemptCounts[type] = Math.max(0, attempts - 1);
    return result;
  }
  const exhausted = attempts >= 2;
  if (result.decision === "pass") {
    session.stage = nextStage;
  } else if (result.decision === "assisted" || exhausted) {
    session.assistance[type] = true;
    session.stage = nextStage;
    result.decision = "assisted";
  }
  return result;
}

function judgmentInput(input = {}) {
  const source = input || {};
  const verdict = clean(source.verdict || source.choice || source.judgment);
  if (!VERDICTS.includes(verdict)) throw new StageError("请选择“合理”“不合理”或“信息不足”。", "INSUFFICIENT_JUDGMENT");
  const response = normalizeStudentAnswer({ text: source.reason ?? source.text, imageData: source.imageData ?? source.image }, { allowEmpty: true });
  if (!response.text && !response.image) throw new StageError("请补充一句判断依据，文字或图片都可以。", "INSUFFICIENT_JUDGMENT");
  return { verdict, ...response };
}

export function submitJudgment(session, input = {}, evaluation = null) {
  assertStage(session, STAGES.JUDGMENT);
  const answer = judgmentInput(input);
  ensureAttemptCounts(session).judgment += 1;
  session.answers.judgment ||= { attempts: [] };
  session.answers.judgment.attempts ||= [];
  session.answers.judgment.attempts.push(answer);
  session.answers.judgment.latest = answer;
  if (evaluation) applyJudgmentEvaluation(session, evaluation);
  else session.stage = STAGES.TRANSFER;
  return touch(session);
}

export function applyJudgmentEvaluation(session, evaluation = {}) {
  assertStage(session, [STAGES.JUDGMENT, STAGES.TRANSFER]);
  const result = applyAttemptEvaluation(session, "judgment", evaluation, STAGES.TRANSFER);
  session.answers.judgment ||= { attempts: [] };
  session.answers.judgment.evaluation = result;
  session.answers.judgment.retryAvailable = session.stage === STAGES.JUDGMENT;
  return touch(session);
}

function transferInput(input = {}) {
  const source = input || {};
  const response = normalizeStudentAnswer({ text: source.answer ?? source.text, imageData: source.imageData ?? source.image }, { allowEmpty: false });
  return response;
}

export function submitTransfer(session, input = {}, evaluation = null) {
  assertStage(session, STAGES.TRANSFER);
  const answer = transferInput(input);
  ensureAttemptCounts(session).transfer += 1;
  session.answers.transfer ||= { attempts: [] };
  session.answers.transfer.attempts ||= [];
  session.answers.transfer.attempts.push(answer);
  session.answers.transfer.latest = answer;
  if (evaluation) applyTransferEvaluation(session, evaluation);
  else session.stage = STAGES.REFLECTION;
  return touch(session);
}

export function applyTransferEvaluation(session, evaluation = {}) {
  assertStage(session, [STAGES.TRANSFER, STAGES.REFLECTION]);
  const result = applyAttemptEvaluation(session, "transfer", evaluation, STAGES.REFLECTION);
  session.answers.transfer ||= { attempts: [] };
  session.answers.transfer.evaluation = result;
  session.answers.transfer.retryAvailable = session.stage === STAGES.TRANSFER;
  return touch(session);
}

export function submitReflection(session, input = {}) {
  assertStage(session, STAGES.REFLECTION);
  const source = input || {};
  const result = {};
  for (const field of ["selfWork", "aiHelp", "nextTime"]) {
    const text = clean(source[field]);
    const image = imageMetadata(source[`${field}ImageData`] ?? source[`${field}Image`]);
    if (text) result[field] = text;
    if (image) result[`${field}Image`] = image;
  }
  const generic = normalizeStudentAnswer(source, { allowEmpty: true });
  if (generic.text || generic.image) result.text = generic.text || undefined, result.image = generic.image || undefined;
  if (!Object.keys(result).some(key => result[key])) throw new StageError("请留下至少一条反思，文字或图片都可以。", "INSUFFICIENT_REFLECTION");
  session.attemptCounts.reflection += 1;
  session.answers.reflection = result;
  session.stage = STAGES.COMPLETED;
  session.completedAt = now();
  session.updatedAt = session.completedAt;
  return session;
}

/** Defensive serializer for APIs and stores; strips any accidental raw image value. */
export function sanitizeSession(session) {
  const clone = structuredClone(session);
  const scrub = value => {
    if (!value || typeof value !== "object") return;
    for (const key of Object.keys(value)) {
      if (["imageData", "dataUrl", "base64"].includes(key)) delete value[key];
      else if (typeof value[key] === "object") scrub(value[key]);
    }
  };
  scrub(clone);
  return clone;
}
