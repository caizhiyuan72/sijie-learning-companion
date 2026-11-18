import { advanceHelpOptions, helpOptionsForSession, resolveHelpSelection } from "../lib/help-options.mjs";
import { requestPointHint, recordHelpSelection, withHelpRequest } from "../lib/help-request.mjs";
import { DeepSeekClient } from "../lib/deepseek.mjs";
import { normalizeProblemAnalysis, taskToPublic } from "../lib/task-schema.mjs";
import { resolveStageChoice } from "../lib/stage-choice.mjs";
import { classifyStudentInput, isHelpCompletionSignal, redactPersonalInfo } from "../lib/guardrails.mjs";
import { summarizeLearningOutcome, publicTaskReview } from "../lib/learning-outcome.mjs";
import { summarizeSession } from "../lib/teacher-summary.mjs";
import {
  initializeKnowledge,
  listKnowledge,
  saveKnowledgeDraft,
  publishKnowledge,
  disableKnowledge,
  retrieveKnowledge
} from "../lib/knowledge-base.mjs";
import {
  STAGES,
  assertStage,
  requestAssistance,
  StageError,
  applyInitialEvaluation,
  availableHint,
  createSession,
  normalizeUsername,
  finishHelp,
  recordHintEvaluation,
  sanitizeSession,
  submitInitial,
  submitJudgment,
  submitReflection,
  submitTransfer,
  unlockHint
} from "../lib/state-machine.mjs";
import { D1Store } from "./d1-store.mjs";

const MAX_BODY_BYTES = 12 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MODEL = "deepseek-v4-flash-vision-exp";
const REQUEST_IDS = new WeakMap();

function errorWith(message, code = "SERVER_ERROR", status = 500) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function cleanText(value) {
  return redactPersonalInfo(typeof value === "string" ? value.trim() : "");
}

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      ...headers
    }
  });
}

async function readJson(request, maxBytes = MAX_BODY_BYTES) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > maxBytes) throw errorWith(`请求内容超过${Math.round(maxBytes / 1024 / 1024)}MB限制。`, "BODY_TOO_LARGE", 413);
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > maxBytes) throw errorWith(`请求内容超过${Math.round(maxBytes / 1024 / 1024)}MB限制。`, "BODY_TOO_LARGE", 413);
  try {
    return JSON.parse(raw || "{}");
  } catch {
    throw errorWith("请求JSON无效。", "INVALID_JSON", 400);
  }
}

function parseImageData(dataUrl) {
  if (!dataUrl) return null;
  const match = String(dataUrl).match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/);
  if (!match) throw Object.assign(errorWith("只支持PNG、JPG或WebP图片。", "INVALID_IMAGE_INPUT", 400), { step: "upload", retryable: false });
  let bytes;
  try {
    const binary = atob(match[2]);
    bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  } catch {
    throw Object.assign(errorWith("图片编码无效，请重新选择图片。", "INVALID_IMAGE_INPUT", 400), { step: "upload", retryable: false });
  }
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw Object.assign(errorWith("图片为空或超过8MB限制，请压缩后重试。", "INVALID_IMAGE_INPUT", 400), { step: "upload", retryable: false });
  const format = match[1];
  const valid = format === "png"
    ? bytes.length >= 8 && bytes.slice(0, 8).every((value, index) => value === [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a][index])
    : format === "jpeg"
      ? bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      : bytes.length >= 12 && new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" && new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP";
  if (!valid) throw Object.assign(errorWith("图片内容与文件格式不一致，请重新选择图片。", "INVALID_IMAGE_INPUT", 400), { step: "upload", retryable: false });
  return { bytes, extension: format === "jpeg" ? "jpg" : format };
}

function studentBody(body = {}) {
  return {
    ...body,
    stuckPoint: cleanText(body.stuckPoint),
    selectedStuckPointId: body.selectedStuckPointId,
    known: cleanText(body.known || body.knownFacts || body.givens),
    goal: cleanText(body.goal || body.proofGoal || body.target),
    text: cleanText(body.text || body.answer || body.reason),
    answer: cleanText(body.answer || body.text),
    reason: cleanText(body.reason || body.text),
    selfWork: cleanText(body.selfWork),
    aiHelp: cleanText(body.aiHelp),
    nextTime: cleanText(body.nextTime)
  };
}

async function publicTask(task, session, knowledgeStore) {
  const source = task && typeof task === "object" ? { ...task } : {};
  delete source._knowledgeBundle;
  const helpStage = [STAGES.HINT_1, STAGES.HINT_2, STAGES.HINT_3].includes(session?.stage);
  const bundle = helpStage ? await retrieveKnowledge(knowledgeStore, { task: source, session, stage: session.stage }) : { cards: [] };
  return taskToPublic(source, {
    stage: session?.stage || STAGES.INITIAL,
    completed: session?.stage === STAGES.COMPLETED,
    knowledgeCards: bundle.cards || [],
    session
  });
}

