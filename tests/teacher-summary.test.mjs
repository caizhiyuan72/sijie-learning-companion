import test from "node:test";
import assert from "node:assert/strict";
import { summarizeSession } from "../lib/teacher-summary.mjs";

const simulatedLabel = "团队制作的模拟作答，非真实学生数据";

test("摘要保留卡点、教师求助、学生原话、提示和核验追问", () => {
  const session = {
    id: "sim-session-001",
    anonymousId: "模拟-001",
    taskId: "sim-task-001",
    stage: "hint_level_3",
    createdAt: "2026-09-06T08:00:00.000Z",
    updatedAt: "2026-09-06T08:08:00.000Z",
    answers: {
      initial: {
        stuckPoint: "不知道用哪个定理",
        text: "我看见AB和AC相等，想比较两边的三角形。",
        source: "student"
      },
      helpRequests: [{ text: "我还是不知道第二步怎么写。", at: "2026-09-06T08:07:00.000Z" }],
      hint1: {
        student: { text: "我先找AD两侧的两个三角形。" },
        reply: { action: "hint", message: "先列出两组三角形的对应边。" }
      },
      hint2: {
        student: { text: "公共边是不是也要写？" },
        reply: { action: "hint", message: "把公共边也列入对应关系。" }
      },
      helpCheck: {
        attempts: [{
          text: "我懂了，可以继续。",
          evaluation: {
            decision: "retry",
            feedback: "还需要用自己的话说明依据。",
            coreIssue: "模型内部字段不应成为教师诊断",
            nextPrompt: "请说说这组三角形能用哪种条件证明全等。"
          },
          at: "2026-09-06T08:08:00.000Z"
        }]
      }
    }
  };
  const task = {
    id: "sim-task-001",
    title: "等腰三角形的证明",
    problemText: "团队制作的模拟题。",
    proofGoal: "证明AD垂直BC",
    knownFacts: ["AB＝AC", "D 是 BC 的中点"],
    diagramDescription: "D 在 BC 上，连接 AD。",
    diagramPath: "/runtime-uploads/private-original.png",
    referenceProof: "不应在精简教师摘要里展示的参考解析"
  };

  const summary = summarizeSession(session, task);

  assert.equal(summary.sessionId, "sim-session-001");
  assert.equal(summary.anonymousId, "模拟-001");
  assert.equal(summary.needsHelp, true);
  assert.equal(summary.helpRequested, true);
  assert.equal(summary.stuckPoint, "不知道用哪个定理");
  assert.deepEqual(summary.task.knownFacts, task.knownFacts);
  assert.equal(summary.task.diagramDescription, task.diagramDescription);
  assert.equal(summary.task.diagramPath, undefined);
  assert.equal(summary.helpRequests[0].text, "我还是不知道第二步怎么写。");
  assert.deepEqual(summary.hintsGiven.map(item => item.level), [1, 2]);
  assert.equal(summary.hintsGiven[0].student.text, "我先找AD两侧的两个三角形。");
  assert.equal(summary.hintsGiven[0].reply.text, "先列出两组三角形的对应边。");
  assert.equal(summary.helpCheck.attempts[0].student.text, "我懂了，可以继续。");
  assert.equal(summary.suggestedFollowUp, "请说说这组三角形能用哪种条件证明全等。");
  assert.equal(summary.studentQuotes.some(item => item.text === simulatedLabel), false);
  assert.equal(JSON.stringify(summary).includes("模型内部字段"), false);
  assert.equal(JSON.stringify(summary).includes("参考解析"), false);
  assert.ok(summary.trace.length >= 4);
});

