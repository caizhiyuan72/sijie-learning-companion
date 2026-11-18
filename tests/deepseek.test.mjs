import test from "node:test";
import assert from "node:assert/strict";
import { DeepSeekClient } from "../lib/deepseek.mjs";
import { sampleTask } from "../lib/sample-task.mjs";

const previous = {
  key: process.env.DEEPSEEK_API_KEY,
  baseUrl: process.env.DEEPSEEK_BASE_URL,
  model: process.env.DEEPSEEK_MODEL
};

process.env.DEEPSEEK_API_KEY = "test-only-key";
process.env.DEEPSEEK_BASE_URL = "http://127.0.0.1:4189";
process.env.DEEPSEEK_MODEL = "deepseek-v4-flash-vision-exp";

test.after(() => {
  for (const [name, value] of Object.entries({
    DEEPSEEK_API_KEY: previous.key,
    DEEPSEEK_BASE_URL: previous.baseUrl,
    DEEPSEEK_MODEL: previous.model
  })) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function response(content, { reasoning_content, finish_reason = "stop" } = {}) {
  const message = { content };
  if (reasoning_content !== undefined) message.reasoning_content = reasoning_content;
  return {
    ok: true,
    status: 200,
    async json() {
      return { choices: [{ message, finish_reason }] };
    }
  };
}

test("连续无效JSON会明确返回MODEL_JSON_INVALID且只做一次格式重试", async () => {
  let calls = 0;
  const client = new DeepSeekClient("", { fetch: async () => {
    calls += 1;
    return response("这不是JSON");
  }});
  await assert.rejects(
    client.callJson([{ role: "user", content: "测试" }]),
    error => error.code === "MODEL_JSON_INVALID" && /JSON/.test(error.message)
  );
  assert.equal(calls, 2);
});

test("reasoning_content不作为JSON候选，空content连续两次返回MODEL_EMPTY_CONTENT", async () => {
  let calls = 0;
  const client = new DeepSeekClient("", { fetch: async () => {
    calls += 1;
    return response("", { reasoning_content: JSON.stringify({ value: "推理过程不能当答案" }) });
  }});
  await assert.rejects(
    client.callJson([{ role: "user", content: "测试" }]),
    error => error.code === "MODEL_EMPTY_CONTENT"
  );
  assert.equal(calls, 2);
});

test("finish_reason为length时即使content是合法JSON也会翻倍预算重试", async () => {
  const requests = [];
  const client = new DeepSeekClient("", { fetch: async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return requests.length === 1
      ? response(JSON.stringify({ attempt: "截断候选" }), { finish_reason: "length" })
      : response(JSON.stringify({ attempt: "完整候选" }));
  }});
  const result = await client.callJson([{ role: "user", content: "测试" }], { maxTokens: 1800 });
  assert.deepEqual(result.value, { attempt: "完整候选" });
  assert.equal(result.attempt, 2);
  assert.deepEqual(requests.map(item => item.max_tokens), [1800, 3600]);
  for (const request of requests) assert.deepEqual(request.thinking, { type: "disabled" });
});

test("finish_reason连续为length时返回MODEL_OUTPUT_TRUNCATED并遵守8192上限", async () => {
  const requests = [];
  const client = new DeepSeekClient("", { fetch: async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return response(JSON.stringify({ value: "仍然截断" }), { finish_reason: "length" });
  }});
  await assert.rejects(
    client.callJson([{ role: "user", content: "测试" }], { maxTokens: 5000 }),
    error => error.code === "MODEL_OUTPUT_TRUNCATED"
  );
  assert.deepEqual(requests.map(item => item.max_tokens), [5000, 8192]);
  for (const request of requests) assert.deepEqual(request.thinking, { type: "disabled" });
});

