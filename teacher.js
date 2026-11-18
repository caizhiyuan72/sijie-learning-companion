const STAGE_LABELS = Object.freeze({
  initial_thinking: "先思",
  help: "求助",
  judgment: "判别",
  transfer: "迁移",
  reflection: "反思",
  completed: "已完成"
});

const DECISION_LABELS = Object.freeze({
  pass: "本轮通过",
  retry: "需要再解释",
  clearer_input: "需要更清楚的表达",
  assisted: "在帮助下继续"
});

const PROBLEM_LABELS = Object.freeze({
  geometry_proof: "几何证明", geometry: "几何", equation: "方程", inequality: "不等式",
  word_problem: "应用题", calculation: "计算题", algebra: "代数", function: "函数",
  statistics: "统计", probability: "概率", math_problem: "数学题"
});

const TRACE_LABELS = Object.freeze({ point_selection: "点选卡点", hint: "查看提示", teacher_request: "向老师求助", help_check: "理解核验" });
const DEFAULT_FILTERS = Object.freeze({ attention: "all", stage: "all", problemType: "all", stuckPoint: "all" });
const SESSIONS_PER_PAGE = 12;

const state = {
  token: "",
  summaries: [],
  loaded: false,
  loading: false,
  knowledge: [],
  selectedKnowledgeId: "",
  filters: { ...DEFAULT_FILTERS },
  visibleSummaries: [],
  page: 0,
  detailIndex: -1
};

const $ = selector => document.querySelector(selector);

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}

function text(value, fallback = "") {
  if (Array.isArray(value)) return value.map(item => text(item)).filter(Boolean).join("；") || fallback;
  if (value && typeof value === "object") return text(value.text || value.message || value.content || value.label, fallback);
  const result = String(value ?? "").trim();
  return result || fallback;
}

function dateLabel(value) {
  if (!value) return "时间未记录";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间未记录" : date.toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "short" });
}

function summariesFromPayload(payload) {
  return Array.isArray(payload?.sessions) ? payload.sessions.filter(item => item && typeof item === "object") : [];
}

function stageKey(value) {
  const raw = text(value).toLowerCase();
  if (!raw) return "unknown";
  if (/help|hint|求助/u.test(raw)) return "help";
  if (/initial|先思/u.test(raw)) return "initial_thinking";
  if (/judgment|判别/u.test(raw)) return "judgment";
  if (/transfer|迁移/u.test(raw)) return "transfer";
  if (/reflection|反思/u.test(raw)) return "reflection";
  if (/completed|complete|已完成/u.test(raw)) return "completed";
  return raw;
}

function stageLabel(value) {
  const stage = stageKey(value);
  return Object.hasOwn(STAGE_LABELS, stage) ? STAGE_LABELS[stage] : "未记录阶段";
}

function decisionLabel(value) {
  const decision = text(value).toLowerCase();
  return Object.hasOwn(DECISION_LABELS, decision) ? DECISION_LABELS[decision] : "待复核";
}

function topicLabel(summary) {
  const value = text(summary?.task?.problemType);
  const key = value.toLowerCase();
  if (Object.hasOwn(PROBLEM_LABELS, key)) return PROBLEM_LABELS[key];
  return /\p{Script=Han}/u.test(value) ? value : "其他数学题";
}

function latestSelection(summary) {
  return Array.isArray(summary.helpSelections) ? summary.helpSelections.at(-1) : null;
}

function stuckLabel(summary) {
  return text(latestSelection(summary)?.label || summary.stuckPoint);
}

function summaryNeedsAttention(summary) {
  return summary?.needsHelp === true;
}

function sortSummaries(summaries) {
  return [...summaries].sort((a, b) => {
    const attention = Number(summaryNeedsAttention(b)) - Number(summaryNeedsAttention(a));
    if (attention) return attention;
    if (summaryNeedsAttention(a) && Boolean(a.helpRequested) !== Boolean(b.helpRequested)) return Number(Boolean(b.helpRequested)) - Number(Boolean(a.helpRequested));
    const left = Date.parse(a?.updatedAt || a?.createdAt || 0) || 0;
    const right = Date.parse(b?.updatedAt || b?.createdAt || 0) || 0;
    return right - left;
  });
}

function quoteMarkup(quoteValue, fallbackSource = "学生原话") {
  if (!quoteValue) return "";
  const source = text(quoteValue.source, fallbackSource);
  const quoteText = text(quoteValue.text, "（未记录文字）");
  return `<blockquote class="teacher-quote"><small>${escapeHtml(source)}${quoteValue.at ? ` · ${escapeHtml(dateLabel(quoteValue.at))}` : ""}</small>${escapeHtml(quoteText)}</blockquote>`;
}

function requestsMarkup(requests) {
  const list = Array.isArray(requests) ? requests : [];
  if (!list.length) return `<p class="teacher-empty">学生尚未提交教师求助。</p>`;
  return list.map((item, index) => `<div class="teacher-request"><small>第${escapeHtml(item.index || index + 1)}次${item.at ? ` · ${escapeHtml(dateLabel(item.at))}` : ""}</small>${item.selectedStuckPoint ? `<p><strong>学生点选的卡点：</strong>${escapeHtml(text(item.selectedStuckPoint.label, "（未记录标签）"))}</p>` : ""}${item.text ? `<p><strong>教师求助原话：</strong>${escapeHtml(text(item.text, item.image ? "（图片求助）" : "（未记录文字）"))}</p>` : (!item.selectedStuckPoint ? `<p>${escapeHtml(text(item.text, item.image ? "（图片求助）" : "（未记录文字）"))}</p>` : "")}${item.stuckPoint ? `<small>记录的卡点：${escapeHtml(item.stuckPoint)}</small>` : ""}</div>`).join("");
}

function selectionsMarkup(selections) {
  const list = Array.isArray(selections) ? selections : [];
  if (!list.length) return `<p class="teacher-empty">学生还没有点选具体卡点。</p>`;
  return `<ul class="teacher-selection-list">${list.map((item, index) => `<li><span>第${index + 1}次</span><strong>${escapeHtml(text(item.label, "（未记录标签）"))}</strong>${item.at ? `<small>${escapeHtml(dateLabel(item.at))}</small>` : ""}</li>`).join("")}</ul>`;
}

