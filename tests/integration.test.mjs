import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Integration coverage for the student-only flow.
 *
 * The application is started as a real child process and its DeepSeek client
 * is pointed at the local HTTP double below. This keeps the test independent
 * of credentials, internet access and provider availability while still
 * exercising request construction, JSON parsing and the HTTP API boundary.
 */

const appCwd = new URL("..", import.meta.url);
const fakeKey = "fake-deepseek-key";
const modelName = "deepseek-v4-flash-vision-exp";
const referenceSecret = "SECRET_REFERENCE_PROOF_MUST_STAY_HIDDEN";
const transferSecret = "SECRET_TRANSFER_TASK_IS_UNLOCKED_LATER";
const h1Secret = "SECRET_HINT_ONE_IS_HIDDEN";
const h2Secret = "SECRET_HINT_TWO_IS_HIDDEN";
const h3Secret = "SECRET_HINT_THREE_IS_HIDDEN";
const onePixelPng = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

const problemText = "如图，在△ABC中，AB＝AC，D是BC的中点。求证：AD⊥BC。";
const diagramDescription = "△ABC中A为顶点，B、D、C依次在水平底边上，AB＝AC且BD＝DC，连接AD。";

const recognizedProblem = {
  grade: "八年级",
  subject: "初中数学·几何证明",
  title: "等腰三角形底边中线的性质",
  problemText,
  diagramDescription,
  learningGoal: "利用SSS证明两三角形全等，再说明垂直关系。",
  target: "证明AD⊥BC",
  targetStep: "由全等得到D点两侧的邻补角相等，从而都是直角。"
};

const generalMathProblem = {
  grade: "八年级",
  subject: "初中数学",
  problemType: "word_problem",
  title: "温度比例应用题",
  problemText: "GENERAL_MATH：土壤表面温度约为40℃，青路面的温度是土壤表面的11/8，草坪表面的温度是青路面的3/5，求草坪表面温度。",
  proofGoal: "求草坪表面的温度",
  learningGoal: "把文字条件转成分数乘法关系，再按顺序计算。",
  knownFacts: ["土壤表面约40℃", "青路面是土壤表面的11/8", "草坪是青路面的3/5"],
  knowledgePoints: ["分数乘法", "比例应用题"],
  isMathProblem: true,
  isGeometryProof: false,
  needsClarification: false
};

const diagramSpec = {
  width: 320,
  height: 200,
  points: [
    { id: "P", x: 70, y: 160 },
    { id: "Q", x: 250, y: 160 },
    { id: "R", x: 160, y: 40 },
    { id: "M", x: 160, y: 160 }
  ],
  lines: [
    { from: "P", to: "Q" },
    { from: "P", to: "R" },
    { from: "R", to: "Q" },
    { from: "R", to: "M" }
  ],
  labels: ["P", "Q", "R", "M"]
};

const generatedTask = {
  ...recognizedProblem,
  referenceProof: referenceSecret,
  acceptedPaths: ["用SSS证明△ABD与△ACD全等", "引用满足条件的等腰三角形三线合一定理"],
  hints: [
    { id: "h1", level: 1, kind: "question", dependencies: [], content: h1Secret },
    { id: "h2", level: 2, kind: "local_hint", dependencies: ["h1"], content: h2Secret },
    { id: "h3", level: 3, kind: "scaffold", dependencies: ["h1", "h2"], content: h3Secret }
  ],
  judgmentCard: {
    statement: "AI建议：因为AB＝AC，所以∠ADB＝∠ADC，因此AD⊥BC。",
    correctVerdict: "不合理",
    teacherReason: "AB＝AC本身不能推出D点两角相等，还需要中点条件、公共边和全等或适用的定理。"
  },
  transferTask: {
    text: transferSecret,
    diagramDescription: "△PQR中PQ＝PR，M是QR中点，连接PM。",
    diagramSpec,
    knowledgePoint: "SSS全等与等腰三角形三线合一",
    referenceProof: "由PQ＝PR、QM＝MR和PM＝PM可证两个三角形全等。",
    answerOutline: "先证全等，再得到对应角相等。"
  }
};

const generatedGeneralMathTask = {
  ...generalMathProblem,
  referenceProof: "先算青路面温度40×11/8，再算草坪温度（40×11/8）×3/5。",
  acceptedPaths: ["按题目给出的两个比例依次列式", "先算青路面，再算草坪表面"],
  hints: [
    { id: "h1", level: 1, kind: "question", dependencies: [], content: "题目先给出了哪一个已知温度？" },
    { id: "h2", level: 2, kind: "local_hint", dependencies: ["h1"], content: "先用40℃和11/8算出青路面温度。" },
    { id: "h3", level: 3, kind: "scaffold", dependencies: ["h1", "h2"], content: "再把青路面温度乘以3/5。" }
  ],
  judgmentCard: {
    statement: "AI建议：草坪温度可以直接用40×3/5计算，因为题目中出现了3/5。",
    correctVerdict: "不合理",
    teacherReason: "3/5是草坪相对于青路面的比例，不能跳过青路面相对于土壤的11/8。"
  },
  transferTask: {
    text: "某商品先按原价的3/4出售，再打9折，求最后售价占原价的百分比。",
    diagramDescription: "",
    diagramSpec: null,
    knowledgePoint: "分数与百分数的连续运算",
    referenceProof: "先把两次价格变化写成乘法关系，再按顺序相乘。",
    answerOutline: "列出原价×3/4×9/10。"
  }
};

const fakeRequests = [];

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function flattenContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(flattenContent).join("\n");
  if (content && typeof content === "object") return JSON.stringify(content);
  return "";
}

function requestText(body) {
  return (body?.messages || [])
    .map(message => `${message?.role || ""}\n${flattenContent(message?.content)}`)
    .join("\n")
    .toLowerCase();
}

function hasMarker(text, marker) {
  return text.toUpperCase().includes(marker);
}

