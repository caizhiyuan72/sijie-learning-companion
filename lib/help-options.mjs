const MAX_OPTIONS = 5;
const MIN_OPTIONS = 3;
const MAX_LABEL_LENGTH = 80;

/**
 * A small, deliberately conservative fallback. These labels describe a
 * student's uncertainty without exposing any task-specific solution.
 */
export const GENERIC_HELP_OPTIONS = Object.freeze([
  Object.freeze({ id: "conditions", label: "我不知道题目给了哪些条件" }),
  Object.freeze({ id: "method", label: "我不知道该用哪个公式或定理" }),
  Object.freeze({ id: "start", label: "我不知道从哪里开始" }),
  Object.freeze({ id: "unsure", label: "我不确定自己具体卡在哪一步" })
]);

const DIRECT_ANSWER_PATTERN = /(?:完整|最终|直接|只要).{0,8}(?:答案|解法|证明|过程)|(?:答案|解法|证明过程).{0,8}(?:全部|完整|写出)/iu;
const MULTI_STEP_PATTERN = /(?:所以|因此|从而|由此可得|故|∴|→|=>|步骤一|第一步|第二步|第三步)/u;
const UNSAFE_MARKER_PATTERN = /(?:<script|javascript:|data:text\/html|ignore\s+(?:all|previous)|忽略(?:以上|前面)指令)/iu;
const FOLLOW_UP_LABELS = Object.freeze([
  "我还是不明白刚才提示里的这个关系",
  "我不会把这个提示用回原题",
  "我不知道下一步怎么继续",
  "我不确定自己是否理解了"
]);

function text(value) {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (!value || typeof value !== "object") return "";
  for (const key of ["label", "text", "content", "title"]) {
    if (value[key] !== undefined) {
      const result = text(value[key]);
      if (result) return result;
    }
  }
  return "";
}

function normalized(value) {
  return text(value).replace(/[\s，。；：、,.!！?？()（）]/g, "").toLowerCase();
}

function protectedPhraseHit(label, task = {}) {
  const candidate = normalized(label);
  if (!candidate) return false;
  return (Array.isArray(task?.protectedPhrases) ? task.protectedPhrases : [])
    .map(normalized)
    .filter(Boolean)
    .some(phrase => candidate.includes(phrase));
}

function safeLabel(value, task = {}) {
  const label = text(value).replace(/\u0000/g, "").replace(/\s+/g, " ").trim();
  if (!label || label.length > MAX_LABEL_LENGTH) return "";
  if (DIRECT_ANSWER_PATTERN.test(label) || MULTI_STEP_PATTERN.test(label) || UNSAFE_MARKER_PATTERN.test(label)) return "";
  if (protectedPhraseHit(label, task)) return "";
  return label;
}

function sameLabels(left = [], right = []) {
  const a = new Set(left.map(item => normalized(item)).filter(Boolean));
  const b = new Set(right.map(item => normalized(item)).filter(Boolean));
  return a.size > 0 && a.size === b.size && [...a].every(label => b.has(label));
}

function optionWithRoundId(item, round, index) {
  return { id: `r${round}-point-${index + 1}`, label: item.label };
}

function contextualFallbackOptions(task = {}, session = {}, round = 1) {
  const latestSelection = Array.isArray(session?.answers?.helpSelections)
    ? session.answers.helpSelections.at(-1)?.label
    : session?.answers?.[`hint${round}`]?.student?.selectedStuckPoint?.label;
  const selectedLabel = safeLabel(latestSelection, task);
  const selectedTail = selectedLabel ? `“${selectedLabel.slice(0, 28)}”` : "这个卡点";
  const labels = [
    `我还是不明白刚才提示里的${selectedTail}`,
    "我不会把这个提示用回原题",
    "我不知道下一步怎么继续",
    "我不确定自己是否理解了"
  ];
  const normalizedOptions = normalizeHelpOptions(labels, task);
  const options = normalizedOptions.length
    ? normalizedOptions
    : [{ id: "point-1", label: "我不确定自己具体卡在哪一步" }];
  return {
    options: options.map((item, index) => optionWithRoundId(item, round, index)),
    source: "generic",
    round
  };
}

function sessionOptions(task = {}, session = null) {
  const round = Number(session?.helpOptions?.round);
  const stored = session?.helpOptions;
  if (stored && Number.isInteger(round) && round >= 1 && Array.isArray(stored.options)) {
    const options = [];
    const seen = new Set();
    for (const item of stored.options) {
      const label = safeLabel(item, task);
      const id = text(item?.id);
      if (!label || !/^r\d+-point-\d+$/u.test(id) || !id.startsWith(`r${round}-point-`)) continue;
      const key = normalized(label);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      options.push({ id, label });
      if (options.length >= MAX_OPTIONS) break;
    }
    if (options.length) {
      return { options, source: text(stored.source) === "ai" ? "ai" : "generic", round };
    }
    return contextualFallbackOptions(task, session, round);
  }
  const initial = helpOptionsForTask(task);
  const completedHints = Math.max(
    Number(session?.completedHints?.length || 0),
    [1, 2, 3].filter(level => session?.answers?.[`hint${level}`]).length
  );
  if (completedHints > 0) return contextualFallbackOptions(task, session, completedHints);
  return { ...initial, round: 0 };
}