function hintsMarkup(hints) {
  const list = Array.isArray(hints) ? hints : [];
  if (!list.length) return `<p class="teacher-empty">还没有记录到逐级提示。</p>`;
  return list.map(item => {
    const level = Number(item.level) || "?";
    const student = item.student ? quoteMarkup(item.student, `第${level}级提示前学生`) : `<p class="teacher-empty">学生原话未记录。</p>`;
    const selected = item.selectedStuckPoint ? `<p><strong>学生点选的卡点：</strong>${escapeHtml(text(item.selectedStuckPoint.label, "（未记录标签）"))}</p>` : "";
    const reply = item.reply ? `<small>思阶已给提示</small><p>${escapeHtml(text(item.reply.text || item.reply.message || item.reply, "（提示内容未记录）"))}</p>` : `<small>思阶提示内容未记录。</small>`;
    return `<div class="teacher-hint"><span class="teacher-hint-level" aria-label="第${escapeHtml(level)}级提示">${escapeHtml(level)}</span><div>${selected}${student}${reply}</div></div>`;
  }).join("");
}

function quotesMarkup(quotes) {
  const list = Array.isArray(quotes) ? quotes : [];
  if (!list.length) return `<p class="teacher-empty">暂未记录学生原话。</p>`;
  return list.map(item => quoteMarkup(item)).join("");
}

function traceItemMarkup(item, index) {
  const label = Object.hasOwn(TRACE_LABELS, item.type) ? TRACE_LABELS[item.type] : stageLabel(item.stage);
  const student = item.student ? quoteMarkup(item.student) : item.text ? quoteMarkup({ text: item.text }) : "";
  const reply = item.reply ? quoteMarkup(item.reply, "思阶") : "";
  const stuck = item.stuckPoint ? `<p><strong>卡点：</strong>${escapeHtml(item.stuckPoint)}</p>` : "";
  const selected = item.selectedStuckPoint ? `<p><strong>学生点选的卡点：</strong>${escapeHtml(text(item.selectedStuckPoint.label, "（未记录标签）"))}</p>` : "";
  const evaluation = evaluationMarkup(item.evaluation);
  return `<div class="teacher-trace-item"><small>${index + 1}. ${escapeHtml(label)}${item.at ? ` · ${escapeHtml(dateLabel(item.at))}` : ""}</small>${selected}${stuck}${student}${reply}${evaluation}</div>`;
}

function traceMarkup(trace) {
  const list = Array.isArray(trace) ? trace : [];
  if (!list.length) return `<p class="teacher-empty">暂无可展开的先思和求助轨迹。</p>`;
  const dated = list.filter(item => Date.parse(item.at)).sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
  return [...dated, ...list.filter(item => !Date.parse(item.at))].map(traceItemMarkup).join("");
}

function helpCheckMarkup(helpCheck) {
  const attempts = Array.isArray(helpCheck?.attempts) ? helpCheck.attempts : [];
  if (!attempts.length) return `<p class="teacher-empty">暂无理解核验记录。</p>`;
  return attempts.map(item => {
    const student = item.student ? quoteMarkup(item.student, "核验时学生") : "";
    const decision = item.evaluation?.decision ? `<small>记录结果：${escapeHtml(({pass:"已通过",retry:"需要再解释",clearer_input:"需要更清楚的表达",assisted:"在帮助下继续"})[item.evaluation.decision] || "待复核")}</small>` : "";
    const nextPrompt = item.evaluation?.nextPrompt ? `<p><strong>当时追问：</strong>${escapeHtml(item.evaluation.nextPrompt)}</p>` : "";
    return `<div class="teacher-request">${student}${decision}${nextPrompt}</div>`;
  }).join("");
}

function evaluationMarkup(evaluation) {
  if (!evaluation || typeof evaluation !== "object") return "";
  const decision = text(evaluation.decision);
  const feedback = text(evaluation.feedback);
  const nextPrompt = text(evaluation.nextPrompt);
  if (!decision && !feedback && !nextPrompt) return "";
  return `<div class="teacher-evaluation">${decision ? `<small>记录结果：${escapeHtml(decisionLabel(decision))}</small>` : ""}${feedback ? `<p>${escapeHtml(feedback)}</p>` : ""}${nextPrompt ? `<p><strong>下一步追问：</strong>${escapeHtml(nextPrompt)}</p>` : ""}</div>`;
}

function stageAnswerMarkup(answer, { label, empty = "暂未记录" } = {}) {
  if (!answer || typeof answer !== "object" || (!answer.answer && !answer.verdict && !answer.evaluation)) return `<p class="teacher-empty">${escapeHtml(empty)}</p>`;
  const attempts = Number(answer.attempts);
  const attemptLabel = Number.isFinite(attempts) && attempts > 0 ? `<small>提交${attempts}次</small>` : "";
  const verdict = answer.verdict ? `<p><strong>学生判断：</strong>${escapeHtml(text(answer.verdict))}</p>` : "";
  const quote = answer.answer ? quoteMarkup(answer.answer, label) : "";
  return `${attemptLabel}${verdict}${quote}${evaluationMarkup(answer.evaluation)}`;
}

function reflectionMarkup(reflection) {
  if (!reflection || typeof reflection !== "object") return `<p class="teacher-empty">尚未留下反思。</p>`;
  const fields = [
    ["selfWork", "我自己完成的部分"],
    ["aiHelp", "学生记录的AI帮助"],
    ["nextTime", "下次策略"],
    ["note", "反思补充"]
  ];
  const content = fields
    .filter(([key]) => reflection[key])
    .map(([key, label]) => quoteMarkup(reflection[key], label))
    .join("");
  return content || `<p class="teacher-empty">尚未留下反思。</p>`;
}

function helpStatusMarkup(status) {
  const value = status && typeof status === "object" ? status : {};
  const hintsUsed = Number(value.hintsUsed);
  const hintText = Number.isFinite(hintsUsed) ? `${hintsUsed} 次` : "未记录";
  const requestText = value.teacherRequested ? `已提交教师求助${Number(value.teacherRequestCount) > 1 ? ` ${value.teacherRequestCount} 次` : ""}` : "未提交教师求助";
  const assistedText = value.assisted ? "本轮记录为在帮助下继续" : "未记录为在帮助下继续";
  const exitReasons = { self_declared: "学生表示理解后继续", hints_exhausted: "完成提示后继续", explicit_button: "学生确认后继续", understanding_signal: "解释后继续" };
  const exitText = value.exitReason ? (exitReasons[value.exitReason] || "已记录继续方式") : "尚未记录离开求助方式";
  return `<div class="teacher-status-list">
    <div><span>已用提示次数</span><strong>${escapeHtml(hintText)}</strong></div>
    <div><span>教师介入请求</span><strong>${escapeHtml(requestText)}</strong></div>
    <div><span>帮助标记</span><strong>${escapeHtml(assistedText)}</strong></div>
    <div><span>求助出口</span><strong>${escapeHtml(exitText)}</strong></div>
  </div>`;
}