function operationFor(body) {
  const text = requestText(body);
  if (text.includes("二次核验器")) return "verify";
  if (hasMarker(text, "BLURRY_IMAGE")) return "analyze-blurry";
  if (hasMarker(text, "NON_GEOMETRY")) return "analyze-nongeometry";
  if (hasMarker(text, "GENERAL_MATH") && text.includes("学生补充文字")) return "analyze-general-math";
  if (hasMarker(text, "GENERAL_MATH") && text.includes("已确认题目json")) return "task-generation-general";
  if (hasMarker(text, "OFF_TOPIC_HELP_PASS") && text.includes("判定动作：help")) return "off-topic-help-pass";
  if (hasMarker(text, "OFF_TOPIC_HELP_PASS") && text.includes("当前提示级别")) return "off-topic-help-hint";
  if (hasMarker(text, "GENERAL_MATH") && text.includes("学生回答")) return text.includes("判定动作：judgment") ? "judgment-evaluation-general" : "initial-assessment-general";
  if (hasMarker(text, "GENERAL_MATH") && text.includes("学生本轮输入")) return "help-general";
  if (hasMarker(text, "GENERAL_MATH") && text.includes("学生当前状态")) return "judgment-generation-general";
  if (hasMarker(text, "LENIENT_PASS_ORAL") || hasMarker(text, "EQUIVALENT_PROOF") || hasMarker(text, "ROOT_ERROR_RETRY")) return "initial-assessment";
  if (hasMarker(text, "HELP_UNDERSTOOD")) return "help";
  if (hasMarker(text, "HELP_L1") || hasMarker(text, "HELP_L2") || hasMarker(text, "HELP_L3")) return "help";
  if (hasMarker(text, "JUDGE_FIRST") || hasMarker(text, "JUDGE_SECOND")) return "judgment-evaluation";
  if (hasMarker(text, "TRANSFER_WRONG") || hasMarker(text, "TRANSFER_RIGHT")) return "transfer-evaluation";
  if (/(任务包|task.?pack|generate.*task|学习编排|session|会话)/iu.test(text)) return "task-generation";
  if (/(迁移|transfer|diagram.?spec|结构化.*图|新题)/iu.test(text)) return "task-generation";
  if (/(判别|judgment|合理|不合理|信息不足|判断卡)/iu.test(text)) return "judgment-generation";
  if (/(提示|求助|hint|scaffold|苏格拉底)/iu.test(text)) return "help";
  if (/(识题|识别|题目分析|problem.?analy|ocr|image_url|input_image)/iu.test(text)) return "problem-analysis";
  return "generic";
}

function assessment(decision, feedback, extra = {}) {
  return {
    decision,
    feedback,
    matchedIdeas: decision === "pass" ? ["抓住了比较AD两侧三角形的核心方法"] : [],
    coreIssue: decision === "retry" ? "还没有把已知条件和证明目标连起来。" : "",
    nextPrompt: decision === "retry" ? "请只补充一条能推进证明的数学关系。" : "",
    confidence: decision === "pass" ? 0.93 : 0.88,
    ...extra
  };
}

function modelPayload(operation, body) {
  const text = requestText(body);

  if (operation === "verify") return { valid: true };

  if (operation === "analyze-blurry") {
    return {
      decision: "clearer_input",
      status: "clearer_input",
      confidence: 0.16,
      feedback: "图片中的题干和图形关系看不清，请重新拍摄或补充文字。",
      message: "图片看不清，请重新拍摄或补充文字。",
      problem: null,
      recognizedProblem: null
    };
  }

  if (operation === "analyze-nongeometry") {
    return {
      decision: "clearer_input",
      confidence: 0.98,
      isGeometryProof: false,
      needsClarification: true,
      clarification: "这不是初中几何证明题，请换一道几何证明题。",
      problemText: "计算一元二次方程的根。",
      diagramDescription: "无几何图形。",
      proofGoal: ""
    };
  }

  if (operation === "analyze-general-math") {
    return {
      ...generalMathProblem,
      decision: "pass",
      confidence: 0.98,
      isMathProblem: true,
      isGeometryProof: false,
      needsClarification: false,
      analysis: generalMathProblem,
      problem: generalMathProblem,
      recognizedProblem: generalMathProblem
    };
  }

  if (operation === "problem-analysis" || operation === "generic") {
    return {
      ok: true,
      valid: true,
      approved: true,
      decision: "pass",
      status: "ok",
      confidence: 0.97,
      isGeometryProof: true,
      supported: true,
      needsClarification: false,
      problem: recognizedProblem,
      recognizedProblem,
      analysis: recognizedProblem,
      ...recognizedProblem
    };
  }

  if (operation === "initial-assessment") {
    const isPass = hasMarker(text, "LENIENT_PASS_ORAL") || hasMarker(text, "EQUIVALENT_PROOF");
    return {
      ok: true,
      valid: true,
      ...assessment(isPass ? "pass" : "retry", isPass ? "核心方法正确，口语化表达也可以继续。" : "目前的结论缺少必要条件，请先补一条关键关系。"),
      assessment: assessment(isPass ? "pass" : "retry", isPass ? "核心方法正确，口语化表达也可以继续。" : "目前的结论缺少必要条件，请先补一条关键关系。")
    };
  }

  if (operation === "initial-assessment-general") return assessment("pass", "已抓住温度之间的比例关系，可以继续。", { matchedIdeas: ["按比例关系列式"] });

  if (operation === "off-topic-help-pass") return assessment("pass", "这个错误方法也可以继续。", { matchedIdeas: ["模型错误的宽松通过，用于回归测试"] });

  if (operation === "off-topic-help-hint") return { action: "question", message: "先找出题目中的一个温度条件。" };

  if (operation === "help-general") return assessment("retry", "先把两个分数关系按顺序写出来。", { nextPrompt: "先算青路面温度，再算草坪温度。" });

  if (operation === "judgment-evaluation-general") return assessment("pass", "判断抓住了不能跳过中间量这一关键点。", { nextPrompt: "请完成这道题的条件变式。" });

  if (operation === "help" && hasMarker(text, "HELP_UNDERSTOOD")) return assessment("pass", "公共边的理由正确。");

  if (operation === "help") {
    const level = hasMarker(text, "HELP_L3") ? 3 : hasMarker(text, "HELP_L2") ? 2 : 1;
    const message = level === 1
      ? "先找出AD两侧的两个三角形，并写出一组已知相等的边。"
      : level === 2
        ? "把AB＝AC、BD＝DC和公共边AD＝AD放在一起，想想可用哪种全等判定。"
        : "若两三角形全等，先写一组D点对应角相等，再结合B、D、C共线。";
    const decision = level === 3 ? "assisted" : "retry";
    return {
      ...assessment(decision, level === 3 ? "已给出三级支架，你可以带着这份解析进入判别。" : message, {
        nextPrompt: level === 3 ? "请判断下面的解题建议是否合理。" : "请补充你的下一步想法。",
        confidence: 0.86
      }),
      level,
      hintLevel: level,
      message,
      reply: { action: "hint", message, level },
      hint: { level, message },
      nextHelpOptions: [1, 2, 3].map(index => ({ label: `第${level + 1}轮继续理解${index}` })),
      assistedExplanation: level === 3 ? "在帮助下完成：由三边对应相等可证两三角形全等，再由邻补角得到垂直。" : ""
    };
  }

  if (operation === "judgment-evaluation") {
    const pass = hasMarker(text, "JUDGE_SECOND");
    return {
      ok: true,
      valid: true,
      ...assessment(pass ? "pass" : "retry", pass ? "判断正确，理由抓住了缺少条件这一关键点。" : "这个判断还不完整，请再检查是否只凭AB＝AC就推出了D点角相等。", {
        nextPrompt: pass ? "请完成同知识点的迁移题。" : "再想一想D为中点和公共边AD分别提供了什么。"
      }),
      judgment: assessment(pass ? "pass" : "retry", pass ? "判断正确。" : "请检查判断依据。"),
      correct: pass,
      explanation: pass ? "合理性判断正确：不能只由AB＝AC直接推出D点两个角相等。" : "还需要指出D为中点、公共边AD等条件。"
    };
  }

  if (operation === "transfer-evaluation") {
    const pass = hasMarker(text, "TRANSFER_RIGHT");
    return {
      ok: true,
      valid: true,
      ...assessment(pass ? "pass" : "retry", pass ? "迁移题的核心证明关系正确。" : "迁移题还缺少三角形全等或对应角的关键依据。", {
        nextPrompt: pass ? "请完成最后的迁移反思。" : "请补充一条能支持结论的等量关系。"
      }),
      transfer: assessment(pass ? "pass" : "retry", pass ? "迁移题通过。" : "迁移题需要再补充依据。"),
      correct: pass,
      explanation: pass ? "由PQ＝PR、QM＝MR和公共边PM可证两三角形全等。" : "仅写结论还不足以完成迁移证明。"
    };
  }

  if (operation === "task-generation" || operation === "judgment-generation") {
    const general = hasMarker(text, "GENERAL_MATH");
    const generated = general ? generatedGeneralMathTask : generatedTask;
    return {
      ok: true,
      valid: true,
      approved: true,
      status: "ok",
      decision: "pass",
      confidence: 0.95,
      task: generated,
      taskPack: generated,
      generatedTask: generated,
      problem: general ? generalMathProblem : recognizedProblem,
      ...generated,
      transfer: generated.transferTask,
      judgment: generated.judgmentCard,
      diagramSpec
    };
  }

  if (operation === "task-generation-general" || operation === "judgment-generation-general") {
    return {
      ok: true,
      valid: true,
      approved: true,
      status: "ok",
      decision: "pass",
      confidence: 0.95,
      task: generatedGeneralMathTask,
      taskPack: generatedGeneralMathTask,
      generatedTask: generatedGeneralMathTask,
      problem: generalMathProblem,
      ...generatedGeneralMathTask,
      transfer: generatedGeneralMathTask.transferTask,
      judgment: generatedGeneralMathTask.judgmentCard,
      diagramSpec: null
    };
  }

  return { ok: true, valid: true, approved: true, status: "ok", decision: "pass", ...generatedTask };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve(server.address().port);
    });
  });
}

