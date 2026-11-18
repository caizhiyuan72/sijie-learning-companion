import test from "node:test";
import assert from "node:assert/strict";
import { sampleTask } from "../lib/sample-task.mjs";
import { createWorker } from "../cloud/worker.mjs";

class MemoryStore {
  constructor(state) { this.state = state; }
  drafts() { return [...this.state.drafts.values()]; }
  draft(id) { return this.state.drafts.get(id) || null; }
  saveDraft(value) { this.state.drafts.set(value.id, structuredClone(value)); return value; }
  tasks() { return [...this.state.tasks.values()]; }
  taskById(id) { return this.state.tasks.get(id) || null; }
  saveTask(value) { this.state.tasks.set(value.id, structuredClone(value)); return value; }
  saveSession(value) { this.state.sessions.set(value.id, structuredClone(value)); return value; }
  session(id) { return this.state.sessions.get(id) || null; }
  sessions() { return [...this.state.sessions.values()]; }
  event(value) { const result = { id: `event-${this.state.events.length + 1}`, at: new Date().toISOString(), ...value }; this.state.events.push(result); return result; }
  events(sessionId = "") { return this.state.events.filter(item => !sessionId || item.sessionId === sessionId); }
  saveImage() { return null; }
  getImage() { return null; }
  knowledgeCards() { return [...(this.state.knowledge?.values() || [])].map(item => structuredClone(item)); }
  saveKnowledgeCard(value) { this.state.knowledge ||= new Map(); this.state.knowledge.set(`${value.id}@${value.version}`, structuredClone(value)); return value; }
  archiveKnowledgeCards(id, version) {
    this.state.knowledge ||= new Map();
    for (const [key, value] of this.state.knowledge) if (value.id === id && Number(value.version) < Number(version)) this.state.knowledge.set(key, { ...value, status: "archived" });
  }
}

class FakeModel {
  status() { return { configured: true, available: true, model: "test-model", mode: "test" }; }
  analyzeProblem({ grade, problemText }) {
    return {
      verified: true,
      analysis: {
        grade,
        subject: "初中数学",
        problemType: "word_problem",
        isMathProblem: true,
        isGeometryProof: false,
        title: "测试题",
        problemText,
        proofGoal: "求出结果",
        knownFacts: ["已知一个数量"],
        learningGoal: "整理数量关系",
        needsClarification: false,
        clarification: ""
      }
    };
  }
  generateTask() { return { task: structuredClone(sampleTask), mode: "test", verified: true }; }
  evaluateAnswer() { return { decision: "pass", feedback: "已完成当前步骤。", matchedIdeas: ["关键关系"], coreIssue: "", nextPrompt: "", confidence: 0.95 }; }
  generateHint() { return { action: "hint", message: "请指出一条关键关系。", blocked: false, verified: true }; }
  generateJudgmentCard() { return { judgmentCard: structuredClone(sampleTask.judgmentCard), mode: "test", verified: true }; }
  generateTransferTask() { return { transferTask: structuredClone(sampleTask.transferTask), mode: "test", verified: true }; }
  revalidateProblem({ analysis }) { return { ...analysis, analysis: { ...analysis, needsClarification: false, clarification: "" }, needsClarification: false, clarification: "", verified: true }; }
}

function setup({ model = new FakeModel(), assets = null } = {}) {
  const state = { drafts: new Map(), tasks: new Map(), sessions: new Map(), events: [], knowledge: new Map() };
  const worker = createWorker({
    storeFactory: () => new MemoryStore(state),
    modelFactory: () => model
  });
  const env = { TEACHER_TOKEN: "teacher-secret", ...(assets ? { ASSETS: assets } : {}) };
  return { worker, env, state };
}

function helpPicker(payload) {
  const picker = payload?.session?.helpOptions;
  if (picker && Array.isArray(picker.options)) return picker;
  return {
    round: Number(payload?.task?.helpOptionsRound || 0),
    options: Array.isArray(payload?.task?.helpOptions) ? payload.task.helpOptions : [],
    source: payload?.task?.helpOptionsSource || ""
  };
}

async function call(worker, env, path, init = {}) {
  const request = new Request(`https://sijie.example.test${path}`, { ...init, headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers || {}) } });
  const response = await worker.fetch(request, env);
  const payload = await response.json();
  return { response, payload };
}

