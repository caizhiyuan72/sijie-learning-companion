import { safeDiagramSpec } from "./diagram-spec.mjs";
import { findKnowledgeCards, toPublicKnowledgeCard } from "./knowledge-base.mjs";
import { publicTaskReview } from "./learning-outcome.mjs";
import { helpOptionsForSession, normalizeHelpOptions } from "./help-options.mjs";

export const DECISIONS = Object.freeze(["pass", "retry", "clearer_input", "assisted"]);
export const VERDICTS = Object.freeze(["合理", "不合理", "信息不足"]);

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function invalid(message, code = "INVALID_TASK") {
  const error = new Error(message);
  error.status = 400;
  error.code = code;
  throw error;
}

export function lines(value) {
  if (Array.isArray(value)) return value.map(item => clean(item?.content ?? item)).filter(Boolean);
  return clean(value).split(/\r?\n/).map(clean).filter(Boolean);
}

function firstText(...values) {
  for (const value of values) {
    const text = clean(value);
    if (text) return text;
  }
  return "";
}

function asConfidence(value, fallback = 0.7) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(1, number > 1 && number <= 100 ? number / 100 : number));
}

function randomId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function normalizeStringList(value, max = 24) {
  return lines(value).slice(0, max).map(item => item.slice(0, 500));
}

function normalizeHint(item, index) {
  const source = typeof item === "string" ? { content: item } : item || {};
  const level = Number(source.level || index + 1);
  if (![1, 2, 3].includes(level)) invalid("提示级别必须是1、2或3。", "INVALID_HINT");
  const content = firstText(source.content, source.text, source.message);
  if (!content) invalid(`第${level}级提示不能为空。`, "INVALID_HINT");
  const dependencies = level === 1
    ? []
    : level === 2
      ? ["h1"]
      : ["h1", "h2"];
  return {
    id: `h${level}`,
    level,
    dependencies,
    kind: ["question", "local_hint", "scaffold"].includes(source.kind)
      ? source.kind
      : level === 1 ? "question" : level === 2 ? "local_hint" : "scaffold",
    content: content.slice(0, 500)
  };
}

function normalizeHints(input) {
  const values = Array.isArray(input.hints)
    ? input.hints
    : [input.hint1, input.hint2, input.hint3];
  if (values.length < 3 || values.slice(0, 3).some(item => !item)) invalid("AI任务必须包含三级提示。", "INVALID_HINT");
  const hints = values.slice(0, 3).map(normalizeHint).sort((a, b) => a.level - b.level);
  if (hints.length !== 3 || hints.some((item, index) => item.level !== index + 1)) {
    invalid("AI任务必须按1、2、3级各提供一条提示。", "INVALID_HINT");
  }
  return hints;
}

function normalizeJudgmentCard(input, existing = null) {
  const card = input.judgmentCard || {};
  const statement = firstText(card.statement, input.judgmentStatement, existing?.judgmentCard?.statement);
  const correctVerdict = firstText(card.correctVerdict, input.correctVerdict, existing?.judgmentCard?.correctVerdict);
  const reason = firstText(card.reason, card.explanation, card.teacherReason, input.reason, input.teacherReason, existing?.judgmentCard?.reason, existing?.judgmentCard?.teacherReason);
  if (!statement || !VERDICTS.includes(correctVerdict) || !reason) {
    invalid("AI任务的判别卡需要建议、合理性结论和判断依据。", "INVALID_JUDGMENT_CARD");
  }
  return {
    statement: statement.slice(0, 1200),
    correctVerdict,
    reason: reason.slice(0, 1600),
    followUpQuestion: firstText(card.followUpQuestion, card.nextPrompt, input.followUpQuestion).slice(0, 500)
  };
}