test("模型超时返回MODEL_TIMEOUT而不是伪装成内容错误", async () => {
  let calls = 0;
  const client = new DeepSeekClient("", { fetch: async () => {
    calls += 1;
    const error = new Error("timed out");
    error.name = "TimeoutError";
    throw error;
  }});
  await assert.rejects(
    client.callJson([{ role: "user", content: "测试" }]),
    error => error.code === "MODEL_TIMEOUT" && error.status === 504 && /超时/.test(error.message)
  );
  assert.equal(calls, 2);
});

test("文本请求显式关闭thinking且空content返回MODEL_EMPTY_CONTENT", async () => {
  let request;
  const client = new DeepSeekClient("", { fetch: async (_url, options) => {
    request = JSON.parse(options.body);
    return response("");
  }});
  await assert.rejects(
    client.callText([{ role: "user", content: "测试" }]),
    error => error.code === "MODEL_EMPTY_CONTENT"
  );
  assert.deepEqual(request.thinking, { type: "disabled" });
});

test("连接检查遇到空content返回MODEL_EMPTY_CONTENT而不是伪装连接成功", async () => {
  const client = new DeepSeekClient("", { fetch: async () => response("") });
  await assert.rejects(
    client.checkConnection(),
    error => error.code === "MODEL_EMPTY_CONTENT"
  );
});

test("生成内容连续两次未通过核验会明确返回AI_VERIFICATION_FAILED", async () => {
  let calls = 0;
  const client = new DeepSeekClient("", { fetch: async (_url, options) => {
    calls += 1;
    const body = JSON.parse(options.body);
    const verifying = body.messages.some(message => String(message.content).includes("二次核验器"));
    return response(JSON.stringify(verifying ? { valid: false, issues: ["题图与题干不一致"] } : { value: "候选内容" }));
  }});
  await assert.rejects(
    client.generateVerified({
      purpose: "测试内容生成",
      messages: [{ role: "user", content: "生成" }],
      normalize: value => value,
      schema: "测试"
    }),
    error => error.code === "AI_VERIFICATION_FAILED" && /核验/.test(error.message) && /题图与题干不一致/.test(error.reviewReason)
  );
  assert.equal(calls, 4);
});

test("二次核验兼容模型把valid返回为字符串的情况", async () => {
  const client = new DeepSeekClient("", { fetch: async (_url, options) => {
    const body = JSON.parse(options.body);
    const verifying = body.messages.some(message => String(message.content).includes("二次核验器"));
    return response(JSON.stringify(verifying ? { valid: "true" } : { candidate: true }));
  }});
  client.setRuntimeKey("test-only-runtime-key");
  const result = await client.generateVerified({
    purpose: "字符串布尔值核验",
    messages: [{ role: "user", content: "生成" }],
    normalize: value => value,
    schema: "测试"
  });
  assert.equal(result.verification.valid, true);
});

test("几何任务会丢弃模型生成的非法可选图形标注", async () => {
  const candidate = structuredClone(sampleTask);
  candidate.transferTask.diagramSpec.labels = [{ text: "未知点", point: "Z" }];
  candidate.transferTask.diagramSpec.annotations = [{ kind: "equal_mark", points: ["P"] }];
  const client = new DeepSeekClient("", { fetch: async (_url, options) => {
    const body = JSON.parse(options.body);
    const verifying = body.messages.some(message => String(message.content).includes("二次核验器"));
    return response(JSON.stringify(verifying ? { valid: true } : candidate));
  }});
  client.setRuntimeKey("test-only-runtime-key");
  const result = await client.generateTask({
    analysis: {
      grade: "八年级",
      subject: "初中数学·几何证明",
      problemType: "geometry_proof",
      title: candidate.title,
      problemText: candidate.problemText,
      proofGoal: "AD⊥BC",
      diagramDescription: candidate.diagramDescription,
      isMathProblem: true,
      isGeometryProof: true,
      needsClarification: false
    }
  });
  assert.deepEqual(result.task.transferTask.diagramSpec.labels, []);
  assert.deepEqual(result.task.transferTask.diagramSpec.annotations, []);
  assert.equal(result.task.transferTask.diagramSpec.points.length, 4);
});