function learningOutcome(summary) {
  const raw = summary?.learningOutcome && typeof summary.learningOutcome === "object" ? summary.learningOutcome : null;
  if (!raw) return {
    tone: "review",
    label: "需复核",
    reason: "当前记录没有统一学习结果标记；完成态不等于掌握。",
    needsTeacherReview: false,
    reviewReason: "",
    stages: []
  };
  const status = text(raw.status || raw.code || raw.result).toLowerCase().replace(/[\s-]+/g, "_");
  const labels = {
    independent_pass: "独立通过",
    independent: "独立通过",
    recognized: "点选正确",
    passed_independently: "独立通过",
    independent_completed: "独立通过",
    assisted_continue: "辅助继续",
    assisted: "辅助继续",
    helped: "辅助继续",
    pending: "尚未验证",
    needs_review: "需教师复核",
    review: "需教师复核",
    review_required: "需教师复核",
    not_recorded: "尚未验证",
    unknown: "尚未验证"
  };
  const review = raw.taskReview && typeof raw.taskReview === "object"
    ? raw.taskReview
    : raw.review && typeof raw.review === "object" ? raw.review : {};
  const needsTeacherReview = raw.needsTeacherReview === true || review.needsTeacherReview === true;
  const isIndependentStatus = ["independent_pass", "independent", "passed_independently", "independent_completed"].includes(status);
  const isAssisted = ["assisted_continue", "assisted", "helped"].includes(status);
  // An independent result with an unresolved task review must never be shown
  // as independently trusted. Assisted remains visibly assisted, while the
  // separate review note below preserves the content-validation warning.
  const tone = isIndependentStatus && !needsTeacherReview ? "independent" : isAssisted ? "assisted" : "review";
  const fallbackLabel = tone === "independent" ? "独立通过" : tone === "assisted" ? "辅助继续" : "需教师复核";
  const label = isIndependentStatus && needsTeacherReview ? "需教师复核" : labels[status] || text(raw.label || raw.title, fallbackLabel);
  const stages = Array.isArray(raw.stages) ? raw.stages.map(stage => {
    const source = stage && typeof stage === "object" ? stage : {};
    const key = text(source.key || source.stage).toLowerCase().replace(/[\s-]+/g, "_");
    const stageStatus = text(source.status).toLowerCase().replace(/[\s-]+/g, "_");
    const stageLabels = {
      independent: "独立通过",
      recognized: "点选正确",
      assisted: "辅助继续",
      pending: "尚未验证",
      review_required: "需教师复核",
      not_recorded: "尚未验证",
      unknown: "尚未验证"
    };
    return {
      label: text(source.label, STAGE_LABELS[key] || key || "未标记阶段"),
      statusLabel: text(source.statusLabel, stageLabels[stageStatus] || "尚未验证"),
      reason: text(source.reason, "该阶段尚未记录足够的核验依据。")
    };
  }).filter(item => item.label) : [];
  const reviewReason = needsTeacherReview
    ? text(review.reason || review.reviewReason || raw.reviewReason, "任务内容需要教师复核。")
    : "";
  return {
    tone,
    label,
    reason: text(raw.reason || raw.description || raw.explanation || raw.message, tone === "independent"
      ? "当前记录显示关键步骤由学生独立完成；仍不等同于长期掌握。"
      : tone === "assisted" ? "当前记录显示在提示或帮助下继续；请结合迁移和反思人工判断。" : "当前记录需要教师结合原话和过程证据复核。"),
    needsTeacherReview,
    reviewReason,
    stages
  };
}

function learningOutcomeMarkup(summary) {
  const outcome = learningOutcome(summary);
  const stagesMarkup = outcome.stages.length
    ? `<div class="teacher-status-list"><div><span>五阶段核验</span><strong>过程证据</strong></div>${outcome.stages.map(stage => `<div><span>${escapeHtml(stage.label)}</span><strong>${escapeHtml(stage.statusLabel)}<small>${escapeHtml(stage.reason)}</small></strong></div>`).join("")}</div>`
    : "";
  const reviewMarkup = outcome.needsTeacherReview
    ? `<div class="teacher-evaluation"><small>内容核验标记：需教师复核</small><p>${escapeHtml(outcome.reviewReason)}</p></div>`
    : "";
  return `<section class="teacher-evidence teacher-outcome is-${outcome.tone}"><h4>学习结果标记（不等同掌握）</h4><p><strong>${escapeHtml(outcome.label)}</strong></p><p>${escapeHtml(outcome.reason)}</p>${reviewMarkup}${stagesMarkup}</section>`;
}

function problemMarkup(task = {}) {
  const statement = text(task.problemText);
  const hasDetails = statement.length > 160 || task.knownFacts?.length || task.proofGoal || task.diagramDescription;
  const preview = statement.length > 160 ? `${statement.slice(0, 160)}…` : statement;
  return `<section class="teacher-problem">
    <h4>题目</h4><p>${escapeHtml(preview || "这条记录没有题干。")}</p>
    ${hasDetails ? `<details class="teacher-problem-detail"><summary>查看${statement.length > 160 ? "完整题干和" : ""}题目条件</summary><div>
      ${statement.length > 160 ? `<p>${escapeHtml(statement)}</p>` : ""}
      ${task.knownFacts?.length ? `<p><strong>已知条件</strong> ${escapeHtml(text(task.knownFacts))}</p>` : ""}
      ${task.proofGoal ? `<p><strong>目标</strong> ${escapeHtml(text(task.proofGoal))}</p>` : ""}
      ${task.diagramDescription ? `<p><strong>图形关系</strong> ${escapeHtml(text(task.diagramDescription))}</p>` : ""}
    </div></details>` : ""}
  </section>`;
}

function retryNotes(summary) {
  return Array.isArray(summary.retryNotes) ? summary.retryNotes.filter(item => text(item?.feedback) && text(item?.stage)) : [];
}