function normalizeTransferTask(input, existing = null, { requireDiagram = true } = {}) {
  // `transfer` and `transferTaskDraft` were used by earlier callers. Keep
  // accepting them while new tasks use the canonical transferTask property.
  const source = input.transferTask || input.transfer || input.transferTaskDraft || {};
  const previous = existing?.transferTask || existing?.transfer || existing?.transferTaskDraft || {};
  const text = firstText(source.text, source.problemText, input.transferText, previous.text, previous.problemText);
  if (!text) invalid("AI任务缺少迁移题题干。", "INVALID_TRANSFER_TASK");
  let diagramSpec = null;
  // A saved task may be re-normalized with only the edited transfer text.
  // Reuse its validated diagram before falling back to the main task diagram.
  const legacySourceDiagram = source.diagram && typeof source.diagram === "object" ? source.diagram : undefined;
  const legacyPreviousDiagram = previous.diagram && typeof previous.diagram === "object" ? previous.diagram : undefined;
  const candidate = source.diagramSpec
    ?? legacySourceDiagram
    ?? input.transferDiagramSpec
    ?? input.diagramSpec
    ?? previous.diagramSpec
    ?? legacyPreviousDiagram
    ?? existing?.diagramSpec;
  if (candidate !== undefined && candidate !== null && candidate !== "") {
    diagramSpec = safeDiagramSpec(candidate);
  }
  if (!diagramSpec && requireDiagram) invalid("AI迁移题缺少可安全绘制的结构化图形数据。", "INVALID_TRANSFER_DIAGRAM");
  const knowledgePoint = firstText(
    source.knowledgePoint,
    source.concept,
    input.transferKnowledgePoint,
    previous.knowledgePoint,
    previous.concept
  );
  const referenceProof = firstText(
    source.referenceProof,
    source.solution,
    input.transferReferenceProof,
    previous.referenceProof,
    previous.solution
  );
  if (!knowledgePoint || !referenceProof) {
    invalid("AI迁移题需要明确同知识点标签和经过核验的参考证明。", "INVALID_TRANSFER_TASK");
  }
  const answerOutline = firstText(
    source.answerOutline,
    source.keySteps,
    input.transferAnswerOutline,
    previous.answerOutline,
    previous.keySteps
  ) || referenceProof;
  const variantType = firstText(
    source.variantType,
    source.variant,
    input.transferVariantType,
    previous.variantType,
    previous.variant
  );
  const conditionChange = firstText(
    source.conditionChange,
    source.changedCondition,
    source.variation,
    input.transferConditionChange,
    previous.conditionChange,
    previous.changedCondition,
    previous.variation
  );
  return {
    text: text.slice(0, 2400),
    diagramDescription: firstText(
      source.diagramDescription,
      source.figureDescription,
      typeof source.diagram === "string" ? source.diagram : "",
      input.transferDiagramDescription,
      previous.diagramDescription,
      previous.figureDescription,
      typeof previous.diagram === "string" ? previous.diagram : ""
    ).slice(0, 1200),
    diagramSpec,
    knowledgePoint: knowledgePoint.slice(0, 300),
    // These fields stay server-side and are removed by publicTask in server.mjs.
    referenceProof: referenceProof.slice(0, 3000),
    answerOutline: answerOutline.slice(0, 1600),
    ...(variantType ? { variantType: variantType.slice(0, 120) } : {}),
    ...(conditionChange ? { conditionChange: conditionChange.slice(0, 1000) } : {})
  };
}

function normalizeLearningContract(input, existing = null) {
  const source = input.learningContract || {};
  return {
    coreIdea: firstText(source.coreIdea, source.targetIdea, input.targetStep, existing?.learningContract?.coreIdea).slice(0, 1000),
    acceptableEvidence: normalizeStringList(source.acceptableEvidence ?? input.acceptedPaths ?? existing?.acceptedPaths, 12),
    commonMisconceptions: normalizeStringList(source.commonMisconceptions ?? input.misconceptions ?? existing?.learningContract?.commonMisconceptions, 12),
    knowledgePoints: normalizeStringList(source.knowledgePoints ?? input.knowledgePoints ?? input.concepts ?? existing?.learningContract?.knowledgePoints, 12)
  };
}