test("任务语义核验连续拒绝时会尝试一次结构化恢复", async () => {
  let calls = 0;
  const client = new DeepSeekClient("", { fetch: async (_url, options) => {
    calls += 1;
    const body = JSON.parse(options.body);
    const verifying = body.messages.some(message => String(message.content).includes("二次核验器"));
    return response(JSON.stringify(verifying ? { valid: false, issues: ["候选内容过于复杂"] } : sampleTask));
  }});
  client.setRuntimeKey("test-only-runtime-key");
  const result = await client.generateTask({
    analysis: {
      grade: sampleTask.grade,
      subject: sampleTask.subject,
      problemType: "geometry_proof",
      title: sampleTask.title,
      problemText: sampleTask.problemText,
      proofGoal: "AD⊥BC",
      diagramDescription: sampleTask.diagramDescription,
      isMathProblem: true,
      isGeometryProof: true,
      needsClarification: false
    }
  });
  assert.equal(result.mode, "live-recovery");
  assert.equal(result.verified, false);
  assert.equal(result.needsTeacherReview, true);
  assert.match(result.reviewReason, /候选内容过于复杂/);
  assert.equal(result.task.transferTask.diagramSpec.labels.length, 0);
  assert.equal(calls, 5);
});

test("任务生成会保留经过规范化的AI卡点选项", async () => {
  const candidate = structuredClone(sampleTask);
  candidate.helpOptions = [
    { id: "conditions", label: "我不知道题目给了哪些条件" },
    { id: "method", label: "我不知道该用哪个公式或定理" },
    { id: "start", label: "我不知道从哪里开始" }
  ];
  const client = new DeepSeekClient("", { fetch: async (_url, options) => {
    const body = JSON.parse(options.body);
    const verifying = body.messages.some(message => String(message.content).includes("二次核验器"));
    return response(JSON.stringify(verifying ? { valid: true } : candidate));
  }});
  client.setRuntimeKey("test-only-runtime-key");
  const result = await client.generateTask({
    analysis: {
      grade: candidate.grade,
      subject: candidate.subject,
      problemType: "geometry_proof",
      title: candidate.title,
      problemText: candidate.problemText,
      proofGoal: "AD⊥BC",
      diagramDescription: candidate.diagramDescription,
      isMathProblem: true,
      isGeometryProof: true,
      needsClarification: false
    }
  });
  assert.deepEqual(result.task.helpOptions.map(item => item.id), ["point-1", "point-2", "point-3"]);
  assert.equal(result.task.helpOptions[1].label, "我不知道该用哪个公式或定理");
});

test("结构化恢复未完成语义核验时清空AI卡点并让公开层使用通用选项", async () => {
  let calls = 0;
  const candidate = structuredClone(sampleTask);
  candidate.helpOptions = [
    { label: "我不知道题目给了哪些条件" },
    { label: "我不知道该用哪个公式或定理" },
    { label: "我不知道从哪里开始" }
  ];
  const client = new DeepSeekClient("", { fetch: async (_url, options) => {
    calls += 1;
    const body = JSON.parse(options.body);
    const verifying = body.messages.some(message => String(message.content).includes("二次核验器"));
    return response(JSON.stringify(verifying ? { valid: false, issues: ["候选内容过于复杂"] } : candidate));
  }});
  client.setRuntimeKey("test-only-runtime-key");
  const result = await client.generateTask({
    analysis: {
      grade: candidate.grade,
      subject: candidate.subject,
      problemType: "geometry_proof",
      title: candidate.title,
      problemText: candidate.problemText,
      proofGoal: "AD⊥BC",
      diagramDescription: candidate.diagramDescription,
      isMathProblem: true,
      isGeometryProof: true,
      needsClarification: false
    }
  });
  assert.equal(result.mode, "live-recovery");
  assert.equal(result.task.helpOptions, undefined);
  assert.equal(calls, 5);
});