function recentRetry(summary) {
  return [...retryNotes(summary)].sort((left, right) => (Date.parse(left.at) || 0) - (Date.parse(right.at) || 0)).at(-1);
}

function focusNoteMarkup(label, value) {
  if (!value) return "";
  if (value.length <= 140) return `<p class="teacher-focus-note"><strong>${escapeHtml(label)}</strong> ${escapeHtml(value)}</p>`;
  return `<details class="teacher-focus-note teacher-problem-detail"><summary>${escapeHtml(label)} · ${escapeHtml(value.slice(0, 76))}…</summary><p>${escapeHtml(value)}</p></details>`;
}

function recurringFeedback(summaries) {
  const groups = new Map();
  for (const summary of summaries) {
    const keys = new Set();
    for (const item of retryNotes(summary)) {
      const feedback = text(item.feedback).replace(/\s+/gu, " ");
      const stage = stageLabel(item.stage);
      const topic = topicLabel(summary);
      const key = JSON.stringify([topic, stage, feedback]);
      if (keys.has(key)) continue;
      keys.add(key);
      const group = groups.get(key) || { topic, stage, feedback, count: 0 };
      group.count++;
      groups.set(key, group);
    }
  }
  return [...groups.values()].filter(item => item.count >= 2).sort((left, right) => right.count - left.count).slice(0, 3);
}

function sessionPreviewMarkup(summary, index) {
  const title = text(summary.taskTitle || summary.task?.title, "未命名题目");
  const student = text(summary.anonymousId, `匿名学生${index + 1}`);
  const attention = summaryNeedsAttention(summary);
  const stage = stageLabel(summary.stage);
  const status = attention ? (summary.helpRequested ? "向老师求助" : "待关注") : stage;
  const problem = text(summary.task?.problemText);
  const stuck = stuckLabel(summary);
  return `<button class="teacher-preview${attention ? " is-attention" : ""}" type="button" data-session-index="${index}" aria-haspopup="dialog">
    <span class="teacher-preview-head"><strong class="teacher-preview-title">${escapeHtml(title)}</strong><span class="teacher-badge${attention ? " is-attention" : ""}">${escapeHtml(status)}</span></span>
    <span class="teacher-preview-meta">${escapeHtml(student)} · ${escapeHtml(topicLabel(summary))}</span>
    ${problem && problem !== title ? `<span class="teacher-preview-problem">${escapeHtml(problem)}</span>` : ""}
    <span class="teacher-preview-stuck">${stuck ? `<strong>卡点</strong> ${escapeHtml(stuck)}` : "暂无卡点记录"}</span>
  </button>`;
}

function cardMarkup(summary, index) {
  const attention = summaryNeedsAttention(summary);
  const anonymousId = text(summary.anonymousId, `匿名学生${index + 1}`);
  const taskTitle = text(summary.taskTitle || summary.task?.title, "未命名题目");
  const taskType = topicLabel(summary);
  const stuckPoint = stuckLabel(summary);
  const request = attention ? text(summary.helpRequests?.at(-1)?.text) : "";
  const retry = recentRetry(summary);
  const outcome = learningOutcome(summary);
  const suggested = attention ? text(summary.suggestedFollowUp) : "";
  const knowledgeReferences = Array.isArray(summary.knowledgeReferences) ? summary.knowledgeReferences : [];
  const helpSelections = Array.isArray(summary.helpSelections) ? summary.helpSelections : [];
  const trace = Array.isArray(summary.trace) ? summary.trace : [];
  const referenceMarkup = knowledgeReferences.length
    ? `<section class="teacher-evidence is-wide"><h4>引用过的知识卡</h4>${knowledgeReferences.map(item => `<div class="teacher-request"><small>${escapeHtml(text(item.title, "知识条目"))}${item.stage ? ` · ${escapeHtml(stageLabel(item.stage))}` : ""}</small><p>${escapeHtml(text(item.reason, "匹配到当前题目或卡点"))}</p></div>`).join("")}</section>`
    : "";
  return `<article class="teacher-card${attention ? " is-attention" : ""}">
    <header class="teacher-card-head">
      <div><h3>${escapeHtml(taskTitle)}</h3><p class="teacher-card-meta">${escapeHtml(anonymousId)} · ${escapeHtml(taskType)} · ${escapeHtml(dateLabel(summary.updatedAt || summary.createdAt))}</p></div>
      <div class="teacher-card-status"><span class="teacher-badge${attention ? " is-attention" : ""}">${escapeHtml(attention ? (summary.helpRequested ? "已向老师求助" : "待关注") : stageLabel(summary.stage))}</span>${attention ? `<small>${escapeHtml(stageLabel(summary.stage))}</small>` : `<small>${escapeHtml(outcome.label)}</small>`}</div>
    </header>
    ${problemMarkup(summary.task)}
    <section class="teacher-focus"><h4>${latestSelection(summary) ? "学生点选的卡点" : "记录的卡点"}</h4><p>${escapeHtml(stuckPoint || "暂无卡点记录。")}</p>
      ${focusNoteMarkup(retry ? `${stageLabel(retry.stage)}核验反馈` : "", retry?.feedback)}
      ${focusNoteMarkup("建议追问", suggested)}
      ${!stuckPoint ? focusNoteMarkup("求助原话", request) : ""}
    </section>
    <details class="teacher-later-evidence"><summary>查看学习结果和作答</summary><div class="teacher-grid teacher-later-grid">
      ${learningOutcomeMarkup(summary)}
      <section class="teacher-evidence"><h4>帮助状态</h4>${helpStatusMarkup(summary.helpStatus)}</section>
      <section class="teacher-evidence"><h4>判别理由</h4>${stageAnswerMarkup(summary.judgment, { label: "判别时学生理由" })}</section>
      <section class="teacher-evidence"><h4>迁移解法</h4>${stageAnswerMarkup(summary.transfer, { label: "迁移时学生解法" })}</section>
      <section class="teacher-evidence"><h4>反思记录</h4>${reflectionMarkup(summary.reflection)}</section>
      ${referenceMarkup}
    </div></details>
    <details class="teacher-trace"><summary>展开原始轨迹${trace.length ? `（${trace.length}条）` : ""}</summary><div class="teacher-trace-body">
      ${trace.length ? traceMarkup(trace) : `<h4>学生点选的卡点</h4>${selectionsMarkup(helpSelections)}<h4>教师求助原话</h4>${requestsMarkup(summary.helpRequests)}<h4>已给提示</h4>${hintsMarkup(summary.hintsGiven)}<h4>学生原话</h4>${quotesMarkup(summary.studentQuotes)}<h4>理解核验记录</h4>${helpCheckMarkup(summary.helpCheck)}`}</div></details>
  </article>`;
}