test("Cloud Worker serves teacher HTML aliases through the ASSETS canonical route", async () => {
  const requested = [];
  const assets = {
    async fetch(request) {
      const pathname = new URL(request.url).pathname;
      requested.push(pathname);
      return pathname === "/teacher"
        ? new Response("<!doctype html><title>教师看板</title>", { status: 200, headers: { "content-type": "text/html" } })
        : new Response("Not found", { status: 404 });
    }
  };
  const { worker, env } = setup({ assets });
  for (const path of ["/teacher.html", "/teacher", "/teacher/"]) {
    const response = await worker.fetch(new Request(`https://sijie.example.test${path}`), env);
    assert.equal(response.status, 200, path);
    assert.match(await response.text(), /教师看板/u);
  }
  assert.deepEqual(requested, ["/teacher", "/teacher", "/teacher"]);
});

test("Cloud Worker API covers recognition, session steps and teacher authentication", async () => {
  const { worker, env } = setup();

  const status = await call(worker, env, "/api/status");
  assert.equal(status.response.status, 200);
  assert.equal(status.payload.configured, true);

  const analyzed = await call(worker, env, "/api/problem/analyze", { method: "POST", body: JSON.stringify({ grade: "八年级", problemText: "2+2=？" }) });
  assert.equal(analyzed.response.status, 200);
  assert.ok(analyzed.payload.draftId);

  const created = await call(worker, env, "/api/session", { method: "POST", body: JSON.stringify({ draftId: analyzed.payload.draftId, draft: analyzed.payload.draft, problem: analyzed.payload.draft }) });
  assert.equal(created.response.status, 201);
  assert.equal(created.payload.generation.needsTeacherReview, false);
  assert.equal(created.payload.session.learningOutcome.taskReview.status, "model_checked");
  const sessionId = created.payload.session.id;

  const initial = await call(worker, env, `/api/session/${sessionId}/initial`, { method: "POST", body: JSON.stringify({ known: "2", goal: "求和", text: "2+2" }) });
  assert.equal(initial.response.status, 200);
  const help = await call(worker, env, `/api/session/${sessionId}/help`, { method: "POST", body: JSON.stringify({ text: "我知道要把两个数相加" }) });
  assert.equal(help.response.status, 200);
  const judgment = await call(worker, env, `/api/session/${sessionId}/judgment`, { method: "POST", body: JSON.stringify({ verdict: "合理", reason: "有依据" }) });
  assert.equal(judgment.response.status, 200);
  const transfer = await call(worker, env, `/api/session/${sessionId}/transfer`, { method: "POST", body: JSON.stringify({ text: "按同样方法" }) });
  assert.equal(transfer.response.status, 200);
  const reflection = await call(worker, env, `/api/session/${sessionId}/reflection`, { method: "POST", body: JSON.stringify({ selfWork: "先整理条件", aiHelp: "没有", nextTime: "先找关系" }) });
  assert.equal(reflection.response.status, 200);
  assert.equal(reflection.payload.session.stage, "completed");
  assert.equal(reflection.payload.session.learningOutcome.status, "independent");

  const denied = await call(worker, env, "/api/teacher/sessions");
  assert.equal(denied.response.status, 403);
  const teacher = await call(worker, env, "/api/teacher/sessions", { headers: { "x-teacher-token": "teacher-secret" } });
  assert.equal(teacher.response.status, 200);
  assert.equal(teacher.payload.sessions.length, 1);
});

test("Cloud Worker marks a structure-only task for teacher review without calling completion mastery", async () => {
  class StructureOnlyModel extends FakeModel {
    generateTask() { return { ...super.generateTask(), mode: "live-recovery", verified: false }; }
  }
  const { worker, env } = setup({ model: new StructureOnlyModel() });
  const analyzed = await call(worker, env, "/api/problem/analyze", { method: "POST", body: JSON.stringify({ grade: "八年级", problemText: "2+2=？" }) });
  const created = await call(worker, env, "/api/session", { method: "POST", body: JSON.stringify({ draftId: analyzed.payload.draftId, draft: analyzed.payload.draft }) });
  assert.equal(created.response.status, 201);
  assert.equal(created.payload.generation.verified, false);
  assert.equal(created.payload.generation.needsTeacherReview, true);
  assert.ok(created.payload.generation.reviewReason);
  assert.match(created.payload.generation.reviewReason, /需教师复核/u);
  assert.equal(created.payload.session.learningOutcome.taskReview.status, "structure_only");
  assert.equal(created.payload.session.learningOutcome.status, "pending");
});

