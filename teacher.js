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

const state = {
  token: "",
  summaries: [],
  loaded: false,
  loading: false,
  knowledge: [],
  selectedKnowledgeId: "",
  filters: { stage: "all", problemType: "all", stuckPoint: "all" }
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
  return Number.isNaN(date.getTime()) ? text(value, "时间未记录") : date.toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "short" });
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
  return STAGE_LABELS[stageKey(value)] || text(value, "未记录阶段");
}

function decisionLabel(value) {
  return DECISION_LABELS[text(value).toLowerCase()] || text(value, "待复核");
}

function topicLabel(summary) {
  return text(summary?.task?.problemType, "未标注题型");
}

function summaryNeedsAttention(summary) {
  return summary?.needsHelp === true;
}

function sortSummaries(summaries) {
  return [...summaries].sort((a, b) => {
    const attention = Number(summaryNeedsAttention(b)) - Number(summaryNeedsAttention(a));
    if (attention) return attention;
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

function selectionsMarkup(selections, empty = "学生还没有点选具体卡点。", { latestOnly = false } = {}) {
  const list = Array.isArray(selections) ? selections : [];
  if (!list.length) return `<p class="teacher-empty">${escapeHtml(empty)}</p>`;
  const visible = latestOnly ? list.slice(-1) : list;
  const offset = latestOnly ? list.length - visible.length : 0;
  return `<ul class="teacher-selection-list">${visible.map((item, index) => `<li><span>${latestOnly ? "当前" : `第${index + 1 + offset}次`}</span><strong>${escapeHtml(text(item.label, "（未记录标签）"))}</strong>${item.at ? `<small>${escapeHtml(dateLabel(item.at))}</small>` : ""}</li>`).join("")}</ul>`;
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
  const label = text(item.type, text(item.stage, "学习记录"));
  const student = item.student ? quoteMarkup(item.student, "学生") : item.text ? quoteMarkup({ text: item.text, at: item.at }, "学生") : "";
  const reply = item.reply ? quoteMarkup(item.reply, "思阶") : "";
  const stuck = item.stuckPoint ? `<p><strong>卡点：</strong>${escapeHtml(item.stuckPoint)}</p>` : "";
  const selected = item.selectedStuckPoint ? `<p><strong>学生点选的卡点：</strong>${escapeHtml(text(item.selectedStuckPoint.label, "（未记录标签）"))}</p>` : "";
  const evaluation = item.evaluation?.feedback ? `<p><strong>记录反馈：</strong>${escapeHtml(item.evaluation.feedback)}</p>` : "";
  return `<div class="teacher-trace-item"><small>${index + 1}. ${escapeHtml(label)}${item.at ? ` · ${escapeHtml(dateLabel(item.at))}` : ""}</small>${selected}${stuck}${student}${reply}${evaluation}</div>`;
}

function traceMarkup(trace) {
  const list = Array.isArray(trace) ? trace : [];
  if (!list.length) return `<p class="teacher-empty">暂无可展开的先思和求助轨迹。</p>`;
  return list.map(traceItemMarkup).join("");
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

function cardMarkup(summary, index) {
  const attention = summaryNeedsAttention(summary);
  const anonymousId = text(summary.anonymousId, `匿名学生${index + 1}`);
  const taskTitle = text(summary.taskTitle || summary.task?.title, "未命名题目");
  const taskType = topicLabel(summary);
  const knowledgePoints = Array.isArray(summary.task?.knowledgePoints) ? summary.task.knowledgePoints : [];
  const stuckPoint = text(summary.stuckPoint, "学生尚未选择具体卡点。");
  const suggested = text(summary.suggestedFollowUp, "请学生指出当前已知条件、目标和已经尝试的下一步。");
  const knowledgeReferences = Array.isArray(summary.knowledgeReferences) ? summary.knowledgeReferences : [];
  const helpSelections = Array.isArray(summary.helpSelections) ? summary.helpSelections : [];
  const referenceMarkup = knowledgeReferences.length
    ? `<section class="teacher-evidence is-wide"><h4>AI调用过的知识依据（仅记录提供过的条目）</h4>${knowledgeReferences.map(item => `<div class="teacher-request"><small>${escapeHtml(text(item.title, item.id || "知识条目"))}${item.version ? ` · v${escapeHtml(item.version)}` : ""}${item.stage ? ` · ${escapeHtml(item.stage)}` : ""}</small><p>${escapeHtml(text(item.reason, "匹配到当前题目或卡点"))}</p></div>`).join("")}</section>`
    : "";
  return `<article class="teacher-card${attention ? " is-attention" : ""}">
    <header class="teacher-card-head">
      <div><h3>${escapeHtml(anonymousId)}</h3><p class="teacher-card-meta">${escapeHtml(taskTitle)} · 最近记录：${escapeHtml(dateLabel(summary.updatedAt || summary.createdAt))}</p><div class="teacher-tags"><span>阶段：${escapeHtml(stageLabel(summary.stage))}</span><span>题型：${escapeHtml(taskType)}</span>${knowledgePoints.slice(0, 3).map(item => `<span>${escapeHtml(text(item))}</span>`).join("")}</div></div>
      <span class="teacher-badge${attention ? " is-attention" : ""}">${attention ? (summary.helpRequested ? "已提交教师求助" : "已留下卡点") : (summary.helpRequested || summary.stuckPoint ? "历史求助记录" : "暂无求助记录")}</span>
    </header>
    <div class="teacher-grid">
      ${learningOutcomeMarkup(summary)}
      <section class="teacher-evidence"><h4>具体卡点</h4><p>${escapeHtml(stuckPoint)}</p></section>
      <section class="teacher-evidence"><h4>学生点选的卡点</h4>${selectionsMarkup(helpSelections, "学生还没有点选具体卡点。", { latestOnly: true })}</section>
      <section class="teacher-evidence teacher-suggestion"><h4>建议追问</h4><p>${escapeHtml(suggested)}</p></section>
      <section class="teacher-evidence"><h4>教师求助原话</h4>${requestsMarkup(summary.helpRequests)}</section>
      <section class="teacher-evidence"><h4>已给提示</h4>${hintsMarkup(summary.hintsGiven)}</section>
    </div>
    <details class="teacher-later-evidence" open><summary>后续学习证据（只展示过程记录，不作能力判断）</summary><div class="teacher-grid teacher-later-grid">
      <section class="teacher-evidence"><h4>帮助状态</h4>${helpStatusMarkup(summary.helpStatus)}</section>
      <section class="teacher-evidence"><h4>判别理由</h4>${stageAnswerMarkup(summary.judgment, { label: "判别时学生理由" })}</section>
      <section class="teacher-evidence"><h4>迁移解法</h4>${stageAnswerMarkup(summary.transfer, { label: "迁移时学生解法" })}</section>
      <section class="teacher-evidence"><h4>反思记录</h4>${reflectionMarkup(summary.reflection)}</section>
      ${referenceMarkup}
    </div></details>
    <details class="teacher-trace"><summary>展开原始轨迹（${Array.isArray(summary.trace) ? summary.trace.length : 0}条）</summary><div class="teacher-trace-body"><h4>学生点选的卡点</h4>${selectionsMarkup(helpSelections)}<h4>学生原话</h4>${quotesMarkup(summary.studentQuotes)}<h4>理解核验记录</h4>${helpCheckMarkup(summary.helpCheck)}<h4>过程轨迹</h4>${traceMarkup(summary.trace)}</div></details>
  </article>`;
}

function filterSummaries(summaries, filters = state.filters) {
  const active = { stage: "all", problemType: "all", stuckPoint: "all", ...(filters || {}) };
  return summaries.filter(summary => {
    const stageMatch = active.stage === "all" || stageKey(summary.stage) === active.stage;
    const typeMatch = active.problemType === "all" || topicLabel(summary) === active.problemType;
    const stuckValue = text(summary.stuckPoint);
    const stuckMatch = active.stuckPoint === "all"
      || (active.stuckPoint === "__none__" && !stuckValue)
      || stuckValue === active.stuckPoint;
    return stageMatch && typeMatch && stuckMatch;
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
  const typeValues = [...new Set(state.summaries.map(topicLabel).filter(value => value !== "未标注题型"))].sort((a, b) => a.localeCompare(b, "zh-CN"));
  addFilterOptions($("#teacherTypeFilter"), typeValues, "全部题型", state.filters.problemType);
  const stuckValues = [...new Set(state.summaries.map(summary => text(summary.stuckPoint)).filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-CN"));
  if (state.summaries.some(summary => !text(summary.stuckPoint))) stuckValues.push("__none__");
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

function renderSummaries() {
  const list = $("#sessionList");
  refreshFilterOptions();
  const summaries = filterSummaries(sortSummaries(state.summaries));
  $("#sessionCount").textContent = state.loaded
    ? `显示${summaries.length} / 共${state.summaries.length}条匿名学习记录${filtersActive() ? "（已筛选）" : "，当前仍在求助阶段的会话排在前面"}。`
    : "点击查看后读取；本机可留空口令。";
  if (!summaries.length) {
    const filteredEmpty = state.loaded && state.summaries.length && filtersActive();
    list.innerHTML = `<div class="teacher-empty-state"><h3>${filteredEmpty ? "没有符合筛选条件的记录" : state.loaded ? "还没有学习记录" : "等待教师打开记录"}</h3><p>${filteredEmpty ? "可以清除一个筛选条件，再查看全部记录。" : state.loaded ? "学生留下先思或求助记录后，这里会出现摘要。" : "点击“查看学习记录”后，这里会显示匿名会话。"}</p></div>`;
    return;
  }
  list.innerHTML = summaries.map(cardMarkup).join("");
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
  state.filters = { stage: "all", problemType: "all", stuckPoint: "all" };
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
  const bindings = [
    ["#teacherStageFilter", "stage"],
    ["#teacherTypeFilter", "problemType"],
    ["#teacherStuckFilter", "stuckPoint"]
  ];
  bindings.forEach(([selector, key]) => $(selector)?.addEventListener("change", event => {
    state.filters[key] = String(event.currentTarget.value || "all");
    renderSummaries();
  }));
  $("#clearTeacherFilters")?.addEventListener("click", () => {
    state.filters = { stage: "all", problemType: "all", stuckPoint: "all" };
    renderSummaries();
  });
}

function init() {
  bindFilters();
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

export { cardMarkup, filterSummaries, renderSummaries, sortSummaries, stageKey, summaryNeedsAttention };
