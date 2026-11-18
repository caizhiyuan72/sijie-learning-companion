import test from "node:test";
import assert from "node:assert/strict";
import { normalizeDiagramSpec, isSafeDiagramSpec } from "../lib/diagram-spec.mjs";
import {
  normalizeProblemAnalysis,
  normalizeTaskInput,
  taskToEditor,
  taskToPublic
} from "../lib/task-schema.mjs";
import { sampleTask } from "../lib/sample-task.mjs";

test("选择题的显示位置随会话变化，重进同一会话保持一致", () => {
  const choice = { options: [
    { id: "option-1", text: "依据一" },
    { id: "option-2", text: "依据二" },
    { id: "option-3", text: "依据三" }
  ], correctOptionId: "option-1" };
  const task = { judgmentCard: { statement: "判断这一步", reasonChoice: choice }, transferTask: { text: "迁移小问", stepChoice: choice } };
  const publicView = tail => taskToPublic(task, { stage: "transfer", session: { id: `00000000-0000-4000-8000-${tail}` } });
  const first = publicView("000000000000");
  const second = publicView("000001000002");
  assert.equal(first.judgmentCard.reasonOptions[0].id, "option-1");
  assert.equal(second.judgmentCard.reasonOptions[2].id, "option-1");
  assert.equal(second.transferTask.stepOptions[1].id, "option-1");
  assert.deepEqual(second, publicView("000001000002"));
  assert.doesNotMatch(JSON.stringify(second), /correctOptionId/);
});

const safeDiagram = {
  width: 600,
  height: 420,
  points: [
    { id: "A", x: 300, y: 40 },
    { id: "B", x: 90, y: 350 },
    { id: "C", x: 510, y: 350 },
    { id: "D", x: 300, y: 350 }
  ],
  segments: [
    { from: "A", to: "B" },
    { from: "A", to: "C" },
    { from: "A", to: "D" },
    { from: "B", to: "C" }
  ],
  labels: [
    { text: "A", point: "A" },
    { text: "B", point: "B" },
    { text: "C", point: "C" },
    { text: "D", point: "D" }
  ],
  annotations: [{ kind: "equal_mark", points: ["A", "B"] }]
};

function input(overrides = {}) {
  return {
    grade: "八年级",
    title: "等腰三角形的证明",
    problemText: "在△ABC中，AB=AC，D是BC的中点，求证AD⊥BC。",
    proofGoal: "证明AD垂直BC",
    diagramDescription: "A在上方，B、D、C共线，连接AD。",
    diagramSpec: safeDiagram,
    learningGoal: "用全等三角形说明目标关系。",
    knownFacts: ["AB=AC", "BD=DC", "B、D、C共线"],
    knowledgePoints: ["三角形全等", "等腰三角形"],
    isGeometryProof: true,
    confidence: 0.92,
    hints: [
      { level: 1, kind: "question", content: "先找AD两侧的两个三角形。" },
      { level: 2, kind: "local_hint", content: "列出两组已知边和公共边。" },
      { level: 3, kind: "scaffold", content: "全等后能得到什么角关系？" }
    ],
    judgmentCard: {
      statement: "因为AB=AC，所以AD一定垂直BC。",
      correctVerdict: "不合理",
      reason: "还需要使用中点和公共边条件完成证明。",
      followUpQuestion: "这条建议遗漏了什么条件？"
    },
    transferTask: {
      text: "在△PQR中，PQ=PR，M是QR的中点，证明PM与QR的位置关系。",
      diagramDescription: "P在上方，Q、M、R共线，连接PM。",
      diagramSpec: safeDiagram,
      knowledgePoint: "等腰三角形的三线合一",
      referenceProof: "用三边对应相等证明两个三角形全等，再得到目标关系。",
      answerOutline: "找出两组相等边和公共边。"
    },
    referenceProof: "先证两个三角形全等，再结合邻补角得到直角。",
    learningContract: {
      coreIdea: "通过全等三角形连接已知条件和证明目标。",
      acceptableEvidence: ["说明两组对应边相等", "指出公共边"],
      commonMisconceptions: ["只凭图形看起来相等"],
      knowledgePoints: ["三角形全等"]
    },
    protectedPhrases: ["△ABD≌△ACD", "AD⊥BC"],
    ...overrides
  };
}