test("同一次提示生成会返回规范化的下一轮卡点并携带最近提示历史", async () => {
  const requests = [];
  const client = new DeepSeekClient("", { fetch: async (_url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    const verifying = body.messages.some(message => String(message.content).includes("二次核验器"));
    return response(JSON.stringify(verifying
      ? { valid: true }
      : {
          action: "hint",
          message: "先指出题目中两组对应的数量关系。",
          nextHelpOptions: [
            { id: "model-1", label: "我不明白刚才提示里的数量关系" },
            { id: "model-2", label: "我不会把这个提示用回原题" },
            { id: "model-3", label: "我不知道下一步怎么检查" }
          ]
        }));
  }});
  client.setRuntimeKey("test-only-runtime-key");
  const result = await client.generateHint({
    task: {
      problemText: "甲数是乙数的2倍，求两数关系。",
      proofGoal: "说明两数关系",
      problemType: "word_problem",
      hints: [{ level: 1, content: "先找题目中的对应量" }]
    },
    session: {
      stage: "hint_level_1",
      completedHints: [],
      answers: {
        hint1: { reply: { message: "上一轮提示：先找对应量。" }, student: { selectedStuckPoint: { label: "我不知道题目给了哪些条件" } } },
        helpSelections: [{ id: "point-1", label: "我不知道题目给了哪些条件", hintLevel: 1 }]
      }
    },
    hint: { level: 1, content: "先找题目中的对应量" },
    selectedStuckPoint: { id: "point-1", label: "我不知道题目给了哪些条件" }
  });
  assert.deepEqual(result.nextHelpOptions.map(item => item.id), ["point-1", "point-2", "point-3"]);
  assert.equal(result.nextHelpOptions[0].label, "我不明白刚才提示里的数量关系");
  assert.equal(requests[0].max_tokens, 900);
  assert.match(requests[0].messages[0].content, /最近已给提示与点选历史/);
  assert.match(requests[0].messages[0].content, /上一轮提示/);
  assert.match(requests[0].messages[0].content, /我不知道题目给了哪些条件/);
});

test("状态只报告服务能力，不返回API密钥", async () => {
  const client = new DeepSeekClient("");
  const status = await client.status();
  assert.equal(status.configured, true);
  assert.equal(status.model, "deepseek-v4-flash-vision-exp");
  assert.equal(Object.hasOwn(status, "key"), false);
  assert.equal(JSON.stringify(status).includes("test-only-key"), false);
});

test("网页密钥只保存在服务进程内存且可清除", async () => {
  process.env.DEEPSEEK_API_KEY = "";
  const client = new DeepSeekClient("");
  client.setRuntimeKey("runtime-test-key-123456");
  const configured = await client.status();
  assert.equal(configured.configured, true);
  assert.equal(configured.keyStoredIn, "server-memory");
  assert.equal(JSON.stringify(configured).includes("runtime-test-key-123456"), false);
  client.clearRuntimeKey();
  assert.equal((await client.status()).configured, false);
});

test("作答判定提示允许关键证据通过，不把不完整当成错误", async () => {
  const requests = [];
  const client = new DeepSeekClient("", { fetch: async (_url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    const verifying = body.messages.some(message => String(message.content).includes("二次核验器"));
    return response(JSON.stringify(verifying
      ? { valid: true }
      : { decision: "pass", feedback: "关键关系正确，继续下一步。", confidence: 0.86 }));
  }});
  client.setRuntimeKey("test-only-evaluation-key");
  const result = await client.evaluateAnswer({
    task: { proofGoal: "证明AD⊥BC", learningContract: { acceptableEvidence: ["指出公共边"] } },
    session: { completedHints: [] },
    stage: "hint_level_1",
    kind: "help",
    answer: { text: "AD是公共边" }
  });
  assert.equal(result.decision, "pass");
  const systemPrompt = requests[0].messages.find(message => message.role === "system")?.content || "";
  assert.match(systemPrompt, /命中任一条正确的可接受证据/);
  assert.match(systemPrompt, /只写部分条件/);
  assert.match(systemPrompt, /只有明确数学错误/);
  assert.match(systemPrompt, /求助只要说出一个正确的关键关系即可通过/);
});

