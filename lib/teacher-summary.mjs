import { summarizeLearningOutcome } from "./learning-outcome.mjs";
import { normalizeUsername } from "./state-machine.mjs";

const HINT_LEVELS = Object.freeze([1, 2, 3]);
const TEXT_LIMIT = 1200;
const SHORT_TEXT_LIMIT = 240;
const REFERENCE_MARKER = /(?:参考解析|参考答案|标准答案|完整解答)\s*[:：]?/iu;
const IMAGE_DATA_MARKER = /data:image\/(?:png|jpe?g|webp);base64,/iu;
const SECRET_MARKER = /(?:^|\s)(?:bearer\s+[A-Za-z0-9._-]{8,}|sk-[A-Za-z0-9_-]{8,}|(?:api[_ -]?key|apikey)\s*[:=]\s*[A-Za-z0-9._-]{8,})/iu;

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function list(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return [value];
  return [];
}

function sanitizeText(value, max = TEXT_LIMIT) {
  let result = String(value ?? "")
    .replace(/\u0000/g, "")
    .replace(/\r\n?/g, "\n")
    .trim();
  if (!result) return "";
  if (IMAGE_DATA_MARKER.test(result) && /^data:image\//iu.test(result)) return "";
  if (IMAGE_DATA_MARKER.test(result)) result = result.replace(/data:image\/(?:png|jpe?g|webp);base64,[A-Za-z0-9+/=]+/giu, "[图片内容已隐藏]");
  if (SECRET_MARKER.test(result)) return "[敏感内容已隐藏]";
  result = result
    .replace(/1\d{10}/g, "[手机号已隐藏]")
    .replace(/\b\d{15,18}[Xx]?\b/g, "[证件号已隐藏]");
  const referenceAt = result.search(REFERENCE_MARKER);
  if (referenceAt >= 0) result = result.slice(0, referenceAt).trim();
  return result.slice(0, max);
}

function text(value, keys = ["text", "studentText", "answer", "reason", "message", "content", "label"], max = TEXT_LIMIT) {
  if (typeof value === "string") return sanitizeText(value, max);
  if (typeof value === "number" || typeof value === "boolean") return sanitizeText(value, max);
  if (Array.isArray(value)) return sanitizeText(value.map(item => text(item, keys, max)).filter(Boolean).join("；"), max);
  if (!value || typeof value !== "object") return "";
  for (const key of keys) {
    const result = text(value[key], keys, max);
    if (result) return result;
  }
  return "";
}

function firstText(...values) {
  for (const value of values) {
    const result = text(value);
    if (result) return result;
  }
  return "";
}

function timestamp(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function hasImage(value) {
  if (!value || typeof value !== "object") return false;
  if (value.image || value.imageData || value.dataUrl || value.imageUrl || value.base64) return true;
  return Object.values(value).some(item => item && typeof item === "object" && hasImage(item));
}

function quote(value, source, at = "") {
  const textValue = text(value);
  const image = hasImage(value) || (typeof value === "string" && IMAGE_DATA_MARKER.test(value));
  if (!textValue && !image) return null;
  return {
    source,
    text: textValue || "（图片作答，原图未随摘要保存）",
    ...(image ? { image: true } : {}),
    ...(at ? { at } : {})
  };
}

function cleanDecision(value) {
  const result = text(value, ["decision", "outcome", "status"]);
  return result || "";
}

function evaluationEvidence(value, at = "") {
  const source = record(value);
  const result = {};
  const decision = cleanDecision(source);
  const feedback = text(source.feedback || source.message, ["text", "studentText", "answer", "reason", "message", "content", "label"], TEXT_LIMIT);
  const nextPrompt = text(source.nextPrompt || source.followUpQuestion || source.suggestedFollowUp, ["text", "studentText", "answer", "reason", "message", "content", "label"], TEXT_LIMIT);
  const confidence = source.confidence === null || source.confidence === undefined || source.confidence === ""
    ? Number.NaN
    : Number(source.confidence);
  if (decision) result.decision = decision;
  if (feedback) result.feedback = feedback;
  if (nextPrompt) result.nextPrompt = nextPrompt;
  if (Number.isFinite(confidence)) result.confidence = confidence;
  const observedAt = timestamp(source.at, at);
  if (observedAt) result.at = observedAt;
  return result;
}

function normalizeHelpRequest(item, index) {
  const source = record(item);
  const at = timestamp(source.at, source.createdAt, source.updatedAt);
  const student = quote(source, "提交给老师", at);
  const selectedStuckPoint = normalizeSelectedStuckPoint(source.selectedStuckPoint || source.stuckPointSelection, at);
  return {
    index: index + 1,
    ...(student ? { text: student.text, image: Boolean(student.image) } : {}),
    ...(source.stuckPoint ? { stuckPoint: text(source.stuckPoint) } : {}),
    ...(selectedStuckPoint ? { selectedStuckPoint } : {}),
    ...(at ? { at } : {})
  };
}

/** Keep a point selection separate from student-authored text. */
function normalizeSelectedStuckPoint(value, at = "") {
  if (!value) return null;
  const source = record(value);
  const id = text(source.id || source.key, ["id", "key", "label"], SHORT_TEXT_LIMIT);
  const label = text(source.label || source.text || source.content || value, ["label", "text", "content", "name", "id"], SHORT_TEXT_LIMIT);
  if (!label) return null;
  const hintLevel = Number(source.hintLevel);
  return {
    ...(id ? { id } : {}),
    label,
    ...(Number.isInteger(hintLevel) && hintLevel > 0 ? { hintLevel } : {}),
    ...(timestamp(source.at, at) ? { at: timestamp(source.at, at) } : {})
  };
}

function normalizeHint(raw, level) {
  const source = record(raw);
  const studentValue = source.student ?? source.input ?? source.answer;
  const replyValue = source.reply ?? source.output;
  const at = timestamp(source.at, record(studentValue).at, record(replyValue).at);
  const student = quote(studentValue, `第${level}级提示前学生`, at);
  const selectedStuckPoint = normalizeSelectedStuckPoint(record(studentValue).selectedStuckPoint || source.selectedStuckPoint, at);
  if (selectedStuckPoint && !selectedStuckPoint.hintLevel) selectedStuckPoint.hintLevel = level;
  const reply = quote(replyValue, `第${level}级提示`, at);
  const evaluation = evaluationEvidence(source.evaluation || source.assessment, at);
  if (!student && !selectedStuckPoint && !reply && !Object.keys(evaluation).length) return null;
  return {
    level,
    ...(student ? { student } : {}),
    ...(selectedStuckPoint ? { selectedStuckPoint } : {}),
    ...(reply ? { reply } : {}),
    ...(Object.keys(evaluation).length ? { evaluation } : {}),
    ...(at ? { at } : {})
  };
}

function normalizeHelpCheck(raw) {
  const source = record(raw);
  const attempts = list(source.attempts).map((item, index) => {
    const value = record(item);
    const at = timestamp(value.at, value.createdAt, value.updatedAt);
    const student = quote(value.text ?? value.student ?? value.input ?? value.answer, "求助核验时学生", at);
    const evaluation = evaluationEvidence(value.evaluation || value.result, at);
    return {
      index: index + 1,
      ...(student ? { student } : {}),
      ...(Object.keys(evaluation).length ? { evaluation } : {}),
      ...(at ? { at } : {})
    };
  }).filter(item => item.student || Object.keys(item.evaluation || {}).length);
  const evaluations = list(source.evaluations).map((item, index) => {
    const value = evaluationEvidence(item);
    return Object.keys(value).length ? { index: index + 1, ...value } : null;
  }).filter(Boolean);
  const latest = attempts.at(-1) || evaluations.at(-1) || null;
  return {
    attempts,
    evaluations,
    ...(latest ? { latest } : {})
  };
}

function taskEvidence(task) {
  const source = record(task);
  const result = {};
  for (const [key, aliases] of Object.entries({
    title: ["title", "name"],
    proofGoal: ["proofGoal", "goal", "target"],
    diagramDescription: ["diagramDescription", "diagramAlt"]
  })) {
    const value = firstText(...aliases.map(alias => source[alias]));
    if (value) result[key] = value;
  }
  const problemText = [source.problemText, source.problem, source.text].map(value => text(value, undefined, 4000)).find(Boolean);
  if (problemText) result.problemText = problemText;
  const knownFacts = list(source.knownFacts).map(item => text(item, undefined, SHORT_TEXT_LIMIT)).filter(Boolean).slice(0, 12);
  if (knownFacts.length) result.knownFacts = knownFacts;
  const problemType = text(source.problemType, ["problemType", "type", "label"], SHORT_TEXT_LIMIT);
  if (problemType) result.problemType = problemType;
  const knowledgePoints = list(source.knowledgePoints)
    .map(item => text(item, ["text", "content", "label", "name"], SHORT_TEXT_LIMIT))
    .filter(Boolean)
    .slice(0, 8);
  if (knowledgePoints.length) result.knowledgePoints = knowledgePoints;
  return result;
}

function normalizeStageAnswer(raw, label, at = "") {
  const source = record(raw);
  const attempts = list(source.attempts);
  const latest = record(source.latest || attempts.at(-1));
  const observedAt = timestamp(latest.at, source.at, at);
  const result = { attempts: attempts.length };
  const verdict = text(latest.verdict || latest.choice || latest.judgment, ["text", "label", "value"], SHORT_TEXT_LIMIT);
  if (verdict) result.verdict = verdict;
  const answer = quote(latest, label, observedAt);
  if (answer) result.answer = answer;
  const evaluation = evaluationEvidence(source.evaluation || latest.evaluation, observedAt);
  if (Object.keys(evaluation).length) result.evaluation = evaluation;
  if (observedAt) result.at = observedAt;
  return result;
}

function retryEvidence(label, evaluations) {
  return evaluations.filter(item => item?.decision === "retry" && item.feedback && item.feedback !== "这组选择还不成立。")
    .map(item => ({ stage: label, feedback: item.feedback, ...(item.at ? { at: item.at } : {}) }));
}

function attemptRetryEvidence(raw) {
  return list(raw?.attempts).map(item => {
    const evaluation = evaluationEvidence(item?.evaluation);
    if (evaluation.decision === "retry" && item.evaluation.evidence === "choice") {
      const answer = text(item, undefined, SHORT_TEXT_LIMIT);
      const verdict = text(item.verdict, undefined, SHORT_TEXT_LIMIT);
      if (answer) evaluation.feedback = `未通过的点选：${verdict ? `${verdict} · ` : ""}${answer}`;
    }
    return evaluation;
  });
}

function normalizeReflection(raw, at = "") {
  const source = record(raw);
  const observedAt = timestamp(source.at, source.createdAt, source.updatedAt, at);
  const fields = {
    selfWork: "学生自己完成的部分",
    aiHelp: "学生记录的AI帮助",
    nextTime: "学生记录的下次策略"
  };
  const result = {};
  for (const [field, label] of Object.entries(fields)) {
    const value = quote({ text: source[field], image: source[`${field}Image`] }, label, observedAt);
    if (value) result[field] = value;
  }
  const note = quote({ text: source.text, image: source.image }, "学生反思补充", observedAt);
  if (note && !Object.keys(result).length) result.note = note;
  if (observedAt && Object.keys(result).length) result.at = observedAt;
  return result;
}

function normalizeKnowledgeReferences(raw) {
  const values = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? [raw] : [];
  return values.map(item => {
    const source = record(item);
    const id = text(source.id || source.cardId || source.knowledgeId, ["id", "cardId", "knowledgeId", "label"], SHORT_TEXT_LIMIT);
    const version = text(source.version || source.cardVersion, ["version", "cardVersion", "label"], SHORT_TEXT_LIMIT);
    const title = text(source.title || source.name, ["title", "name", "label"], SHORT_TEXT_LIMIT);
    const reason = text(source.reason || source.matchReason || source.matchedBy, ["reason", "matchReason", "matchedBy", "text", "label"], SHORT_TEXT_LIMIT);
    const stage = text(source.stage, ["stage", "label"], SHORT_TEXT_LIMIT);
    const purpose = text(source.purpose, ["purpose", "label"], SHORT_TEXT_LIMIT);
    if (!id && !title) return null;
    return {
      ...(id ? { id } : {}),
      ...(version ? { version } : {}),
      ...(title ? { title } : {}),
      ...(reason ? { reason } : {}),
      ...(stage ? { stage } : {}),
      ...(purpose ? { purpose } : {}),
      ...(timestamp(source.at) ? { at: timestamp(source.at) } : {})
    };
  }).filter(Boolean).slice(0, 80);
}

function normalizeHelpStatus(source, answers, helpRequests, hints) {
  const helpExit = record(answers.helpExit);
  const assistance = record(source.assistance);
  const completedHints = Array.isArray(source.completedHints) ? source.completedHints : [];
  const hintCount = Math.max(completedHints.length, hints.length);
  const result = {
    hintsUsed: hintCount,
    teacherRequestCount: helpRequests.length,
    teacherRequested: helpRequests.length > 0,
    assisted: assistance.help === true || cleanDecision(helpExit.decision) === "assisted"
  };
  const reason = text(helpExit.reason, ["reason", "text", "label"], SHORT_TEXT_LIMIT);
  const decision = cleanDecision(helpExit.decision || helpExit.evaluation?.decision);
  if (reason) result.exitReason = reason;
  if (decision) result.exitDecision = decision;
  const completedHintCount = Number(helpExit.completedHintCount);
  if (Number.isFinite(completedHintCount) && completedHintCount >= 0) result.exitHintCount = completedHintCount;
  const assistedStages = Object.entries(assistance)
    .filter(([, value]) => value === true)
    .map(([stage]) => stage)
    .slice(0, 8);
  if (assistedStages.length) result.assistedStages = assistedStages;
  return result;
}

/**
 * Reduce a stored student session to evidence a teacher can inspect.
 *
 * The function intentionally does not infer ability, dependence, or a
 * diagnosis. `needsHelp` only reflects an unresolved, explicitly recorded
 * signal while the session is still in help; historical signals remain in the
 * evidence fields after the student moves on.
 */
export function summarizeSession(session = {}, task = {}) {
  const source = record(session);
  const answers = record(source.answers);
  const initial = record(answers.initial);
  const initialAt = timestamp(initial.at, initial.createdAt, source.createdAt);
  const initialStuckPoint = firstText(initial.stuckPoint, source.stuckPoint);
  const helpRequests = list(answers.helpRequests ?? source.helpRequests).map(normalizeHelpRequest);
  const hints = HINT_LEVELS.map(level => normalizeHint(answers[`hint${level}`], level)).filter(Boolean);
  const recordedSelectionsValue = answers.helpSelections ?? source.helpSelections;
  const hasAuthoritativeSelections = Array.isArray(recordedSelectionsValue);
  const recordedHelpSelections = hasAuthoritativeSelections
    ? recordedSelectionsValue.map(item => normalizeSelectedStuckPoint(item)).filter(Boolean)
    : [];
  const requestSelections = helpRequests.map(item => item.selectedStuckPoint).filter(Boolean);
  const hintSelections = hints.map(item => item.selectedStuckPoint).filter(Boolean);
  const legacySelections = [...requestSelections, ...hintSelections]
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      const leftAt = Date.parse(left.item.at || "");
      const rightAt = Date.parse(right.item.at || "");
      if (Number.isFinite(leftAt) && Number.isFinite(rightAt) && leftAt !== rightAt) return leftAt - rightAt;
      if (Number.isFinite(leftAt) !== Number.isFinite(rightAt)) return Number.isFinite(leftAt) ? -1 : 1;
      return left.index - right.index;
    })
    .map(entry => entry.item)
    .filter((item, index, all) => {
      const key = `${item.id || ""}|${item.label}|${item.at || ""}`;
      return all.findIndex(candidate => `${candidate.id || ""}|${candidate.label}|${candidate.at || ""}` === key) === index;
    });
  // New sessions persist the picker history directly, including repeated
  // choices. Only legacy sessions need reconstruction from hint/request data.
  const helpSelections = hasAuthoritativeSelections ? recordedHelpSelections : legacySelections;
  const latestSelection = helpSelections.at(-1) || null;
  const stuckPoint = latestSelection?.label || initialStuckPoint;
  const helpCheck = normalizeHelpCheck(answers.helpCheck);
  const judgment = normalizeStageAnswer(answers.judgment, "判别时学生理由", timestamp(answers.judgment?.at, source.updatedAt));
  const transfer = normalizeStageAnswer(answers.transfer, "迁移时学生解法", timestamp(answers.transfer?.at, source.updatedAt));
  const retryNotes = [
    ...retryEvidence("求助", [...hints.map(item => item.evaluation), ...helpCheck.evaluations, ...helpCheck.attempts.map(item => item.evaluation)]),
    ...retryEvidence("判别", [...attemptRetryEvidence(answers.judgment), judgment.evaluation]),
    ...retryEvidence("迁移", [...attemptRetryEvidence(answers.transfer), transfer.evaluation])
  ].filter((item, index, all) => all.findIndex(candidate => candidate.stage === item.stage && candidate.feedback === item.feedback) === index);
  const reflection = normalizeReflection(answers.reflection, source.completedAt || source.updatedAt);
  const knowledgeReferences = normalizeKnowledgeReferences(source.knowledgeReferences || answers.knowledgeReferences || source.knowledge_refs);
  const initialQuote = quote(initial, "先思时学生原话", initialAt);
  const studentQuotes = [
    ...(initialStuckPoint ? [{ source: "先思时学生选择的卡点", text: initialStuckPoint, ...(initialAt ? { at: initialAt } : {}) }] : []),
    ...(initialQuote ? [initialQuote] : []),
    ...hints.map(item => item.student).filter(Boolean),
    ...helpRequests.map(item => item.text ? { source: "提交给老师时学生原话", text: item.text, ...(item.image ? { image: true } : {}), ...(item.at ? { at: item.at } : {}) } : null).filter(Boolean),
    ...helpCheck.attempts.map(item => item.student).filter(Boolean)
  ];
  const nextPrompts = [
    ...helpCheck.attempts.map(item => item.evaluation?.nextPrompt),
    ...helpCheck.evaluations.map(item => item.nextPrompt),
    ...hints.map(item => item.evaluation?.nextPrompt)
  ].filter(Boolean);
  const suggestedFollowUp = nextPrompts.at(-1)
    || (stuckPoint ? `你选择了“${stuckPoint}”，具体是哪个已知条件、证明目标或步骤让你卡住？` : "请学生指出当前已知条件、证明目标和已经尝试的下一步。")
  const taskInfo = taskEvidence(task);
  const helpRequested = helpRequests.length > 0;
  const stage = text(source.stage).toLowerCase();
  const helpStatus = normalizeHelpStatus(source, answers, helpRequests, hints);
  const inHelp = /^(?:help|hint(?:_level)?_[123])$/u.test(stage);
  const latestDecision = text(helpCheck.latest?.evaluation?.decision).toLowerCase();
  const helpSignals = Boolean(stuckPoint || helpRequested || (Array.isArray(source.completedHints) && source.completedHints.length >= 3) || hints.length >= 3);
  const needsHelp = inHelp && latestDecision !== "pass" && helpSignals;
  const trace = [
    ...(initialQuote || initialStuckPoint ? [{
      stage: "先思",
      ...(initialQuote ? { student: initialQuote } : {}),
      ...(initialStuckPoint ? { stuckPoint: initialStuckPoint } : {}),
      ...(initialAt ? { at: initialAt } : {})
    }] : []),
    ...helpSelections.map(item => ({ stage: "求助", type: "point_selection", selectedStuckPoint: item, ...(item.at ? { at: item.at } : {}) })),
    ...hints.map(item => ({ stage: "求助", type: "hint", ...item })),
    ...helpRequests.map(item => ({ stage: "求助", type: "teacher_request", ...item })),
    ...helpCheck.attempts.map(item => ({ stage: "求助核验", type: "help_check", ...item }))
  ];

  return {
    sessionId: text(source.id || source.sessionId),
    anonymousId: firstText(source.anonymousId, source.anonymous_id) || "匿名学生",
    username: normalizeUsername(source.username),
    taskId: text(source.taskId),
    ...(Object.keys(taskInfo).length ? { task: taskInfo } : {}),
    ...(taskInfo.title ? { taskTitle: taskInfo.title } : {}),
    stage: text(source.stage),
    createdAt: timestamp(source.createdAt),
    updatedAt: timestamp(source.updatedAt),
    ...(source.completedAt ? { completedAt: timestamp(source.completedAt) } : {}),
    needsHelp,
    helpRequested,
    helpStatus,
    stuckPoint,
    ...(initialStuckPoint ? { initialStuckPoint } : {}),
    helpSelections,
    helpRequests,
    hintsGiven: hints,
    helpCheck,
    retryNotes,
    judgment,
    transfer,
    ...(reflection && Object.keys(reflection).length ? { reflection } : {}),
    ...(knowledgeReferences.length ? { knowledgeReferences } : {}),
    learningOutcome: summarizeLearningOutcome(source),
    studentQuotes,
    suggestedFollowUp,
    trace
  };
}

export { summarizeLearningOutcome };

export const __private__ = Object.freeze({ taskEvidence, normalizeHelpCheck, normalizeHint });