/**
 * Normalize the result of image/text recognition. This function intentionally
 * does not carry the submitted data URL; the caller may retain it only for
 * the in-flight model request or save a separately validated image path.
 */
function explicitGoalFromText(problemText) {
  // Transcribe an explicit request only. Never solve or infer a missing goal.
  const english = problemText.match(/\bsolve\s+for\s+([A-Za-z][A-Za-z0-9]*)\b/iu);
  if (english) return `求${english[1]}的值`;
  const chinese = problemText.match(/(?:求证|证明|求|计算|化简)\s*[:：]?[^。\n；;]{1,160}[。]?$/u);
  return chinese ? chinese[0].trim() : "";
}

export function normalizeProblemAnalysis(input = {}, existing = null) {
  const source = {
    ...(input && typeof input === "object" ? input : {}),
    ...(input?.analysis && typeof input.analysis === "object" ? input.analysis : {}),
    ...(input?.problem && typeof input.problem === "object" ? input.problem : {})
  };
  const problemText = firstText(source.problemText, source.text, source.statement, existing?.problemText);
  const diagramDescription = firstText(source.diagramDescription, source.figureDescription, source.diagram, existing?.diagramDescription);
  const proofGoal = firstText(source.proofGoal, source.goal, source.target, source.conclusion, existing?.proofGoal) || explicitGoalFromText(problemText);
  const typeHint = firstText(source.problemType, source.questionType, source.type, existing?.problemType);
  const geometry = source.isGeometryProof ?? source.isGeometry ?? source.geometryProof;
  const hasGeometryFlag = geometry !== undefined && geometry !== null && geometry !== "";
  const isGeometryProof = typeof geometry === "boolean"
    ? geometry
    : typeHint ? /几何|geometry|proof/iu.test(typeHint) : !/^(不是|否|false|no)$/iu.test(clean(geometry));
  const math = source.isMathProblem ?? source.isMathematics ?? source.isMath;
  const isMathProblem = typeof math === "boolean"
    ? math
    : hasGeometryFlag ? isGeometryProof : true;
  const confidence = asConfidence(source.confidence ?? source.recognitionConfidence ?? source.score, 0.7);
  const needsClarification = Boolean(source.needsClarification || source.clarificationRequired || confidence < 0.45 || !problemText || !proofGoal || (isGeometryProof && !diagramDescription));
  const problemType = typeHint || (isGeometryProof ? "geometry_proof" : "math_problem");
  const normalized = {
    id: firstText(source.id, existing?.id) || randomId("problem"),
    grade: firstText(source.grade, source.schoolGrade, existing?.grade) || "初中",
    subject: firstText(source.subject, existing?.subject) || (isGeometryProof ? "初中数学·几何证明" : "初中数学"),
    problemType: problemType.slice(0, 120),
    title: firstText(source.title, source.name, existing?.title) || (isGeometryProof ? "几何证明题" : "数学题"),
    problemText: problemText.slice(0, 5000),
    proofGoal: proofGoal.slice(0, 1000),
    diagramDescription: diagramDescription.slice(0, 2400),
    diagramAlt: firstText(source.diagramAlt, source.alt, existing?.diagramAlt) || diagramDescription.slice(0, 180),
    diagramSpec: source.diagramSpec ?? existing?.diagramSpec ?? null,
    learningGoal: firstText(source.learningGoal, source.objective, existing?.learningGoal).slice(0, 1000),
    knownFacts: normalizeStringList(source.knownFacts ?? source.known ?? source.givens ?? existing?.knownFacts, 24),
    knowledgePoints: normalizeStringList(source.knowledgePoints ?? source.concepts ?? source.tags ?? existing?.knowledgePoints, 12),
    isMathProblem,
    isGeometryProof,
    confidence,
    needsClarification,
    clarification: firstText(source.clarification, source.clarificationQuestion, existing?.clarification).slice(0, 800),
    ...(DECISIONS.includes(clean(source.decision).toLowerCase()) ? { decision: clean(source.decision).toLowerCase() } : {}),
    feedback: firstText(source.feedback, source.message).slice(0, 1200)
  };
  if (!normalized.problemText && !normalized.needsClarification) invalid("识题结果缺少题目文字。", "INVALID_PROBLEM_ANALYSIS");
  if (!normalized.isMathProblem) {
    normalized.needsClarification = true;
    normalized.clarification ||= "这似乎不是初中数学题，请补充初中数学题图片或文字。";
  } else if (normalized.isGeometryProof && !normalized.diagramDescription) {
    normalized.needsClarification = true;
    normalized.clarification ||= "几何题还缺少图形关系，请补充题图或图形转录。";
  }
  if (!normalized.proofGoal) normalized.clarification ||= "尚未识别出题目要求求什么或证明什么，请补充目标后再次核验。";
  return normalized;
}