test("任务重新生成会携带具体校验原因，而不是重复同一错误请求", async () => {
  const requests = [];
  const client = new DeepSeekClient("", { fetch: async (_url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    return response(JSON.stringify(requests.length === 3 ? { valid: true } : { candidate: true }));
  }});
  client.setRuntimeKey("test-only-runtime-key");
  let normalizations = 0;
  await client.generateVerified({
    purpose: "任务生成", messages: [{ role: "user", content: "生成JSON任务" }],
    normalize(value) {
      if (++normalizations === 1) throw Object.assign(new Error("自由图形标注需要合法坐标。"), { code: "INVALID_DIAGRAM_SPEC" });
      return value;
    }
  });
  assert.equal(requests.length, 3);
  assert.match(requests[1].messages.at(-1).content, /自由图形标注需要合法坐标/);
});


test("模型认证、图片协议和模型配置错误不会被盲目重试，诊断不包含上游秘密", async () => {
  for (const [status, message, code] of [[401, "Bearer sk-private-user-secret", "MODEL_AUTH_FAILED"], [400, "image_url is unsupported", "MODEL_IMAGE_REJECTED"], [404, "unknown model", "MODEL_UNAVAILABLE"]]) {
    let calls = 0;
    const client = new DeepSeekClient("", { retryDelayMs: 0, fetch: async () => {
      calls++;
      return { ok: false, status, async json() { return { error: { message } }; } };
    }});
    client.setRuntimeKey("private-test-key-never-expose");
    await assert.rejects(client.generateVerified({ purpose: "题目识别", messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } }] }], normalize: value => value }), error => {
      assert.equal(error.code, code);
      assert.equal(error.step, "recognition");
      assert.equal(error.upstreamStatus, status);
      assert.equal(error.retryable, false);
      assert.ok(error.requestId);
      assert.ok(error.elapsedMs >= 0);
      assert.doesNotMatch(JSON.stringify(error), /private-user-secret|private-test-key|data:image/);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test("AI临时服务错误只重试一次且不附加JSON纠错指令", async () => {
  const requests = [];
  const client = new DeepSeekClient("", { retryDelayMs: 0, fetch: async (_url, options) => {
    requests.push(JSON.parse(options.body));
    if (requests.length === 1) return { ok: false, status: 503, async json() { return {}; } };
    return response('{"ok":true}');
  }});
  client.setRuntimeKey("test-only-runtime-key");
  const result = await client.callJson([{ role: "user", content: "题目" }], { purpose: "题目识别" });
  assert.equal(result.attempt, 2);
  assert.deepEqual(requests[0].messages, requests[1].messages);
  assert.equal(client.usage.retries, 1);
});

test("识别后核验失败的诊断步骤是verification而非图片识别", async () => {
  let calls = 0;
  const client = new DeepSeekClient("", { retryDelayMs: 0, fetch: async () => {
    calls++;
    return calls === 1 ? response('{"candidate":true}') : { ok: false, status: 403, async json() { return {}; } };
  }});
  client.setRuntimeKey("test-only-runtime-key");
  await assert.rejects(client.generateVerified({ purpose: "题目识别", messages: [], normalize: value => value }), error => error.step === "verification" && error.code === "MODEL_AUTH_FAILED");
  assert.equal(calls, 2);
});

test("持久化知识检索结果按请求注入与返回，停用后无静态知识回流", async () => {
  const requests = [];
  const ref = { id: "teacher-ratio", version: 3, title: "审核比例卡", reason: "题目知识点匹配" };
  let enabled = true;
  const client = new DeepSeekClient("", { knowledgeProvider: async () => enabled ? {
    cards: [{ title: "审核比例卡", principle: "先检查对应量及比例的适用条件" }],
    strategies: [{ title: "求助策略", principle: "只问一个条件" }], references: [ref]
  } : { cards: [], strategies: [], references: [] }, fetch: async (_url, options) => {
    const request = JSON.parse(options.body); requests.push(request);
    const verifying = request.messages.some(item => String(item.content).includes("二次核验器"));
    return response(JSON.stringify(verifying ? { valid: true } : { action: "question", message: "你能指出一组对应的量吗？" }));
  }});
  client.setRuntimeKey("test-only-runtime-key");
  const task = { problemText: "数量的比例关系", hints: [{ level: 1, content: "先找已知量" }] };
  const first = await client.generateHint({ task, session: { stage: "hint_level_1" }, studentText: "卡在比例关系" });
  assert.deepEqual(first.knowledgeReferences, [ref]);
  assert.match(requests[0].messages[0].content, /审核比例卡/);
  enabled = false;
  const second = await client.generateHint({ task, session: { stage: "hint_level_1" }, studentText: "卡在比例关系" });
  assert.deepEqual(second.knowledgeReferences, []);
  assert.doesNotMatch(requests[2].messages[0].content, /参考知识卡|审核比例卡/);
});

test("识别与核验共享总时限，提取耗尽时限后不再发送核验请求", async () => {
  let calls = 0;
  const client = new DeepSeekClient("", { retryDelayMs: 0, fetch: async () => {
    calls++;
    await new Promise(resolve => setTimeout(resolve, 8));
    return response('{"candidate":true}');
  }});
  client.setRuntimeKey("test-only-runtime-key");
  await assert.rejects(client.generateVerified({ purpose: "题目识别", messages: [], normalize: value => value, deadlineMs: 1 }), error => error.code === "MODEL_TIMEOUT" && error.step === "verification");
  assert.equal(calls, 1);
});


test("二次核验收到原图和原任务，不只检查候选JSON自洽", async () => {
  const requests = [];
  const client = new DeepSeekClient("", { fetch: async (_url, options) => {
    const body = JSON.parse(options.body); requests.push(body);
    return response(JSON.stringify(body.messages[0].content.includes("二次核验器") ? { valid: true } : { candidate: true }));
  }});
  client.setRuntimeKey("test-only-runtime-key");
  const source = [{ role: "system", content: "原题规则：只转录数字和单位" }, { role: "user", content: [{ type: "text", text: "读清楚数字" }, { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } }] }];
  await client.generateVerified({ purpose: "题目识别", messages: source, normalize: value => value });
  assert.ok(requests[1].messages.some(item => Array.isArray(item.content) && item.content.some(part => part.type === "image_url")));
  assert.ok(requests[1].messages.some(item => typeof item.content === "string" && item.content.includes("原题规则")));
  assert.match(requests[1].messages[0].content, /初中数学/);
  assert.match(requests[1].messages[0].content, /待核对的数据/);
});