test("摘要补全判别、迁移、反思和帮助状态，但不带参考答案或原始图片", () => {
  const secretImage = "data:image/png;base64,THIS_IMAGE_MUST_NOT_APPEAR";
  const secretReference = "SECRET_REFERENCE_ANSWER";
  const session = {
    id: "sim-session-later",
    anonymousId: "模拟-后续证据",
    taskId: "sim-task-later",
    stage: "completed",
    completedHints: ["h1", "h2"],
    assistance: { initial: false, help: true, judgment: false, transfer: true },
    createdAt: "2026-09-06T08:00:00.000Z",
    updatedAt: "2026-09-06T08:18:00.000Z",
    completedAt: "2026-09-06T08:18:00.000Z",
    answers: {
      helpRequests: [{ text: "第二步怎么写？" }],
      helpExit: { reason: "hints_exhausted", decision: "assisted", completedHintCount: 2 },
      judgment: {
        attempts: [{ verdict: "不合理", text: "只凭一组边不能推出垂直。", at: "2026-09-06T08:10:00.000Z" }],
        latest: { verdict: "不合理", text: "只凭一组边不能推出垂直。", at: "2026-09-06T08:10:00.000Z" },
        evaluation: { decision: "pass", feedback: "判断抓住了缺少条件。" }
      },
      transfer: {
        attempts: [{ text: "先找对应边，再说明两组三角形的关系。", at: "2026-09-06T08:15:00.000Z" }],
        latest: { text: "先找对应边，再说明两组三角形的关系。", at: "2026-09-06T08:15:00.000Z" },
        evaluation: { decision: "assisted", feedback: `迁移已记录。参考解析：${secretReference}` }
      },
      reflection: {
        selfWork: "我自己先找到了已知条件。",
        aiHelp: "提示让我注意公共边。",
        nextTime: "下次先列出对应关系。",
        nextTimeImage: { provided: true, mimeType: "image/png", bytes: 48 },
        text: secretImage
      }
    }
  };
  const summary = summarizeSession(session, {
    id: "sim-task-later",
    title: "等腰三角形的证明",
    problemType: "geometry_proof",
    knowledgePoints: ["三角形全等", "等腰三角形"],
    referenceProof: secretReference,
    transferTask: { referenceProof: secretReference }
  });

  assert.equal(summary.helpStatus.hintsUsed, 2);
  assert.equal(summary.helpStatus.teacherRequested, true);
  assert.equal(summary.helpStatus.assisted, true);
  assert.equal(summary.judgment.verdict, "不合理");
  assert.equal(summary.judgment.answer.text, "只凭一组边不能推出垂直。");
  assert.equal(summary.judgment.evaluation.decision, "pass");
  assert.equal(summary.transfer.answer.text, "先找对应边，再说明两组三角形的关系。");
  assert.equal(summary.transfer.evaluation.decision, "assisted");
  assert.equal(summary.reflection.selfWork.text, "我自己先找到了已知条件。");
  assert.equal(summary.reflection.aiHelp.text, "提示让我注意公共边。");
  assert.equal(summary.reflection.nextTime.image, true);
  assert.deepEqual(summary.task.knowledgePoints, ["三角形全等", "等腰三角形"]);
  assert.equal(summary.task.problemType, "geometry_proof");
  assert.equal(JSON.stringify(summary).includes(secretReference), false);
  assert.equal(JSON.stringify(summary).includes(secretImage), false);
  assert.equal(JSON.stringify(summary).includes("referenceProof"), false);
});

test("教师摘要会限制长文本并清理敏感内容", () => {
  const summary = summarizeSession({
    id: "sim-session-sanitized",
    stage: "reflection",
    answers: {
      reflection: {
        selfWork: "A".repeat(2000),
        aiHelp: "我的手机号是13812345678。"
      }
    }
  }, {});

  assert.equal(summary.reflection.selfWork.text.length, 1200);
  assert.equal(summary.reflection.aiHelp.text, "我的手机号是[手机号已隐藏]。");
});