/**
 * Normalize a model-generated learning package. There is no teacher/publish
 * gate here: a package is ready for the anonymous student's confirmed task.
 */
export function normalizeTaskInput(input = {}, existing = null) {
  const analysis = normalizeProblemAnalysis(input.analysis || input.problem || input, existing);
  const hints = normalizeHints(input);
  const helpOptions = normalizeHelpOptions(
    input.helpOptions ?? existing?.helpOptions,
    { ...analysis, protectedPhrases: input.protectedPhrases ?? existing?.protectedPhrases }
  );
  const judgmentCard = normalizeJudgmentCard(input, existing);
  const transferTask = normalizeTransferTask(input, existing, { requireDiagram: analysis.isGeometryProof });
  const learningContract = normalizeLearningContract(input, existing);
  const referenceProof = firstText(input.referenceProof, input.solution, input.proof, existing?.referenceProof).slice(0, 5000);
  const diagramPath = firstText(input.diagramPath, existing?.diagramPath);
  if (diagramPath && !/^\/(?:assets|runtime-uploads)\/[A-Za-z0-9._/-]+$/u.test(diagramPath)) {
    invalid("题图只能使用项目资源或服务端本地上传路径。", "INVALID_DIAGRAM_PATH");
  }
  const now = new Date().toISOString();
  let diagramSpec = null;
  const diagramCandidate = input.diagramSpec ?? analysis.diagramSpec;
  if (diagramCandidate !== undefined && diagramCandidate !== null && diagramCandidate !== "") diagramSpec = safeDiagramSpec(diagramCandidate);

  return {
    id: firstText(input.id, existing?.id) || randomId("task"),
    version: Number(existing?.version || 0) + 1,
    status: "ready",
    grade: analysis.grade,
    subject: analysis.subject,
    problemType: analysis.problemType,
    title: analysis.title,
    problemText: analysis.problemText,
    proofGoal: analysis.proofGoal,
    diagramPath: diagramPath || null,
    diagramAlt: analysis.diagramAlt,
    diagramDescription: analysis.diagramDescription,
    diagramSpec,
    learningGoal: analysis.learningGoal || learningContract.coreIdea,
    knownFacts: analysis.knownFacts,
    knowledgePoints: analysis.knowledgePoints,
    isMathProblem: analysis.isMathProblem,
    isGeometryProof: analysis.isGeometryProof,
    recognitionConfidence: analysis.confidence,
    needsClarification: analysis.needsClarification,
    clarification: analysis.clarification,
    learningContract,
    ...(helpOptions.length ? { helpOptions } : {}),
    hints,
    judgmentCard,
    transferTask,
    referenceProof,
    acceptedPaths: learningContract.acceptableEvidence,
    protectedPhrases: normalizeStringList(input.protectedPhrases ?? existing?.protectedPhrases, 24),
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };
}

/** A public-safe editor-shaped object retained for callers that need it. */
export function taskToEditor(task = {}) {
  const {
    referenceProof,
    acceptedPaths,
    protectedPhrases,
    learningContract,
    judgmentCard,
    transferTask,
    hints,
    helpOptions,
    ...publicFields
  } = task;
  return {
    ...publicFields,
    hints: (hints || []).map(item => ({ id: item.id, level: item.level, kind: item.kind, content: item.content })),
    ...(helpOptions?.length ? { helpOptions: normalizeHelpOptions(helpOptions, task) } : {}),
    judgmentCard: judgmentCard ? { statement: judgmentCard.statement } : undefined,
    transferTask: transferTask ? { text: transferTask.text, diagramDescription: transferTask.diagramDescription, diagramSpec: transferTask.diagramSpec } : undefined
  };
}