function filterSummaries(summaries, filters = state.filters) {
  const active = { ...DEFAULT_FILTERS, ...filters };
  return summaries.filter(summary => {
    const attentionMatch = active.attention === "all" || summaryNeedsAttention(summary);
    const stageMatch = active.stage === "all" || stageKey(summary.stage) === active.stage;
    const typeMatch = active.problemType === "all" || topicLabel(summary) === active.problemType;
    const stuckValue = stuckLabel(summary);
    const stuckMatch = active.stuckPoint === "all"
      || (active.stuckPoint === "__none__" && !stuckValue)
      || stuckValue === active.stuckPoint;
    return attentionMatch && stageMatch && typeMatch && stuckMatch;
  });
}

function addFilterOptions(select, values, allLabel, current) {
  if (!select) return;
  const options = [`<option value="all">${escapeHtml(allLabel)}</option>`, ...values.map(value => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`)]
    .join("");
  select.innerHTML = options;
  select.value = values.includes(current) || current === "all" ? current : "all";
}

function refreshFilterOptions() {
  const stageValues = Object.entries(STAGE_LABELS).map(([value, label]) => ({ value, label }));
  const stageSelect = $("#teacherStageFilter");
  if (stageSelect) {
    stageSelect.innerHTML = `<option value="all">全部阶段</option>${stageValues.map(item => `<option value="${item.value}">${item.label}</option>`).join("")}`;
    stageSelect.value = Object.hasOwn(STAGE_LABELS, state.filters.stage) ? state.filters.stage : "all";
  }
  const typeValues = [...new Set(state.summaries.map(topicLabel))].sort((a, b) => a.localeCompare(b, "zh-CN"));
  if (!typeValues.includes(state.filters.problemType)) state.filters.problemType = "all";
  addFilterOptions($("#teacherTypeFilter"), typeValues, "全部题型", state.filters.problemType);
  const stuckValues = [...new Set(state.summaries.map(stuckLabel).filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-CN"));
  if (state.summaries.some(summary => !stuckLabel(summary))) stuckValues.push("__none__");
  if (!stuckValues.includes(state.filters.stuckPoint)) state.filters.stuckPoint = "all";
  const stuckSelect = $("#teacherStuckFilter");
  if (stuckSelect) {
    const labels = stuckValues.map(value => value === "__none__" ? "未选择卡点" : value);
    stuckSelect.innerHTML = `<option value="all">全部卡点</option>${stuckValues.map((value, index) => `<option value="${escapeHtml(value)}">${escapeHtml(labels[index])}</option>`).join("")}`;
    stuckSelect.value = stuckValues.includes(state.filters.stuckPoint) || state.filters.stuckPoint === "all" ? state.filters.stuckPoint : "all";
  }
}

function filtersActive() {
  return Object.values(state.filters).some(value => value !== "all");
}

function renderSessionPage() {
  const list = $("#sessionList");
  const summaries = state.visibleSummaries;
  const pageCount = Math.ceil(summaries.length / SESSIONS_PER_PAGE);
  state.page = Math.min(state.page, Math.max(0, pageCount - 1));
  const start = state.page * SESSIONS_PER_PAGE;
  const end = Math.min(start + SESSIONS_PER_PAGE, summaries.length);
  const range = end ? `第 ${start + 1}–${end} 条` : "0 条记录";
  $("#sessionCount").textContent = state.loaded
    ? `${range} / 共 ${summaries.length} 条${filtersActive() ? `（筛选前 ${state.summaries.length} 条）` : ""}`
    : "点击查看后读取；本机可留空口令。";
  $("#teacherPagination").hidden = pageCount < 2;
  $("#teacherPageNumber").textContent = `第 ${state.page + 1} / ${pageCount} 页`;
  $("#teacherPrevPage").disabled = state.page === 0;
  $("#teacherNextPage").disabled = state.page >= pageCount - 1;
  if (!summaries.length) {
    const filteredEmpty = state.loaded && state.summaries.length && filtersActive();
    list.innerHTML = `<div class="teacher-empty-state"><h3>${filteredEmpty ? "没有符合筛选条件的记录" : state.loaded ? "还没有学习记录" : "等待教师打开记录"}</h3><p>${filteredEmpty ? "可以清除一个筛选条件，再查看全部记录。" : state.loaded ? "学生留下先思或求助记录后，这里会出现摘要。" : "点击“查看学习记录”后，这里会显示匿名会话。"}</p></div>`;
    return;
  }
  list.innerHTML = summaries.slice(start, end).map((summary, index) => sessionPreviewMarkup(summary, start + index)).join("");
}

function renderSummaries() {
  const dialog = $("#teacherDetail");
  if (dialog.open) {
    state.detailIndex = -1;
    $("#teacherDetailBody").replaceChildren();
    dialog.close();
  }
  refreshFilterOptions();
  const summaries = filterSummaries(sortSummaries(state.summaries));
  state.visibleSummaries = summaries;
  renderSessionPage();
  const attention = $("#teacherAttentionFilter");
  const all = $("#teacherAllFilter");
  $("#teacherControls").hidden = !state.loaded;
  all.textContent = `全部 ${state.summaries.length}`;
  all.setAttribute("aria-pressed", String(state.filters.attention === "all"));
  attention.textContent = `待关注 ${state.summaries.filter(summaryNeedsAttention).length}`;
  attention.setAttribute("aria-pressed", String(state.filters.attention === "needed"));
  const repeat = recurringFeedback(summaries);
  const repeatPanel = $("#teacherRecurring");
  repeatPanel.hidden = !repeat.length;
  $("#teacherRecurringList").innerHTML = repeat.map(item => `<li><small>${escapeHtml(item.topic)} · ${escapeHtml(item.stage)} · ${item.count} 条记录</small>${item.feedback.length > 140
    ? `<details class="teacher-problem-detail"><summary>${escapeHtml(item.feedback.slice(0, 76))}…</summary>${escapeHtml(item.feedback)}</details>`
    : `<span>${escapeHtml(item.feedback)}</span>`}</li>`).join("");
}

function changeSessionPage(step) {
  const next = state.page + step;
  if (next < 0 || next * SESSIONS_PER_PAGE >= state.visibleSummaries.length) return;
  state.page = next;
  renderSessionPage();
  $("#sessionListTitle").focus();
}

function openSessionDetail(index) {
  const summary = state.visibleSummaries[index];
  if (!summary) return;
  const dialog = $("#teacherDetail");
  const body = $("#teacherDetailBody");
  state.detailIndex = index;
  body.innerHTML = cardMarkup(summary, index);
  body.scrollTop = 0;
  $("#teacherDetailPosition").textContent = `第 ${index + 1} / ${state.visibleSummaries.length} 条`;
  $("#teacherPrevDetail").disabled = index === 0;
  $("#teacherNextDetail").disabled = index === state.visibleSummaries.length - 1;
  if (!dialog.open) dialog.showModal();
  if (document.activeElement?.disabled) $("#teacherCloseDetail").focus();
}

function bindSessionNavigation() {
  const dialog = $("#teacherDetail");
  $("#sessionList").addEventListener("click", event => {
    const preview = event.target.closest("[data-session-index]");
    if (preview) openSessionDetail(Number(preview.dataset.sessionIndex));
  });
  $("#teacherPrevPage").addEventListener("click", () => changeSessionPage(-1));
  $("#teacherNextPage").addEventListener("click", () => changeSessionPage(1));
  $("#teacherPrevDetail").addEventListener("click", () => openSessionDetail(state.detailIndex - 1));
  $("#teacherNextDetail").addEventListener("click", () => openSessionDetail(state.detailIndex + 1));
  $("#teacherCloseDetail").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    if (dialog.open) return;
    const index = state.detailIndex;
    state.detailIndex = -1;
    $("#teacherDetailBody").replaceChildren();
    if (index < 0 || !state.visibleSummaries[index]) return;
    const page = Math.floor(index / SESSIONS_PER_PAGE);
    if (state.page !== page) {
      state.page = page;
      renderSessionPage();
    }
    $(`#sessionList [data-session-index="${index}"]`)?.focus();
  });
}

