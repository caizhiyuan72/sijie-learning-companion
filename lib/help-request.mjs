import { advanceHelpOptions, helpOptionsForSession, resolveHelpSelection } from "./help-options.mjs";
import { classifyStudentInput } from "./guardrails.mjs";
import {
  STAGES, assertStage, availableHint, normalizeStudentAnswer,
  recordHintEvaluation, unlockHint
} from "./state-machine.mjs";

// Reject overlapping requests rather than queueing another paid hint. The
// HTTP handlers reload the session inside this lock and hold it through save.
// This protects one Node process / Worker isolate, not a distributed lock.
const activeRequests = new Set();

export async function withHelpRequest(sessionId, operation) {
  if (activeRequests.has(sessionId)) {
    throw Object.assign(new Error("上一次求助仍在处理中，请稍候再试。"), {
      status: 409, code: "HELP_REQUEST_BUSY", retryable: true
    });
  }
  activeRequests.add(sessionId);
  try { return await operation(); }
  finally { activeRequests.delete(sessionId); }
}

export function recordHelpSelection(session, selection, hintLevel = null) {
  if (!selection) return;
  session.answers.helpSelections ||= [];
  session.answers.helpSelections.push({
    id: selection.id, label: selection.label,
    at: new Date().toISOString(),
    ...(hintLevel ? { hintLevel } : {})
  });
}

export async function requestPointHint({ task, session, body, model }) {
  assertStage(session, [STAGES.HINT_1, STAGES.HINT_2, STAGES.HINT_3]);
  const previousOptions = helpOptionsForSession(task, session).options;
  const selection = resolveHelpSelection(task, body.selectedStuckPointId, session);
  const student = normalizeStudentAnswer(body, { allowEmpty: Boolean(selection) });
  const evaluation = {
    decision: "retry", feedback: "先围绕这个卡点想一小步。",
    matchedIdeas: [], coreIssue: selection?.label || "学生主动请求提示",
    nextPrompt: "", confidence: null
  };
  const hint = availableHint(task, session);
  if (!hint) {
    evaluation.feedback = "三级提示已用完，可以检查理解或把卡点提交给老师。";
    return { evaluation, reply: null, hintLevel: null };
  }

  // No answer evaluation: an AI-authored label is never evidence of the
  // student's understanding. Only their actual supplemental text is text.
  const reply = await model.generateHint({
    task, session, studentText: student.text || "",
    studentImageData: body.imageData,
    selectedStuckPoint: selection, hint
  });
  unlockHint(session, hint);
  if (hint.level === 3) evaluation.nextPrompt = "三级提示已给出；可以检查理解，或提交给老师。";
  recordHintEvaluation(session, hint.level, evaluation);
  recordHelpSelection(session, selection, hint.level);
  session.answers[`hint${hint.level}`] = {
    ...session.answers[`hint${hint.level}`],
    at: new Date().toISOString(),
    student: { ...student, ...(selection ? { selectedStuckPoint: selection } : {}) },
    reply: { action: reply.action, message: reply.message, blocked: Boolean(reply.blocked) }
  };
  // Options belong to this student's current round. A successful hint must
  // advance the picker together with the consumed hint, never on failure.
  advanceHelpOptions(task, session, { nextHelpOptions: reply.nextHelpOptions, selectedStuckPoint: selection, reply, previousOptions });
  const flags = classifyStudentInput(student.text || "", { task });
  session.riskCounts ||= {};
  for (const [flag, key] of [[flags.directAnswerRequest, "directAnswerRequests"], [flags.irrelevant, "irrelevantInputs"], [reply.blocked, "blockedLeaks"]]) {
    if (flag) session.riskCounts[key] = Number(session.riskCounts[key] || 0) + 1;
  }
  return { evaluation, reply, hintLevel: hint.level };
}