test("学生确认题稿后任务直接ready，不需要code或教师确认门槛", () => {
  const task = normalizeTaskInput(input());
  assert.equal(task.status, "ready");
  assert.equal(Object.hasOwn(task, "code"), false);
  assert.equal(Object.hasOwn(task, "teacherConfirmed"), false);
  assert.equal(task.isGeometryProof, true);
  assert.equal(task.needsClarification, false);
  assert.deepEqual(task.hints.map(item => item.dependencies), [[], ["h1"], ["h1", "h2"]]);
});

test("旧publish和任务码字段不会恢复教师端门槛", () => {
  const task = normalizeTaskInput(input({ publish: false, code: "旧任务码", teacherConfirmed: false }));
  assert.equal(task.status, "ready");
  assert.equal(Object.hasOwn(task, "code"), false);
  assert.equal(Object.hasOwn(task, "teacherConfirmed"), false);
});

test("编辑器兼容对象只保留可编辑学习内容，不暴露参考答案", () => {
  const editor = taskToEditor(normalizeTaskInput(input()));
  assert.equal(editor.hints.length, 3);
  assert.equal(editor.hints[1].content, "列出两组已知边和公共边。");
  assert.equal(Object.hasOwn(editor, "referenceProof"), false);
  assert.equal(Object.hasOwn(editor, "protectedPhrases"), false);
  assert.equal(Object.hasOwn(editor, "learningContract"), false);
});

test("识别结果会区分普通数学题与非数学题，并标记非数学题或低置信度为需要澄清", () => {
  const generalMath = normalizeProblemAnalysis({
    grade: "八年级",
    subject: "初中数学",
    problemType: "equation",
    problemText: "解方程2x+1=5",
    proofGoal: "求方程的解",
    isMathProblem: true,
    isGeometryProof: false,
    confidence: 0.9
  });
  assert.equal(generalMath.isMathProblem, true);
  assert.equal(generalMath.isGeometryProof, false);
  assert.equal(generalMath.needsClarification, false);
  assert.equal(generalMath.subject, "初中数学");

  const notMath = normalizeProblemAnalysis({
    grade: "八年级",
    problemText: "请写一首诗",
    isMathProblem: false,
    isGeometryProof: false,
    confidence: 0.9
  });
  assert.equal(notMath.isMathProblem, false);
  assert.equal(notMath.needsClarification, true);
  assert.match(notMath.clarification, /不是.*数学题/);

  const fuzzy = normalizeProblemAnalysis({
    problemText: "题目文字看不清",
    diagramDescription: "模糊图形",
    confidence: 0.2,
    isGeometryProof: true
  });
  assert.equal(fuzzy.needsClarification, true);
  assert.equal(fuzzy.confidence, 0.2);
});

test("识别稿允许学生确认时修改文字和证明目标", () => {
  const draft = normalizeProblemAnalysis(input());
  const edited = normalizeProblemAnalysis({
    problemText: "补充后的几何题文字",
    proofGoal: "证明新的角关系",
    diagramDescription: "补充后的图形关系",
    isGeometryProof: true
  }, draft);
  assert.equal(edited.problemText, "补充后的几何题文字");
  assert.equal(edited.proofGoal, "证明新的角关系");
  assert.equal(edited.diagramDescription, "补充后的图形关系");
  assert.equal(edited.id, draft.id);
});

test("普通数学题可以生成无图形的迁移任务", () => {
  const task = normalizeTaskInput(input({
    subject: "初中数学",
    problemType: "word_problem",
    title: "温度比例应用题",
    problemText: "土壤表面温度约40℃，青路面是土壤表面的11/8，草坪是青路面的3/5，求草坪温度。",
    proofGoal: "求草坪表面的温度",
    diagramDescription: "",
    diagramSpec: null,
    isMathProblem: true,
    isGeometryProof: false,
    transferTask: {
      text: "某商品先按原价的3/4出售，再打9折，求最后售价占原价的百分比。",
      diagramDescription: "",
      diagramSpec: null,
      knowledgePoint: "分数与百分数的连续运算",
      referenceProof: "先把每次变化转成乘法关系，再按顺序相乘。",
      answerOutline: "写出两次变化对应的乘法关系。"
    },
    learningContract: {
      coreIdea: "把文字条件转成数量关系，再按顺序计算。",
      acceptableEvidence: ["写出比例关系", "按顺序列式"],
      commonMisconceptions: [],
      knowledgePoints: ["分数与百分数"]
    }
  }));
  assert.equal(task.isMathProblem, true);
  assert.equal(task.isGeometryProof, false);
  assert.equal(task.transferTask.diagramSpec, null);
  assert.equal(task.subject, "初中数学");
});