/**
 * Remove server-only answer keys before returning a task to a student. The
 * function is useful to the server and makes the secrecy contract explicit.
 */
export function taskToPublic(task = {}, options = {}) {
  const { stage = "initial_thinking", completed = false, knowledgeCards: knowledgeCardsOverride, session = null } = options || {};
  // Learning goals and knowledge-point labels describe the AI's teaching
  // plan. They are useful to an editor/model, but exposing them in the
  // student's initial task gives away the reasoning entrance before先思. Keep
  // them available after that first response for existing summary screens.
  const {
    referenceProof,
    protectedPhrases,
    acceptedPaths,
    learningContract,
    learningGoal,
    knowledgePoints,
    knowledgeCards,
    // Legacy task records sometimes kept these learning-plan aliases at the
    // top level; hide them as well when such a record is served directly.
    coreIdea,
    targetStep,
    concepts,
    misconceptions,
    hints,
    helpOptions,
    judgmentCard,
    transferTask,
    taskReview,
    ...safe
  } = task;
  const isInitialStage = stage === "initial_thinking" || stage === "initial";
  const judgmentStages = ["judgment", "transfer", "reflection", "completed"];
  const transferStages = ["transfer", "reflection", "completed"];
  // The HTTP handlers always pass `knowledgeCards: bundle?.cards`; when no
  // help-stage bundle exists that value is undefined and should retain the
  // legacy static matcher. An actual array—including an empty array after a
  // card is disabled—is the deliberate server-side override.
  const hasKnowledgeOverride = Object.prototype.hasOwnProperty.call(options || {}, "knowledgeCards") && Array.isArray(knowledgeCardsOverride);
  const publicKnowledgeCards = hasKnowledgeOverride
    ? (Array.isArray(knowledgeCardsOverride) ? knowledgeCardsOverride.map(toPublicKnowledgeCard).filter(card => card.id && card.title) : [])
    : findKnowledgeCards(task);
  return {
    ...safe,
    ...(taskReview ? { taskReview: publicTaskReview(taskReview) } : {}),
    ...(["help", "hint_level_1", "hint_level_2", "hint_level_3"].includes(stage) ? { knowledgeCards: publicKnowledgeCards } : {}),
    ...(["help", "hint_level_1", "hint_level_2", "hint_level_3"].includes(stage)
      ? (() => {
          const resolved = helpOptionsForSession({ ...task, helpOptions }, session);
          return { helpOptions: resolved.options, helpOptionsSource: resolved.source, helpOptionsRound: resolved.round };
        })()
      : {}),
    ...(!isInitialStage ? {
      ...(learningGoal ? { learningGoal } : {}),
      ...(knowledgePoints ? { knowledgePoints } : {})
    } : {}),
    ...(judgmentStages.includes(stage) && judgmentCard ? {
      judgmentCard: { statement: judgmentCard.statement }
    } : {}),
    ...(transferStages.includes(stage) && transferTask ? {
      transferTask: {
        text: transferTask.text,
        diagramDescription: transferTask.diagramDescription,
        diagramSpec: transferTask.diagramSpec || null,
        knowledgePoint: transferTask.knowledgePoint
      }
    } : {}),
    ...(completed && referenceProof ? { referenceProof } : {})
  };
}

export const defaultSafeFallbacks = Object.freeze([
  "我不能直接代写整题。请先指出一个已知条件，以及它能帮助你求出什么。",
  "先只推进一步：题目中的哪个数量、关系或条件最值得先处理？",
  "请写出你准备使用的公式、定理或计算关系，并说明它还需要哪些条件。"
]);

export { clean };