function taskReviewFromGeneration(generated = {}) {
  const stored = generated?.taskReview && typeof generated.taskReview === "object" ? generated.taskReview : {};
  const reviewReason = String(generated.reviewReason || stored.reason || "").trim();
  if (generated.verified === false || generated.needsTeacherReview === true || stored.needsTeacherReview === true || stored.status === "structure_only") {
    return {
      status: "structure_only",
      needsTeacherReview: true,
      reason: reviewReason || "学习任务只通过结构校验，需教师复核。"
    };
  }
  if (generated.verified === true || stored.status === "model_checked") {
    return {
      status: "model_checked",
      needsTeacherReview: false,
      ...(reviewReason ? { reason: reviewReason } : {})
    };
  }
  return {
    status: "not_recorded",
    needsTeacherReview: true,
    reason: reviewReason || "任务生成结果未记录核验状态，需教师复核。"
  };
}

function publicSession(session, { includeKnowledge = false } = {}) {
  const safe = sanitizeSession(session, { includeUsername: false });
  safe.learningOutcome = summarizeLearningOutcome(session, { publicView: true });
  if (session.taskReview) safe.taskReview = publicTaskReview(session.taskReview);
  const references = Array.isArray(safe.knowledgeReferences) ? safe.knowledgeReferences : [];
  delete safe.knowledgeReferences;
  if (includeKnowledge && references.length) safe.knowledgeReferences = references.map(item => ({ id: item.id, version: item.version, title: item.title, stage: item.stage, purpose: item.purpose }));
  return safe;
}

function publicKnowledgeReferences(session) {
  return (Array.isArray(session?.knowledgeReferences) ? session.knowledgeReferences : []).map(item => ({ id: item.id, version: item.version, title: item.title, stage: item.stage, purpose: item.purpose }));
}

function recordKnowledgeReferences(session, result, stage, purpose) {
  const raw = result?.knowledgeReferences || result?.references;
  if (!Array.isArray(raw) || !raw.length || !session) return [];
  const refs = raw.map(item => {
    const source = item && typeof item === "object" ? item : { id: item };
    const id = String(source.id || source.cardId || "").trim().slice(0, 120);
    if (!id) return null;
    return { id, ...(source.version ? { version: String(source.version).slice(0, 40) } : {}), ...(source.title ? { title: String(source.title).slice(0, 200) } : {}), ...(source.reason ? { reason: String(source.reason).slice(0, 300) } : {}), ...(source.kind ? { kind: String(source.kind).slice(0, 40) } : {}), stage: String(stage || session.stage || "").slice(0, 40), purpose: String(purpose || "").slice(0, 80), at: new Date().toISOString() };
  }).filter(Boolean);
  session.knowledgeReferences ||= [];
  session.knowledgeReferences.push(...refs);
  if (session.knowledgeReferences.length > 120) session.knowledgeReferences = session.knowledgeReferences.slice(-120);
  return refs;
}

function markModelError(error, step, request) {
  if (!error || typeof error !== "object") return error;
  if (!error.step) error.step = step;
  if (!error.requestId && request) error.requestId = request.requestId || REQUEST_IDS.get(request);
  if (error.retryable === undefined) error.retryable = ["MODEL_REQUEST_FAILED", "MODEL_TIMEOUT", "MODEL_JSON_INVALID", "MODEL_EMPTY_CONTENT", "MODEL_OUTPUT_TRUNCATED", "AI_VERIFICATION_FAILED", "TASK_GENERATION_RETRY"].includes(error.code);
  return error;
}

function editableAnalysis(analysis, overrides = {}) {
  const knownFacts = String(overrides.known || overrides.knownFacts || "")
    .split(/\r?\n|；|;/).map(item => item.trim()).filter(Boolean);
  return normalizeProblemAnalysis({
    ...analysis,
    grade: cleanText(overrides.grade) || analysis.grade,
    title: cleanText(overrides.title) || analysis.title,
    problemText: cleanText(overrides.problemText) || analysis.problemText,
    knownFacts: knownFacts.length ? knownFacts : analysis.knownFacts,
    proofGoal: cleanText(overrides.goal || overrides.proofGoal) || analysis.proofGoal,
    diagramDescription: cleanText(overrides.diagramDescription) || analysis.diagramDescription,
    learningGoal: cleanText(overrides.learningGoal) || analysis.learningGoal,
    subject: cleanText(overrides.subject) || analysis.subject,
    problemType: cleanText(overrides.problemType) || analysis.problemType,
    isMathProblem: analysis.isMathProblem !== false,
    isGeometryProof: analysis.isGeometryProof === true,
    needsClarification: false,
    clarification: ""
  });
}