test("Cloud Worker hides verifier review markers from students but keeps them in teacher summaries", async () => {
  const marker = "SECRET_REFERENCE_MARKER";
  class MarkerModel extends FakeModel {
    generateTask() { return { ...super.generateTask(), mode: "live-recovery", verified: false, reviewReason: marker }; }
  }
  const { worker, env } = setup({ model: new MarkerModel() });
  const analyzed = await call(worker, env, "/api/problem/analyze", { method: "POST", body: JSON.stringify({ grade: "八年级", problemText: "2+2=？" }) });
  const created = await call(worker, env, "/api/session", { method: "POST", body: JSON.stringify({ draftId: analyzed.payload.draftId, draft: analyzed.payload.draft }) });
  assert.equal(created.response.status, 201);
  const studentPayload = JSON.stringify(created.payload);
  assert.equal(studentPayload.includes(marker), false);
  assert.equal(created.payload.generation.needsTeacherReview, true);
  assert.notEqual(created.payload.generation.reviewReason, marker);

  const teacher = await call(worker, env, "/api/teacher/sessions", { headers: { "x-teacher-token": "teacher-secret" } });
  assert.equal(teacher.response.status, 200);
  assert.equal(JSON.stringify(teacher.payload).includes(marker), true);
});

test("Cloud Worker rejects teacher access when the secret is absent", async () => {
  const { worker } = setup();
  const result = await call(worker, {}, "/api/teacher/sessions", { headers: { "x-teacher-token": "" } });
  assert.equal(result.response.status, 403);
});

test("Cloud Worker teacher knowledge API supports draft, publish, disable and protects student payloads", async () => {
  const { worker, env } = setup();
  const token = { headers: { "x-teacher-token": "teacher-secret" } };
  const denied = await call(worker, env, "/api/teacher/knowledge");
  assert.equal(denied.response.status, 403);

  const listed = await call(worker, env, "/api/teacher/knowledge", token);
  assert.equal(listed.response.status, 200);
  assert.ok(listed.payload.items.length >= 8);

  const draft = await call(worker, env, "/api/teacher/knowledge/draft", {
    method: "POST",
    headers: { "x-teacher-token": "teacher-secret" },
    body: JSON.stringify({
      id: "teacher-strategy-test",
      kind: "strategy",
      title: "教师策略：先找基准量",
      keywords: ["策略测试", "基准量"],
      principle: "先确认每个比例的基准量，再推进一步。",
      question: "当前比例以哪个量为基准？",
      requiredConditions: ["题目给出对应量"],
      avoidWhen: ["没有确认基准量"],
      strategies: [{ stage: "help", action: "question", instruction: "让学生指出基准量。" }],
      source: "项目整理，待教师复核"
    })
  });
  assert.equal(draft.response.status, 200);
  assert.equal(draft.payload.item.status, "draft");
  assert.equal(draft.payload.item.kind, "strategy");

  const published = await call(worker, env, "/api/teacher/knowledge/teacher-strategy-test/publish", { method: "POST", ...token, body: "{}" });
  assert.equal(published.response.status, 200);
  assert.equal(published.payload.item.status, "published");
  assert.ok(Number(published.payload.item.version) > Number(draft.payload.item.version));

  const disabled = await call(worker, env, "/api/teacher/knowledge/teacher-strategy-test/disable", { method: "POST", ...token, body: "{}" });
  assert.equal(disabled.response.status, 200);
  assert.equal(disabled.payload.item.status, "disabled");

  const analyzed = await call(worker, env, "/api/problem/analyze", { method: "POST", body: JSON.stringify({ grade: "八年级", problemText: "策略测试：2+2=？" }) });
  const created = await call(worker, env, "/api/session", { method: "POST", body: JSON.stringify({ draftId: analyzed.payload.draftId, draft: analyzed.payload.draft, problem: analyzed.payload.draft }) });
  assert.equal(created.response.status, 201);
  assert.equal(Object.hasOwn(created.payload.task, "_knowledgeBundle"), false);
  assert.equal(Object.hasOwn(created.payload.task, "strategies"), false);
  assert.equal(Object.hasOwn(created.payload.session, "knowledgeReferences"), false);

  const corrected = await call(worker, env, "/api/session", { method: "POST", body: JSON.stringify({ confirmed: true, analysis: { grade: "八年级", subject: "初中数学", problemType: "word_problem", isMathProblem: true, isGeometryProof: false, title: "人工修正题", problemText: "人工修正题：2+2=？", proofGoal: "求出结果", knownFacts: ["2"], needsClarification: true, clarification: "原识别稿不清楚" }, draft: { problemText: "人工修正题：2+2=？", goal: "求出结果" } }) });
  assert.equal(corrected.response.status, 201);
});