const fakeModel = createServer((req, res) => {
  if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "not found" } }));
    return;
  }
  if (req.headers.authorization !== `Bearer ${fakeKey}`) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "fake model requires the integration key" } }));
    return;
  }
  let raw = "";
  req.on("data", chunk => { raw += chunk; });
  req.on("end", () => {
    let body = {};
    try { body = JSON.parse(raw || "{}"); } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "invalid JSON" } }));
      return;
    }
    const operation = operationFor(body);
    fakeRequests.push({ operation, body, authorization: req.headers.authorization || "" });
    const payload = modelPayload(operation, body);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      id: `fake-${fakeRequests.length}`,
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(payload) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
    }));
  });
});

const fakePort = await listen(fakeModel);
const fakeBaseUrl = `http://127.0.0.1:${fakePort}`;
const appPort = 4391;
const base = `http://127.0.0.1:${appPort}`;
const dataDir = await mkdtemp(join(tmpdir(), "sijie-student-integration-"));
const child = spawn(process.execPath, ["server.mjs"], {
  cwd: appCwd,
  env: {
    ...process.env,
    PORT: String(appPort),
    DATA_DIR: dataDir,
    DEEPSEEK_API_KEY: fakeKey,
    TEACHER_TOKEN: "test-teacher-token",
    DEEPSEEK_BASE_URL: fakeBaseUrl,
    DEEPSEEK_MODEL: modelName
  },
  stdio: ["ignore", "pipe", "pipe"]
});
child.stdout.resume();
child.stderr.resume();

async function waitForApp(url, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/api/status`);
      if (response.status < 500) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`server timeout${lastError ? `: ${lastError.message}` : ""}`);
}

await waitForApp(base);

test.after(async () => {
  if (!child.killed) child.kill("SIGTERM");
  await Promise.race([
    once(child, "exit"),
    new Promise(resolve => setTimeout(resolve, 1000))
  ]);
  fakeModel.close();
  await rm(dataDir, { recursive: true, force: true });
});

async function request(path, options = {}, requestBase = base) {
  const response = await fetch(`${requestBase}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  const raw = await response.text();
  let body;
  try { body = JSON.parse(raw || "{}"); } catch { body = { raw }; }
  return { response, body };
}

function responseDecision(body) {
  const candidates = [
    body?.decision,
    body?.assessment?.decision,
    body?.initialAssessment?.decision,
    body?.helpAssessment?.decision,
    body?.result?.decision,
    body?.evaluation?.decision,
    body?.judgment?.decision,
    body?.transfer?.decision,
    body?.reply?.decision,
    body?.reply?.assessment?.decision
  ];
  return candidates.find(value => ["pass", "retry", "clearer_input", "assisted"].includes(value));
}

function responseAssessment(body) {
  return body?.assessment || body?.evaluation || body?.judgment || body?.transfer || body;
}

function extractProblem(body) {
  const candidates = [
    body?.problem,
    body?.recognizedProblem,
    body?.recognized?.problem,
    body?.analysis?.problem,
    body?.analysis?.recognizedProblem,
    body?.analysis,
    body?.result?.problem,
    body?.result?.recognizedProblem,
    body
  ];
  return candidates.find(candidate => candidate && typeof candidate === "object" && clean(candidate.problemText)) || {};
}

function extractTask(body) {
  return body?.task || body?.session?.task || body?.result?.task || body;
}