test("只有学生选择卡点也会被标为留下了可观察关注信号", () => {
  const session = {
    id: "sim-session-002",
    anonymousId: "模拟-002",
    taskId: "sim-task-002",
    stage: "hint_level_1",
    answers: { initial: { stuckPoint: "找不到相等关系", source: "student" } }
  };
  const before = structuredClone(session);
  const summary = summarizeSession(session, {});

  assert.equal(summary.needsHelp, true);
  assert.equal(summary.helpRequested, false);
  assert.equal(summary.stuckPoint, "找不到相等关系");
  assert.equal(summary.studentQuotes[0].text, "找不到相等关系");
  assert.deepEqual(session, before);
});

test("学生完成求助后，历史卡点仍可见但不会继续排在当前关注列表", () => {
  const session = {
    id: "sim-session-completed",
    anonymousId: "模拟-完成",
    stage: "judgment",
    completedHints: ["h1", "h2"],
    answers: {
      initial: { stuckPoint: "不知道从哪里开始", text: "我不知道先看哪两个三角形。" },
      helpRequests: [{ text: "请老师看看我卡在哪里。" }],
      helpCheck: { attempts: [{ text: "我能说明公共边和中点条件了。", evaluation: { decision: "pass" } }] }
    }
  };
  const summary = summarizeSession(session, {});

  assert.equal(summary.needsHelp, false);
  assert.equal(summary.helpRequested, true);
  assert.equal(summary.stuckPoint, "不知道从哪里开始");
  assert.equal(summary.helpCheck.latest.evaluation.decision, "pass");
});

test("求助阶段在三级提示耗尽后仍保留当前关注信号", () => {
  const summary = summarizeSession({
    id: "sim-session-hints",
    anonymousId: "模拟-三级",
    stage: "hint_level_3",
    completedHints: ["h1", "h2", "h3"],
    answers: { initial: { text: "我找到了两组三角形。" } }
  }, {});

  assert.equal(summary.needsHelp, true);
  assert.equal(summary.helpRequested, false);
  assert.equal(summary.stuckPoint, "");
});

test("空会话返回稳定的可渲染摘要，不猜测学生状态", () => {
  const summary = summarizeSession({ id: "sim-session-empty", anonymousId: "模拟-空" }, {});

  assert.equal(summary.needsHelp, false);
  assert.equal(summary.helpRequested, false);
  assert.equal(summary.stuckPoint, "");
  assert.deepEqual(summary.helpRequests, []);
  assert.deepEqual(summary.hintsGiven, []);
  assert.deepEqual(summary.helpCheck.attempts, []);
  assert.equal(summary.suggestedFollowUp, "请学生指出当前已知条件、证明目标和已经尝试的下一步。");
  assert.deepEqual(summary.trace, []);
});

test("图片只保留存在证据，不把原始数据带进教师摘要", () => {
  const secretImage = "data:image/png;base64,SHOULD_NOT_APPEAR";
  const summary = summarizeSession({
    id: "sim-session-image",
    anonymousId: "模拟-图片",
    answers: {
      initial: { image: { provided: true, mimeType: "image/png", bytes: 68 } },
      helpRequests: [{ image: { provided: true }, at: "2026-09-06T08:00:00.000Z" }],
      hint1: { student: { imageData: secretImage }, reply: { message: "先找两组三角形。" } }
    }
  }, {});

  assert.equal(JSON.stringify(summary).includes(secretImage), false);
  assert.equal(summary.studentQuotes.some(item => item.image === true), true);
  assert.equal(summary.hintsGiven[0].student.text, "（图片作答，原图未随摘要保存）");
});