function draftForStudent(analysis) {
  return {
    grade: analysis.grade, subject: analysis.subject, problemType: analysis.problemType,
    isMathProblem: analysis.isMathProblem, isGeometryProof: analysis.isGeometryProof,
    title: analysis.title, problemText: analysis.problemText,
    known: (analysis.knownFacts || []).join("\n"), goal: analysis.proofGoal,
    diagramDescription: analysis.diagramDescription, learningGoal: analysis.learningGoal
  };
}

function isSameOrigin(request) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try { return new URL(origin).origin === new URL(request.url).origin; } catch { return false; }
}

function equalSecret(expected, provided) {
  if (!expected || expected.length !== provided.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) difference |= expected.charCodeAt(index) ^ provided.charCodeAt(index);
  return difference === 0;
}

class WorkerModel extends DeepSeekClient {
  constructor(env) {
    super("", { fetch: globalThis.fetch });
    this.workerEnv = env;
  }

  async config() {
    const baseUrl = String(this.workerEnv.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/$/, "");
    if (!/^https:\/\//i.test(baseUrl)) throw errorWith("模型地址必须使用HTTPS。", "INVALID_MODEL_URL", 400);
    return {
      key: String(this.workerEnv.DEEPSEEK_API_KEY || ""),
      baseUrl,
      model: String(this.workerEnv.DEEPSEEK_MODEL || DEFAULT_MODEL)
    };
  }
}

async function handleApi(request, env, store, model, url) {
  if (!isSameOrigin(request)) return json(403, { error: "请求来源不受支持。", code: "BAD_ORIGIN" });

  if (request.method === "GET" && url.pathname === "/api/status") {
    const status = await model.status();
    return json(200, { configured: status.configured, available: status.available, model: status.model, mode: status.mode });
  }

  if (request.method === "POST" && url.pathname === "/api/ai/config") {
    return json(403, { error: "云端服务不接受网页提交的模型密钥，请由管理员在 Cloudflare Secret 中配置。", code: "REMOTE_CONFIG_DISABLED" });
  }

  if (request.method === "GET" && url.pathname === "/api/teacher/sessions") {
    const expected = String(env.TEACHER_TOKEN || "");
    const provided = request.headers.get("x-teacher-token") || "";
    if (!expected || !equalSecret(expected, provided)) return json(403, { error: "教师口令不正确，或云端尚未配置 TEACHER_TOKEN。" });
    const tasks = await store.tasks();
    const sessions = (await store.sessions()).map(session => ({
      ...summarizeSession(session, tasks.find(task => task.id === session.taskId) || {}),
      learningOutcome: summarizeLearningOutcome(session)
    }));
    return json(200, { sessions });
  }

  if (url.pathname.startsWith("/api/teacher/knowledge")) {
    const expected = String(env.TEACHER_TOKEN || "");
    const provided = request.headers.get("x-teacher-token") || "";
    if (!expected || !equalSecret(expected, provided)) return json(403, { error: "教师口令不正确，或云端尚未配置 TEACHER_TOKEN。", code: "TEACHER_AUTH_REQUIRED" });
    if (request.method === "GET" && url.pathname === "/api/teacher/knowledge") return json(200, { items: await listKnowledge(store, { history: url.searchParams.get("history") === "true" }) });
    if (request.method === "POST" && url.pathname === "/api/teacher/knowledge/draft") return json(200, { item: await saveKnowledgeDraft(store, await readJson(request, 256 * 1024)) });
    const matchKnowledge = url.pathname.match(/^\/api\/teacher\/knowledge\/([^/]+)\/(publish|disable)$/);
    if (request.method === "POST" && matchKnowledge) {
      const id = decodeURIComponent(matchKnowledge[1]);
      const body = await readJson(request, 32 * 1024);
      const item = matchKnowledge[2] === "publish" ? await publishKnowledge(store, id, body) : await disableKnowledge(store, id, body);
      return json(200, { item });
    }
    return json(405, { error: "Method not allowed", code: "METHOD_NOT_ALLOWED" });
  }

  if (request.method === "POST" && url.pathname === "/api/problem/analyze") {
    const body = await readJson(request);
    const grade = cleanText(body.grade) || "初中";
    const problemText = cleanText(body.problemText || body.text);
    if (!problemText && !body.imageData) return json(400, { error: "请先输入题目文字或上传题目图片。", code: "EMPTY_PROBLEM_INPUT" });
    const parsedImage = parseImageData(body.imageData);
    let result;
    try {
      result = await model.analyzeProblem({ grade, problemText, imageData: body.imageData || null });
    } catch (error) {
      throw markModelError(error, "recognition", request);
    }
    const analysis = result.analysis || normalizeProblemAnalysis(result);
    const imagePath = parsedImage ? await store.saveImage(parsedImage.bytes, parsedImage.extension) : null;
    const draft = { id: `draft-${crypto.randomUUID()}`, analysis, imagePath, createdAt: new Date().toISOString() };
    await store.saveDraft(draft);
    const studentDraft = draftForStudent(analysis);
    const clarification = analysis.clarification || analysis.feedback || (analysis.needsClarification ? "图片或题意暂时无法确认，请重新拍摄或补充文字。" : "");
    return json(200, {
      draftId: draft.id, draft: studentDraft, problem: studentDraft,
      analysis: { ...analysis, clarification }, decision: analysis.needsClarification ? "clearer_input" : "pass",
      confidence: analysis.confidence, needsClarification: analysis.needsClarification,
      clarification, verified: result.verified === true
    });
  }

  if (request.method === "POST" && url.pathname === "/api/session") {
    const body = await readJson(request);
    const username = normalizeUsername(body.username);
    if (!username) return json(400, { error: "请输入 1–32 个字符的用户名。", code: "INVALID_USERNAME" });
    const savedDraft = await store.draft(String(body.draftId || ""));
    const submittedRecognition = body.problem || body.recognition || body.recognizedProblem || body.analysis;
    if (!savedDraft && !(body.confirmed === true && submittedRecognition)) return json(400, { error: "识题结果已失效，请重新识别题目。", code: "DRAFT_NOT_FOUND" });
    const sourceAnalysis = savedDraft?.analysis || normalizeProblemAnalysis(submittedRecognition);
    if (sourceAnalysis.isMathProblem === false) return json(422, { error: sourceAnalysis.clarification || "题目仍需重新拍摄或补充文字后再识别。", code: "PROBLEM_NEEDS_CLARIFICATION", decision: "clearer_input" });
    const analysis = editableAnalysis(sourceAnalysis, { ...body.draft, ...body.problem, grade: body.grade });
    if (analysis.needsClarification || sourceAnalysis.needsClarification) {
      if (typeof model.revalidateProblem === "function") {
        try {
          const verified = await model.revalidateProblem({ analysis, imageData: body.imageData || null });
          if (verified?.analysis) Object.assign(analysis, verified.analysis);
          analysis.needsClarification = Boolean(verified?.needsClarification || verified?.analysis?.needsClarification);
          analysis.clarification = verified?.clarification || verified?.analysis?.clarification || "";
        } catch (error) {
          throw markModelError(error, "verification", request);
        }
      }
    }
    if (analysis.needsClarification) return json(422, { error: analysis.clarification || "题目仍需重新拍摄或补充文字后再识别。", code: "PROBLEM_NEEDS_CLARIFICATION", decision: "clearer_input", retryable: true, step: "verification" });
    if (!analysis.problemText || !analysis.proofGoal || (analysis.isGeometryProof && !analysis.diagramDescription)) return json(400, { error: analysis.isGeometryProof ? "请补全题目文字、求证目标和图形关系后再开始。" : "请补全题目文字和求解目标后再开始。", code: "INCOMPLETE_CONFIRMED_PROBLEM" });
    let generated;
    try {
      generated = await model.generateTask({ analysis, imageData: body.imageData || null });
    } catch (error) {
      markModelError(error, "task_generation", request);
      const retryable = new Set(["AI_VERIFICATION_FAILED", "MODEL_JSON_INVALID", "MODEL_EMPTY_CONTENT", "MODEL_OUTPUT_TRUNCATED", "MODEL_REQUEST_FAILED", "MODEL_TIMEOUT", "MODEL_NOT_CONFIGURED"]);
      if (retryable.has(error?.code)) return json(409, { error: error.code === "MODEL_NOT_CONFIGURED" ? "AI服务暂不可用，请联系管理员配置模型。" : "AI正在整理学习任务，但这次结果没有通过核验。请再次点击确认，题目不需要重新上传。", code: error.code === "MODEL_NOT_CONFIGURED" ? "MODEL_NOT_CONFIGURED" : "TASK_GENERATION_RETRY", retryable: true });
      throw error;
    }
    const taskReview = taskReviewFromGeneration(generated);
    const task = { ...generated.task, taskReview, diagramPath: savedDraft?.imagePath || null };
    await store.saveTask(task);
    const session = createSession(task.id, undefined, { username });
    session.taskReview = structuredClone(taskReview);
    recordKnowledgeReferences(session, generated, STAGES.INITIAL, "task_generation");
    await store.saveSession(sanitizeSession(session));
    await store.event({ sessionId: session.id, taskId: session.taskId, stage: session.stage, type: "session_started", source: savedDraft?.imagePath ? "student_image" : "student_text", recognitionConfidence: analysis.confidence });
    return json(201, {
      session: publicSession(session),
      task: await publicTask(task, session, store),
      generation: {
        mode: generated.mode || "live",
        verified: generated.verified !== false,
        needsTeacherReview: taskReview.needsTeacherReview,
        reviewReason: publicTaskReview(taskReview).reason
      }
    });
  }

  const match = url.pathname.match(/^\/api\/session\/([^/]+)(?:\/(initial|help|judgment|transfer|reflection))?$/);
  if (!match) return json(404, { error: "接口不存在。" });
  const session = await store.session(match[1]);
  if (!session) return json(404, { error: "会话不存在或已失效。" });
  const task = await store.taskById(session.taskId);
  if (!task) return json(404, { error: "学习任务不存在，请重新导入题目。" });
  if (request.method === "GET" && !match[2]) return json(200, { session: publicSession(session), task: await publicTask(task, session, store), events: await store.events(session.id) });
  if (request.method !== "POST") return json(405, { error: "Method not allowed" });
  const body = studentBody(await readJson(request));


  if (match[2] === "initial") {
    submitInitial(session, body);
    const evaluation = body.stuckPoint && session.answers.initial.stuckPoint
      ? { decision: "retry", feedback: "已记录你的卡点。我们从一个小问题开始。", nextPrompt: "请指出题目中你能找到的一条条件，或在图上找到一个对应的点。", matchedIdeas: [], coreIssue: body.stuckPoint, confidence: null }
      : await model.evaluateAnswer({ task, session, stage: STAGES.INITIAL, kind: "initial", answer: body });
    recordKnowledgeReferences(session, evaluation, STAGES.INITIAL, "answer_evaluation");
    applyInitialEvaluation(session, evaluation);
    await store.saveSession(sanitizeSession(session));
    await store.event({ sessionId: session.id, taskId: session.taskId, stage: session.stage, type: "initial_evaluated", decision: evaluation.decision, confidence: evaluation.confidence });
    return json(200, { session: publicSession(session), task: await publicTask(task, session, store), evaluation });
  }

  if (match[2] === "help") {
    return withHelpRequest(session.id, async () => {
      Object.assign(session, await store.session(session.id));
      assertStage(session, [STAGES.HINT_1, STAGES.HINT_2, STAGES.HINT_3]);
      if (body.action === "hint" || (!body.action && body.selectedStuckPointId)) {
        if (body.imageData) parseImageData(body.imageData);
        const hintStage = session.stage;
        const result = await requestPointHint({ task, session, body, model });
        recordKnowledgeReferences(session, result.reply, hintStage, "hint_generation");
        await store.saveSession(sanitizeSession(session));
        if (result.hintLevel) await store.event({ sessionId: session.id, taskId: session.taskId, stage: session.stage, type: "hint_delivered", hintLevel: result.hintLevel, decision: "retry", inputSource: body.selectedStuckPointId ? "point_selection" : "student_input", blocked: Boolean(result.reply?.blocked) });
        return json(200, { session: publicSession(session), task: await publicTask(task, session, store), evaluation: result.evaluation, ...(result.reply ? { reply: { action: result.reply.action, message: result.reply.message, blocked: Boolean(result.reply.blocked) } } : {}) });
      }
      if (body.action === "teacher") {
        if (body.imageData) parseImageData(body.imageData);
        const selectedStuckPoint = resolveHelpSelection(task, body.selectedStuckPointId, session);
        requestAssistance(session, { ...body, selectedStuckPoint });
        recordHelpSelection(session, selectedStuckPoint);
        await store.saveSession(sanitizeSession(session));
        await store.event({ sessionId: session.id, taskId: session.taskId, stage: session.stage, type: "teacher_help_requested" });
        return json(200, { session: publicSession(session), task: await publicTask(task, session, store), evaluation: { decision: "retry", feedback: "卡点和提示记录已保存到教师看板。你可以继续整理想法；这不代表老师已经收到通知。" } });
      }
      if (body.action === "understood") {
        const evaluation = { decision: "assisted", feedback: "你选择直接进入判别；接下来请核验AI的解题建议。", matchedIdeas: [], coreIssue: "", nextPrompt: "", confidence: null };
        await prepareJudgment(task, session, model, store);
        finishHelp(session, { action: "understood", studentText: body.text || "我懂了", reason: "self_declared", assisted: true, evaluation });
        await store.saveSession(sanitizeSession(session));
        return json(200, { session: publicSession(session), task: await publicTask(task, session, store), evaluation });
      }
      const prompt = "请用自己的话写出你现在确定的一条数学关系；如果能说出依据，也可以一起补上。";
      if ((!body.text && !body.imageData) || isHelpCompletionSignal(body.text) || /^(我)?(已理解|理解了|懂了|会了|可以继续)[。！!\s]*$/u.test(body.text)) {
        const evaluation = { decision: "retry", feedback: "先用一句具体理由检查一下理解。", nextPrompt: prompt, matchedIdeas: [], coreIssue: "尚未提供理解依据", confidence: null };
        session.answers.helpCheck ||= { attempts: [] };
        session.answers.helpCheck.attempts.push({ text: body.text || "", evaluation, at: new Date().toISOString() });
        await store.saveSession(sanitizeSession(session));
        return json(200, { session: publicSession(session), task: await publicTask(task, session, store), evaluation, reply: { action: "question", message: prompt } });
      }
      const flags = classifyStudentInput(body.text, { task });
      const evaluation = flags.offTopic ? { decision: "retry", feedback: flags.offTopicReason || "你使用的公式与当前题目条件不匹配，请先回到题目给出的数量和关系。", matchedIdeas: [], coreIssue: "使用了与题型不匹配的公式", nextPrompt: "请先指出题目中的一个已知量或比例关系。", confidence: null } : await model.evaluateAnswer({ task, session, stage: session.stage, kind: "help", answer: body });
      recordKnowledgeReferences(session, evaluation, session.stage, "answer_evaluation");
      session.answers.helpCheck ||= { attempts: [] };
      session.answers.helpCheck.attempts.push({ text: body.text, evaluation, at: new Date().toISOString() });
      if (evaluation.decision === "pass") {
        await prepareJudgment(task, session, model, store);
        finishHelp(session, { studentText: body.text, imageData: body.imageData, reason: body.action === "finish" ? "explicit_button" : "understanding_signal", evaluation });
        await store.saveSession(sanitizeSession(session));
        return json(200, { session: publicSession(session), task: await publicTask(task, session, store), evaluation });
      }
      if (body.action === "finish") { await store.saveSession(sanitizeSession(session)); return json(200, { session: publicSession(session), task: await publicTask(task, session, store), evaluation, reply: { action: "question", message: evaluation.nextPrompt || prompt } }); }
      if (evaluation.decision === "clearer_input") { await store.saveSession(sanitizeSession(session)); return json(200, { session: publicSession(session), task: await publicTask(task, session, store), evaluation }); }
      const hint = availableHint(task, session);
      if (!hint) { await store.saveSession(sanitizeSession(session)); return json(200, { session: publicSession(session), task: await publicTask(task, session, store), evaluation: { ...evaluation, decision: "retry", nextPrompt: "三级提示已用完。请说明具体卡点并提交给老师，或解释一个关键关系来检查理解。" } }); }
      const reply = await model.generateHint({ task, session, studentText: body.text, studentImageData: body.imageData, hint });
      const previousOptions = helpOptionsForSession(task, session).options;
      recordKnowledgeReferences(session, reply, session.stage, "hint_generation");
      unlockHint(session, hint);
      if (hint.level === 3) Object.assign(evaluation, { decision: "retry", feedback: "三级提示已给出，请解释一个关键关系来检查理解。", nextPrompt: "如果仍然卡住，请说明具体问题并提交给老师。" });
      recordHintEvaluation(session, hint.level, evaluation);
      session.answers[`hint${hint.level}`] = { ...session.answers[`hint${hint.level}`], at: new Date().toISOString(), student: { ...(body.text ? { text: body.text } : {}), ...(body.imageData ? { image: { provided: true } } : {}) }, reply: { action: reply.action, message: reply.message, blocked: Boolean(reply.blocked) } };
      advanceHelpOptions(task, session, { nextHelpOptions: reply.nextHelpOptions, reply, previousOptions });
      if (flags.directAnswerRequest) session.riskCounts.directAnswerRequests += 1;
      if (reply.blocked) session.riskCounts.blockedLeaks += 1;
      if (flags.irrelevant) session.riskCounts.irrelevantInputs += 1;
      await store.saveSession(sanitizeSession(session));
      return json(200, { session: publicSession(session), task: await publicTask(task, session, store), evaluation, reply: { action: reply.action, message: reply.message, blocked: Boolean(reply.blocked) } });
    });
  }

  if (match[2] === "judgment") {
    assertStage(session, STAGES.JUDGMENT);
    const verdict = cleanText(body.verdict);
    const selected = body.reasonOptionId === undefined ? null : resolveStageChoice(task.judgmentCard?.reasonChoice, body.reasonOptionId, { verdict, correctVerdict: task.judgmentCard?.correctVerdict });
    const input = selected ? { verdict, reason: selected.text } : body;
    const evaluation = selected?.evaluation || await model.evaluateAnswer({ task, session, stage: STAGES.JUDGMENT, kind: "judgment", answer: { verdict, reason: body.reason || body.text, imageData: body.imageData } });
    recordKnowledgeReferences(session, evaluation, STAGES.JUDGMENT, "answer_evaluation");
    submitJudgment(session, input, evaluation);
    const storedEvaluation = session.answers.judgment.evaluation;
    if (session.stage === STAGES.TRANSFER) { if (storedEvaluation.decision === "assisted") appendExplanation(storedEvaluation, task.judgmentCard.reason); await prepareTransfer(task, session, model, store); }
    await store.saveSession(sanitizeSession(session));
    return json(200, { session: publicSession(session), task: await publicTask(task, session, store), evaluation: storedEvaluation });
  }

  if (match[2] === "transfer") {
    assertStage(session, STAGES.TRANSFER);
    const selected = task.transferTask?.stepChoice || body.stepOptionId !== undefined ? resolveStageChoice(task.transferTask?.stepChoice, body.stepOptionId) : null;
    const input = selected ? { answer: selected.text } : body;
    const evaluation = selected?.evaluation || await model.evaluateAnswer({ task, session, stage: STAGES.TRANSFER, kind: "transfer", answer: body });
    recordKnowledgeReferences(session, evaluation, STAGES.TRANSFER, "answer_evaluation");
    submitTransfer(session, input, evaluation);
    const storedEvaluation = session.answers.transfer.evaluation;
    if (session.stage === STAGES.REFLECTION && storedEvaluation.decision === "assisted") appendExplanation(storedEvaluation, task.transferTask.referenceProof || task.transferTask.answerOutline);
    await store.saveSession(sanitizeSession(session));
    return json(200, { session: publicSession(session), task: await publicTask(task, session, store), evaluation: storedEvaluation });
  }

  if (match[2] === "reflection") {
    assertStage(session, STAGES.REFLECTION);
    const reflectionEvaluation = await model.evaluateAnswer({ task, session, stage: STAGES.REFLECTION, kind: "reflection", answer: body });
    recordKnowledgeReferences(session, reflectionEvaluation, STAGES.REFLECTION, "answer_evaluation");
    if (reflectionEvaluation.decision === "clearer_input") {
      await store.saveSession(sanitizeSession(session));
      return json(200, { session: publicSession(session), task: await publicTask(task, session, store), evaluation: reflectionEvaluation });
    }
    submitReflection(session, body);
    const summary = {
      title: "本轮五步学习已完成",
      message: "已保存本次学习记录。完成流程不等同于独立掌握。",
      selfWork: body.selfWork || "",
      aiHelp: body.aiHelp || "",
      nextTime: body.nextTime || "",
      note: body.text || "",
      hintsUsed: session.completedHints.length,
      initial: session.answers.initial?.evaluation?.decision || "recorded",
      judgment: session.answers.judgment?.evaluation?.decision || "recorded",
      transfer: session.answers.transfer?.evaluation?.decision || "recorded",
      assisted: Object.entries(session.assistance).filter(([, value]) => value).map(([key]) => key),
      learningOutcome: summarizeLearningOutcome(session, { publicView: true })
    };
    session.answers.summary = summary;
    await store.saveSession(sanitizeSession(session));
    return json(200, { session: publicSession(session, { includeKnowledge: true }), task: await publicTask(task, session, store), evaluation: reflectionEvaluation, summary, knowledgeReferences: publicKnowledgeReferences(session) });
  }
  return json(404, { error: "接口不存在。" });
}

async function enforceRateLimit(request, env, url) {
  const limiter = env.RATE_LIMITER;
  if (!limiter || typeof limiter.limit !== "function") return null;
  const ip = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const category = url.pathname === "/api/ai/config" || url.pathname === "/api/problem/analyze" || url.pathname.startsWith("/api/session") ? "ai" : url.pathname.startsWith("/api/teacher/") ? "teacher" : "api";
  const result = await limiter.limit({ key: `${category}:${ip}` });
  if (result && result.success === false) return json(429, { error: "请求过于频繁，请稍后再试。", code: "RATE_LIMITED" }, { "retry-after": "60" });
  return null;
}

async function prepareJudgment(task, session, model, store) {
  const generated = await model.generateJudgmentCard({ task, session });
  recordKnowledgeReferences(session, generated, STAGES.JUDGMENT, "judgment_generation");
  task.judgmentCard = generated.judgmentCard;
  task.updatedAt = new Date().toISOString();
  await store.saveTask(task);
  return generated.judgmentCard;
}

async function prepareTransfer(task, session, model, store) {
  const generated = await model.generateTransferTask({ task, session });
  recordKnowledgeReferences(session, generated, STAGES.TRANSFER, "transfer_generation");
  task.transferTask = generated.transferTask;
  task.updatedAt = new Date().toISOString();
  await store.saveTask(task);
  return generated.transferTask;
}

function appendExplanation(evaluation, explanation) {
  if (!evaluation || !explanation) return evaluation;
  evaluation.feedback = [evaluation.feedback, `参考解析：${explanation}`].filter(Boolean).join("\n");
  return evaluation;
}

function uploadContentType(pathname) {
  return pathname.endsWith(".png") ? "image/png" : pathname.endsWith(".jpg") || pathname.endsWith(".jpeg") ? "image/jpeg" : "image/webp";
}

// Cloudflare ASSETS uses the extensionless route as the canonical URL for
// HTML pages.  A request for /teacher.html is therefore redirected to
// /teacher by ASSETS; keep both URLs inside the Worker allow-list and fetch
// the canonical asset path so the redirect cannot fall into our 404 branch.
function canonicalAssetPath(pathname) {
  return pathname === "/teacher.html" || pathname === "/teacher/" ? "/teacher" : pathname;
}

function isAllowedAsset(pathname) {
  const canonical = canonicalAssetPath(pathname);
  return canonical === "/" || ["/index.html", "/app.js", "/styles.css", "/teacher", "/teacher.js", "/vendor/katex.min.css", "/vendor/katex.min.js", "/vendor/auto-render.min.js"].includes(canonical)
    || /^\/assets\/[A-Za-z0-9_.-]+$/.test(pathname)
    || /^\/vendor\/fonts\/[A-Za-z0-9_.-]+$/.test(pathname);
}

async function staticResponse(request, env, store) {
  const requestedPathname = new URL(request.url).pathname;
  if (requestedPathname.startsWith("/runtime-uploads/")) {
    const name = requestedPathname.slice("/runtime-uploads/".length);
    if (!/^[A-Za-z0-9_-]{16,120}\.(?:png|jpg|webp)$/i.test(name)) return new Response("Not found", { status: 404 });
    const image = await store.getImage(name);
    return image ? new Response(image.body || image.bytes || image, { headers: { "content-type": image.contentType || uploadContentType(name), "cache-control": "no-store", "x-content-type-options": "nosniff" } }) : new Response("Not found", { status: 404 });
  }
  const pathname = canonicalAssetPath(requestedPathname);
  if (!isAllowedAsset(requestedPathname)) return new Response("Not found", { status: 404 });
  if (!env.ASSETS || typeof env.ASSETS.fetch !== "function") return new Response("Not found", { status: 404 });
  // Request objects are immutable.  The alias rewrite only affects the
  // internal ASSETS lookup; the public URL may still be /teacher.html or
  // /teacher/ when an old bookmark is used.
  if (pathname !== requestedPathname) {
    const assetUrl = new URL(request.url);
    assetUrl.pathname = pathname;
    request = new Request(assetUrl, request);
  }
  const asset = await env.ASSETS.fetch(request);
  return asset.status === 404 ? new Response("Not found", { status: 404 }) : asset;
}

export function createWorker({ storeFactory = env => new D1Store(env.DB, { bucket: env.R2 }), modelFactory = env => new WorkerModel(env) } = {}) {
  return {
    async fetch(request, env) {
      const startedAt = Date.now();
      const requestId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      REQUEST_IDS.set(request, requestId);
      let store;
      try {
        store = await storeFactory(env, request);
        const url = new URL(request.url);
        if (url.pathname.startsWith("/api/")) {
          const limited = await enforceRateLimit(request, env, url);
          if (limited) return limited;
          if (url.pathname.startsWith("/api/session") || url.pathname.startsWith("/api/teacher/knowledge")) await initializeKnowledge(store);
          const model = await modelFactory(env, request);
          model.knowledgeProvider = context => retrieveKnowledge(store, context);
          return await handleApi(request, env, store, model, url);
        }
        if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
        return await staticResponse(request, env, store);
      } catch (error) {
        const status = error.status || (error instanceof StageError ? 409 : 500);
        const retryable = typeof error.retryable === "boolean" ? error.retryable : ["MODEL_REQUEST_FAILED", "MODEL_TIMEOUT", "MODEL_JSON_INVALID", "MODEL_EMPTY_CONTENT", "MODEL_OUTPUT_TRUNCATED", "AI_VERIFICATION_FAILED", "TASK_GENERATION_RETRY"].includes(error.code);
        return json(status, {
          error: error.message || "服务暂时不可用。",
          code: error.code || "SERVER_ERROR",
          step: error.step || (["INVALID_IMAGE_INPUT", "BODY_TOO_LARGE", "INVALID_JSON"].includes(error.code) ? "upload" : "server"),
          requestId: error.requestId || requestId,
          retryable,
          ...(Number.isFinite(error.upstreamStatus) ? { upstreamStatus: error.upstreamStatus } : {}),
          elapsedMs: Number.isFinite(error.elapsedMs) ? error.elapsedMs : Math.max(0, Date.now() - startedAt)
        });
      }
    }
  };
}

export default createWorker();