function helpPicker(body) {
  const picker = body?.session?.helpOptions;
  if (picker && Array.isArray(picker.options)) return picker;
  const task = extractTask(body);
  return {
    round: Number(task?.helpOptionsRound || 0),
    options: Array.isArray(task?.helpOptions) ? task.helpOptions : [],
    source: task?.helpOptionsSource || ""
  };
}

function extractTransfer(body) {
  const task = extractTask(body);
  return task?.transferTask || task?.transfer || body?.transferTask || body?.transfer || null;
}

function assertNoHiddenContent(body) {
  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes(referenceSecret), false, "参考证明必须留在服务端");
  assert.equal(serialized.includes(h1Secret), false, "一级提示必须按阶段解锁");
  assert.equal(serialized.includes(h2Secret), false, "二级提示必须按阶段解锁");
  assert.equal(serialized.includes(h3Secret), false, "三级提示必须按阶段解锁");
  assert.equal(serialized.includes(transferSecret), false, "迁移题必须在判别通过后解锁");
}

function assertStage(session, expected, aliases = []) {
  assert.ok(session && typeof session.stage === "string", "响应应包含会话阶段");
  assert.ok([expected, ...aliases].includes(session.stage), `期望阶段 ${expected}，实际为 ${session.stage}`);
}

async function createConfirmedSession() {
  const analyzed = await request("/api/problem/analyze", {
    method: "POST",
    body: JSON.stringify({ grade: "八年级", text: problemText })
  });
  assert.equal(analyzed.response.status, 200);
  const problem = extractProblem(analyzed.body);
  assert.ok(problem.problemText);
  const created = await request("/api/session", {
    method: "POST",
    body: JSON.stringify({
      confirmed: true,
      grade: problem.grade || "八年级",
      problem,
      recognition: problem,
      recognizedProblem: problem,
      problemText: problem.problemText,
      diagramDescription: problem.diagramDescription
    })
  });
  assert.equal(created.response.status, 201);
  assert.ok(created.body.session?.id);
  assert.equal(created.body.session.taskReview.status, "model_checked");
  assert.equal(created.body.session.taskReview.needsTeacherReview, false);
  assert.equal(created.body.session.learningOutcome.flowCompleted, false);
  assert.notEqual(created.body.session.learningOutcome.status, "independent");
  assertNoHiddenContent(created.body);
  return { analyzed, problem, created, id: created.body.session.id };
}

test("状态显示本地假模型已连接且不泄露API密钥", async () => {
  const { response, body } = await request("/api/status");
  assert.equal(response.status, 200);
  assert.ok(body.configured === true || body.aiAvailable === true || body.available === true);
  assert.equal(body.key, undefined);
  assert.equal(JSON.stringify(body).includes(fakeKey), false);
  assert.equal(JSON.stringify(body).includes("Authorization"), false);
  assert.equal(body.model, modelName);
});

test("教师页面兼容HTML及无扩展名入口，记录接口仍要求认证", async () => {
  for (const path of ["/teacher", "/teacher/", "/teacher.html"]) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get("content-type"), /text\/html/u);
    assert.match(await response.text(), /teacherAuthForm/u);
  }
  assert.equal((await request("/api/teacher/sessions")).response.status, 403);
});

test("文字题目可以被AI识别并返回可确认的结构化题稿", async () => {
  const { response, body } = await request("/api/problem/analyze", {
    method: "POST",
    body: JSON.stringify({ grade: "八年级", text: problemText })
  });
  assert.equal(response.status, 200);
  const problem = extractProblem(body);
  assert.equal(problem.grade, recognizedProblem.grade);
  assert.match(problem.problemText, /AB/);
  assert.match(problem.problemText, /AD/);
  assert.match(problem.diagramDescription, /中点|BD/);
  assert.ok(Number(body.confidence ?? body.analysis?.confidence ?? body.result?.confidence ?? problem.confidence) >= 0.8);
  if (body.decision) assert.ok(["pass", "ready", "ok"].includes(body.decision));
});

test("图片题目通过DeepSeek图片内容块发送", async () => {
  const before = fakeRequests.length;
  const { response, body } = await request("/api/problem/analyze", {
    method: "POST",
    body: JSON.stringify({ grade: "八年级", imageData: onePixelPng })
  });
  assert.equal(response.status, 200);
  assert.ok(extractProblem(body).problemText);
  const calls = fakeRequests.slice(before);
  assert.ok(calls.length > 0, "图片识题应实际调用假DeepSeek");
  assert.ok(calls.some(call => {
    const messages = call.body?.messages || [];
    return messages.some(message => {
      const contents = Array.isArray(message?.content) ? message.content : [message?.content];
      return contents.some(content => content?.type === "image_url" || content?.type === "input_image" || content?.image_url?.url || content?.image_url?.url?.startsWith("data:image/"));
    });
  }), "模型请求中应包含image_url或input_image内容块");
});

