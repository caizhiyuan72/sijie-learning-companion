import { advanceHelpOptions, helpOptionsForSession, resolveHelpSelection } from "./lib/help-options.mjs";
import { requestPointHint, recordHelpSelection, withHelpRequest } from "./lib/help-request.mjs";
import { timingSafeEqual } from "node:crypto";
import { summarizeSession } from "./lib/teacher-summary.mjs";
import { summarizeLearningOutcome, publicTaskReview } from "./lib/learning-outcome.mjs";
import {
  initializeKnowledge,
  listKnowledge,
  saveKnowledgeDraft,
  publishKnowledge,
  disableKnowledge,
  retrieveKnowledge
} from "./lib/knowledge-base.mjs";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { FileStore } from "./lib/store.mjs";
import { DeepSeekClient } from "./lib/deepseek.mjs";
import { normalizeProblemAnalysis, taskToPublic } from "./lib/task-schema.mjs";
import { classifyStudentInput, isHelpCompletionSignal, redactPersonalInfo } from "./lib/guardrails.mjs";
import {
  STAGES,
  assertStage,
  requestAssistance,
  StageError,
  applyInitialEvaluation,
  availableHint,
  createSession,
  finishHelp,
  recordHintEvaluation,
  sanitizeSession,
  submitInitial,
  submitJudgment,
  submitReflection,
  submitTransfer,
  unlockHint
} from "./lib/state-machine.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
const env = await readSimpleEnv();
const store = new FileStore(root, process.env.DATA_DIR || env.DATA_DIR || "");
const model = new DeepSeekClient(root);
await store.init();
await initializeKnowledge?.(store);
model.knowledgeProvider = context => retrieveKnowledge(store, context);

const port = Number(process.env.PORT || env.PORT || 4180);
const MAX_BODY_BYTES = 12 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2"
};

async function readSimpleEnv() {
  const values = {};
  const path = join(root, ".env");
  if (!existsSync(path)) return values;
  for (const line of (await readFile(path, "utf8")).split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match && !line.trim().startsWith("#")) values[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
  return values;
}

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer"
  });
  res.end(Buffer.isBuffer(body) ? body : typeof body === "string" ? body : JSON.stringify(body));
}

function readBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let raw = "";
    let exceeded = false;
    req.on("data", chunk => {
      if (exceeded) return;
      raw += chunk;
      if (Buffer.byteLength(raw) > maxBytes) {
        exceeded = true;
        const error = new Error(`请求内容超过${Math.round(maxBytes / 1024 / 1024)}MB限制。`);
        error.status = 413;
        reject(error);
      }
    });
    req.on("end", () => {
      if (exceeded) return;
      try { resolve(JSON.parse(raw || "{}")); }
      catch {
        const error = new Error("请求JSON无效。");
        error.status = 400;
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function parseImageData(dataUrl) {
  if (!dataUrl) return null;
  const match = String(dataUrl).match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/);
  if (!match) {
    const error = new Error("只支持PNG、JPG或WebP图片。");
    error.status = 400;
    error.code = "INVALID_IMAGE_INPUT";
    error.step = "upload";
    error.retryable = false;
    throw error;
  }
  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) {
    const error = new Error("图片为空或超过8MB限制，请压缩后重试。");
    error.status = 400;
    error.code = "INVALID_IMAGE_INPUT";
    error.step = "upload";
    error.retryable = false;
    throw error;
  }
  const format = match[1];
  const valid = format === "png"
    ? buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    : format === "jpeg"
      ? buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
      : buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP";
  if (!valid) {
    const error = new Error("图片内容与文件格式不一致，请重新选择图片。");
    error.status = 400;
    error.code = "INVALID_IMAGE_INPUT";
    error.step = "upload";
    error.retryable = false;
    throw error;
  }
  return { buffer, extension: format === "jpeg" ? "jpg" : format };
}

function cleanText(value) {
  return redactPersonalInfo(typeof value === "string" ? value.trim() : "");
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

function publicSession(session, { includeKnowledge = false } = {}) {
  const safe = sanitizeSession(session);
  safe.learningOutcome = summarizeLearningOutcome(session, { publicView: true });
  if (session.taskReview) safe.taskReview = publicTaskReview(session.taskReview);
  const references = Array.isArray(safe.knowledgeReferences) ? safe.knowledgeReferences : [];
  delete safe.knowledgeReferences;
  if (includeKnowledge && references.length) {
    safe.knowledgeReferences = references.map(item => ({
      ...(item.id ? { id: item.id } : {}),
      ...(item.version ? { version: item.version } : {}),
      ...(item.title ? { title: item.title } : {}),
      ...(item.stage ? { stage: item.stage } : {}),
      ...(item.purpose ? { purpose: item.purpose } : {})
    }));
  }
  return safe;
}

function publicKnowledgeReferences(session) {
  return (Array.isArray(session?.knowledgeReferences) ? session.knowledgeReferences : []).map(item => ({
    ...(item.id ? { id: item.id } : {}),
    ...(item.version ? { version: item.version } : {}),
    ...(item.title ? { title: item.title } : {}),
    ...(item.stage ? { stage: item.stage } : {}),
    ...(item.purpose ? { purpose: item.purpose } : {})
  }));
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

function recordKnowledgeReferences(session, result, stage, purpose) {
  const raw = result?.knowledgeReferences || result?.references;
  if (!Array.isArray(raw) || !raw.length || !session) return [];
  const references = raw.map(item => {
    const source = item && typeof item === "object" ? item : { id: item };
    const id = String(source.id || source.cardId || "").trim().slice(0, 120);
    if (!id) return null;
    return {
      id,
      ...(source.version ? { version: String(source.version).slice(0, 40) } : {}),
      ...(source.title ? { title: String(source.title).slice(0, 200) } : {}),
      ...(source.reason ? { reason: String(source.reason).slice(0, 300) } : {}),
      ...(source.kind ? { kind: String(source.kind).slice(0, 40) } : {}),
      stage: String(stage || session.stage || "").slice(0, 40),
      purpose: String(purpose || "").slice(0, 80),
      at: new Date().toISOString()
    };
  }).filter(Boolean);
  if (!references.length) return [];
  session.knowledgeReferences ||= [];
  session.knowledgeReferences.push(...references);
  if (session.knowledgeReferences.length > 120) session.knowledgeReferences = session.knowledgeReferences.slice(-120);
  return references;
}

function markModelError(error, step, req) {
  if (!error || typeof error !== "object") return error;
  if (!error.step) error.step = step;
  if (!error.requestId && req?.requestId) error.requestId = req.requestId;
  if (error.retryable === undefined) error.retryable = ["MODEL_REQUEST_FAILED", "MODEL_TIMEOUT", "MODEL_JSON_INVALID", "MODEL_EMPTY_CONTENT", "MODEL_OUTPUT_TRUNCATED", "AI_VERIFICATION_FAILED", "TASK_GENERATION_RETRY"].includes(error.code);
  return error;
}

async function requireSession(id) {
  const session = await store.session(id);
  if (!session) {
    const error = new Error("会话不存在或已失效。");
    error.status = 404;
    throw error;
  }
  return session;
}

async function requireTask(session) {
  const task = await store.taskById(session.taskId);
  if (!task) {
    const error = new Error("学习任务不存在，请重新导入题目。");
    error.status = 404;
    throw error;
  }
  return task;
}

async function saveSession(session) {
  await store.saveSession(sanitizeSession(session));
}

async function record(session, type, data = {}) {
  const safe = structuredClone(data);
  delete safe.imageData;
  delete safe.dataUrl;
  delete safe.text;
  delete safe.answer;
  delete safe.reason;
  return store.event({ sessionId: session.id, taskId: session.taskId, stage: session.stage, type, ...safe });
}

function editableAnalysis(analysis, overrides = {}) {
  const knownFacts = String(overrides.known || overrides.knownFacts || "")
    .split(/\r?\n|；|;/)
    .map(item => item.trim())
    .filter(Boolean);
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
    grade: analysis.grade,
    subject: analysis.subject,
    problemType: analysis.problemType,
    isMathProblem: analysis.isMathProblem,
    isGeometryProof: analysis.isGeometryProof,
    title: analysis.title,
    problemText: analysis.problemText,
    known: (analysis.knownFacts || []).join("\n"),
    goal: analysis.proofGoal,
    diagramDescription: analysis.diagramDescription,
    learningGoal: analysis.learningGoal
  };
}

function taskReviewFromGeneration(generated = {}) {
  const status = generated.needsTeacherReview === true || generated.verified === false ? "structure_only" : generated.verified === true ? "model_checked" : "not_recorded";
  return {
    status,
    needsTeacherReview: status !== "model_checked",
    reason: status === "structure_only" ? (generated.reviewReason || "本题尚未通过完整的AI内容复核，请老师核对题面、判别建议和迁移题。") : status === "model_checked" ? "已由模型复核，数学内容仍可由老师检查。" : "本题未记录内容核验状态。"
  };
}

async function prepareJudgment(task, session) {
  const generated = await model.generateJudgmentCard({ task, session });
  recordKnowledgeReferences(session, generated, STAGES.JUDGMENT, "judgment_generation");
  task.judgmentCard = generated.judgmentCard;
  task.updatedAt = new Date().toISOString();
  await store.saveTask(task);
  return generated.judgmentCard;
}

async function prepareTransfer(task, session) {
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

function isLocalRequest(req) {
  const address = String(req.socket?.remoteAddress || "");
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function isSameOrigin(req) {
  const origin = String(req.headers.origin || "");
  if (!origin) return true;
  try {
    return new URL(origin).host === String(req.headers.host || "");
  } catch {
    return false;
  }
}

function teacherAuthorized(req) {
  const expected = process.env.TEACHER_TOKEN || env.TEACHER_TOKEN || "";
  const provided = String(req.headers["x-teacher-token"] || "");
  const authenticated = expected
    ? Buffer.byteLength(expected) === Buffer.byteLength(provided) && timingSafeEqual(Buffer.from(expected), Buffer.from(provided))
    : isLocalRequest(req) && /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(String(req.headers.host || ""));
  return isSameOrigin(req) && authenticated;
}

function requestFailure(error, req, fallbackStep = "server") {
  const code = error?.code || "SERVER_ERROR";
  const retryable = typeof error?.retryable === "boolean" ? error.retryable : ["MODEL_REQUEST_FAILED", "MODEL_TIMEOUT", "MODEL_JSON_INVALID", "MODEL_EMPTY_CONTENT", "MODEL_OUTPUT_TRUNCATED", "AI_VERIFICATION_FAILED", "TASK_GENERATION_RETRY"].includes(code);
  return {
    error: error?.message || "服务暂时不可用。",
    code,
    step: error?.step || (["INVALID_IMAGE_INPUT", "BODY_TOO_LARGE", "INVALID_JSON"].includes(code) || error?.status === 413 ? "upload" : fallbackStep),
    requestId: error?.requestId || req?.requestId || crypto.randomUUID(),
    retryable,
    ...(Number.isFinite(error?.upstreamStatus) ? { upstreamStatus: error.upstreamStatus } : {}),
    elapsedMs: Number.isFinite(error?.elapsedMs) ? error.elapsedMs : Math.max(0, Date.now() - (req?.startedAt || Date.now()))
  };
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/teacher/sessions") {
    if (!teacherAuthorized(req)) return send(res, 403, { error: "教师口令不正确，或远程访问尚未配置 TEACHER_TOKEN。", code: "TEACHER_AUTH_REQUIRED", requestId: req.requestId });
    const tasks = await store.tasks();
    const sessions = (await store.sessions()).map(session => summarizeSession(session, tasks.find(task => task.id === session.taskId) || {}));
    return send(res, 200, { sessions });
  }

  if (url.pathname.startsWith("/api/teacher/knowledge")) {
    if (!teacherAuthorized(req)) return send(res, 403, { error: "教师口令不正确，或远程访问尚未配置 TEACHER_TOKEN。", code: "TEACHER_AUTH_REQUIRED", requestId: req.requestId });
    if (req.method === "GET" && url.pathname === "/api/teacher/knowledge") {
      return send(res, 200, { items: await listKnowledge(store, { history: url.searchParams.get("history") === "true" }) });
    }
    if (req.method === "POST" && url.pathname === "/api/teacher/knowledge/draft") {
      const item = await saveKnowledgeDraft(store, await readBody(req, 256 * 1024));
      return send(res, 200, { item });
    }
    const matchKnowledge = url.pathname.match(/^\/api\/teacher\/knowledge\/([^/]+)\/(publish|disable)$/);
    if (req.method === "POST" && matchKnowledge) {
      const id = decodeURIComponent(matchKnowledge[1]);
      const body = await readBody(req, 32 * 1024);
      const item = matchKnowledge[2] === "publish"
        ? await publishKnowledge(store, id, body)
        : await disableKnowledge(store, id, body);
      return send(res, 200, { item });
    }
    return send(res, 405, { error: "Method not allowed", code: "METHOD_NOT_ALLOWED", requestId: req.requestId });
  }

  if (req.method === "GET" && url.pathname === "/api/status") {
    const status = await model.status();
    return send(res, 200, { configured: status.configured, available: status.available, model: status.model, mode: status.mode });
  }

  if (req.method === "POST" && url.pathname === "/api/ai/config") {
    if (!isLocalRequest(req) || !isSameOrigin(req)) {
      return send(res, 403, { error: "网页密钥设置只允许从本机页面操作。", code: "LOCAL_CONFIG_ONLY" });
    }
    const body = await readBody(req, 4096);
    const previousKey = model.runtimeKey;
    model.setRuntimeKey(body.apiKey);
    try {
      await model.checkConnection();
    } catch (error) {
      if (previousKey) model.setRuntimeKey(previousKey);
      else model.clearRuntimeKey();
      throw error;
    }
    const status = await model.status();
    return send(res, 200, { configured: true, available: true, model: status.model, mode: status.mode });
  }

  if (req.method === "POST" && url.pathname === "/api/problem/analyze") {
    const body = await readBody(req);
    const grade = cleanText(body.grade) || "初中";
    const problemText = cleanText(body.problemText || body.text);
    if (!problemText && !body.imageData) return send(res, 400, { error: "请先输入题目文字或上传题目图片。", code: "EMPTY_PROBLEM_INPUT" });
    const parsedImage = parseImageData(body.imageData);
    let result;
    try {
      result = await model.analyzeProblem({ grade, problemText, imageData: body.imageData || null });
    } catch (error) {
      throw markModelError(error, "recognition", req);
    }
    const analysis = result.analysis || normalizeProblemAnalysis(result);
    const imagePath = parsedImage ? await store.saveImage(parsedImage.buffer, parsedImage.extension) : null;
    const draft = {
      id: `draft-${crypto.randomUUID()}`,
      analysis,
      imagePath,
      createdAt: new Date().toISOString()
    };
    await store.saveDraft(draft);
    const studentDraft = draftForStudent(analysis);
    const clarification = analysis.clarification || analysis.feedback || (analysis.needsClarification ? "图片或题意暂时无法确认，请重新拍摄或补充文字。" : "");
    return send(res, 200, {
      draftId: draft.id,
      draft: studentDraft,
      problem: studentDraft,
      analysis: { ...analysis, clarification },
      decision: analysis.needsClarification ? "clearer_input" : "pass",
      confidence: analysis.confidence,
      needsClarification: analysis.needsClarification,
      clarification,
      verified: result.verified === true
    });
  }

  if (req.method === "POST" && url.pathname === "/api/session") {
    const body = await readBody(req);
    const savedDraft = await store.draft(String(body.draftId || ""));
    const submittedRecognition = body.problem || body.recognition || body.recognizedProblem || body.analysis;
    if (!savedDraft && !(body.confirmed === true && submittedRecognition)) {
      return send(res, 400, { error: "识题结果已失效，请重新识别题目。", code: "DRAFT_NOT_FOUND" });
    }
    const sourceAnalysis = savedDraft?.analysis || normalizeProblemAnalysis(submittedRecognition);
    if (sourceAnalysis.isMathProblem === false) {
      return send(res, 422, {
        error: sourceAnalysis.clarification || "题目仍需重新拍摄或补充文字后再识别。",
        code: "PROBLEM_NEEDS_CLARIFICATION",
        decision: "clearer_input"
      });
    }
    const analysis = editableAnalysis(sourceAnalysis, { ...body.draft, ...body.problem, grade: body.grade });
    if (analysis.needsClarification || sourceAnalysis.needsClarification) {
      if (typeof model.revalidateProblem === "function") {
        try {
          const verified = await model.revalidateProblem({ analysis, imageData: body.imageData || null });
          if (verified?.analysis) Object.assign(analysis, verified.analysis);
          analysis.needsClarification = Boolean(verified?.needsClarification || verified?.analysis?.needsClarification);
          analysis.clarification = verified?.clarification || verified?.analysis?.clarification || "";
        } catch (error) {
          throw markModelError(error, "verification", req);
        }
      }
    }
    if (analysis.needsClarification) {
      return send(res, 422, {
        error: analysis.clarification || "题目仍需重新拍摄或补充文字后再识别。",
        code: "PROBLEM_NEEDS_CLARIFICATION",
        decision: "clearer_input",
        retryable: true,
        requestId: req.requestId,
        step: "verification"
      });
    }
    if (!analysis.problemText || !analysis.proofGoal || (analysis.isGeometryProof && !analysis.diagramDescription)) {
      return send(res, 400, { error: analysis.isGeometryProof ? "请补全题目文字、求证目标和图形关系后再开始。" : "请补全题目文字和求解目标后再开始。", code: "INCOMPLETE_CONFIRMED_PROBLEM" });
    }
    let generated;
    try {
      generated = await model.generateTask({ analysis, imageData: body.imageData || null });
    } catch (error) {
      markModelError(error, "task_generation", req);
      const retryableModelErrors = new Set([
        "AI_VERIFICATION_FAILED",
        "MODEL_JSON_INVALID",
        "MODEL_EMPTY_CONTENT",
        "MODEL_OUTPUT_TRUNCATED",
        "MODEL_REQUEST_FAILED",
        "MODEL_TIMEOUT",
        "MODEL_NOT_CONFIGURED"
      ]);
      if (retryableModelErrors.has(error?.code)) {
        const configuredMessage = error.code === "MODEL_NOT_CONFIGURED"
          ? "AI服务暂不可用，请先在本机填写模型密钥。"
          : "AI正在整理学习任务，但这次结果没有通过核验。请再次点击确认，题目不需要重新上传。";
        return send(res, 409, {
          error: configuredMessage,
          code: error.code === "MODEL_NOT_CONFIGURED" ? "MODEL_NOT_CONFIGURED" : "TASK_GENERATION_RETRY",
          retryable: true
          ,requestId: error.requestId || req.requestId
          ,step: error.step || "task_generation"
          ,upstreamStatus: error.upstreamStatus
        });
      }
      throw error;
    }
    const task = { ...generated.task, taskReview: taskReviewFromGeneration(generated), diagramPath: savedDraft?.imagePath || null };
    await store.saveTask(task);
    const session = createSession(task.id);
    session.taskReview = structuredClone(task.taskReview);
    recordKnowledgeReferences(session, generated, STAGES.INITIAL, "task_generation");
    await saveSession(session);
    await record(session, "session_started", { source: savedDraft?.imagePath ? "student_image" : "student_text", recognitionConfidence: analysis.confidence });
    return send(res, 201, {
      session: publicSession(session),
      task: await publicTask(task, session, store),
      generation: { mode: generated.mode || "live", verified: generated.verified === true, needsTeacherReview: task.taskReview.needsTeacherReview, reviewReason: publicTaskReview(task.taskReview).reason }
    });
  }

  const match = url.pathname.match(/^\/api\/session\/([^/]+)(?:\/(initial|help|judgment|transfer|reflection))?$/);
  if (match) {
    const session = await requireSession(match[1]);
    const task = await requireTask(session);
    if (req.method === "GET" && !match[2]) {
      return send(res, 200, { session: publicSession(session), task: await publicTask(task, session, store), events: await store.events(session.id) });
    }
    if (req.method !== "POST") return send(res, 405, { error: "Method not allowed" });
    const body = studentBody(await readBody(req));


    if (match[2] === "initial") {
      submitInitial(session, body);
      const evaluation = body.stuckPoint && session.answers.initial.stuckPoint
        ? { decision: "retry", feedback: "已记录你的卡点。我们从一个小问题开始。", nextPrompt: "请指出题目中你能找到的一条条件，或在图上找到一个对应的点。", matchedIdeas: [], coreIssue: body.stuckPoint, confidence: null }
        : await model.evaluateAnswer({ task, session, stage: STAGES.INITIAL, kind: "initial", answer: body });
      recordKnowledgeReferences(session, evaluation, STAGES.INITIAL, "answer_evaluation");
      applyInitialEvaluation(session, evaluation);
      await saveSession(session);
      await record(session, "initial_evaluated", { decision: evaluation.decision, confidence: evaluation.confidence });
      return send(res, 200, { session: publicSession(session), task: await publicTask(task, session, store), evaluation });
    }

    if (match[2] === "help") {
      return withHelpRequest(session.id, async () => {
        Object.assign(session, await requireSession(session.id));
        assertStage(session, [STAGES.HINT_1, STAGES.HINT_2, STAGES.HINT_3]);
        if (body.action === "hint" || (!body.action && body.selectedStuckPointId)) {
          if (body.imageData) parseImageData(body.imageData);
          const hintStage = session.stage;
          let result;
          try { result = await requestPointHint({ task, session, body, model }); }
          catch (error) { throw error.name === "DeepSeekError" ? markModelError(error, "hint_generation", req) : error; }
          recordKnowledgeReferences(session, result.reply, hintStage, "hint_generation");
          await saveSession(session);
          if (result.hintLevel) await record(session, "hint_delivered", { hintLevel: result.hintLevel, decision: "retry", inputSource: body.selectedStuckPointId ? "point_selection" : "student_input", blocked: Boolean(result.reply?.blocked) });
          return send(res, 200, { session: publicSession(session), task: await publicTask(task, session, store), evaluation: result.evaluation, ...(result.reply ? { reply: { action: result.reply.action, message: result.reply.message, blocked: Boolean(result.reply.blocked) } } : {}) });
        }
        if (body.action === "teacher") {
          if (body.imageData) parseImageData(body.imageData);
          const selectedStuckPoint = resolveHelpSelection(task, body.selectedStuckPointId, session);
          requestAssistance(session, { ...body, selectedStuckPoint });
          recordHelpSelection(session, selectedStuckPoint);
          await saveSession(session);
          await record(session, "teacher_help_requested");
          return send(res, 200, { session: publicSession(session), task: await publicTask(task, session, store), evaluation: { decision: "retry", feedback: "卡点和提示记录已保存到教师看板。你可以继续整理想法；这不代表老师已经收到通知。" } });
        }
        if (body.action === "understood") {
          const evaluation = { decision: "assisted", feedback: "你选择直接进入判别；接下来请核验AI的解题建议。", matchedIdeas: [], coreIssue: "", nextPrompt: "", confidence: null };
          await prepareJudgment(task, session);
          finishHelp(session, { action: "understood", studentText: body.text || "我懂了", reason: "self_declared", assisted: true, evaluation });
          await saveSession(session);
          await record(session, "help_completed", { decision: "assisted", reason: "self_declared", completedHintCount: session.completedHints.length });
          return send(res, 200, { session: publicSession(session), task: await publicTask(task, session, store), evaluation });
        }
        const prompt = "请用自己的话写出你现在确定的一条数学关系；如果能说出依据，也可以一起补上。";
        if ((!body.text && !body.imageData) || isHelpCompletionSignal(body.text) || /^(我)?(已理解|理解了|懂了|会了|可以继续)[。！!\s]*$/u.test(body.text)) {
          const evaluation = { decision: "retry", feedback: "先用一句具体理由检查一下理解。", nextPrompt: prompt, matchedIdeas: [], coreIssue: "尚未提供理解依据", confidence: null };
          session.answers.helpCheck ||= { attempts: [] };
          session.answers.helpCheck.attempts.push({ text: body.text || "", evaluation, at: new Date().toISOString() });
          await saveSession(session);
          return send(res, 200, { session: publicSession(session), task: await publicTask(task, session, store), evaluation, reply: { action: "question", message: prompt } });
        }
        const flags = classifyStudentInput(body.text, { task });
        const evaluation = flags.offTopic
          ? {
              decision: "retry",
              feedback: flags.offTopicReason || "你使用的公式与当前题目条件不匹配，请先回到题目给出的数量和关系。",
              matchedIdeas: [],
              coreIssue: "使用了与题型不匹配的公式",
              nextPrompt: "请先指出题目中的一个已知量或比例关系。",
              confidence: null
            }
          : await model.evaluateAnswer({ task, session, stage: session.stage, kind: "help", answer: body });
        recordKnowledgeReferences(session, evaluation, session.stage, "answer_evaluation");
        session.answers.helpCheck ||= { attempts: [] };
        session.answers.helpCheck.attempts.push({ text: body.text, evaluation, at: new Date().toISOString() });
        if (evaluation.decision === "pass") {
          await prepareJudgment(task, session);
          finishHelp(session, { studentText: body.text, imageData: body.imageData, reason: body.action === "finish" ? "explicit_button" : "understanding_signal", evaluation });
          await saveSession(session);
          await record(session, "help_completed", { decision: "pass", completedHintCount: session.completedHints.length });
          return send(res, 200, { session: publicSession(session), task: await publicTask(task, session, store), evaluation });
        }
        if (body.action === "finish") {
          await saveSession(session);
          return send(res, 200, { session: publicSession(session), task: await publicTask(task, session, store), evaluation, reply: { action: "question", message: evaluation.nextPrompt || prompt } });
        }
        if (evaluation.decision === "clearer_input") {
          await saveSession(session);
          await record(session, "help_input_unclear", { decision: evaluation.decision });
          return send(res, 200, { session: publicSession(session), task: await publicTask(task, session, store), evaluation });
        }

        const hint = availableHint(task, session);
        if (!hint) {
          await saveSession(session);
          return send(res, 200, { session: publicSession(session), task: await publicTask(task, session, store), evaluation: { ...evaluation, decision: "retry", nextPrompt: "三级提示已用完。请说明具体卡点并提交给老师，或解释一个关键关系来检查理解。" } });
        }

        let reply;
        try {
          reply = await model.generateHint({ task, session, studentText: body.text, studentImageData: body.imageData, hint });
        } catch (error) {
          throw markModelError(error, "hint_generation", req);
        }
        const previousOptions = helpOptionsForSession(task, session).options;
        recordKnowledgeReferences(session, reply, session.stage, "hint_generation");
        unlockHint(session, hint);
        if (hint.level === 3) Object.assign(evaluation, { decision: "retry", feedback: "三级提示已给出，请解释一个关键关系来检查理解。", nextPrompt: "如果仍然卡住，请说明具体问题并提交给老师。" });
        recordHintEvaluation(session, hint.level, evaluation);
        session.answers[`hint${hint.level}`] = {
          ...session.answers[`hint${hint.level}`],
          at: new Date().toISOString(),
          student: { ...(body.text ? { text: body.text } : {}), ...(body.imageData ? { image: { provided: true } } : {}) },
          reply: { action: reply.action, message: reply.message, blocked: Boolean(reply.blocked) }
        };
        advanceHelpOptions(task, session, { nextHelpOptions: reply.nextHelpOptions, reply, previousOptions });
        if (flags.directAnswerRequest) session.riskCounts.directAnswerRequests += 1;
        if (reply.blocked) session.riskCounts.blockedLeaks += 1;
        if (flags.irrelevant) session.riskCounts.irrelevantInputs += 1;
        await saveSession(session);
        await record(session, "hint_delivered", { hintLevel: hint.level, decision: evaluation.decision, blocked: Boolean(reply.blocked) });
        return send(res, 200, { session: publicSession(session), task: await publicTask(task, session, store), evaluation, reply: { action: reply.action, message: reply.message, blocked: Boolean(reply.blocked) } });
      });
    }

    if (match[2] === "judgment") {
      const verdict = cleanText(body.verdict);
      const judgmentText = [`选择：${verdict}`, `理由：${body.reason || body.text}`].join("\n");
      let evaluation;
      try {
        evaluation = await model.evaluateAnswer({
          task,
          session,
          stage: STAGES.JUDGMENT,
          kind: "judgment",
          answer: { text: judgmentText, imageData: body.imageData }
        });
      } catch (error) {
        throw markModelError(error, "answer_evaluation", req);
      }
      recordKnowledgeReferences(session, evaluation, STAGES.JUDGMENT, "answer_evaluation");
      submitJudgment(session, body, evaluation);
      const storedEvaluation = session.answers.judgment.evaluation;
      if (session.stage === STAGES.TRANSFER) {
        if (storedEvaluation.decision === "assisted") appendExplanation(storedEvaluation, task.judgmentCard.reason);
        await prepareTransfer(task, session);
      }
      await saveSession(session);
      await record(session, "judgment_evaluated", { decision: storedEvaluation.decision, attempt: session.attemptCounts.judgment });
      return send(res, 200, { session: publicSession(session), task: await publicTask(task, session, store), evaluation: storedEvaluation });
    }

    if (match[2] === "transfer") {
      let evaluation;
      try {
        evaluation = await model.evaluateAnswer({ task, session, stage: STAGES.TRANSFER, kind: "transfer", answer: body });
      } catch (error) {
        throw markModelError(error, "answer_evaluation", req);
      }
      recordKnowledgeReferences(session, evaluation, STAGES.TRANSFER, "answer_evaluation");
      submitTransfer(session, body, evaluation);
      const storedEvaluation = session.answers.transfer.evaluation;
      if (session.stage === STAGES.REFLECTION && storedEvaluation.decision === "assisted") {
        appendExplanation(storedEvaluation, task.transferTask.referenceProof || task.transferTask.answerOutline);
      }
      await saveSession(session);
      await record(session, "transfer_evaluated", { decision: storedEvaluation.decision, attempt: session.attemptCounts.transfer });
      return send(res, 200, { session: publicSession(session), task: await publicTask(task, session, store), evaluation: storedEvaluation });
    }

    if (match[2] === "reflection") {
      assertStage(session, STAGES.REFLECTION);
      let reflectionEvaluation;
      try {
        reflectionEvaluation = await model.evaluateAnswer({ task, session, stage: STAGES.REFLECTION, kind: "reflection", answer: body });
      } catch (error) {
        throw markModelError(error, "answer_evaluation", req);
      }
      recordKnowledgeReferences(session, reflectionEvaluation, STAGES.REFLECTION, "answer_evaluation");
      if (reflectionEvaluation.decision === "clearer_input") {
        await saveSession(session);
        return send(res, 200, { session: publicSession(session), task: await publicTask(task, session, store), evaluation: reflectionEvaluation });
      }
      submitReflection(session, body);
      const summary = {
        title: "本轮流程已完成",
        learningOutcome: summarizeLearningOutcome(session, { publicView: true }),
        message: "已保存本次学习记录。",
        selfWork: body.selfWork || "",
        aiHelp: body.aiHelp || "",
        nextTime: body.nextTime || "", note: body.text || "",
        hintsUsed: session.completedHints.length,
        initial: session.answers.initial?.evaluation?.decision || "recorded",
        judgment: session.answers.judgment?.evaluation?.decision || "recorded",
        transfer: session.answers.transfer?.evaluation?.decision || "recorded",
        assisted: Object.entries(session.assistance).filter(([, value]) => value).map(([key]) => key)
      };
      session.answers.summary = summary;
      await saveSession(session);
      await record(session, "reflection_completed", { hintsUsed: summary.hintsUsed, assistedStages: summary.assisted });
      return send(res, 200, { session: publicSession(session, { includeKnowledge: true }), task: await publicTask(task, session, store), evaluation: reflectionEvaluation, summary, knowledgeReferences: publicKnowledgeReferences(session) });
    }
  }

  return false;
}

createServer(async (req, res) => {
  req.requestId = crypto.randomUUID();
  req.startedAt = Date.now();
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname.startsWith("/api/")) {
      const handled = await handleApi(req, res, url);
      if (handled !== false) return;
      return send(res, 404, { error: "接口不存在。" });
    }
    if (req.method !== "GET") return send(res, 405, { error: "Method not allowed" });
    const vendor = {
      "/vendor/katex.min.css": join(root, "node_modules/katex/dist/katex.min.css"),
      "/vendor/katex.min.js": join(root, "node_modules/katex/dist/katex.min.js"),
      "/vendor/auto-render.min.js": join(root, "node_modules/katex/dist/contrib/auto-render.min.js")
    };
    const relative = url.pathname === "/" ? "index.html" : ["/teacher", "/teacher/"].includes(url.pathname) ? "teacher.html" : url.pathname.slice(1);
    const publicFile = ["index.html", "app.js", "styles.css", "teacher.html", "teacher.js"].includes(relative)
      || /^assets\/[A-Za-z0-9_.-]+$/.test(relative)
      || /^vendor\/fonts\/[A-Za-z0-9_.-]+$/.test(relative);
    if (!publicFile && !vendor[url.pathname] && !url.pathname.startsWith("/runtime-uploads/")) return send(res, 404, "Not found", "text/plain; charset=utf-8");
    const uploadName = url.pathname.startsWith("/runtime-uploads/") ? basename(url.pathname) : "";
    const filePath = uploadName ? join(store.uploadsDir, uploadName) : vendor[url.pathname] || normalize(join(root, relative));
    if ((!vendor[url.pathname] && !uploadName && !filePath.startsWith(root)) || !existsSync(filePath) || !(await stat(filePath)).isFile()) {
      return send(res, 404, "Not found", "text/plain; charset=utf-8");
    }
    return send(res, 200, await readFile(filePath), contentTypes[extname(filePath)] || "application/octet-stream");
  } catch (error) {
    const status = error.status || (error instanceof StageError ? 409 : 500);
    return send(res, status, requestFailure(error, req));
  }
}).listen(port, () => console.log(`思阶学生版已启动：http://localhost:${port}`));