test("任务必须生成恰好三级提示和完整判别卡", () => {
  assert.throws(() => normalizeTaskInput(input({ hints: ["只有一级"] })), /三级提示/);
  assert.throws(() => normalizeTaskInput(input({ judgmentCard: { statement: "建议" } })), /判别卡/);
});

test("公开任务按阶段隐藏提示、判别标准、迁移解析和参考证明", () => {
  const task = normalizeTaskInput(input());
  const initial = taskToPublic(task, { stage: "initial_thinking" });
  assert.equal(Object.hasOwn(initial, "hints"), false);
  assert.equal(Object.hasOwn(initial, "judgmentCard"), false);
  assert.equal(Object.hasOwn(initial, "transferTask"), false);
  assert.equal(Object.hasOwn(initial, "referenceProof"), false);
  assert.equal(Object.hasOwn(initial, "protectedPhrases"), false);
  assert.equal(Object.hasOwn(initial, "learningGoal"), false);
  assert.equal(Object.hasOwn(initial, "knowledgePoints"), false);
  assert.equal(Object.hasOwn(initial, "learningContract"), false);

  const judgment = taskToPublic(task, { stage: "judgment" });
  assert.equal(judgment.learningGoal, task.learningGoal);
  assert.deepEqual(judgment.knowledgePoints, task.knowledgePoints);
  assert.equal(judgment.judgmentCard.statement, task.judgmentCard.statement);
  assert.equal(Object.hasOwn(judgment.judgmentCard, "correctVerdict"), false);
  assert.equal(Object.hasOwn(judgment.judgmentCard, "reason"), false);
  assert.equal(Object.hasOwn(judgment, "transferTask"), false);
  assert.equal(Object.hasOwn(judgment, "referenceProof"), false);

  const transfer = taskToPublic(task, { stage: "transfer" });
  assert.equal(transfer.transferTask.text, task.transferTask.text);
  assert.equal(Object.hasOwn(transfer.transferTask, "referenceProof"), false);
  assert.equal(Object.hasOwn(transfer.transferTask, "answerOutline"), false);
  assert.equal(Object.hasOwn(transfer, "referenceProof"), false);

  const completed = taskToPublic(task, { stage: "completed", completed: true });
  assert.equal(completed.referenceProof, task.referenceProof);
});

test("迁移题支持条件变式并始终保留私有评分依据", () => {
  const task = normalizeTaskInput(input({
    transferTask: {
      text: "先判断去掉中点条件后能否推出垂直，再补回中点条件完成证明。",
      diagramDescription: "M在QR上，连接PM；只标出PQ=PR。",
      diagramSpec: safeDiagram,
      knowledgePoint: "等腰三角形三线合一的条件作用",
      variantType: "condition_change",
      conditionChange: "去掉QM=MR后先判断结论是否仍成立。",
      referenceProof: "仅有PQ=PR不足；补充QM=MR后可用SSS证明全等并得到垂直。",
      answerOutline: "评分要点：指出缺少中点条件；补回后列出三边相等、证明全等并说明邻补角。"
    }
  }));
  assert.equal(task.transferTask.variantType, "condition_change");
  assert.match(task.transferTask.conditionChange, /去掉/);
  assert.match(task.transferTask.answerOutline, /评分要点/);

  const oldTask = normalizeTaskInput(input({
    transferTask: {
      text: "旧版本迁移题",
      diagramDescription: "旧版本图形",
      diagramSpec: safeDiagram,
      knowledgePoint: "三角形全等",
      referenceProof: "旧版本参考证明。"
    }
  }));
  assert.equal(oldTask.transferTask.answerOutline, oldTask.transferTask.referenceProof);
});