test("判别建议出现连续多步计算时重新生成一个局部建议", async () => {
  let generated = 0;
  const client = new DeepSeekClient("", { fetch: async (_url, options) => {
    const body = JSON.parse(options.body);
    if (body.messages[0].content.includes("二次核验器")) return response('{"valid":true}');
    generated++;
    return response(JSON.stringify({ statement: generated === 1 ? "先在两边减5得到3x=15，再除3得到x=5。" : "可以在等式两边同时减去5。", correctVerdict: "合理", reason: "两边同时减去同一个数符合等式性质。" }));
  }});
  client.setRuntimeKey("test-only-runtime-key");
  const result = await client.generateJudgmentCard({ task: { problemText: "解方程3x+5=20" } });
  assert.equal(generated, 2);
  assert.equal(result.judgmentCard.statement, "可以在等式两边同时减去5。");
});

test("模型生成的题型保留小问与选项，作答核验收到迁移小问", async () => {
  const requests = [];
  const client = new DeepSeekClient("", { fetch: async (_url, options) => {
    const { messages } = JSON.parse(options.body);
    const prompt = messages[0].content;
    requests.push(prompt);
    if (prompt.includes("二次核验器")) return response('{"valid":true}');
    if (prompt.includes("判别题生成器")) {
      return response(JSON.stringify({ statement: "减 3 后得到 x＝8。", correctVerdict: "不合理", reason: "左边仍是 2x。", reasonChoice: { options: ["条件不足", "左边仍是 2x", "应当两边乘 2"], correctIndex: 1 } }));
    }
    if (prompt.includes("迁移题生成器")) {
      return response(JSON.stringify({ text: "3x＋2＝14。", focusPrompt: "两边减 2 后得到什么等式？", knowledgePoint: "等式的性质", referenceProof: "3x＝12", answerOutline: "3x＝12", stepChoice: null }));
    }
    return response('{"decision":"pass","feedback":"已写出关键一步。"}');
  }});
  client.setRuntimeKey("test-only-runtime-key");
  const task = { grade: "七年级", problemText: "解方程 2x＋3＝11。", proofGoal: "求 x", isMathProblem: true };
  const { judgmentCard } = await client.generateJudgmentCard({ task });
  assert.equal(judgmentCard.reasonChoice.correctOptionId, "option-2");
  const { transferTask } = await client.generateTransferTask({ task });
  assert.equal(transferTask.focusPrompt, "两边减 2 后得到什么等式？");
  assert.equal(transferTask.stepChoice, undefined);
  const result = await client.evaluateAnswer({ task: { ...task, transferTask }, stage: "transfer", kind: "transfer", answer: { text: "3x＝12" } });
  assert.equal(result.decision, "pass");
  assert.match(requests[4], /"focusPrompt":"两边减 2 后得到什么等式？"/u);
});