test("点选卡点作为独立证据保留，不伪造成学生原话", () => {
  const summary = summarizeSession({
    id: "sim-session-selection",
    stage: "hint_level_2",
    answers: {
      initial: { stuckPoint: "先思阶段的旧卡点" },
      helpSelections: [
        { id: "point-1", label: "不会把题目条件列成关系", at: "2026-09-06T08:01:00.000Z" },
        { id: "point-2", label: "不知道从哪一步开始", at: "2026-09-06T08:03:00.000Z" }
      ],
      hint1: {
        student: { selectedStuckPoint: { id: "point-1", label: "不会把题目条件列成关系" } },
        reply: { message: "先圈出题目中的数量关系。" }
      },
      hint2: {
        student: { selectedStuckPoint: { id: "point-2", label: "不知道从哪一步开始" }, text: "我先试着找已知量。" },
        reply: { message: "先写一条你能确定的关系。" }
      }
    }
  }, {});

  assert.equal(summary.stuckPoint, "不知道从哪一步开始");
  assert.equal(summary.initialStuckPoint, "先思阶段的旧卡点");
  assert.deepEqual(summary.helpSelections.map(item => item.label), ["不会把题目条件列成关系", "不知道从哪一步开始"]);
  assert.equal(summary.hintsGiven[0].selectedStuckPoint.label, "不会把题目条件列成关系");
  assert.equal(summary.hintsGiven[0].student, undefined);
  assert.equal(summary.hintsGiven[1].student.text, "我先试着找已知量。");
  assert.equal(summary.studentQuotes.some(item => item.text === "不会把题目条件列成关系"), false);
  assert.equal(summary.trace.some(item => item.type === "point_selection" && item.selectedStuckPoint.label === "不知道从哪一步开始"), true);
});

test("教师求助中的点选卡点也能作为当前卡点且与原话分开", () => {
  const summary = summarizeSession({
    id: "sim-session-teacher-selection",
    stage: "hint_level_1",
    answers: {
      helpRequests: [{
        selectedStuckPoint: { id: "point-3", label: "不知道用哪个公式" },
        at: "2026-09-06T08:05:00.000Z"
      }]
    }
  }, {});

  assert.equal(summary.stuckPoint, "不知道用哪个公式");
  assert.equal(summary.helpSelections[0].label, "不知道用哪个公式");
  assert.deepEqual(summary.studentQuotes, []);
  assert.equal(summary.helpRequests[0].selectedStuckPoint.label, "不知道用哪个公式");
});

test("权威点选历史保留A-B-A及时间和提示级别，当前卡点取最后一次", () => {
  const summary = summarizeSession({
    id: "sim-session-aba",
    stage: "hint_level_3",
    answers: {
      helpSelections: [
        { id: "point-a", label: "不会列关系", at: "2026-09-06T08:01:00.000Z", hintLevel: 1 },
        { id: "point-b", label: "不知道从哪一步开始", at: "2026-09-06T08:02:00.000Z", hintLevel: 2 },
        { id: "point-a", label: "不会列关系", at: "2026-09-06T08:03:00.000Z", hintLevel: 3 }
      ]
    }
  }, {});

  assert.deepEqual(summary.helpSelections.map(item => [item.id, item.label, item.at, item.hintLevel]), [
    ["point-a", "不会列关系", "2026-09-06T08:01:00.000Z", 1],
    ["point-b", "不知道从哪一步开始", "2026-09-06T08:02:00.000Z", 2],
    ["point-a", "不会列关系", "2026-09-06T08:03:00.000Z", 3]
  ]);
  assert.equal(summary.stuckPoint, "不会列关系");
  assert.equal(summary.studentQuotes.some(item => item.text === "不会列关系"), false);
});

test("旧记录从提示和教师求助补全时按时间取较新的教师点选", () => {
  const summary = summarizeSession({
    id: "sim-session-legacy-order",
    stage: "hint_level_2",
    answers: {
      hint1: {
        at: "2026-09-06T08:01:00.000Z",
        student: { selectedStuckPoint: { id: "point-a", label: "不会列关系" } },
        reply: { message: "先找出条件。" }
      },
      helpRequests: [{
        at: "2026-09-06T08:03:00.000Z",
        selectedStuckPoint: { id: "point-b", label: "不知道从哪一步开始" }
      }]
    }
  }, {});

  assert.deepEqual(summary.helpSelections.map(item => item.label), ["不会列关系", "不知道从哪一步开始"]);
  assert.equal(summary.stuckPoint, "不知道从哪一步开始");
});