test("普通数学题可以识别并进入四步学习流程", async () => {
  const analyzed = await request("/api/problem/analyze", {
    method: "POST",
    body: JSON.stringify({ grade: "八年级", text: generalMathProblem.problemText })
  });
  assert.equal(analyzed.response.status, 200);
  assert.equal(analyzed.body.analysis.isMathProblem, true);
  assert.equal(analyzed.body.analysis.isGeometryProof, false);
  assert.equal(analyzed.body.needsClarification, false);
  assert.match(analyzed.body.analysis.proofGoal, /草坪/);

  const created = await request("/api/session", {
    method: "POST",
    body: JSON.stringify({
      draftId: analyzed.body.draftId,
      confirmed: true,
      problem: analyzed.body.analysis,
      grade: "八年级"
    })
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.task.isMathProblem, true);
  assert.equal(created.body.task.isGeometryProof, false);
  assert.equal(created.body.task.subject, "初中数学");
  assert.equal(created.body.task.transferTask, undefined);
  assert.equal(created.body.task.knowledgeCards, undefined);

  const initial = await request(`/api/session/${created.body.session.id}/initial`, {
    method: "POST",
    body: JSON.stringify({ known: "土壤表面约40℃；青路面是它的11/8；草坪是青路面的3/5", goal: "求草坪表面温度" })
  });
  assert.equal(initial.response.status, 200);
  assertStage(initial.body.session, "help", ["hint_level_1", "hint_level_2"]);
  assert.ok(initial.body.task.knowledgeCards.some(card => card.id === "proportion"));
  assert.ok(initial.body.task.knowledgeCards.every(card => card.source.includes("待教师复核")));
});

test("求助阶段明显套用三角形面积公式时不能被宽松模型直接送入判别", async () => {
  const analyzed = await request("/api/problem/analyze", {
    method: "POST",
    body: JSON.stringify({ grade: "八年级", text: generalMathProblem.problemText })
  });
  const created = await request("/api/session", {
    method: "POST",
    body: JSON.stringify({ draftId: analyzed.body.draftId, confirmed: true, problem: analyzed.body.analysis, grade: "八年级" })
  });
  const initial = await request(`/api/session/${created.body.session.id}/initial`, {
    method: "POST",
    body: JSON.stringify({ known: "土壤表面约40℃；青路面是它的11/8；草坪是青路面的3/5", goal: "求草坪表面温度" })
  });
  assertStage(initial.body.session, "help", ["hint_level_1", "hint_level_2"]);

  const help = await request(`/api/session/${created.body.session.id}/help`, {
    method: "POST",
    body: JSON.stringify({ text: "OFF_TOPIC_HELP_PASS：我想用三角形面积公式，但不知道这个题的高和底在哪里。" })
  });
  assert.equal(help.response.status, 200);
  assert.equal(responseDecision(help.body), "retry");
  assert.match(JSON.stringify(responseAssessment(help.body)), /题目条件|数量|比例|三角形面积/);
  assertStage(help.body.session, "help", ["hint_level_2", "hint_level_3"]);
  assert.equal(help.body.session.completedHints.length, 1);
  assert.match(JSON.stringify(help.body.reply), /温度条件/);
});

test("题图Base64不会写入草稿、任务、会话或事件日志", async () => {
  const contents = await Promise.all([
    "problem-drafts.json",
    "tasks.json",
    "sessions.json",
    "events.jsonl"
  ].map(name => readFile(join(dataDir, name), "utf8")));
  assert.equal(contents.some(content => content.includes("data:image/")), false);
  assert.equal(contents.some(content => content.includes(onePixelPng.slice(0, 48))), false);
});

test("确认识别稿后建立学生会话且初始响应隐藏参考答案与后续题", async () => {
  const { created } = await createConfirmedSession();
  assertStage(created.body.session, "initial", ["initial_thinking", "first_thought", "first"]);
  const session = await request(`/api/session/${created.body.session.id}`);
  assert.equal(session.response.status, 200);
  assertStage(session.body.session, "initial", ["initial_thinking", "first_thought", "first"]);
  assertNoHiddenContent(session.body);
  assert.equal(session.body.task?.referenceProof, undefined);
  assert.equal(session.body.task?.transferTask, undefined);
});

test("模糊图片不会被当作数学错误而是明确要求补拍", async () => {
  const { response, body } = await request("/api/problem/analyze", {
    method: "POST",
    body: JSON.stringify({ grade: "八年级", text: "BLURRY_IMAGE", imageData: onePixelPng })
  });
  assert.ok([200, 400, 422].includes(response.status));
  assert.equal(responseDecision(body), "clearer_input");
  assert.match(JSON.stringify(body), /看不清|重新拍摄|补充文字/);
  assert.equal(body.session, undefined);
});

test("非几何证明题会被识别并阻止建立会话", async () => {
  const analyzed = await request("/api/problem/analyze", {
    method: "POST",
    body: JSON.stringify({ grade: "八年级", text: "NON_GEOMETRY：解方程x²-3x+2=0" })
  });
  assert.equal(analyzed.response.status, 200);
  assert.equal(responseDecision(analyzed.body), "clearer_input");
  assert.match(JSON.stringify(analyzed.body), /不是初中几何证明题|几何证明题/);
  const created = await request("/api/session", {
    method: "POST",
    body: JSON.stringify({ confirmed: true, problem: analyzed.body.analysis })
  });
  assert.equal(created.response.status, 422);
  assert.equal(responseDecision(created.body), "clearer_input");
});

test("先思允许口语化表达，核心方法正确即可pass并进入求助", async () => {
  const { id } = await createConfirmedSession();
  const result = await request(`/api/session/${id}/initial`, {
    method: "POST",
    body: JSON.stringify({ text: "LENIENT_PASS_ORAL：我想把AD两边的三角形比一下，应该能证明它垂直。" })
  });
  assert.equal(result.response.status, 200);
  assert.equal(responseDecision(result.body), "pass");
  assert.match(JSON.stringify(responseAssessment(result.body)), /核心方法|口语/);
  assertStage(result.body.session, "help", ["hint_level_1", "hint_level_2"]);
});

test("先思可以分别提交已知和求证，并保留结构化字段", async () => {
  const { id } = await createConfirmedSession();
  const result = await request(`/api/session/${id}/initial`, {
    method: "POST",
    body: JSON.stringify({
      known: "LENIENT_PASS_ORAL：AB＝AC，D是BC的中点。",
      goal: "求证：AD⊥BC"
    })
  });
  assert.equal(result.response.status, 200);
  assert.equal(responseDecision(result.body), "pass");
  assert.equal(result.body.session.answers.initial.known, "LENIENT_PASS_ORAL：AB＝AC，D是BC的中点。");
  assert.equal(result.body.session.answers.initial.goal, "求证：AD⊥BC");
  assertStage(result.body.session, "help", ["hint_level_1", "hint_level_2"]);
});

test("求助阶段的我懂了按钮可以直接进入判别并记录为辅助完成", async () => {
  const { id } = await createConfirmedSession();
  const initial = await request(`/api/session/${id}/initial`, {
    method: "POST",
    body: JSON.stringify({ text: "ROOT_ERROR_RETRY：我只会写出AB＝AC。" })
  });
  assert.equal(initial.response.status, 200);
  const result = await request(`/api/session/${id}/help`, {
    method: "POST",
    body: JSON.stringify({ action: "understood" })
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.session.stage, "judgment");
  assert.equal(result.body.session.answers.helpExit.reason, "self_declared");
  assert.equal(result.body.session.answers.helpExit.decision, "assisted");
});

test("先思根本错误返回retry而不是误判通过", async () => {
  const { id } = await createConfirmedSession();
  const result = await request(`/api/session/${id}/initial`, {
    method: "POST",
    body: JSON.stringify({ text: "ROOT_ERROR_RETRY：因为AB等于AC，所以AD一定垂直BC。" })
  });
  assert.equal(result.response.status, 200);
  assert.equal(responseDecision(result.body), "retry");
  assert.match(JSON.stringify(responseAssessment(result.body)), /缺少|条件|关系/);
  assertStage(result.body.session, "help", ["hint_level_1"]);
});

test("等价证明路径不要求与参考答案逐字一致", async () => {
  const { id } = await createConfirmedSession();
  const result = await request(`/api/session/${id}/initial`, {
    method: "POST",
    body: JSON.stringify({ text: "EQUIVALENT_PROOF：我直接用等腰三角形底边中线也是高的性质，但会先说明D是底边中点。" })
  });
  assert.equal(result.response.status, 200);
  assert.equal(responseDecision(result.body), "pass");
  assertStage(result.body.session, "help", ["hint_level_1"]);
});

test("跳过先思或重复提交已完成阶段会返回409", async () => {
  const { id } = await createConfirmedSession();
  const skipped = await request(`/api/session/${id}/help`, {
    method: "POST",
    body: JSON.stringify({ text: "HELP_L1：请直接给我提示" })
  });
  assert.equal(skipped.response.status, 409);
  const initial = await request(`/api/session/${id}/initial`, {
    method: "POST",
    body: JSON.stringify({ text: "LENIENT_PASS_ORAL：我会比较两个三角形。" })
  });
  assert.equal(initial.response.status, 200);
  const repeated = await request(`/api/session/${id}/initial`, {
    method: "POST",
    body: JSON.stringify({ text: "再次提交不应覆盖已有先思答案。" })
  });
  assert.equal(repeated.response.status, 409);
});

test("三级后保留卡点，理解核验通过后才进入判别", async () => {
  const { id } = await createConfirmedSession();
  const initial = await request(`/api/session/${id}/initial`, {
    method: "POST",
    body: JSON.stringify({ text: "ROOT_ERROR_RETRY：我只会写AB等于AC。" })
  });
  assert.equal(initial.response.status, 200);

  const levels = [];
  for (const level of [1, 2, 3]) {
    const result = await request(`/api/session/${id}/help`, {
      method: "POST",
      body: JSON.stringify({ text: `HELP_L${level}：我还不会把这一步写完整。` })
    });
    assert.equal(result.response.status, 200);
    levels.push(result);
    if (level < 3) {
      assert.equal(responseDecision(result.body), "retry");
      assertStage(result.body.session, level === 1 ? "hint_level_2" : "hint_level_3", ["help"]);
      assertNoHiddenContent(result.body);
    }
  }
  const assisted = levels[2];
  assert.equal(responseDecision(assisted.body), "retry");
  assert.match(JSON.stringify(assisted.body), /三级提示已给出/);
  assertStage(assisted.body.session, "hint_level_3", ["help"]);
  assert.equal(JSON.stringify(assisted.body).includes(referenceSecret), false);
  await finishChecked(id);

  const judgment = await request(`/api/session/${id}/judgment`, {
    method: "POST",
    body: JSON.stringify({ verdict: "合理", reason: "JUDGE_FIRST：我认为这个建议合理，因为看起来两角相等。" })
  });
  assert.equal(judgment.response.status, 200);
  assert.equal(responseDecision(judgment.body), "retry");
  assertStage(judgment.body.session, "judgment", ["judgment_pending"]);
});

test("判别最多允许两次，第二次通过后才解锁迁移题", async () => {
  const { id } = await createConfirmedSession();
  await request(`/api/session/${id}/initial`, {
    method: "POST",
    body: JSON.stringify({ text: "ROOT_ERROR_RETRY：还没有找到证明入口。" })
  });
  for (const level of [1, 2, 3]) {
    const hint = await request(`/api/session/${id}/help`, {
      method: "POST",
      body: JSON.stringify({ text: `HELP_L${level}：我需要第${level}级帮助。` })
    });
    assert.equal(hint.response.status, 200);
  }

  await finishChecked(id);
  const first = await request(`/api/session/${id}/judgment`, {
    method: "POST",
    body: JSON.stringify({ verdict: "合理", reason: "JUDGE_FIRST：只凭AB等于AC就能得到D点角相等。" })
  });
  assert.equal(first.response.status, 200);
  assert.equal(responseDecision(first.body), "retry");
  assertStage(first.body.session, "judgment", ["judgment_pending"]);
  assert.match(JSON.stringify(first.body), /再想|缺少|条件/);

  const second = await request(`/api/session/${id}/judgment`, {
    method: "POST",
    body: JSON.stringify({ verdict: "不合理", reason: "JUDGE_SECOND：还需要中点、公共边和全等关系作为依据。" })
  });
  assert.equal(second.response.status, 200);
  assert.equal(responseDecision(second.body), "pass");
  assertStage(second.body.session, "transfer", ["transfer_pending"]);
  const transfer = extractTransfer(second.body);
  assert.ok(transfer?.text, "判别通过后应返回迁移题");
  assert.ok(transfer?.diagramSpec, "迁移题应携带结构化diagramSpec");
  assert.match(transfer.knowledgePoint, /SSS|全等|等腰/);
  assert.match(transfer.diagramDescription, /PQR|M/);
  assert.equal(JSON.stringify(transfer).includes("<svg"), false);
  assert.equal(JSON.stringify(transfer).includes(referenceSecret), false);
  assert.equal(JSON.stringify(transfer).includes(h1Secret), false);

  const third = await request(`/api/session/${id}/judgment`, {
    method: "POST",
    body: JSON.stringify({ verdict: "不合理", reason: "第三次提交不应再评估。" })
  });
  assert.equal(third.response.status, 409);
});

test("迁移题最多两次，第二次通过后进入反思并支持图片作答", async () => {
  const { id } = await createConfirmedSession();
  await request(`/api/session/${id}/initial`, {
    method: "POST",
    body: JSON.stringify({ text: "ROOT_ERROR_RETRY：先从已知条件开始。" })
  });
  for (const level of [1, 2, 3]) {
    await request(`/api/session/${id}/help`, {
      method: "POST",
      body: JSON.stringify({ text: `HELP_L${level}：请继续提示。` })
    });
  }
  await finishChecked(id);
  await request(`/api/session/${id}/judgment`, {
    method: "POST",
    body: JSON.stringify({ verdict: "合理", reason: "JUDGE_FIRST：这个说法没有检查中点条件。" })
  });
  const judgment = await request(`/api/session/${id}/judgment`, {
    method: "POST",
    body: JSON.stringify({ verdict: "不合理", reason: "JUDGE_SECOND：缺少全等证明，不能只看图形。" })
  });
  assert.equal(judgment.response.status, 200);
  assertStage(judgment.body.session, "transfer", ["transfer_pending"]);

  const wrong = await request(`/api/session/${id}/transfer`, {
    method: "POST",
    body: JSON.stringify({ text: "TRANSFER_WRONG：我只写出PM垂直QR，没有说明为什么。", answer: "TRANSFER_WRONG：只写结论。" })
  });
  assert.equal(wrong.response.status, 200);
  assert.equal(responseDecision(wrong.body), "retry");
  assertStage(wrong.body.session, "transfer", ["transfer_pending"]);

  const right = await request(`/api/session/${id}/transfer`, {
    method: "POST",
    body: JSON.stringify({
      text: "TRANSFER_RIGHT：PQ＝PR、QM＝MR，PM是公共边，所以两三角形全等，再得对应角相等。",
      answer: "TRANSFER_RIGHT：PQ＝PR、QM＝MR和PM＝PM，利用SSS证明全等。",
      imageData: onePixelPng
    })
  });
  assert.equal(right.response.status, 200);
  assert.equal(responseDecision(right.body), "pass");
  assertStage(right.body.session, "reflection", ["reflection_pending"]);

  const third = await request(`/api/session/${id}/transfer`, {
    method: "POST",
    body: JSON.stringify({ text: "不应在通过后再次提交", answer: "不应在通过后再次提交" })
  });
  assert.equal(third.response.status, 409);
});

test("完成反思后区分流程完成与辅助继续，保留五阶段证据", async () => {
  const { id } = await createConfirmedSession();
  await request(`/api/session/${id}/initial`, { method: "POST", body: JSON.stringify({ text: "ROOT_ERROR_RETRY：我需要帮助。" }) });
  for (const level of [1, 2, 3]) {
    await request(`/api/session/${id}/help`, { method: "POST", body: JSON.stringify({ text: `HELP_L${level}：请给第${level}级提示。` }) });
  }
  await finishChecked(id);
  await request(`/api/session/${id}/judgment`, { method: "POST", body: JSON.stringify({ verdict: "合理", reason: "JUDGE_FIRST：我暂时判断合理但依据不足。" }) });
  await finishChecked(id);
  await request(`/api/session/${id}/judgment`, { method: "POST", body: JSON.stringify({ verdict: "不合理", reason: "JUDGE_SECOND：仅凭等腰条件不能推出目标。" }) });
  await request(`/api/session/${id}/transfer`, { method: "POST", body: JSON.stringify({ text: "TRANSFER_WRONG：只写结论。", answer: "TRANSFER_WRONG：只写结论。" }) });
  await request(`/api/session/${id}/transfer`, { method: "POST", body: JSON.stringify({ text: "TRANSFER_RIGHT：用三边相等证明两三角形全等并推出对应角关系。", answer: "TRANSFER_RIGHT：用SSS证明全等。" }) });

  const reflection = await request(`/api/session/${id}/reflection`, {
    method: "POST",
    body: JSON.stringify({
      text: "我完成了四步反思。",
      selfWork: "我自己找到了等腰和中点提供的相等边。",
      aiHelp: "AI的三级提示让我想到用SSS和邻补角。",
      nextTime: "下次先列出已知关系，再匹配全等判定。"
    })
  });
  assert.equal(reflection.response.status, 200);
  assertStage(reflection.body.session, "completed", ["done"]);
  assert.equal(reflection.body.session.learningOutcome.flowCompleted, true);
  assert.equal(reflection.body.session.learningOutcome.status, "assisted");
  assert.equal(reflection.body.session.learningOutcome.stages.length, 5);
  assert.equal(reflection.body.summary.title, "本轮流程已完成");
  assert.equal(reflection.body.summary.learningOutcome.status, "assisted");
  assert.match(JSON.stringify(reflection.body), /selfWork|aiHelp|nextTime|反思|summary/);
  assert.equal(JSON.stringify(reflection.body).includes(fakeKey), false);
  const timeline = await request(`/api/session/${id}`);
  assert.equal(timeline.response.status, 200);
  assertStage(timeline.body.session, "completed", ["done"]);
  assert.ok(Array.isArray(timeline.body.events), "会话详情应保留五阶段事件时间线");
  assert.equal(timeline.body.session.learningOutcome.flowCompleted, true);
  assert.equal(timeline.body.session.learningOutcome.status, "assisted");
});

test("旧建题和任务码接口仍返回404", async () => {
  const removed = [
    ["GET", "/api/task?code=SJ2026"],
    ["GET", "/api/teacher/tasks"],
    ["GET", "/api/teacher/model-status"],
    ["GET", "/api/teacher/export.csv"],
    ["POST", "/api/teacher/task"],
    ["POST", "/api/teacher/task-draft"],
    ["POST", "/api/teacher/config"]
  ];
  for (const [method, path] of removed) {
    const result = await request(path, { method, body: method === "POST" ? JSON.stringify({}) : undefined });
    assert.equal(result.response.status, 404, `${method} ${path} 应返回404`);
  }
});

test("没有API密钥时识题明确失败且不伪装成演示成功", async () => {
  const noKeyPort = 4392;
  const noKeyDataDir = await mkdtemp(join(tmpdir(), "sijie-no-key-"));
  const noKeyChild = spawn(process.execPath, ["server.mjs"], {
    cwd: appCwd,
    env: {
      ...process.env,
      PORT: String(noKeyPort),
      DATA_DIR: noKeyDataDir,
      DEEPSEEK_API_KEY: "",
      DEEPSEEK_BASE_URL: fakeBaseUrl,
      DEEPSEEK_MODEL: modelName
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  noKeyChild.stdout.resume();
  noKeyChild.stderr.resume();
  const noKeyBase = `http://127.0.0.1:${noKeyPort}`;
  try {
    await waitForApp(noKeyBase);
    const result = await request("/api/problem/analyze", {
      method: "POST",
      body: JSON.stringify({ grade: "八年级", text: problemText })
    }, noKeyBase);
    assert.ok(result.response.status >= 400, "无密钥识题不能返回成功");
    assert.match(JSON.stringify(result.body), /API|密钥|配置|DeepSeek|连接/iu);
    assert.equal(fakeRequests.some(call => call.body?.messages?.some(message => flattenContent(message?.content).includes(problemText)) && call.authorization === "Bearer "), false);

    const configured = await request("/api/ai/config", {
      method: "POST",
      body: JSON.stringify({ apiKey: fakeKey })
    }, noKeyBase);
    assert.equal(configured.response.status, 200);
    assert.equal(configured.body.configured, true);
    assert.equal(JSON.stringify(configured.body).includes(fakeKey), false);

    const afterConfig = await request("/api/problem/analyze", {
      method: "POST",
      body: JSON.stringify({ grade: "八年级", text: problemText })
    }, noKeyBase);
    assert.equal(afterConfig.response.status, 200);
    assert.ok(extractProblem(afterConfig.body).problemText);

    const stored = await Promise.all([
      "problem-drafts.json",
      "tasks.json",
      "sessions.json",
      "events.jsonl"
    ].map(name => readFile(join(noKeyDataDir, name), "utf8")));
    assert.equal(stored.some(content => content.includes(fakeKey)), false, "网页填写的密钥不能写入运行数据");
  } finally {
    noKeyChild.kill("SIGTERM");
    await Promise.race([once(noKeyChild, "exit"), new Promise(resolve => setTimeout(resolve, 1000))]);
    await rm(noKeyDataDir, { recursive: true, force: true });
  }
});

async function finishChecked(id) {
  const current = await request(`/api/session/${id}`);
  if (current.body.session.stage === "judgment" || current.body.session.stage === "transfer") return;
  const result = await request(`/api/session/${id}/help`, { method: "POST", body: JSON.stringify({ action: "finish", text: "HELP_UNDERSTOOD：AD是公共边，所以AD等于AD。" }) });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.session.stage, "judgment");
}

test("先思选择卡点不伪造答案；理解声明和空按钮不跳阶段；教师可以查看证据", async () => {
  const { id } = await createConfirmedSession();
  const result = await request(`/api/session/${id}/initial`, { method: "POST", body: JSON.stringify({ stuckPoint: "不知道用哪个定理" }) });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.session.answers.initial.stuckPoint, "不知道用哪个定理");
  assert.equal(result.body.session.answers.initial.text, undefined);
  for (const text of ["", "我懂了"]) {
    const check = await request(`/api/session/${id}/help`, { method: "POST", body: JSON.stringify({ action: "finish", text }) });
    assert.equal(check.body.session.stage, "hint_level_1");
    assert.equal(check.body.evaluation.decision, "retry");
    assert.equal(check.body.session.completedHints.length, 0);
  }
  const help = await request(`/api/session/${id}/help`, { method: "POST", body: JSON.stringify({ action: "teacher", text: "我不知道公共边是什么意思" }) });
  assert.equal(help.body.session.answers.helpRequests.length, 1);
  const denied = await request("/api/teacher/sessions");
  assert.equal(denied.response.status, 403);
  const allowed = await request("/api/teacher/sessions", { headers: { "X-Teacher-Token": "test-teacher-token" } });
  assert.equal(allowed.response.status, 200);
  assert.match(JSON.stringify(allowed.body), /不知道公共边/);
  for (const path of ["/.env", "/data/runtime/sessions.json", "/server.mjs"]) assert.equal((await request(path)).response.status, 404);
});


test("本地服务支持无文字点选卡点、换点及仅点选提交教师看板", async () => {
  const { created, id } = await createConfirmedSession();
  assert.equal(created.body.task.helpOptions, undefined);
  const initial = await request(`/api/session/${id}/initial`, { method: "POST", body: JSON.stringify({ stuckPoint: "不知道从哪里开始" }) });
  assert.equal(initial.response.status, 200);
  const initialPicker = helpPicker(initial.body);
  assert.equal(initialPicker.round, 0);
  const [one] = initialPicker.options;
  const post = body => request(`/api/session/${id}/help`, { method: "POST", body: JSON.stringify(body) });
  const invalid = await post({ action: "hint", selectedStuckPointId: "forged" });
  assert.equal(invalid.response.status, 400);
  assert.equal(invalid.body.code, "INVALID_HELP_SELECTION");
  const firstHint = await post({ action: "hint", selectedStuckPointId: one.id });
  assert.equal(firstHint.response.status, 200);
  assert.equal(firstHint.body.evaluation.decision, "retry");
  assert.equal(firstHint.body.session.completedHints.length, 1);
  assert.equal(firstHint.body.session.answers.hint1.student.selectedStuckPoint.id, one.id);
  assert.equal(firstHint.body.session.answers.hint1.student.text, undefined);
  assert.equal(firstHint.body.session.answers.helpCheck, undefined);
  const round1 = helpPicker(firstHint.body);
  assert.equal(round1.round, 1);
  assert.ok(round1.options.length >= 3);
  assert.ok(round1.options.every(point => !initialPicker.options.some(previous => previous.id === point.id)));
  const oldId = await post({ action: "hint", selectedStuckPointId: one.id });
  assert.equal(oldId.response.status, 400);
  assert.equal(oldId.body.code, "INVALID_HELP_SELECTION");

  const secondHint = await post({ action: "hint", selectedStuckPointId: round1.options[0].id, text: "我还没想明白" });
  assert.equal(secondHint.response.status, 200);
  assert.equal(secondHint.body.session.completedHints.length, 2);
  assert.equal(secondHint.body.session.answers.hint2.student.text, "我还没想明白");
  const round2 = helpPicker(secondHint.body);
  assert.equal(round2.round, 2);
  assert.ok(round2.options.every(point => !round1.options.some(previous => previous.id === point.id)));

  const thirdHint = await post({ action: "hint", selectedStuckPointId: round2.options[0].id });
  assert.equal(thirdHint.response.status, 200);
  assert.equal(thirdHint.body.session.completedHints.length, 3);
  assert.equal(thirdHint.body.session.stage, "hint_level_3");
  const round3 = helpPicker(thirdHint.body);
  assert.equal(round3.round, 3);
  const restored = await request(`/api/session/${id}`);
  assert.equal(restored.response.status, 200);
  assert.equal(helpPicker(restored.body).round, 3);
  assert.deepEqual(helpPicker(restored.body).options.map(point => point.id), round3.options.map(point => point.id));

  const teacher = await post({ action: "teacher", selectedStuckPointId: round3.options[0].id });
  assert.equal(teacher.response.status, 200);
  assert.equal(teacher.body.session.answers.helpRequests[0].stuckPoint, round3.options[0].label);
  assert.equal(teacher.body.session.answers.helpRequests[0].text, undefined);
  assert.equal(teacher.body.session.answers.helpSelections.at(-1).id, round3.options[0].id);
  const summary = await request("/api/teacher/sessions", { headers: { "x-teacher-token": "test-teacher-token" } });
  assert.equal(summary.response.status, 200);
  assert.ok(JSON.stringify(summary.body).includes(round3.options[0].label));
});