/**
 * Normalize model-provided task options. AI ids are intentionally discarded:
 * the server owns the public allow-list ids so a client cannot invent a label
 * or select a private task field. Generic ids are assigned only by the
 * fallback list below.
 */
export function normalizeHelpOptions(value, task = {}) {
  const input = Array.isArray(value) ? value : value && typeof value === "object" ? value.options : [];
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const result = [];
  for (const item of input) {
    const label = safeLabel(item, task);
    if (!label) continue;
    const key = normalized(label);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push({ id: `point-${result.length + 1}`, label });
    if (result.length >= MAX_OPTIONS) break;
  }
  // A task-specific set is only considered AI-generated when it has enough
  // choices to make the picker useful. Older tasks can safely fall back.
  return result.length >= MIN_OPTIONS ? result : [];
}

export function helpOptionsForTask(task = {}) {
  const reviewStatus = text(task?.taskReview?.status).toLowerCase();
  const needsReview = task?.taskReview?.needsTeacherReview === true
    || reviewStatus === "structure_only"
    || reviewStatus === "needsteacherreview"
    || reviewStatus === "needs_teacher_review";
  if (needsReview) return { options: GENERIC_HELP_OPTIONS.map(item => ({ ...item })), source: "generic" };
  const options = normalizeHelpOptions(task?.helpOptions, task);
  return options.length
    ? { options, source: "ai" }
    : { options: GENERIC_HELP_OPTIONS.map(item => ({ ...item })), source: "generic" };
}

export function helpOptionsForSession(task = {}, session = null) {
  return sessionOptions(task, session);
}

export function resolveHelpSelection(task = {}, id, session = null) {
  if (id === undefined || id === null) return null;
  if (typeof id !== "string") {
    const error = new Error("请选择当前题目中的一个卡点。 ");
    error.status = 400;
    error.code = "INVALID_HELP_SELECTION";
    throw error;
  }
  const selectionId = id.trim();
  // Empty selection is a valid absence of the optional picker choice. The
  // route decides whether text/image input is enough; only a non-empty,
  // unknown id is a client error.
  if (!selectionId) return null;
  const { options } = helpOptionsForSession(task, session);
  let selected = options.find(item => item.id === selectionId);
  // An already-open pre-rounds page still shows the initial picker. Let
  // that legacy session continue once using the label it actually displayed;
  // the delivered response stores round-scoped options from then on.
  const legacyContinuation = !session?.helpOptions && Number(session?.completedHints?.length || 0) > 0;
  if (!selected && legacyContinuation) {
    selected = helpOptionsForTask(task).options.find(item => item.id === selectionId);
  }
  if (!selected) {
    const error = new Error("请选择当前题目中的一个卡点。 ");
    error.status = 400;
    error.code = "INVALID_HELP_SELECTION";
    throw error;
  }
  return selected;
}

/**
 * Replace the picker after each delivered hint. The model's labels are
 * normalized again here because this is the session boundary that becomes
 * selectable by the browser. The task's initial options are never mutated.
 */
export function advanceHelpOptions(task = {}, session = {}, { nextHelpOptions, selectedStuckPoint = null, reply = null, previousOptions = null } = {}) {
  const round = Math.max(1, Number(session?.completedHints?.length || 0));
  const previous = Array.isArray(previousOptions) && previousOptions.length
    ? previousOptions
    : (round > 1 ? helpOptionsForSession(task, { ...session, helpOptions: session.helpOptions }).options : helpOptionsForTask(task).options);
  const candidate = normalizeHelpOptions(nextHelpOptions, task);
  const candidateLabels = candidate.map(item => item.label);
  let options = candidate;
  let source = "ai";
  if (!options.length || sameLabels(candidateLabels, previous.map(item => item.label))) {
    const fallback = contextualFallbackOptions(task, {
      answers: {
        helpSelections: selectedStuckPoint ? [{ label: safeLabel(selectedStuckPoint, task) }] : []
      }
    }, round);
    const followUp = fallback.options.map((item, index) => ({ ...item, id: `point-${index + 1}` }));
    const replyText = safeLabel(reply?.message ?? reply, task);
    if (replyText && !followUp.some(item => normalized(item.label) === normalized(replyText)) && followUp[1]) {
      // Keep the model reply out of the label unless it is short and clearly
      // a question; the selected label remains the required stable anchor.
      followUp[1] = { ...followUp[1], label: `${FOLLOW_UP_LABELS[1]}（${replyText.slice(0, 18)}）` };
    }
    options = followUp;
    source = "generic";
  }
  session.helpOptions = {
    round,
    source,
    options: options.map((item, index) => optionWithRoundId(item, round, index))
  };
  return { options: session.helpOptions.options.map(item => ({ ...item })), source, round };
}

export const __private__ = Object.freeze({ safeLabel, normalized, sameLabels });