function setStatus(message, kind = "") {
  const status = $("#teacherMessage");
  status.textContent = message;
  status.className = `teacher-status${kind ? ` is-${kind}` : ""}`;
  const topStatus = $("#teacherApiStatus");
  topStatus.className = `status-pill${kind === "error" ? " is-offline" : kind === "success" ? " is-live" : ""}`;
  topStatus.querySelector("span:last-child").textContent = message;
}

async function loadSessions() {
  if (state.loading) return;
  state.loading = true;
  const button = $("#teacherAuthForm button[type=submit]");
  const refresh = $("#refreshSessions");
  if (button) { button.disabled = true; button.dataset.label ||= button.textContent; button.textContent = "正在读取…"; }
  if (refresh) refresh.disabled = true;
  setStatus("正在读取学习记录…");
  try {
    const response = await fetch("/api/teacher/sessions", {
      method: "GET",
      credentials: "same-origin",
      headers: { "X-Teacher-Token": state.token }
    });
    let payload = {};
    try { payload = await response.json(); } catch { payload = {}; }
    if (!response.ok) {
      const message = text(payload.error || payload.message);
      if (response.status === 403) throw new Error(message || "教师口令不正确，或远程访问尚未配置 TEACHER_TOKEN。");
      if (response.status === 503) throw new Error(message || "教师看板尚未配置，请先检查服务端设置。");
      throw new Error(message || `读取失败（${response.status}）。`);
    }
    state.summaries = summariesFromPayload(payload);
    state.loaded = true;
    renderSummaries();
    setStatus(`已读取${state.summaries.length}条学习记录。`, "success");
    $("#refreshSessions").hidden = false;
    $("#clearTeacherSession").hidden = false;
  } catch (error) {
    state.loaded = false;
    state.summaries = [];
    renderSummaries();
    setStatus(error.message || "暂时无法读取学习记录，请稍后重试。", "error");
  } finally {
    state.loading = false;
    if (button) { button.disabled = false; button.textContent = button.dataset.label || "查看学习记录"; }
    if (refresh) refresh.disabled = false;
  }
}

function clearTeacherSession() {
  state.token = "";
  state.summaries = [];
  state.knowledge = [];
  state.selectedKnowledgeId = "";
  state.loaded = false;
  state.filters = { ...DEFAULT_FILTERS };
  state.page = 0;
  $("#teacherToken").value = "";
  $("#refreshSessions").hidden = true;
  $("#clearTeacherSession").hidden = true;
  setStatus("已清除口令，尚未重新读取学习记录。");
  renderSummaries();
  renderKnowledgeList();
}

function knowledgeStatus(message, kind = "") {
  const node = $("#knowledgeMessage");
  if (!node) return;
  node.textContent = message;
  node.className = `teacher-status${kind ? ` is-${kind}` : ""}`;
}

function bindTeacherTokenToggle() {
  const input = $("#teacherToken");
  const toggle = $("#teacherTokenToggle");
  if (!input || !toggle) return;
  toggle.addEventListener("click", () => {
    const visible = input.type === "password";
    input.type = visible ? "text" : "password";
    toggle.textContent = visible ? "隐藏" : "显示";
    toggle.setAttribute("aria-pressed", String(visible));
    toggle.setAttribute("aria-label", visible ? "隐藏教师口令" : "显示教师口令");
    input.focus({ preventScroll: true });
  });
}