test("反思图片看不清保持第五阶段，补充文字后完成且不编造学生反思", async () => {
  class ReflectionModel extends FakeModel {
    evaluateAnswer(args = {}) {
      if (args.kind === "reflection" && args.answer?.imageData) return { decision: "clearer_input", feedback: "反思图片看不清，请补充文字。" };
      return super.evaluateAnswer(args);
    }
  }
  const { worker, env } = setup({ model: new ReflectionModel() });
  const analyzed = await call(worker, env, "/api/problem/analyze", { method: "POST", body: JSON.stringify({ grade: "八年级", problemText: "2+2=？" }) });
  const created = await call(worker, env, "/api/session", { method: "POST", body: JSON.stringify({ draftId: analyzed.payload.draftId, draft: analyzed.payload.draft }) });
  const prefix = `/api/session/${created.payload.session.id}`;
  for (const [step, body] of [["initial", { known: "2", goal: "求和" }], ["help", { action: "understood" }], ["judgment", { verdict: "合理", reason: "条件足够" }], ["transfer", { text: "按同一方法完成" }]]) await call(worker, env, `${prefix}/${step}`, { method: "POST", body: JSON.stringify(body) });
  const blurry = await call(worker, env, `${prefix}/reflection`, { method: "POST", body: JSON.stringify({ imageData: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" }) });
  assert.equal(blurry.payload.session.stage, "reflection");
  assert.equal(blurry.payload.session.completedAt, undefined);
  const done = await call(worker, env, `${prefix}/reflection`, { method: "POST", body: JSON.stringify({ text: "下次先核对运算条件。" }) });
  assert.equal(done.payload.session.stage, "completed");
  assert.equal(done.payload.summary.selfWork, "");
  assert.equal(done.payload.summary.aiHelp, "");
  assert.equal(done.payload.summary.nextTime, "");
  assert.equal(done.payload.summary.note, "下次先核对运算条件。");
});


test("Cloud Worker point selection requests hints without evaluating understanding and preserves the global budget", async () => {
  class PointModel extends FakeModel {
    constructor() { super(); this.hintCalls = []; this.evaluationCalls = 0; this.failNext = false; }
    evaluateAnswer() { this.evaluationCalls += 1; return super.evaluateAnswer(); }
    generateHint(input) {
      this.hintCalls.push(structuredClone(input));
      if (this.failNext) { this.failNext = false; throw Object.assign(new Error("模拟模型故障"), { status: 502, code: "MODEL_REQUEST_FAILED", retryable: true }); }
      const level = Number(input?.hint?.level || 1);
      return {
        ...super.generateHint(input),
        nextHelpOptions: [1, 2, 3].map(index => ({ label: `第${level + 1}轮继续理解${index}` }))
      };
    }
  }
  const model = new PointModel();
  const { worker, env } = setup({ model });
  const analyzed = await call(worker, env, "/api/problem/analyze", { method: "POST", body: JSON.stringify({ problemText: "2+2=？" }) });
  const created = await call(worker, env, "/api/session", { method: "POST", body: JSON.stringify({ draftId: analyzed.payload.draftId, draft: analyzed.payload.draft }) });
  assert.equal(created.payload.task.helpOptions, undefined, "先思不能公开卡点");
  const endpoint = `/api/session/${created.payload.session.id}`;
  const initial = await call(worker, env, `${endpoint}/initial`, { method: "POST", body: JSON.stringify({ stuckPoint: "不知道从哪里开始" }) });
  const initialPicker = helpPicker(initial.payload);
  assert.equal(initialPicker.round, 0);
  assert.equal(initialPicker.source, "generic");
  const [first, second] = initialPicker.options;
  assert.ok(first.id && second.id);
  const post = body => call(worker, env, `${endpoint}/help`, { method: "POST", body: JSON.stringify(body) });
  const invalid = await post({ action: "hint", selectedStuckPointId: "forged", text: "我已经理解了" });
  assert.equal(invalid.response.status, 400);
  assert.equal(invalid.payload.code, "INVALID_HELP_SELECTION");
  assert.equal(model.hintCalls.length, 0);
  const failed = await post({ action: "hint", selectedStuckPointId: first.id, imageData: "not-an-image" });
  assert.equal(failed.response.status, 400);
  model.failNext = true;
  const modelFailed = await post({ action: "hint", selectedStuckPointId: first.id });
  assert.equal(modelFailed.response.status, 502);
  const afterFailure = await call(worker, env, endpoint);
  assert.equal(afterFailure.payload.session.completedHints.length, 0);
  assert.equal(afterFailure.payload.session.answers.helpSelections, undefined);
  assert.equal(helpPicker(afterFailure.payload).round, 0);
  const firstHint = await post({ action: "hint", selectedStuckPointId: first.id });
  assert.equal(firstHint.response.status, 200);
  assert.equal(firstHint.payload.evaluation.decision, "retry");
  assert.equal(firstHint.payload.session.stage, "hint_level_2");
  assert.equal(firstHint.payload.session.answers.hint1.student.text, undefined);
  assert.equal(firstHint.payload.session.answers.hint1.student.selectedStuckPoint.label, first.label);
  assert.equal(firstHint.payload.session.answers.helpCheck, undefined);
  const round1 = helpPicker(firstHint.payload);
  assert.equal(round1.round, 1);
  assert.ok(round1.options.length >= 3);
  assert.ok(round1.options.every(option => !initialPicker.options.some(previous => previous.id === option.id)));
  assert.equal(model.evaluationCalls, 0, "点选不得被送入理解判定");
  assert.equal(model.hintCalls.at(-1).studentText, "");
  assert.equal(model.hintCalls.at(-1).selectedStuckPoint.label, first.label);
  const oldRoundId = await post({ action: "hint", selectedStuckPointId: first.id });
  assert.equal(oldRoundId.response.status, 400);
  assert.equal(oldRoundId.payload.code, "INVALID_HELP_SELECTION");
  assert.equal(oldRoundId.payload.session, undefined);
  const round1Point = round1.options[0];
  const next = await post({ action: "hint", selectedStuckPointId: round1Point.id, text: "我还没想明白" });
  assert.equal(next.payload.session.completedHints.length, 2);
  assert.equal(next.payload.session.answers.hint2.student.text, "我还没想明白");
  const round2 = helpPicker(next.payload);
  assert.equal(round2.round, 2);
  assert.ok(round2.options.every(option => !round1.options.some(previous => previous.id === option.id)));
  const third = await post({ action: "hint", selectedStuckPointId: round2.options[0].id });
  assert.equal(third.payload.session.completedHints.length, 3);
  assert.equal(third.payload.session.stage, "hint_level_3");
  const round3 = helpPicker(third.payload);
  assert.equal(round3.round, 3);
  const beforeFourth = model.hintCalls.length;
  const fourth = await post({ action: "hint", selectedStuckPointId: round3.options[0].id });
  assert.equal(fourth.payload.session.completedHints.length, 3);
  assert.equal(model.hintCalls.length, beforeFourth);
  const teacher = await post({ action: "teacher", selectedStuckPointId: round3.options[0].id });
  assert.equal(teacher.response.status, 200);
  assert.equal(teacher.payload.session.answers.helpRequests[0].selectedStuckPoint.label, round3.options[0].label);
  assert.equal(teacher.payload.session.answers.helpRequests[0].text, undefined);
  assert.equal(teacher.payload.session.answers.helpSelections.at(-1).id, round3.options[0].id);
  assert.equal(model.evaluationCalls, 0);
});

test("Cloud Worker rejects overlapping help requests and releases the lock after completion", async () => {
  let startHint;
  let releaseHint;
  const started = new Promise(resolve => { startHint = resolve; });
  const released = new Promise(resolve => { releaseHint = resolve; });
  class SlowModel extends FakeModel {
    async generateHint() { startHint(); await released; return super.generateHint(); }
  }
  const { worker, env } = setup({ model: new SlowModel() });
  const analyzed = await call(worker, env, "/api/problem/analyze", { method: "POST", body: JSON.stringify({ problemText: "2+2=？" }) });
  const created = await call(worker, env, "/api/session", { method: "POST", body: JSON.stringify({ draftId: analyzed.payload.draftId, draft: analyzed.payload.draft }) });
  const endpoint = `/api/session/${created.payload.session.id}`;
  const initial = await call(worker, env, `${endpoint}/initial`, { method: "POST", body: JSON.stringify({ stuckPoint: "不知道从哪里开始" }) });
  const body = { action: "hint", selectedStuckPointId: helpPicker(initial.payload).options[0].id };
  const first = call(worker, env, `${endpoint}/help`, { method: "POST", body: JSON.stringify(body) });
  await started;
  try {
    const second = await call(worker, env, `${endpoint}/help`, { method: "POST", body: JSON.stringify(body) });
    assert.equal(second.response.status, 409);
    assert.equal(second.payload.code, "HELP_REQUEST_BUSY");
  } finally { releaseHint(); }
  const delivered = await first;
  assert.equal(delivered.response.status, 200);
  assert.equal(delivered.payload.session.completedHints.length, 1);
  const after = await call(worker, env, endpoint);
  assert.equal(after.payload.session.completedHints.length, 1);
});

test("Cloud Worker keeps help option rounds isolated between sessions sharing one task", async () => {
  class RoundModel extends FakeModel {
    generateHint(input) {
      const level = Number(input?.hint?.level || 1);
      return {
        ...super.generateHint(input),
        nextHelpOptions: [1, 2, 3].map(index => ({ label: `同题第${level + 1}轮卡点${index}` }))
      };
    }
  }
  const { worker, env, state } = setup({ model: new RoundModel() });
  const analyzed = await call(worker, env, "/api/problem/analyze", { method: "POST", body: JSON.stringify({ problemText: "2+2=？" }) });
  const first = await call(worker, env, "/api/session", { method: "POST", body: JSON.stringify({ draftId: analyzed.payload.draftId, draft: analyzed.payload.draft }) });
  const second = await call(worker, env, "/api/session", { method: "POST", body: JSON.stringify({ draftId: analyzed.payload.draftId, draft: analyzed.payload.draft }) });
  const secondSession = state.sessions.get(second.payload.session.id);
  secondSession.taskId = first.payload.task.id;
  state.sessions.set(second.payload.session.id, secondSession);

  const firstEndpoint = `/api/session/${first.payload.session.id}`;
  const secondEndpoint = `/api/session/${second.payload.session.id}`;
  const firstInitial = await call(worker, env, `${firstEndpoint}/initial`, { method: "POST", body: JSON.stringify({ stuckPoint: "不知道从哪里开始" }) });
  const secondInitial = await call(worker, env, `${secondEndpoint}/initial`, { method: "POST", body: JSON.stringify({ stuckPoint: "不知道从哪里开始" }) });
  const firstPoint = helpPicker(firstInitial.payload).options[0];
  await call(worker, env, `${firstEndpoint}/help`, { method: "POST", body: JSON.stringify({ action: "hint", selectedStuckPointId: firstPoint.id }) });

  const firstAfter = await call(worker, env, firstEndpoint);
  const secondAfter = await call(worker, env, secondEndpoint);
  assert.equal(helpPicker(firstAfter.payload).round, 1);
  assert.equal(helpPicker(secondAfter.payload).round, 0);
  assert.equal(secondAfter.payload.session.completedHints.length, 0);
  assert.equal(helpPicker(secondInitial.payload).options[0].id, helpPicker(secondAfter.payload).options[0].id);
});

test("Cloud Worker explicit hint with only text never evaluates it as an understanding answer", async () => {
  class TextHintModel extends FakeModel {
    constructor() { super(); this.evaluations = 0; this.input = null; }
    evaluateAnswer() { this.evaluations += 1; return super.evaluateAnswer(); }
    generateHint(input) { this.input = input; return super.generateHint(input); }
  }
  const model = new TextHintModel();
  const { worker, env } = setup({ model });
  const analyzed = await call(worker, env, "/api/problem/analyze", { method: "POST", body: JSON.stringify({ problemText: "2+2=？" }) });
  const created = await call(worker, env, "/api/session", { method: "POST", body: JSON.stringify({ draftId: analyzed.payload.draftId, draft: analyzed.payload.draft }) });
  const endpoint = `/api/session/${created.payload.session.id}`;
  await call(worker, env, `${endpoint}/initial`, { method: "POST", body: JSON.stringify({ stuckPoint: "不知道从哪里开始" }) });
  const hint = await call(worker, env, `${endpoint}/help`, { method: "POST", body: JSON.stringify({ action: "hint", text: "我想知道题目中的中点是什么意思" }) });
  assert.equal(hint.response.status, 200);
  assert.equal(hint.payload.evaluation.decision, "retry");
  assert.equal(hint.payload.session.stage, "hint_level_2");
  assert.equal(model.evaluations, 0);
  assert.equal(model.input.studentText, "我想知道题目中的中点是什么意思");
  assert.equal(model.input.selectedStuckPoint, null);
  assert.equal(hint.payload.session.answers.helpSelections, undefined);
});