test("重新保存旧任务时迁移题字段从已有任务回填", () => {
  const existing = normalizeTaskInput(input({
    transferTask: {
      text: "原迁移题",
      diagramDescription: "原迁移图形",
      diagramSpec: safeDiagram,
      knowledgePoint: "原知识点",
      referenceProof: "原参考证明。",
      answerOutline: "原评分依据。"
    }
  }));
  const updated = normalizeTaskInput({
    ...input({
      transferTask: { text: "修改后的迁移题" },
      transferText: "修改后的迁移题"
    }),
    // Simulate an editor sending only the changed transfer text.
    diagramSpec: undefined,
    transferDiagramDescription: undefined,
    transferKnowledgePoint: undefined,
    transferReferenceProof: undefined,
    transferAnswerOutline: undefined
  }, existing);
  assert.equal(updated.transferTask.text, "修改后的迁移题");
  assert.deepEqual(updated.transferTask.diagramSpec, existing.transferTask.diagramSpec);
  assert.equal(updated.transferTask.knowledgePoint, existing.transferTask.knowledgePoint);
  assert.equal(updated.transferTask.referenceProof, existing.transferTask.referenceProof);
  assert.equal(updated.transferTask.answerOutline, existing.transferTask.answerOutline);
});

test("默认示例迁移题是条件作用变式且可以通过任务规范化", () => {
  const task = normalizeTaskInput(sampleTask);
  assert.equal(task.transferTask.variantType, "condition_change");
  assert.match(task.transferTask.text, /只知道PQ.*能否推出PM⊥QR/);
  assert.match(task.transferTask.text, /再补充QM＝MR/);
  assert.match(task.transferTask.referenceProof, /PQ＝PR.*QM＝MR.*PM＝PM/s);
  assert.match(task.transferTask.answerOutline, /评分要点/);
  assert.ok(task.transferTask.diagramSpec);
});

test("迁移题图形只允许结构化点线数据并丢弃未知字段", () => {
  const diagram = normalizeDiagramSpec({ ...safeDiagram, extra: "drop me" });
  assert.equal(diagram.points.length, 4);
  assert.equal(Object.hasOwn(diagram, "raw"), false);
  assert.equal(Object.hasOwn(diagram, "extra"), false);
  assert.equal(isSafeDiagramSpec(diagram), true);
});

test("非法SVG、脚本、路径和越界点不能进入diagramSpec", () => {
  for (const bad of [
    { ...safeDiagram, svg: "<svg/>" },
    { ...safeDiagram, script: "alert(1)" },
    { ...safeDiagram, points: [{ id: "A", x: 1200, y: 20 }] },
    { ...safeDiagram, segments: [{ from: "A", to: "Z" }] }
  ]) {
    assert.equal(isSafeDiagramSpec(bad), false);
    assert.throws(() => normalizeDiagramSpec(bad), /图形|diagramSpec/);
  }
  assert.throws(() => normalizeTaskInput(input({ transferTask: {
    text: "迁移题",
    knowledgePoint: "全等三角形",
    referenceProof: "先证两个三角形全等。",
    diagramSpec: { ...safeDiagram, path: "M 0 0" }
  } })), /diagramSpec/);
});

test("题图路径只接受项目资源或临时上传路径", () => {
  assert.throws(
    () => normalizeTaskInput(input({ diagramPath: "https://example.com/problem.png" })),
    /题图只能使用项目资源/
  );
  assert.equal(
    normalizeTaskInput(input({ diagramPath: "/runtime-uploads/local.webp" })).diagramPath,
    "/runtime-uploads/local.webp"
  );
});


test("识题漏填目标时只能转录题面明确要求，不能高置信度误报完成", () => {
  const explicit = normalizeProblemAnalysis({ isMathProblem: true, isGeometryProof: false, problemText: "Solve for x: 3x + 5 = 20", confidence: 0.99, proofGoal: "", needsClarification: false });
  assert.equal(explicit.proofGoal, "求x的值");
  assert.equal(explicit.needsClarification, false);
  const missing = normalizeProblemAnalysis({ isMathProblem: true, isGeometryProof: false, problemText: "3x+5=20", confidence: 0.99, proofGoal: "", needsClarification: false });
  assert.equal(missing.proofGoal, "");
  assert.equal(missing.needsClarification, true);
  assert.match(missing.clarification, /目标/);
});

test("学生任务保留需复核标记但不暴露内部核验中的参考解析", () => {
  const task = { ...sampleTask, taskReview: { status: "structure_only", needsTeacherReview: true, reason: "参考解析：SECRET_REVIEW_REFERENCE 答案为x=5" } };
  for (const stage of ["initial_thinking", "hint_level_1", "judgment", "transfer"]) {
    const result = taskToPublic(task, { stage });
    assert.equal(result.taskReview.needsTeacherReview, true);
    assert.equal(JSON.stringify(result).includes("SECRET_REVIEW_REFERENCE"), false);
    assert.equal(JSON.stringify(result).includes("答案为x=5"), false);
  }
});