async function knowledgeRequest(path, options = {}) {
  const headers = { "X-Teacher-Token": state.token, ...(options.headers || {}) };
  if (options.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  const response = await fetch(path, { ...options, credentials: "same-origin", headers });
  let payload = {};
  try { payload = await response.json(); } catch { payload = {}; }
  if (!response.ok) throw new Error(text(payload.error || payload.message, `请求失败（${response.status}）`));
  return payload;
}

function knowledgeItemLabel(item) {
  const status = text(item.status || item.teacherStatus, "draft");
  const statusLabel = { published: "已发布", draft: "草稿", disabled: "已停用" }[status] || status;
  return `${text(item.title || item.name, "未命名知识卡")} · ${statusLabel}`;
}

function renderKnowledgeList() {
  const list = $("#knowledgeList");
  if (!list) return;
  if (!state.knowledge.length) {
    list.innerHTML = `<p class="teacher-empty">知识库暂无条目，或尚未读取。</p>`;
    return;
  }
  list.innerHTML = state.knowledge.map(item => {
    const selected = text(item.id) === state.selectedKnowledgeId;
    const source = text(item.source, "来源未填写");
    return `<button type="button" class="teacher-knowledge-item${selected ? " is-selected" : ""}" data-knowledge-id="${escapeHtml(item.id)}"><strong>${escapeHtml(knowledgeItemLabel(item))}</strong><small>${escapeHtml(source)}${item.version ? ` · v${escapeHtml(item.version)}` : ""}</small></button>`;
  }).join("");
  list.querySelectorAll("[data-knowledge-id]").forEach(node => node.addEventListener("click", () => {
    state.selectedKnowledgeId = node.dataset.knowledgeId || "";
    const item = state.knowledge.find(value => value.id === state.selectedKnowledgeId);
    fillKnowledgeForm(item || {});
    renderKnowledgeList();
  }));
}

function fillKnowledgeForm(item = {}) {
  const form = $("#knowledgeForm");
  if (!form) return;
  form.hidden = false;
  if ($("#knowledgeHistory")) $("#knowledgeHistory").innerHTML = "";
  const strategies = Array.isArray(item.strategies) ? item.strategies : [];
  const strategyText = stage => strategies.find(strategy => strategy?.stage === stage)?.instruction || "";
  const values = {
    id: item.id || "",
    expectedVersion: item.version || 0,
    title: item.title || item.name || "",
    kind: item.kind || "math",
    gradeRange: Array.isArray(item.gradeRange) ? item.gradeRange.join(", ") : "",
    aliases: Array.isArray(item.aliases) ? item.aliases.join(", ") : "",
    sourceUrl: (item.references || []).find(reference => reference.url && !reference.url.includes("moe.gov.cn"))?.url || item.references?.[0]?.url || "",
    reviewStatus: item.reviewStatus === "teacher_reviewed" ? "teacher_reviewed" : "pending_teacher_review",
    keywords: Array.isArray(item.keywords || item.topicAliases) ? (item.keywords || item.topicAliases).join(", ") : item.keywords || "",
    principle: item.principle || "",
    requiredConditions: Array.isArray(item.applicableWhen || item.requiredConditions) ? (item.applicableWhen || item.requiredConditions).join("\n") : item.applicableWhen || item.requiredConditions || "",
    avoidWhen: Array.isArray(item.avoidWhen) ? item.avoidWhen.join("\n") : item.avoidWhen || "",
    question: item.question || "",
    source: item.source || "教师整理，待复核",
    strategyHelp: strategyText("help"),
    strategyHint1: strategyText("hint_level_1"),
    strategyHint2: strategyText("hint_level_2"),
    strategyHint3: strategyText("hint_level_3"),
    strategyJudgment: strategyText("judgment"),
    strategyTransfer: strategyText("transfer"),
    strategyReflection: strategyText("reflection")
  };
  Object.entries(values).forEach(([key, value]) => { if (form.elements[key]) form.elements[key].value = value; });
  $("#publishKnowledge").disabled = !item.id || item.status !== "draft";
  $("#disableKnowledge").disabled = !item.id || item.status === "disabled";
}

function knowledgeFormPayload() {
  const form = $("#knowledgeForm");
  const values = Object.fromEntries(new FormData(form));
  const strategyStages = [["help", values.strategyHelp], ["hint_level_1", values.strategyHint1], ["hint_level_2", values.strategyHint2], ["hint_level_3", values.strategyHint3], ["judgment", values.strategyJudgment], ["transfer", values.strategyTransfer], ["reflection", values.strategyReflection]];
  const strategies = strategyStages.filter(([, instruction]) => String(instruction || "").trim()).map(([stage, instruction]) => ({ stage, action: stage === "judgment" ? "verify" : stage === "transfer" ? "transfer" : stage === "reflection" ? "reflect" : "question", instruction: String(instruction).trim() }));
  const current = state.knowledge.find(item => item.id === values.id);
  const currentUrl = (current?.references || []).find(reference => reference.url && !reference.url.includes("moe.gov.cn"))?.url || current?.references?.[0]?.url || "";
  const sourceUrl = String(values.sourceUrl || "").trim();
  const references = sourceUrl === currentUrl ? (current?.references || []) : sourceUrl ? [{ id: `source-${values.id || "teacher"}`, version: 1, title: String(values.source || "教师提供来源").trim(), url: sourceUrl, publisher: "教师提供，按所列链接核对" }] : [];
  const principle = String(values.principle || "").trim() || strategies[0]?.instruction || "按当前学习阶段推进一个认知动作，不直接提供完整解答。";
  return {
    ...(values.id ? { id: values.id } : {}),
    expectedVersion: Number(values.expectedVersion || 0),
    title: String(values.title || "").trim(),
    kind: values.kind === "strategy" ? "strategy" : "math",
    gradeRange: String(values.gradeRange || "").split(/[,，;；\n]/u).map(value => value.trim()).filter(Boolean),
    aliases: String(values.aliases || "").split(/[,，;；\n]/u).map(value => value.trim()).filter(Boolean),
    references,
    reviewStatus: values.reviewStatus === "teacher_reviewed" ? "teacher_reviewed" : "pending_teacher_review",
    keywords: String(values.keywords || "").split(/[,，]/u).map(value => value.trim()).filter(Boolean),
    principle,
    applicableWhen: String(values.requiredConditions || "").split(/\r?\n/u).map(value => value.trim()).filter(Boolean),
    avoidWhen: String(values.avoidWhen || "").split(/\r?\n/u).map(value => value.trim()).filter(Boolean),
    question: String(values.question || "").trim() || "请先说明这条关系在当前题目中的适用条件。",
    strategies,
    source: String(values.source || "项目整理，待教师复核").trim()
  };
}

async function loadKnowledge() {
  state.token = String($("#teacherToken")?.value || state.token || "").trim();
  const localHost = ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname);
  if (!state.token && !localHost) return knowledgeStatus("请先填写教师口令。", "error");
  const button = $("#loadKnowledge");
  if (button) button.disabled = true;
  knowledgeStatus("正在读取知识库…");
  try {
    const payload = await knowledgeRequest("/api/teacher/knowledge");
    state.knowledge = Array.isArray(payload.items || payload.knowledge) ? (payload.items || payload.knowledge) : [];
    renderKnowledgeList();
    knowledgeStatus(`已读取${state.knowledge.length}条知识库记录。`, "success");
  } catch (error) {
    knowledgeStatus(error.message || "知识库读取失败。", "error");
  } finally { if (button) button.disabled = false; }
}