test("优先使用已核验的小问，旧任务在重新生成失败时可继续", async () => {
  const recoveryPrompts = [];
  const client = new DeepSeekClient("", { fetch: async (_url, options) => {
    const { messages } = JSON.parse(options.body);
    recoveryPrompts.push(messages.at(-1).content);
    return response(JSON.stringify(messages[0].content.includes("二次核验器")
      ? { valid: false, issues: ["新题缺少等式右边的数值"] }
      : { text: "不完整的变式", focusPrompt: "写出下一步。" }));
  }});
  client.setRuntimeKey("test-only-runtime-key");
  const saved = { text: "3x＋2＝14。", referenceProof: "3x＝12", focusPrompt: "两边减 2 后得到什么等式？" };
  const task = { isGeometryProof: false, taskReview: { status: "model_checked" }, transferTask: saved };
  assert.deepEqual((await client.generateTransferTask({ task })).transferTask, saved);
  assert.equal(recoveryPrompts.length, 0);
  const legacy = { text: saved.text, referenceProof: saved.referenceProof };
  assert.deepEqual((await client.generateTransferTask({ task: { ...task, transferTask: legacy } })).transferTask, legacy);
  assert.equal(recoveryPrompts.length, 4);
  assert.match(recoveryPrompts[2], /新题缺少等式右边的数值/);
});


test("反思三个独立文字字段进入模型，不再被误当成空作答", async () => {
  const requests = [];
  const client = new DeepSeekClient("", { fetch: async (_url, options) => {
    const body = JSON.parse(options.body); requests.push(body);
    return response(JSON.stringify(body.messages[0].content.includes("二次核验器") ? { valid: true } : { decision: "pass", feedback: "已记录这次反思。" }));
  }});
  client.setRuntimeKey("test-only-runtime-key");
  const result = await client.evaluateAnswer({ task: {}, session: {}, stage: "reflection", kind: "reflection", answer: { selfWork: "我先整理条件", aiHelp: "AI给了一个提示", nextTime: "下次先检查适用条件" } });
  assert.equal(result.decision, "pass");
  const text = requests[0].messages[1].content;
  assert.match(text, /我先整理条件/);assert.match(text, /AI给了一个提示/);assert.match(text, /下次先检查适用条件/);
  assert.match(requests[0].messages[0].content, /不能编造学生未写过/);
});