async function saveKnowledgeDraft(event) {
  event.preventDefault();
  const payload = knowledgeFormPayload();
  if (!payload.title || !payload.principle) return knowledgeStatus("标题和原理不能为空。", "error");
  const form = $("#knowledgeForm");
  form.querySelector("button[type=submit]").disabled = true;
  try {
    const result = await knowledgeRequest("/api/teacher/knowledge/draft", { method: "POST", body: JSON.stringify(payload) });
    const saved = result.item || result.knowledge || result;
    state.knowledge = [...state.knowledge.filter(item => item.id !== saved.id), saved];
    state.selectedKnowledgeId = saved.id || "";
    fillKnowledgeForm(saved);
    renderKnowledgeList();
    knowledgeStatus("草稿已保存，发布前不会提供给AI。", "success");
  } catch (error) { knowledgeStatus(error.message || "草稿保存失败。", "error"); }
  finally { form.querySelector("button[type=submit]").disabled = false; }
}

async function publishKnowledge() {
  const id = String($("#knowledgeId")?.value || state.selectedKnowledgeId || "");
  if (!id) return knowledgeStatus("请先选择一条知识卡。", "error");
  try {
    const result = await knowledgeRequest(`/api/teacher/knowledge/${encodeURIComponent(id)}/publish`, { method: "POST", body: JSON.stringify({ expectedVersion: Number($("#knowledgeVersion")?.value || 0) }) });
    const saved = result.item || result.knowledge || result;
    state.knowledge = [...state.knowledge.filter(item => item.id !== id), saved];
    fillKnowledgeForm(saved); renderKnowledgeList();
    knowledgeStatus("知识卡已发布，新的求助会使用当前版本。", "success");
  } catch (error) { knowledgeStatus(error.message || "发布失败。", "error"); }
}

async function disableKnowledge() {
  const id = String($("#knowledgeId")?.value || state.selectedKnowledgeId || "");
  if (!id) return knowledgeStatus("请先选择一条知识卡。", "error");
  try {
    const result = await knowledgeRequest(`/api/teacher/knowledge/${encodeURIComponent(id)}/disable`, { method: "POST", body: JSON.stringify({ expectedVersion: Number($("#knowledgeVersion")?.value || 0) }) });
    const saved = result.item || result.knowledge || result;
    state.knowledge = [...state.knowledge.filter(item => item.id !== id), saved];
    fillKnowledgeForm(saved); renderKnowledgeList();
    knowledgeStatus("知识卡已停用，不会再被检索。", "success");
  } catch (error) { knowledgeStatus(error.message || "停用失败。", "error"); }
}

async function loadKnowledgeHistory() {
  const id = String($("#knowledgeId")?.value || "");
  if (!id) return knowledgeStatus("请先选择已保存的条目。", "error");
  try {
    const payload = await knowledgeRequest("/api/teacher/knowledge?history=true");
    const items = (payload.items || []).filter(item => item.id === id).sort((a, b) => Number(b.version) - Number(a.version));
    $("#knowledgeHistory").innerHTML = `<h4>版本历史（只读）</h4>${items.map(item => `<details class="teacher-evidence"><summary>v${escapeHtml(item.version)} · ${escapeHtml(knowledgeItemLabel(item))}</summary><p>${escapeHtml(item.principle)}</p><small>${escapeHtml(item.source || "来源未填写")} · ${escapeHtml(dateLabel(item.updatedAt || item.createdAt))}</small></details>`).join("")}`;
  } catch (error) { knowledgeStatus(error.message || "版本历史读取失败。", "error"); }
}

function bindKnowledge() {
  $("#loadKnowledge")?.addEventListener("click", loadKnowledge);
  $("#knowledgeHistoryButton")?.addEventListener("click", loadKnowledgeHistory);
  $("#newKnowledge")?.addEventListener("click", () => { state.selectedKnowledgeId = ""; fillKnowledgeForm({}); renderKnowledgeList(); $("#knowledgeTitleInput")?.focus(); });
  $("#knowledgeForm")?.addEventListener("submit", saveKnowledgeDraft);
  $("#knowledgeForm")?.addEventListener("input", () => { $("#publishKnowledge").disabled = true; knowledgeStatus("内容有未保存的修改，请先保存草稿，再发布。"); });
  $("#publishKnowledge")?.addEventListener("click", publishKnowledge);
  $("#disableKnowledge")?.addEventListener("click", disableKnowledge);
}

function bindFilters() {
  for (const [selector, attention] of [["#teacherAllFilter", "all"], ["#teacherAttentionFilter", "needed"]]) {
    $(selector)?.addEventListener("click", () => {
      state.filters.attention = attention;
      state.page = 0;
      renderSummaries();
    });
  }
  const bindings = [
    ["#teacherStageFilter", "stage"],
    ["#teacherTypeFilter", "problemType"],
    ["#teacherStuckFilter", "stuckPoint"]
  ];
  bindings.forEach(([selector, key]) => $(selector)?.addEventListener("change", event => {
    state.filters[key] = String(event.currentTarget.value || "all");
    state.page = 0;
    renderSummaries();
  }));
  $("#clearTeacherFilters")?.addEventListener("click", () => {
    state.filters = { ...DEFAULT_FILTERS };
    state.page = 0;
    renderSummaries();
  });
}

function init() {
  bindFilters();
  bindSessionNavigation();
  bindTeacherTokenToggle();
  bindKnowledge();
  $("#teacherAuthForm")?.addEventListener("submit", event => {
    event.preventDefault();
    state.token = String($("#teacherToken")?.value || "").trim();
    loadSessions();
  });
  $("#refreshSessions")?.addEventListener("click", () => loadSessions());
  $("#clearTeacherSession")?.addEventListener("click", clearTeacherSession);
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
  else init();
}

export { cardMarkup, filterSummaries, recurringFeedback, renderSummaries, sortSummaries, stageKey, summaryNeedsAttention };
