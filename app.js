const state = {
  task: null,
  session: null,
  draft: null,
  draftId: "",
  grade: "",
  problemImage: null,
  answerImages: {},
  evaluation: null,
  lastReply: null,
  summary: null,
  learningOutcome: null,
  modelStatus: null,
  imageBusy: false,
  imageJobs: Object.create(null),
  requestErrors: Object.create(null),
  formDrafts: Object.create(null),
  lastHelpAction: "",
  mobileScreen: "topic"
};

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const MAX_IMAGE_SIDE = 2048;
const MAX_INPUT_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const TARGET_IMAGE_BYTES = 2 * 1024 * 1024;
const MIN_IMAGE_SIDE = 1280;
const SVG_NS = "http://www.w3.org/2000/svg";

class ApiError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ApiError";
    Object.assign(this, details);
  }
}

function requestMeta(payload = {}, response = null) {
  const requestId = payload?.requestId || payload?.request_id || response?.headers?.get?.("x-request-id") || "未提供";
  const code = payload?.code || "REQUEST_FAILED";
  const retryable = typeof payload?.retryable === "boolean" ? payload.retryable : [408, 409, 425, 429, 500, 502, 503, 504].includes(response?.status);
  return { requestId, code, retryable, status: response?.status || 0, step: payload?.step || payload?.stage || "", elapsedMs: payload?.elapsedMs };
}

async function api(path, options = {}) {
  const headers = { ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) };
  let response;
  try {
    response = await fetch(path, { ...options, headers });
  } catch (cause) {
    throw new ApiError("网络连接中断；当前输入仍保留，可以直接重试。", {
      ...requestMeta({ code: "NETWORK_ERROR", retryable: true }),
      cause
    });
  }
  const type = response.headers.get("content-type") || "";
  let payload;
  try {
    payload = type.includes("application/json") ? await response.json() : await response.text();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    if (type.includes("text/html") && /cloudflare|bad gateway|error code 5\d\d/iu.test(String(payload || ""))) {
      throw new ApiError("公网服务暂时中断；当前输入仍保留，可以直接重试。", { ...requestMeta({ retryable: true }, response), payload });
    }
    const message = payload && typeof payload === "object" ? payload.error || payload.message : payload;
    const publicMessage = payload?.code === "MODEL_NOT_CONFIGURED"
      ? "AI服务暂不可用，请稍后重试。"
      : message;
    throw new ApiError(publicMessage || `请求失败（${response.status}）`, { ...requestMeta(payload, response), payload });
  }
  return payload || {};
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}

function asText(value, fallback = "") {
  if (Array.isArray(value)) return value.filter(Boolean).map(item => asText(item)).join("；") || fallback;
  if (value && typeof value === "object") return asText(value.text || value.message || value.content || value.label, fallback);
  const text = String(value ?? "").trim();
  return text || fallback;
}

function asList(value) {
  if (Array.isArray(value)) return value.map(item => asText(item)).filter(Boolean);
  const text = asText(value);
  return text ? [text] : [];
}

function isGeometryTask(task = {}) {
  if (typeof task.isGeometryProof === "boolean") return task.isGeometryProof;
  return /几何|三角形|角边点线/iu.test(`${task.subject || ""} ${task.problemType || ""} ${task.title || ""}`);
}

let toastTimer;
function toast(message, error = false) {
  const element = $("#toast");
  if (!element) return;
  element.textContent = message;
  element.className = `toast is-visible${error ? " is-error" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { element.className = "toast"; }, 3600);
}

function setBusy(form, busy, label = "处理中…") {
  const buttons = [...form.querySelectorAll("button")].filter(button => !button.dataset.keepEnabled);
  if (!buttons.length) return;
  if (busy) {
    clearRequestError(form);
    form.dataset.busy = "true";
    buttons.forEach(button => {
      if (!button.dataset.label) button.dataset.label = button.textContent;
      button.disabled = true;
    });
    const primary = form.querySelector("button[type=submit]");
    if (primary) primary.textContent = label;
  } else {
    buttons.forEach(button => {
      button.disabled = false;
      if (button.dataset.label) button.textContent = button.dataset.label;
    });
    delete form.dataset.busy;
  }
}

function clearRequestError(form) {
  form?.querySelector("[data-request-error]")?.remove();
}

function showRequestError(form, step, error, retry) {
  if (!form) return;
  clearRequestError(form);
  const wrapper = document.createElement("div");
  wrapper.className = "request-error";
  wrapper.dataset.requestError = "true";
  const requestId = error?.requestId || "未提供";
  const retryable = error?.retryable === true;
  const stepLabels = { processing: "处理图片", upload: "上传图片", recognition: "题目识别", verification: "结果核验", task_generation: "学习任务生成", hint_generation: "生成提示", answer_evaluation: "作答判定", judgment_generation: "准备判别建议", transfer_generation: "准备迁移题", connection: "连接AI服务", server: "服务处理" };
  const actualStep = stepLabels[error?.step] || step;
  const elapsed = Number.isFinite(Number(error?.elapsedMs)) ? ` · 用时：${escapeHtml(error.elapsedMs)}ms` : "";
  wrapper.innerHTML = `<strong>${escapeHtml(actualStep)}失败</strong><p>${escapeHtml(error?.message || "请求失败，请稍后重试。")}</p><small>步骤：${escapeHtml(actualStep)} · 请求编号：${escapeHtml(requestId)}${elapsed} · ${retryable ? "可以重试" : "请检查输入后再试"}</small>${retryable && typeof retry === "function" ? `<button class="secondary retry-button" type="button">重试</button>` : ""}`;
  form.append(wrapper);
  wrapper.querySelector(".retry-button")?.addEventListener("click", () => {
    wrapper.remove();
    retry();
  });
}

function ensureMathLibrary() {
  if (window.renderMathInElement) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-math-renderer="true"]');
    if (existing) {
      existing.addEventListener("load", resolve, { once: true });
      existing.addEventListener("error", reject, { once: true });
      return;
    }
    const script = document.createElement("script");
    script.src = "/vendor/katex.min.js";
    script.dataset.mathRenderer = "true";
    script.onload = () => {
      const autoRender = document.createElement("script");
      autoRender.src = "/vendor/auto-render.min.js";
      autoRender.dataset.mathRenderer = "true";
      autoRender.onload = resolve;
      autoRender.onerror = reject;
      document.head.append(autoRender);
    };
    script.onerror = reject;
    document.head.append(script);
  });
}

function renderMath() {
  ensureMathLibrary().then(() => {
    window.renderMathInElement?.(document.body, {
      delimiters: [{ left: "\\(", right: "\\)", display: false }, { left: "$$", right: "$$", display: true }],
      throwOnError: false
    });
  }).catch(() => {});
}

function supportsWebp() {
  try { return document.createElement("canvas").toDataURL("image/webp").startsWith("data:image/webp"); } catch { return false; }
}

function readBlobAsDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("读取图片失败。"));
    reader.readAsDataURL(blob);
  });
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("手机浏览器无法解码这张图片；请在相册中导出JPEG或换一张清晰的图片。"));
    image.src = dataUrl;
  });
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("图片压缩失败，请重试。")), type, quality);
  });
}

/**
 * Draws the selected image to a fresh canvas. This both limits the long side
 * and removes EXIF/GPS metadata before the image is sent to the server.
 */
async function compressImage(file) {
  const fileType = String(file?.type || "").toLowerCase();
  const extension = String(file?.name || "").split(".").pop()?.toLowerCase();
  const looksLikeImage = fileType.startsWith("image/") || ["png", "jpg", "jpeg", "webp", "heic", "heif"].includes(extension);
  if (!file || !looksLikeImage) {
    throw new Error("只支持常见图片格式；请使用PNG、JPEG、WebP，或让手机先转换HEIC后重试。");
  }
  if (file.size > MAX_INPUT_IMAGE_BYTES) throw new Error("原始图片超过32MB，请先在相册中缩小后重试。");
  const originalUrl = URL.createObjectURL(file);
  try {
    const image = await loadImage(originalUrl);
    const originalWidth = image.naturalWidth || image.width;
    const originalHeight = image.naturalHeight || image.height;
    if (!originalWidth || !originalHeight) throw new Error("图片尺寸无效，请换一张图片。 ");
    const type = supportsWebp() ? "image/webp" : "image/jpeg";
    const qualities = type === "image/jpeg" ? [0.86, 0.76, 0.66, 0.56, 0.46, 0.38] : [0.88, 0.78, 0.68, 0.58, 0.48, 0.38];
    const longest = Math.max(originalWidth, originalHeight);
    let scale = Math.min(1, MAX_IMAGE_SIDE / longest);
    let best = null;
    for (let pass = 0; pass < 8; pass += 1) {
      const width = Math.max(1, Math.round(originalWidth * scale));
      const height = Math.max(1, Math.round(originalHeight * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d", { alpha: type !== "image/jpeg" });
      if (!context) throw new Error("当前浏览器不支持图片处理，请改用相册中的JPEG图片。");
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      if (type === "image/jpeg") {
        context.fillStyle = "#fff";
        context.fillRect(0, 0, width, height);
      }
      context.drawImage(image, 0, 0, width, height);
      for (const quality of qualities) {
        const blob = await canvasToBlob(canvas, type, quality);
        if (!blob) continue;
        best = { blob, width, height };
        if (blob.size <= TARGET_IMAGE_BYTES) break;
      }
      if (best?.blob?.size <= TARGET_IMAGE_BYTES) break;
      const nextScale = scale * 0.82;
      const minScale = Math.min(1, MIN_IMAGE_SIDE / longest);
      if (nextScale < minScale || nextScale >= scale) break;
      scale = nextScale;
    }
    if (!best?.blob) throw new Error("图片压缩失败，请重试或改用JPEG图片。");
    if (best.blob.size > MAX_IMAGE_BYTES) throw new Error("图片太复杂，压缩后仍超过8MB，请拍得更近或先在相册中压缩。");
    return {
      dataUrl: await readBlobAsDataUrl(best.blob),
      mime: best.blob.type || type,
      bytes: best.blob.size,
      width: best.width,
      height: best.height,
      name: file.name
    };
  } finally {
    URL.revokeObjectURL(originalUrl);
  }
}

function imageStatusText(image, prefix = "已处理") {
  if (!image) return "尚未选择图片";
  return `${prefix} · ${image.width}×${image.height} · ${Math.max(1, Math.ceil(image.bytes / 1024))}KB · 已去除图片元数据`;
}

function imageBusyCount() {
  return Object.values(state.imageJobs).filter(Boolean).length;
}

function setImageBusy(key, busy) {
  if (busy) state.imageJobs[key] = true;
  else delete state.imageJobs[key];
  state.imageBusy = imageBusyCount() > 0;
}

function wireImageInput({ input, inputs = [], preview, status, clear, key, onImage, onClear }) {
  const sources = [input, ...inputs].filter(Boolean);
  if (!sources.length) return;
  sources.forEach(source => source.addEventListener("change", async event => {
    const file = event.currentTarget.files?.[0];
    if (!file) return;
    const isProblem = key === "problem";
    const previous = key === "problem" ? state.problemImage : state.answerImages[key];
    const token = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    state.imageJobs[key] = token;
    state.imageBusy = imageBusyCount() > 0;
    source.setCustomValidity("");
    status.textContent = previous ? "正在处理新图片，上一张仍可使用…" : "正在处理图片…";
    status.classList.add("is-loading");
    try {
      const image = await compressImage(file);
      if (state.imageJobs[key] !== token) return;
      if (isProblem) state.problemImage = image;
      else state.answerImages[key] = image;
      if (preview) {
        preview.src = image.dataUrl;
        preview.hidden = false;
      }
      if (clear) clear.hidden = false;
      status.textContent = imageStatusText(image);
      onImage?.(image);
    } catch (error) {
      if (state.imageJobs[key] !== token) return;
      if (preview && !previous) preview.hidden = true;
      if (clear) clear.hidden = !previous;
      status.textContent = previous ? `处理失败，已保留上一张。${error.message}` : error.message;
      source.setCustomValidity(error.message);
      toast(error.message, true);
    } finally {
      if (state.imageJobs[key] === token) {
        delete state.imageJobs[key];
        status.classList.remove("is-loading");
        state.imageBusy = imageBusyCount() > 0;
        sources.forEach(item => { item.value = ""; });
      }
    }
  }));
  clear?.addEventListener("click", () => {
    state.imageJobs[key] = "cancelled";
    if (key === "problem") state.problemImage = null;
    else state.answerImages[key] = null;
    if (preview) {
      preview.removeAttribute("src");
      preview.hidden = true;
    }
    clear.hidden = true;
    status.textContent = "尚未选择图片";
    sources.forEach(item => item.setCustomValidity(""));
    delete state.imageJobs[key];
    state.imageBusy = imageBusyCount() > 0;
    onClear?.();
  });
}

function applyTask(task, fallbackImage = null) {
  if (!task || typeof task !== "object") return;
  // Replace the public task snapshot instead of merging it with an older
  // response. A partial/legacy response must not resurrect stale teaching
  // plan fields from a previous task.
  state.task = { ...task };
  const taskData = state.task;
  const geometry = isGeometryTask(taskData);
  $("#problemEmpty").hidden = true;
  $("#problemSummary").hidden = false;
  $("#taskMeta").textContent = `${asText(taskData.grade, state.grade || "初中")} · ${geometry ? "几何证明" : "数学题"}`;
  $("#taskTitle").textContent = asText(taskData.title, geometry ? "未命名几何题" : "未命名数学题");
  $("#taskText").textContent = asText(taskData.problemText || taskData.text, "题目文字暂未返回，请以识别稿为准。");
  const stage = canonicalStage(state.session?.stage || "initial_thinking");
  const showTaskFacts = Boolean(state.session) && stageIndex(stage) >= 1;
  const learningGoal = asText(taskData.learningGoal);
  const known = asText(taskData.known || taskData.knownFacts || taskData.givens);
  const goal = asText(taskData.goal || taskData.proofGoal || taskData.target);
  const diagramDescription = asText(taskData.diagramDescription);
  $("#taskKnown").textContent = showTaskFacts ? known : "";
  $("#taskGoal").textContent = showTaskFacts ? goal : "";
  $("#taskDiagramDescription").textContent = showTaskFacts ? diagramDescription : "";
  $("#taskDiagramFact")?.toggleAttribute("hidden", !showTaskFacts || !diagramDescription);
  const facts = [known, goal, diagramDescription].some(Boolean);
  $("#taskFacts").hidden = !showTaskFacts || !facts;
  $("#learningGoal").textContent = showTaskFacts ? learningGoal : "";
  $("#learningGoalBox").hidden = !showTaskFacts || !learningGoal;

  const image = taskData.diagramData || taskData.imageData || taskData.problemImage || taskData.diagramPath || fallbackImage || state.problemImage?.dataUrl;
  const imageIsAllowed = typeof image === "string" && (image.startsWith("data:image/") || image.startsWith("/runtime-uploads/") || image.startsWith("/assets/") || image.startsWith("blob:"));
  const figure = $("#taskDiagramCard");
  if (imageIsAllowed) {
    $("#taskDiagram").src = image;
    $("#taskDiagram").alt = asText(taskData.diagramAlt, "本题题图");
    figure.hidden = false;
  } else {
    $("#taskDiagram").removeAttribute("src");
    figure.hidden = true;
  }
  renderMath();
}

function draftFrom(value) {
  const source = value?.draft && typeof value.draft === "object" ? value.draft : value || {};
  return {
    grade: asText(source.grade, state.grade || "初中"),
    subject: asText(source.subject, "初中数学"),
    problemType: asText(source.problemType, "math_problem"),
    isMathProblem: source.isMathProblem !== false,
    isGeometryProof: source.isGeometryProof === true,
    title: asText(source.title, source.isGeometryProof === true ? "待确认的几何证明题" : "待确认的数学题"),
    problemText: asText(source.problemText || source.text),
    known: asText(source.known || source.knownFacts || source.givens),
    goal: asText(source.goal || source.proofGoal || source.target),
    diagramDescription: asText(source.diagramDescription),
    learningGoal: asText(source.learningGoal, "读懂题目条件，选择并表达解题路径。"),
    diagramAlt: asText(source.diagramAlt, "本题题图")
  };
}

function imagePickerMarkup(key, { problem = false } = {}) {
  const prefix = problem ? `${key}Image` : `${key}-answer`;
  return `<div class="image-picker-controls" role="group" aria-label="${problem ? "题目图片" : "作答图片"}上传方式">
    <label class="file-button" for="${prefix}-gallery"><span aria-hidden="true">选择图片</span><input id="${prefix}-gallery" aria-label="${problem ? "选择题目图片" : "选择当前阶段的作答图片"}" type="file" accept="image/*"></label>
  </div>`;
}

function answerComposer(key, textName, label, placeholder, helper = "文字和图片任选其一，也可以同时提交。") {
  const textId = `${key}-answer-text`;
  return `<div class="answer-composer" data-answer-key="${escapeHtml(key)}">
    <label for="${textId}">${escapeHtml(label)} <small>${escapeHtml(helper)}</small></label>
    <textarea id="${textId}" name="${escapeHtml(textName)}" placeholder="${escapeHtml(placeholder)}"></textarea>
    <div class="answer-image-row">
      ${imagePickerMarkup(key)}
      <span class="upload-status" id="${key}-answer-status" role="status">尚未选择手写图片</span>
      <button class="ghost small-button" id="${key}-answer-clear" type="button" hidden>移除图片</button>
    </div>
    <img class="answer-image-preview" id="${key}-answer-preview" alt="已选择的手写答案预览" hidden>
  </div>`;
}

function imageAnswerComposer(key, label, helper = "可以补充一张手写图片。") {
  return `<div class="answer-composer" data-answer-key="${escapeHtml(key)}">
    <div class="field-label">${escapeHtml(label)} <small>${escapeHtml(helper)}</small></div>
    <div class="answer-image-row">
      ${imagePickerMarkup(key)}
      <span class="upload-status" id="${key}-answer-status" role="status">尚未选择手写图片</span>
      <button class="ghost small-button" id="${key}-answer-clear" type="button" hidden>移除图片</button>
    </div>
    <img class="answer-image-preview" id="${key}-answer-preview" alt="已选择的手写补充预览" hidden>
  </div>`;
}

function aiConfigTemplate() {
  const configured = Boolean(state.modelStatus?.configured);
  return `<details class="ai-config"${configured ? "" : " open"}>
    <summary><span>AI连接设置</span><small>${configured ? "AI服务已可用，需要时可更换密钥" : "请先填写DeepSeek API密钥"}</small></summary>
    <form id="aiConfigForm" class="field-stack" novalidate>
      <label for="apiKeyInput">DeepSeek API密钥 <small>仅保存在本机服务的当前运行内存中，不写入浏览器、学习记录或日志。</small></label>
      <div class="secret-input-row">
        <input id="apiKeyInput" name="apiKey" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="粘贴你的API密钥" required>
        <button class="ghost small-button" id="toggleApiKey" type="button" aria-controls="apiKeyInput" aria-pressed="false">显示</button>
      </div>
      <div class="form-actions"><span class="helper">通过网页填写的密钥会在服务重启后清除。</span><button class="secondary" type="submit">保存并检查连接</button></div>
    </form>
  </details>`;
}

function importTemplate() {
  return `<section class="stage-card import-card" id="importCard">
    <div class="stage-number">开始 · 导入题目</div>
    <h3>先把题目交给思阶</h3>
    <p class="stage-intro">选择一张清晰的题目图片，或粘贴题目文字。AI会识别初中数学题，并把识别结果交给你确认。</p>
    ${aiConfigTemplate()}
    <form id="problemForm" class="field-stack" novalidate>
      <label for="problemGrade">年级 <small>用于生成合适的提示和迁移题。</small></label>
      <select id="problemGrade" name="grade" required>
        <option value="初中其他年级" selected>初中其他年级（可调整）</option>
        <option value="七年级">七年级</option>
        <option value="八年级">八年级</option>
        <option value="九年级">九年级</option>
        <option value="初中其他年级">初中其他年级</option>
      </select>
      <label for="problemTextInput">题目文字 <small>可选；图片不清楚时可以补充。</small></label>
      <textarea id="problemTextInput" name="problemText" placeholder="例如：某物体温度约为40℃，另一处是它的11/8，求第三处温度；也可以输入几何题。"></textarea>
      <div class="image-picker">
        <label for="problemImage-gallery">题目图片 <small>可先用手机相机拍好，再从相册选择上传。</small></label>
        <label class="drop-zone" for="problemImage-gallery"><span class="drop-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 16V4m0 0L8 8m4-4 4 4M5 14v5h14v-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></span><span><strong>选择题图</strong><small>从相册或文件中选择已有图片</small></span></label>
        ${imagePickerMarkup("problem", { problem: true })}
        <div class="upload-preview" id="problemUploadPreview" hidden><img id="problemImagePreview" alt="题目图片预览"><span class="upload-status" id="problemUploadStatus" role="status">尚未选择图片</span><button class="ghost small-button" id="problemImageClear" type="button">移除图片</button></div>
      </div>
      <div class="form-actions"><span class="helper">文字和图片至少提供一项。</span><button class="primary" type="submit">识别题目</button></div>
    </form>
    ${state.draft ? draftEditorTemplate(state.draft) : ""}
  </section>`;
}

function draftEditorTemplate(draft) {
  const geometry = isGeometryTask(draft);
  const confidence = asText(state.lastAnalysis?.confidence);
  const needsClarification = state.lastAnalysis?.needsClarification === true || state.lastAnalysis?.decision === "clearer_input";
  const clarification = asText(state.lastAnalysis?.clarification || state.lastAnalysis?.analysis?.clarification, "图片或题意暂时无法确认，请重新拍摄或补充文字后再次识别。");
  const needsTeacherReview = [
    state.lastAnalysis?.needsTeacherReview,
    state.lastAnalysis?.reviewRequired,
    state.lastAnalysis?.teacherReviewRequired,
    state.lastAnalysis?.review?.required,
    state.lastAnalysis?.analysis?.needsTeacherReview,
    state.lastAnalysis?.taskReview?.required,
    state.lastAnalysis?.taskReview?.needsTeacherReview
  ].some(value => value === true);
  const teacherReviewReason = asText(
    state.lastAnalysis?.reviewReason
      || state.lastAnalysis?.teacherReviewReason
      || state.lastAnalysis?.review?.reason
      || state.lastAnalysis?.analysis?.reviewReason
      || state.lastAnalysis?.taskReview?.reason,
    "识别结果或题目条件仍需要人工核对，确认后再开始本轮学习。"
  );
  return `<div class="draft-editor" id="draftEditor" aria-labelledby="draftHeading">
    <div class="divider-label"><span>识别结果</span>${confidence ? `<small>识别置信度：${escapeHtml(confidence)}</small>` : ""}</div>
    <h4 id="draftHeading">请检查题干和求解目标</h4>
    <p class="draft-note">下面只显示题面内容，不是你的先思作答。如果题干、数量、单位、目标或图形关系识别得不准确，直接在下面改正。确认后再开始先思。</p>
    ${needsClarification ? `<div class="evaluation-box is-clearer" role="alert"><div class="evaluation-head"><span class="evaluation-dot" aria-hidden="true"></span><strong>需要重新识别</strong></div><p>${escapeHtml(clarification)}</p></div>` : ""}
    ${needsTeacherReview ? `<div class="review-note" role="note"><strong>本题建议由老师复核</strong><p>${escapeHtml(teacherReviewReason)}</p></div>` : ""}
    <form id="draftForm" class="field-stack" novalidate>
      <label for="draftProblemText">题目文字<textarea id="draftProblemText" name="problemText">${escapeHtml(draft.problemText)}</textarea></label>
      <label for="draftGoal">题目要求 / 求解目标 <small>这里确认一次，进入先思后会自动带入</small><textarea id="draftGoal" name="goal">${escapeHtml(draft.goal)}</textarea></label>
      ${geometry ? `<label for="draftDiagramDescription">图形转录<textarea id="draftDiagramDescription" name="diagramDescription">${escapeHtml(draft.diagramDescription)}</textarea></label>` : ""}
      <div class="form-actions"><button class="secondary" id="reanalyzeProblem" type="button">换一张/重新填写</button><button class="ghost" id="reverifyProblem" type="button">再次核验修正稿</button><button class="primary" type="submit"${needsClarification ? " disabled" : ""}>确认题目并开始</button></div>
    </form>
  </div>`;
}

function evaluationCard(evaluation = state.evaluation) {
  if (!evaluation || typeof evaluation !== "object") return "";
  const decision = asText(evaluation.decision);
  const hasContent = decision || asText(evaluation.feedback) || asList(evaluation.matchedIdeas).length || asText(evaluation.coreIssue) || asText(evaluation.nextPrompt);
  if (!hasContent) return "";
  const labels = { pass: "核心思路通过", retry: "再试一次", clearer_input: "需要更清楚的表达", assisted: "在帮助下继续" };
  const tone = decision === "pass" ? "is-pass" : decision === "assisted" ? "is-assisted" : decision === "clearer_input" ? "is-clearer" : "is-retry";
  const matched = asList(evaluation.matchedIdeas);
  return `<div class="evaluation-box ${tone}" role="status">
    <div class="evaluation-head"><span class="evaluation-dot" aria-hidden="true"></span><strong>${escapeHtml(labels[decision] || "AI反馈")}</strong></div>
    ${asText(evaluation.feedback) ? `<p>${escapeHtml(evaluation.feedback)}</p>` : ""}
    ${matched.length ? `<div class="evaluation-section"><span>已经抓住</span><ul>${matched.map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ul></div>` : ""}
    ${asText(evaluation.coreIssue) ? `<div class="evaluation-section"><span>还可以补上</span><p>${escapeHtml(evaluation.coreIssue)}</p></div>` : ""}
    ${asText(evaluation.nextPrompt) ? `<div class="next-prompt"><span>下一步</span><p>${escapeHtml(evaluation.nextPrompt)}</p></div>` : ""}
  </div>`;
}

const INITIAL_STUCK_POINTS = Object.freeze([
  "不知道题目给了什么条件",
  "不知道用哪个公式或定理",
  "不知道从哪里开始"
]);

function stuckPointField() {
  return `<fieldset class="choice-field stuck-point-field">
    <legend>暂时卡住了？先选一个具体卡点 <small>可选；选中后可以直接提交，不需要为了提交编造文字。</small></legend>
    <div class="choice-row stuck-point-row">
      ${INITIAL_STUCK_POINTS.map(value => `<label><input type="radio" name="stuckPoint" value="${escapeHtml(value)}"><span>${escapeHtml(value)}</span></label>`).join("")}
    </div>
  </fieldset>`;
}

function initialTemplate() {
  const initial = state.session?.answers?.initial || {};
  const known = asText(initial.known);
  const task = state.task || {};
  const goal = asText(initial.goal || task.goal || task.proofGoal || task.target);
  return `<section class="stage-card initial-stage-card">
    <div class="stage-number">阶段一 · 先思</div>
    <h3>先整理题目的骨架</h3>
    <p class="stage-intro">用自己的话写出条件和目标，也可以上传手写整理；题目页可随时回看原题，原题图不算先思。</p>
    ${evaluationCard()}
    <div class="thinking-boundary" role="note">
      <strong>先把“已知”和“目标”分开</strong>
      <p>写清条件、目标或具体卡点；暂时卡住时也可以直接选卡点。题目页可随时回看原题。</p>
    </div>
    <form id="initialForm" class="field-stack" novalidate>
      <div class="initial-facts">
        <label for="initialKnown">已知 / 题目条件 <small>把题目明确给出的数量、单位、关系或图形条件写出来，可分行填写。</small><textarea id="initialKnown" name="known" placeholder="例如：土壤表面约40℃；青路面是它的11/8">${escapeHtml(known)}</textarea></label>
        <label for="initialGoal">求证 / 求解目标 <small>已从题稿确认带入，可直接修改，不必重新抄写。</small><textarea id="initialGoal" name="goal" placeholder="例如：求草坪表面的温度">${escapeHtml(goal)}</textarea></label>
      </div>
      ${imageAnswerComposer("initial", "手写整理（可选）", "如果暂时写不出文字，可以只上传一张自己的手写整理图。")}
      ${stuckPointField()}
      <div class="form-actions"><span class="helper">文字、手写图或具体卡点三者至少提供一种；原题图片不算先思。</span><button class="primary" type="submit">提交先思</button></div>
    </form>
  </section>`;
}

function historyItems() {
  const session = state.session || {};
  const answerSource = session.answers?.helpHistory || session.helpHistory || session.answers?.hints || session.hints;
  const items = Array.isArray(answerSource) ? [...answerSource] : [1, 2, 3].map(level => session.answers?.[`hint${level}`]).filter(Boolean);
  const selections = Array.isArray(session.answers?.helpSelections) ? session.answers.helpSelections : [];
  const selectionsByLevel = new Map(selections.map(selection => [Number(selection?.hintLevel || selection?.level || 0), selection]));
  const usedSelections = new Set();
  const entries = items.map((item, index) => ({
    index: index + 1,
    selected: selectedHelpPoint(item) || selectedHelpPoint(selectionsByLevel.get(index + 1)),
    student: asText(item.studentText || item.student?.text || item.text || item.input),
    reply: replyMessage(item.reply || item)
  }));
  entries.forEach((entry, index) => {
    if (selectionsByLevel.has(index + 1)) usedSelections.add(selectionsByLevel.get(index + 1));
  });
  selections.filter(selection => !usedSelections.has(selection)).forEach(selection => {
    entries.push({ index: entries.length + 1, selected: selectedHelpPoint(selection), student: "", reply: "" });
  });
  if (state.lastReply && !entries.some(item => item.reply === replyMessage(state.lastReply))) entries.push({ index: entries.length + 1, student: asText(state.lastReply.studentText || state.lastReply.input), reply: replyMessage(state.lastReply) });
  return entries.filter(item => item.selected || item.student || item.reply);
}

const GENERIC_HELP_OPTIONS = Object.freeze([
  { id: "conditions", label: "不知道题目给了哪些条件" },
  { id: "method", label: "不知道要用哪个公式或定理" },
  { id: "start", label: "不知道从哪里开始" },
  { id: "unsure", label: "不确定自己卡在哪里" }
]);

function selectedHelpPoint(value = {}) {
  const source = value?.selectedStuckPoint || value?.student?.selectedStuckPoint || value?.selectedPoint || value?.stuckPoint;
  if (!source) return null;
  if (typeof source === "string") return { id: "legacy", label: asText(source) };
  const label = asText(source.label || source.text || source.content || source.title);
  if (!label) return null;
  return { id: asText(source.id) || "legacy", label };
}

function helpOptions() {
  const source = Array.isArray(state.task?.helpOptions) ? state.task.helpOptions : [];
  const values = source.length ? source : GENERIC_HELP_OPTIONS;
  const seen = new Set();
  const items = values.map((value, index) => {
    const item = typeof value === "string" ? { id: `help-${index + 1}`, label: value } : value || {};
    const label = asText(item.label || item.text || item.content).slice(0, 160);
    const id = asText(item.id) || `help-${index + 1}`;
    if (!label || seen.has(id)) return null;
    seen.add(id);
    return { id, label };
  }).filter(Boolean).slice(0, 6);
  return { items: items.length ? items : GENERIC_HELP_OPTIONS, source: source.length ? asText(state.task?.helpOptionsSource, "ai") : "generic" };
}

function helpLatestMessage() {
  const direct = replyMessage(state.lastReply);
  if (direct) return direct;
  const history = historyItems();
  return history.at(-1)?.reply || "";
}

function helpHasHint() {
  return Boolean(helpLatestMessage() || (Array.isArray(state.session?.completedHints) && state.session.completedHints.length));
}

function replyMessage(reply) {
  if (!reply) return "";
  return asText(reply.message || reply.question || reply.text || reply.prompt || reply.output || reply);
}

function knowledgeReferenceLinks(card) {
  const references = Array.isArray(card?.references) ? card.references : [];
  return references.map(reference => {
    const url = asText(typeof reference === "string" ? reference : reference?.url);
    if (!/^https:\/\//iu.test(url)) return "";
    const title = asText(typeof reference === "string" ? "公开来源" : reference?.title, "公开来源");
    return `<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer noopener">${escapeHtml(title)}</a>`;
  }).filter(Boolean);
}

function knowledgeCardMarkup(card = {}) {
  const references = knowledgeReferenceLinks(card);
  const applicability = asText(card.applicableWhen || card.requiredConditions || card.applicability || card.conditions);
  const misuseWarning = asText(card.misuseWarning || card.misuse || card.caution || card.avoidWhen);
  const review = card.reviewStatus === "teacher_reviewed" ? "已教师复核" : "待教师复核";
  return `<article>
    <strong>${escapeHtml(card.title)}</strong>
    <p>${escapeHtml(card.principle)}</p>
    ${asText(card.question) ? `<p class="knowledge-question">想一想：${escapeHtml(card.question)}</p>` : ""}
    ${applicability ? `<p class="knowledge-conditions"><strong>适用条件：</strong>${escapeHtml(applicability)}</p>` : ""}
    ${misuseWarning ? `<p class="knowledge-warning"><strong>误用提醒：</strong>${escapeHtml(misuseWarning)}</p>` : ""}
    <div class="knowledge-card-meta"><span>来源：${escapeHtml(card.source || "未标注")}</span><span>${review}</span><span>v${escapeHtml(card.version || 1)}</span></div>
    ${references.length ? `<div class="knowledge-references" aria-label="公开来源链接">${references.join("")}</div>` : ""}
  </article>`;
}

function helpTemplate() {
  const stage = asText(state.session?.stage);
  const stageMatch = stage.match(/(\d+)/);
  const level = Number(state.session?.helpLevel || state.session?.hintLevel || stageMatch?.[1] || 1);
  const hintsUsed = Array.isArray(state.session?.completedHints) ? state.session.completedHints.length : Number(state.session?.helpCount || 0);
  const history = historyItems();
  const historyHtml = history.length ? `<details class="help-collapsible"><summary>查看已进行的求助 <span>${history.length} 次</span></summary><div class="hint-history" aria-label="已经进行的求助">${history.map(item => `<div class="conversation-item"><strong>第${item.index}次求助</strong>${item.selected ? `<p class="conversation-selection"><span>点选卡点</span>${escapeHtml(item.selected.label)}</p>` : ""}${item.student ? `<p>${escapeHtml(item.student)}</p>` : ""}</div>${item.reply ? `<div class="conversation-item ai"><strong>思阶的回应</strong><p>${escapeHtml(item.reply)}</p></div>` : ""}`).join("")}</div></details>` : "";
  const cards = Array.isArray(state.task?.knowledgeCards) ? state.task.knowledgeCards : [];
  const knowledgeHtml = cards.length ? `<details class="knowledge-panel help-collapsible"><summary>相关知识卡 <span>${cards.length} 张 · 请先核对适用条件</span></summary><p>以下内容是一般知识，可能与本题不完全适用，请结合题目条件判断。</p><div class="knowledge-cards">${cards.map(knowledgeCardMarkup).join("")}</div></details>` : "";
  const options = helpOptions();
  const selectedId = asText(state.formDrafts.help?.selectedOptionId);
  const latestMessage = helpLatestMessage();
  const hasHint = helpHasHint();
  const optionsRound = Number(state.task?.helpOptionsRound || 0);
  const optionsSourceLabel = optionsRound > 0 ? "根据刚才的提示整理" : options.source === "ai" ? "AI根据本题整理" : "通用卡点";
  const showEvaluationFeedback = state.lastHelpAction && state.evaluation && asText(state.evaluation.feedback) && state.lastHelpAction !== "hint";
  const inputDraft = state.formDrafts.help || {};
  const supplementOpen = Boolean(inputDraft.supplementOpen || inputDraft.checkOpen);
  const canSubmit = Boolean(selectedId || inputDraft.text || state.answerImages.help);
  const exhausted = Boolean(state.session?.helpExhausted || state.session?.hintsExhausted || hintsUsed >= 3);
  return `<section class="stage-card help-stage-card">
    <div class="help-heading-row"><div><h3 id="helpStageHeading" tabindex="-1">${hasHint ? "这一步还有哪里不明白？" : "你卡在哪个地方？"}</h3><p class="stage-intro">${hasHint ? "如果这一步仍然卡住，选一个新的点，继续获取提示。" : "选一个不会的点，获得针对性提示。"}</p></div></div>
    ${exhausted ? `<div class="assisted-callout"><strong>三级提示已给出</strong><span>不会自动展示完整解析。你可以提交给老师，或展开“检查我的理解”后写一句自己的解释。</span></div>` : ""}
    ${latestMessage ? `<div class="help-latest" role="status"><div class="help-latest-label"><span class="evaluation-dot" aria-hidden="true"></span><strong>刚才的提示</strong></div><p>${escapeHtml(latestMessage)}</p></div>` : ""}
    ${showEvaluationFeedback ? `<div class="help-feedback" role="status"><p>${escapeHtml(state.evaluation.feedback)}</p>${asText(state.evaluation.nextPrompt) ? `<span>${escapeHtml(state.evaluation.nextPrompt)}</span>` : ""}</div>` : ""}
    <form id="helpForm" class="field-stack" novalidate>
      <fieldset class="help-options-field choice-field">
        <legend><span class="visually-hidden">先选一个最卡的点</span><small class="help-options-meta">${optionsSourceLabel} · 已用 ${hintsUsed}/3 次提示</small></legend>
        <div class="help-option-grid">${options.items.map(item => `<label class="help-option"><input type="radio" name="selectedStuckPointId" value="${escapeHtml(item.id)}"${item.id === selectedId ? " checked" : ""}><span>${escapeHtml(item.label)}</span></label>`).join("")}</div>
      </fieldset>
      <details id="helpInputPanel" class="help-collapsible help-input-panel"${supplementOpen ? " open" : ""}>
        <summary>${hasHint ? "写一句你自己的理解" : "补充文字或图片（可选）"}</summary>
        ${answerComposer("help", "text", hasHint ? "你的理解" : "补充说明", hasHint ? "例如：我认为……因为……" : "可以补充你已经想到的条件、关系或卡点", hasHint ? "写出自己的理由后，可以检查是否真的理解。" : "选卡点已经可以直接求助，文字和图片只是补充。")}
        ${hasHint ? `<div class="help-check-actions"><button class="secondary" id="finishHelp" type="button" disabled>提交理解核验</button></div>` : ""}
      </details>
      <div class="form-actions help-actions"><span class="helper">${exhausted ? "选中的卡点会一起提交给老师。" : "选择后获得针对性提示。"}</span>${exhausted ? `<button class="primary" id="requestTeacherHelp" type="button"${canSubmit ? "" : " disabled"}>提交给老师</button>` : `<button class="primary" id="helpPrimarySubmit" type="submit"${canSubmit ? "" : " disabled"}>帮我理解</button>`}</div>
      ${hasHint ? `<div class="help-followup-actions"><button class="ghost" id="understoodHelp" type="button">我懂了，进入判别</button><button class="secondary" id="checkHelp" type="button" aria-controls="helpInputPanel" aria-expanded="${supplementOpen ? "true" : "false"}">检查我的理解</button></div>` : ""}
    </form>
    ${knowledgeHtml}
    ${historyHtml}
  </section>`;
}

function judgmentStatement() {
  const task = state.task || {};
  return asText(task.judgmentTask?.statement || task.judgmentCard?.statement || task.judgment?.statement || task.judgmentStatement, "AI正在准备一条待核验的解题建议，请稍候重试。 ");
}

function judgmentTemplate() {
  return `<section class="stage-card">
    <div class="stage-number">阶段三 · 判别</div>
    <h3>AI说得像对的，就一定对吗？</h3>
    <p class="stage-intro">先判断下面这条解题建议，再说明你的理由。关键判断正确即可通过，不要求证明文字和标准答案一模一样。</p>
    ${evaluationCard()}
    <div class="judgment-card"><span>待核验建议</span><p>${escapeHtml(judgmentStatement())}</p></div>
    <form id="judgmentForm" class="field-stack" novalidate>
      <fieldset class="choice-field"><legend>你的判断 <small>三选一</small></legend><div class="choice-row">
        ${["合理", "不合理", "信息不足"].map(value => `<label><input type="radio" name="verdict" value="${value}" required><span>${value}</span></label>`).join("")}
      </div></fieldset>
      ${answerComposer("judgment", "reason", "为什么这样判断？", "我判断……因为……还需要……", "理由可以用文字写，也可以上传手写推理。")}
      <div class="form-actions"><span class="helper">选择判断，并提供文字或图片理由。</span><button class="primary" type="submit">提交判断</button></div>
    </form>
  </section>`;
}

function safeDiagramSpec(value) {
  const source = value && typeof value === "object" ? value : {};
  const width = Number.isFinite(Number(source.width)) ? Math.max(120, Math.min(1600, Number(source.width))) : 1000;
  const height = Number.isFinite(Number(source.height)) ? Math.max(120, Math.min(1200, Number(source.height))) : 700;
  const points = Array.isArray(source.points) ? source.points.filter(point => point && typeof point === "object" && Number.isFinite(Number(point.x)) && Number.isFinite(Number(point.y)) && point.id != null).slice(0, 80).map(point => ({ id: String(point.id).slice(0, 40), x: Number(point.x), y: Number(point.y), label: asText(point.label).slice(0, 40) })) : [];
  const ids = new Set(points.map(point => point.id));
  const segments = Array.isArray(source.segments || source.lines) ? (source.segments || source.lines).filter(segment => segment && ids.has(String(segment.from ?? segment.start ?? segment.a)) && ids.has(String(segment.to ?? segment.end ?? segment.b))).slice(0, 120).map(segment => ({ from: String(segment.from ?? segment.start ?? segment.a), to: String(segment.to ?? segment.end ?? segment.b), style: ["normal", "solid", "dashed", "dotted", "auxiliary", "highlight"].includes(segment.style) ? segment.style : "normal" })) : [];
  const rawMarks = [...(Array.isArray(source.marks) ? source.marks : []), ...(Array.isArray(source.annotations) ? source.annotations : [])];
  const marks = rawMarks.filter(mark => mark && typeof mark === "object").slice(0, 80).map(mark => {
    const pointsAt = Array.isArray(mark.points) ? mark.points.map(point => String(point)).filter(id => ids.has(id)) : [];
    const kind = mark.type || mark.kind;
    const type = kind === "right_angle" ? "right-angle" : kind === "equal_mark" ? "tick" : kind === "parallel_mark" ? "label" : ["right-angle", "tick", "circle", "label"].includes(kind) ? kind : "label";
    return { type, at: String(mark.at ?? pointsAt[0] ?? ""), label: asText(mark.label || mark.text).slice(0, 30) };
  }).filter(mark => !mark.at || ids.has(mark.at));
  const labels = Array.isArray(source.labels) ? source.labels.filter(label => label && typeof label === "object").slice(0, 80).map(label => ({ text: asText(label.text || label.label || label.value).slice(0, 40), point: label.point || label.at || "", x: Number(label.x), y: Number(label.y) })).filter(label => label.text && ((!label.point && Number.isFinite(label.x) && Number.isFinite(label.y)) || ids.has(String(label.point)))) : [];
  return { width, height, points, segments, marks, labels };
}

function pointPosition(point, width = 1000, height = 700) {
  const scaleX = Math.abs(point.x) <= 1.5 ? width : 1;
  const scaleY = Math.abs(point.y) <= 1.5 ? height : 1;
  return { x: Math.max(0, Math.min(width, point.x * scaleX)), y: Math.max(0, Math.min(height, point.y * scaleY)) };
}

function drawDiagram(container, input) {
  if (!container) return;
  container.replaceChildren();
  const spec = safeDiagramSpec(input);
  if (!spec.points.length) {
    container.hidden = true;
    return;
  }
  container.hidden = false;
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${spec.width} ${spec.height}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "迁移题几何示意图");
  svg.classList.add("diagram-svg");
  const positions = new Map(spec.points.map(point => [point.id, pointPosition(point, spec.width, spec.height)]));
  spec.segments.forEach(segment => {
    const from = positions.get(segment.from);
    const to = positions.get(segment.to);
    if (!from || !to) return;
    const line = document.createElementNS(SVG_NS, "line");
    line.setAttribute("x1", String(from.x)); line.setAttribute("y1", String(from.y));
    line.setAttribute("x2", String(to.x)); line.setAttribute("y2", String(to.y));
    line.classList.add("diagram-segment", `is-${segment.style}`);
    svg.append(line);
  });
  spec.points.forEach(point => {
    const position = positions.get(point.id);
    const circle = document.createElementNS(SVG_NS, "circle");
    circle.setAttribute("cx", String(position.x)); circle.setAttribute("cy", String(position.y)); circle.setAttribute("r", "8");
    circle.classList.add("diagram-point");
    svg.append(circle);
    const label = document.createElementNS(SVG_NS, "text");
    label.setAttribute("x", String(position.x + 14)); label.setAttribute("y", String(position.y - 13));
    label.textContent = point.label || point.id;
    label.classList.add("diagram-label");
    svg.append(label);
  });
  spec.labels.forEach(labelData => {
    const anchor = labelData.point ? positions.get(String(labelData.point)) : { x: Math.max(0, Math.min(spec.width, labelData.x)), y: Math.max(0, Math.min(spec.height, labelData.y)) };
    if (!anchor) return;
    const label = document.createElementNS(SVG_NS, "text");
    label.setAttribute("x", String(anchor.x + 16)); label.setAttribute("y", String(anchor.y + 28));
    label.textContent = labelData.text; label.classList.add("diagram-mark-label"); svg.append(label);
  });
  spec.marks.forEach(mark => {
    const position = positions.get(mark.at);
    if (!position) return;
    if (mark.type === "circle") {
      const circle = document.createElementNS(SVG_NS, "circle");
      circle.setAttribute("cx", String(position.x)); circle.setAttribute("cy", String(position.y)); circle.setAttribute("r", "22"); circle.classList.add("diagram-mark"); svg.append(circle);
    } else if (mark.type === "right-angle") {
      const square = document.createElementNS(SVG_NS, "rect");
      square.setAttribute("x", String(position.x + 6)); square.setAttribute("y", String(position.y - 26)); square.setAttribute("width", "18"); square.setAttribute("height", "18"); square.classList.add("diagram-mark"); svg.append(square);
    } else if (mark.type === "tick") {
      const tick = document.createElementNS(SVG_NS, "line");
      tick.setAttribute("x1", String(position.x - 10)); tick.setAttribute("y1", String(position.y - 10)); tick.setAttribute("x2", String(position.x + 10)); tick.setAttribute("y2", String(position.y + 10)); tick.classList.add("diagram-mark"); svg.append(tick);
    } else if (mark.label) {
      const text = document.createElementNS(SVG_NS, "text");
      text.setAttribute("x", String(position.x + 18)); text.setAttribute("y", String(position.y + 25)); text.textContent = mark.label; text.classList.add("diagram-mark-label"); svg.append(text);
    }
  });
  container.append(svg);
}

function transferTask() {
  const task = state.task || {};
  return task.transferTask || task.transfer || task.transferTaskDraft || {};
}

function transferTemplate() {
  const geometry = isGeometryTask(state.task || {});
  const transfer = transferTask();
  const spec = transfer.diagramSpec || transfer.diagram || (state.task || {}).diagramSpec;
  return `<section class="stage-card">
    <div class="stage-number">阶段四 · 迁移</div>
    <h3>换一道相似题，重新自己完成</h3>
    <p class="stage-intro">新题和原题练的是同一个关键方法，但表面会有变化。写主要推理即可，符号不规范也没关系。</p>
    ${evaluationCard()}
    <div class="transfer-task"><span>迁移题</span><p>${escapeHtml(asText(transfer.text || transfer.problemText, "迁移题正在准备，请稍候重试。"))}</p></div>
    <div class="diagram-render" id="transferDiagram" hidden></div>
    <form id="transferForm" class="field-stack" novalidate>
      ${answerComposer("transfer", "answer", geometry ? "你的迁移证明" : "你的迁移解法", geometry ? "已知……由……可得……所以……" : "先列出关系……再计算或判断……", "用文字或手写图片写出关键步骤，至少提交一种。")}
      <div class="form-actions"><span class="helper">提交后，AI会判断你的核心方法。</span><button class="primary" type="submit">${geometry ? "提交迁移证明" : "提交迁移解法"}</button></div>
    </form>
  </section>`;
}

function reflectionReviewMarkup() {
  const session = state.session || {};
  const initial = session.answers?.initial || {};
  const initialText = [asText(initial.known) ? `已知：${asText(initial.known)}` : "", asText(initial.goal) ? `目标：${asText(initial.goal)}` : "", asText(initial.text)].filter(Boolean).join("\n");
  const history = historyItems();
  const transfer = session.answers?.transfer || {};
  const transferText = asText(transfer.text || transfer.answer || transfer.student?.text);
  const transferFeedback = asText(transfer.evaluation?.feedback || transfer.feedback || state.evaluation?.feedback);
  const items = [];
  if (initialText) items.push(`<div class="reflection-review-item student"><span>你在先思写过</span><p>${escapeHtml(initialText)}</p></div>`);
  else if (initial.image || initial.imageData) items.push(`<div class="reflection-review-item student"><span>你在先思提交过</span><p>一张手写整理图（原图不会在这里重复展示）。</p></div>`);
  history.slice(0, 3).forEach(item => {
    if (item.student) items.push(`<div class="reflection-review-item student"><span>你在求助阶段写过</span><p>${escapeHtml(item.student)}</p></div>`);
    if (item.reply) items.push(`<div class="reflection-review-item ai"><span>思阶在求助阶段回应</span><p>${escapeHtml(item.reply)}</p></div>`);
  });
  if (transferText) items.push(`<div class="reflection-review-item student"><span>你在迁移题写过</span><p>${escapeHtml(transferText)}</p></div>`);
  if (transferFeedback) items.push(`<div class="reflection-review-item ai"><span>思阶对迁移题的反馈</span><p>${escapeHtml(transferFeedback)}</p></div>`);
  if (!items.length) return "";
  return `<details class="reflection-review" open><summary><h4>回看这次学习过程</h4></summary><p>下面只回放已经记录的内容，方便你区分自己的想法和思阶的提示。</p>${items.join("")}</details>`;
}

function reflectionTemplate() {
  return `<section class="stage-card">
    <div class="stage-number">阶段五 · 反思</div>
    <h3>把帮助还原成自己的方法</h3>
    <p class="stage-intro">不用写长篇。说清楚自己完成了什么、AI帮助了什么、下次准备先做什么。</p>
    ${evaluationCard()}
    ${reflectionReviewMarkup()}
    <form id="reflectionForm" class="field-stack" novalidate>
      <label for="selfWork">我自己完成的部分 <small>可以简单写，也可以只上传一张手写反思图。</small><textarea id="selfWork" name="selfWork" placeholder="我自己先找到了……"></textarea></label>
      <label for="aiHelp">AI帮助我的部分 <small>例如提示了一个关系、帮我发现一个缺口。</small><textarea id="aiHelp" name="aiHelp" placeholder="AI帮助我……"></textarea></label>
      <label for="nextTime">下次没有AI，我会先做什么？<textarea id="nextTime" name="nextTime" placeholder="下次我会先……"></textarea></label>
      ${answerComposer("reflection", "text", "手写反思（可选）", "可以把反思写在纸上，用手机相机拍好后上传图片。", "上面三段文字和这一张图片共用一个提交。")}
      <div class="form-actions"><span class="helper">三段文字和图片至少完成一项。</span><button class="primary" type="submit">完成学习</button></div>
    </form>
  </section>`;
}

function summaryMarkup(summary) {
  if (!summary) return "";
  if (typeof summary === "string") return `<p>${escapeHtml(summary)}</p>`;
  const entries = [
    ["我的思路", summary.selfWork || summary.studentWork || summary.thinking],
    ["AI帮助", summary.aiHelp || summary.help],
    ["下次策略", summary.nextTime || summary.strategy || summary.nextStep],
    ["补充反思", summary.note]
  ].filter(([, value]) => asText(value));
  return entries.length ? entries.map(([label, value]) => `<div class="summary-line"><strong>${escapeHtml(label)}</strong><p>${escapeHtml(asText(value))}</p></div>`).join("") : `<p>${escapeHtml(asText(summary, "已记录本次学习。"))}</p>`;
}

const OUTCOME_STATUS_LABELS = Object.freeze({
  independent: "独立通过",
  assisted: "辅助继续",
  pending: "尚未验证",
  review_required: "需老师复核"
});

const OUTCOME_STAGE_LABELS = Object.freeze({
  initial: "先思",
  initial_thinking: "先思",
  help: "求助",
  judgment: "判别",
  transfer: "迁移",
  reflection: "反思"
});

function learningOutcomeMarkup(outcome = state.learningOutcome) {
  if (!outcome || typeof outcome !== "object") return "";
  const statusKey = asText(outcome.status).toLowerCase();
  const statusLabel = OUTCOME_STATUS_LABELS[statusKey] || asText(outcome.label, "本轮状态待确认");
  const description = asText(outcome.description);
  const taskReview = outcome.taskReview;
  const needsTeacherReview = outcome.needsTeacherReview === true
    || taskReview?.required === true
    || taskReview?.needsTeacherReview === true;
  const taskReviewReason = asText(taskReview?.reason || outcome.taskReviewReason, "题目条件或识别结果仍需要人工核对。");
  const stages = Array.isArray(outcome.stages) ? outcome.stages : [];
  const stageMarkup = stages.map((stage, index) => {
    const item = stage && typeof stage === "object" ? stage : { status: stage };
    const stageKey = asText(item.key || item.stage || item.step || item.name).toLowerCase();
    const stageName = asText(item.label || item.name || item.stage || item.step, OUTCOME_STAGE_LABELS[stageKey] || `阶段${index + 1}`);
    const stageStatusKey = asText(item.status).toLowerCase();
    const stageStatus = OUTCOME_STATUS_LABELS[stageStatusKey] || asText(item.statusLabel || item.status, "状态待确认");
    const stageDescription = asText(item.description || item.reason || item.detail);
    const tone = ["independent", "assisted", "pending", "review_required"].includes(stageStatusKey) ? ` is-${stageStatusKey}` : "";
    return `<div class="outcome-stage${tone}"><strong>${escapeHtml(stageName)}</strong><span class="outcome-status">${escapeHtml(stageStatus)}</span>${stageDescription ? `<p>${escapeHtml(stageDescription)}</p>` : ""}</div>`;
  }).join("");
  return `<section class="learning-outcome" aria-labelledby="learningOutcomeHeading">
    <div class="outcome-head"><h4 id="learningOutcomeHeading">本轮学习结果</h4><span class="outcome-label">${escapeHtml(statusLabel)}</span></div>
    ${description ? `<p>${escapeHtml(description)}</p>` : ""}
    ${needsTeacherReview ? `<div class="review-note"><strong>本题建议由老师复核</strong><p>${escapeHtml(taskReviewReason)}</p></div>` : ""}
    ${stageMarkup ? `<div class="outcome-stages" aria-label="各阶段状态">${stageMarkup}</div>` : ""}
    <p>完成本轮流程不等同于已经掌握；下次可以用另一道题再试一次。</p>
  </section>`;
}

function taskReviewMarkup() {
  const reviews = [
    state.session?.taskReview,
    state.session?.learningOutcome?.taskReview,
    state.learningOutcome?.taskReview,
    state.lastResult?.taskReview
  ].filter(review => review && typeof review === "object");
  const required = state.session?.needsTeacherReview === true
    || state.learningOutcome?.needsTeacherReview === true
    || reviews.some(review => review.required === true || review.needsTeacherReview === true);
  const recovery = state.lastResult?.generation?.mode === "live-recovery";
  if (!required && !recovery) return "";
  const reason = reviews.map(review => asText(review.reason || review.description)).find(Boolean)
    || (recovery ? "题目由图片或不完整条件恢复，建议老师核对题面和求解目标。" : "题目条件或识别结果仍需要人工核对。");
  return `<div class="review-note" role="note"><strong>本题建议由老师复核</strong><p>${escapeHtml(reason)}</p></div>`;
}

function completedTemplate() {
  const task = state.task || {};
  const reference = state.lastResult?.referenceProof || task.referenceProof || task.solution || "";
  const summary = state.summary || state.session?.summary;
  return `<section class="stage-card completed-card">
    <div class="stage-number">完成本轮</div>
    <h3>完成本轮流程</h3>
    <p class="stage-intro">本轮五阶段已结束。请结合独立作答、辅助记录和反思回看；完成流程不等于独立掌握。</p>
    ${learningOutcomeMarkup()}
    ${summary ? `<div class="summary-box"><h4>这次学习摘要</h4>${summaryMarkup(summary)}</div>` : ""}
    ${reference ? `<details class="reference-details"><summary>查看参考思路</summary><div class="reference-proof">${escapeHtml(asText(reference))}</div></details>` : ""}
    <div class="feedback-box"><strong>继续练习</strong><p>可以换一道题，把刚才的方法再走一遍。</p></div>
    <div class="form-actions"><button class="primary" id="newSession" type="button">换一道题</button></div>
  </section>`;
}

function canonicalStage(stage) {
  const value = asText(stage);
  if (value === "initial_thinking" || value === "initial") return "initial_thinking";
  if (value === "help" || value.startsWith("hint_")) return "help";
  if (value === "judgment") return "judgment";
  if (value === "transfer") return "transfer";
  if (value === "reflection") return "reflection";
  if (value === "completed" || value === "complete") return "completed";
  return value;
}

function stageIndex(stage) {
  return ({ initial_thinking: 0, help: 1, judgment: 2, transfer: 3, reflection: 4, completed: 5 })[canonicalStage(stage)] ?? 0;
}

function updateStepper() {
  const stage = state.session ? canonicalStage(state.session.stage) : "initial_thinking";
  const current = stageIndex(stage);
  $$("#stepper li").forEach((item, index) => {
    item.classList.toggle("is-current", index === Math.min(current, 4) && stage !== "completed");
    item.classList.toggle("is-done", index < current || stage === "completed");
  });
  $("#anonymousId").textContent = state.session?.anonymousId || state.session?.anonymous_id || "尚未建立匿名会话";
}

function responseEvaluation(result) {
  if (Object.prototype.hasOwnProperty.call(result || {}, "evaluation")) return result.evaluation;
  if (result?.decision || result?.feedback || result?.matchedIdeas || result?.coreIssue || result?.nextPrompt) return result;
  return result?.session?.evaluation || result?.session?.lastEvaluation || null;
}

function acceptResponse(result) {
  if (!result || typeof result !== "object") return;
  const hadSession = Boolean(state.session);
  const previousStage = canonicalStage(state.session?.stage);
  if (result.session) state.session = result.session;
  const returnedTask = result.task || result.session?.task || result.session?.learningTask;
  if (returnedTask) applyTask(returnedTask);
  const evaluation = responseEvaluation(result);
  state.evaluation = evaluation;
  state.lastReply = result.reply || null;
  state.summary = result.summary || result.session?.summary || state.summary;
  state.learningOutcome = result.learningOutcome || result.session?.learningOutcome || state.learningOutcome;
  state.lastResult = result;
  if (state.session && (!hadSession || previousStage !== canonicalStage(state.session.stage))) {
    state.mobileScreen = "learning";
    mobileFlowState.scroll.learning = 0;
  }
}

const mobileFlowState = {
  bound: false,
  pointer: null,
  scroll: { topic: 0, learning: 0 },
  restoringScroll: false,
  scrollEpoch: 0,
  resizeObserver: null,
  mediaQuery: null
};

function isMobileViewport() {
  return typeof window !== "undefined" && (window.matchMedia?.("(max-width: 700px)")?.matches ?? window.innerWidth <= 700);
}

function activeMobileScreen() {
  return state.mobileScreen === "learning" && state.session ? "learning" : "topic";
}

function syncMobileTrackHeight() {
  const flow = $("#mobileFlow");
  const active = $(activeMobileScreen() === "learning" ? "#mobileLearning" : "#mobileTopic");
  if (!flow || !active || !isMobileViewport()) {
    flow?.style.removeProperty("--mobile-track-height");
    return;
  }
  const minimum = Math.max(0, window.innerHeight - 76);
  flow.style.setProperty("--mobile-track-height", `${Math.max(active.scrollHeight, minimum)}px`);
}

function updateMobileFlowA11y() {
  const flow = $("#mobileFlow");
  const topic = $("#mobileTopic");
  const learning = $("#mobileLearning");
  if (!flow || !topic || !learning) return;
  const mobile = isMobileViewport();
  const current = activeMobileScreen();
  flow.dataset.screen = current;
  const topicHidden = mobile && current !== "topic";
  const learningHidden = mobile && current !== "learning";
  topic.setAttribute("aria-hidden", String(topicHidden));
  learning.setAttribute("aria-hidden", String(learningHidden));
  topic.inert = topicHidden;
  learning.inert = learningHidden;
  const next = $("#mobileTopicNext");
  const hint = $("#mobileTopicHint");
  if (next) next.hidden = !state.session;
  if (hint) hint.textContent = state.session ? "题目已确认；可以回看题目，也可以进入当前阶段。" : "导入并确认题目后，可以进入当前阶段。";
  syncMobileTrackHeight();
}

function setMobileScreen(screen, { focus = false } = {}) {
  const flow = $("#mobileFlow");
  if (!flow) return;
  const target = screen === "learning" && state.session ? "learning" : "topic";
  const previous = activeMobileScreen();
  const mobile = isMobileViewport();
  if (mobile && previous !== target && !mobileFlowState.restoringScroll) mobileFlowState.scroll[previous] = window.scrollY;
  // Capture before changing page height: scroll anchoring can otherwise save
  // the previous page's clamped offset under the newly active page's name.
  const savedScroll = Math.max(0, Number(mobileFlowState.scroll[target]) || 0);
  const epoch = ++mobileFlowState.scrollEpoch;
  mobileFlowState.restoringScroll = mobile;
  state.mobileScreen = target;
  updateMobileFlowA11y();
  if (!mobile) return;
  requestAnimationFrame(() => {
    if (epoch !== mobileFlowState.scrollEpoch) return;
    syncMobileTrackHeight();
    window.scrollTo({ top: savedScroll, behavior: "instant" });
    if (focus) {
      const heading = target === "topic" ? $("#mobileTopicHeading") : $("#stageTitle");
      heading?.focus({ preventScroll: true });
    }
    requestAnimationFrame(() => {
      if (epoch === mobileFlowState.scrollEpoch) mobileFlowState.restoringScroll = false;
    });
  });
}

function mobileGestureTargetIsInteractive(target) {
  return Boolean(target?.closest?.("input, textarea, select, button, a, label, summary, [contenteditable='true'], .diagram-render, .diagram-card, .drop-zone, .answer-composer"));
}

function bindMobileFlow() {
  const flow = $("#mobileFlow");
  if (!flow || mobileFlowState.bound) return;
  mobileFlowState.bound = true;
  $("#mobileTopicNext")?.addEventListener("click", () => setMobileScreen("learning", { focus: true }));
  $("#mobileHome")?.addEventListener("click", () => setMobileScreen("topic", { focus: true }));

  flow.addEventListener("pointerdown", event => {
    if (!isMobileViewport() || mobileGestureTargetIsInteractive(event.target)) return;
    if (event.pointerType === "mouse" && event.buttons !== 1) return;
    if (event.clientX < 24 || event.clientX > window.innerWidth - 24) return;
    mobileFlowState.pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
    try { flow.setPointerCapture(event.pointerId); } catch {}
  }, { passive: true });
  flow.addEventListener("pointerup", event => {
    const start = mobileFlowState.pointer;
    mobileFlowState.pointer = null;
    if (!start || start.id !== event.pointerId || !isMobileViewport()) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (Math.abs(dx) < 48 || Math.abs(dx) <= Math.abs(dy) * 1.25) return;
    const current = activeMobileScreen();
    if (dx < 0 && current === "topic" && state.session) setMobileScreen("learning", { focus: true });
    if (dx > 0 && current === "learning") setMobileScreen("topic", { focus: true });
  }, { passive: true });
  flow.addEventListener("pointercancel", () => { mobileFlowState.pointer = null; }, { passive: true });
  window.addEventListener("scroll", () => {
    if (isMobileViewport() && !mobileFlowState.restoringScroll) mobileFlowState.scroll[activeMobileScreen()] = window.scrollY;
  }, { passive: true });
  window.addEventListener("resize", () => {
    setMobileScreen(activeMobileScreen(), { focus: false });
  }, { passive: true });
  mobileFlowState.mediaQuery = window.matchMedia?.("(max-width: 700px)");
  mobileFlowState.mediaQuery?.addEventListener?.("change", () => setMobileScreen(activeMobileScreen(), { focus: false }));
  if (typeof ResizeObserver === "function") {
    mobileFlowState.resizeObserver = new ResizeObserver(() => syncMobileTrackHeight());
    mobileFlowState.resizeObserver.observe($("#mobileTopic"));
    mobileFlowState.resizeObserver.observe($("#mobileLearning"));
  }
  updateMobileFlowA11y();
}

function renderStudent() {
  updateStepper();
  const stage = canonicalStage(state.session?.stage);
  const titles = { initial_thinking: "先思：整理题目骨架", help: "求助：让卡点变小", judgment: "判别：核验AI建议", transfer: "迁移：换题独立完成", reflection: "反思：把方法带走", completed: "完成：看见自己的推理" };
  $("#stageTitle").textContent = titles[stage] || "先从一道题开始";
  const shell = $("#studentShell");
  shell?.classList.toggle("has-session", Boolean(state.session));
  shell?.classList.toggle("no-session", !state.session);
  let html;
  if (!state.session) html = "";
  else if (stage === "initial_thinking") html = initialTemplate();
  else if (stage === "help") html = helpTemplate();
  else if (stage === "judgment") html = judgmentTemplate();
  else if (stage === "transfer") html = transferTemplate();
  else if (stage === "reflection") html = reflectionTemplate();
  else if (stage === "completed") html = completedTemplate();
  else html = `<section class="stage-card"><h3>正在同步学习状态</h3><p>当前阶段暂时无法识别，请刷新后重试。</p><button class="secondary" id="refreshSession" type="button">重新读取</button></section>`;
  $("#topicImportContent").innerHTML = state.session ? "" : importTemplate();
  $("#studentContent").innerHTML = stage === "completed" ? html : `${taskReviewMarkup()}${html}`;
  if (state.task) applyTask(state.task, state.problemImage?.dataUrl);
  else {
    $("#problemEmpty").hidden = false;
    $("#problemSummary").hidden = true;
  }
  bindForms();
  restoreFormDrafts();
  if (stage === "transfer") drawDiagram($("#transferDiagram"), transferTask().diagramSpec || transferTask().diagram || state.task?.diagramSpec);
  renderMath();
  setMobileScreen(activeMobileScreen(), { focus: false });
}

function bindProblemForm() {
  const form = $("#problemForm");
  if (!form) return;
  wireImageInput({
    inputs: [$("#problemImage-gallery")],
    preview: $("#problemImagePreview"),
    status: $("#problemUploadStatus"),
    clear: $("#problemImageClear"),
    key: "problem",
    onImage: () => { $("#problemUploadPreview").hidden = false; }
  });
  if (state.problemImage) {
    $("#problemUploadPreview").hidden = false;
    $("#problemImagePreview").src = state.problemImage.dataUrl;
    $("#problemImagePreview").hidden = false;
    $("#problemUploadStatus").textContent = imageStatusText(state.problemImage);
    $("#problemImageClear").hidden = false;
  }
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (state.imageBusy) return toast("图片还在处理中，请稍候。", true);
    const values = Object.fromEntries(new FormData(form));
    if (!values.grade) return toast("请先选择年级。", true);
    if (!String(values.problemText || "").trim() && !state.problemImage) return toast("请至少输入题目文字或选择一张题目图片。", true);
    setBusy(form, true, "正在识别题目…");
    state.grade = values.grade;
    try {
      const result = await api("/api/problem/analyze", { method: "POST", body: JSON.stringify({ grade: values.grade, problemText: String(values.problemText || "").trim(), imageData: state.problemImage?.dataUrl || undefined }) });
      state.draftId = asText(result.draftId || result.id);
      state.lastAnalysis = result;
      state.draft = draftFrom(result.draft || result);
      renderStudent();
      $("#draftEditor")?.scrollIntoView({ behavior: "smooth", block: "start" });
      toast(result.decision === "clearer_input" || result.needsClarification ? asText(result.clarification, "请重新拍摄或补充文字。") : "题目识别完成，请检查识别稿。", Boolean(result.decision === "clearer_input" || result.needsClarification));
    } catch (error) {
      toast(error.message, true);
      setBusy(form, false);
      showRequestError(form, "题目识别", error, () => form.requestSubmit());
    }
  });
}

function applyModelStatus(status) {
  state.modelStatus = status;
  const pill = $("#apiStatus");
  const configured = Boolean(status?.configured);
  pill.classList.toggle("is-live", configured);
  pill.classList.toggle("is-offline", !configured);
  pill.querySelector("span:last-child").textContent = configured ? "AI服务可用" : "AI服务暂不可用 · 请填写密钥";
}

function bindAiConfigForm() {
  const form = $("#aiConfigForm");
  if (!form) return;
  const input = $("#apiKeyInput");
  const toggle = $("#toggleApiKey");
  toggle?.addEventListener("click", () => {
    const visible = input.type === "text";
    input.type = visible ? "password" : "text";
    toggle.textContent = visible ? "显示" : "隐藏";
    toggle.setAttribute("aria-pressed", String(!visible));
    input.focus();
  });
  input?.addEventListener("blur", () => {
    const valid = String(input.value || "").trim().length >= 12 && !/\s/u.test(input.value);
    input.setCustomValidity(input.value && !valid ? "密钥格式似乎不完整，请检查是否复制完整。" : "");
  });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const apiKey = String(input.value || "").trim();
    if (apiKey.length < 12 || /\s/u.test(apiKey)) return toast("请填写完整且不含空格的API密钥。", true);
    setBusy(form, true, "正在检查连接…");
    try {
      const status = await api("/api/ai/config", { method: "POST", body: JSON.stringify({ apiKey }) });
      input.value = "";
      applyModelStatus(status);
      renderStudent();
      toast("AI连接成功，现在可以识别题目。 ");
    } catch (error) {
      input.value = "";
      setBusy(form, false);
      toast(error.message, true);
    }
  });
}

function bindDraftForm() {
  const form = $("#draftForm");
  if (!form) return;
  $("#reanalyzeProblem")?.addEventListener("click", () => {
    state.draft = null;
    state.draftId = "";
    renderStudent();
    $("#problemTextInput")?.focus();
  });
  $("#reverifyProblem")?.addEventListener("click", async event => {
    const button = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    const problemText = String(values.problemText || "").trim();
    if (!problemText) return toast("请先补充题目文字，再次核验。", true);
    button.disabled = true;
    const original = button.textContent;
    button.textContent = "正在再次核验…";
    clearRequestError(form);
    try {
      const result = await api("/api/problem/analyze", { method: "POST", body: JSON.stringify({ grade: state.grade || values.grade || "初中", problemText: [problemText, values.goal ? `学生核对的题目要求：${values.goal}` : "", values.diagramDescription ? `学生核对的图形关系：${values.diagramDescription}` : ""].filter(Boolean).join("\n"), imageData: state.problemImage?.dataUrl || undefined }) });
      state.draftId = asText(result.draftId || result.id);
      state.lastAnalysis = result;
      state.draft = draftFrom(result.draft || result);
      renderStudent();
      $("#draftEditor")?.scrollIntoView({ behavior: "smooth", block: "start" });
      toast(result.needsClarification ? asText(result.clarification, "仍需补充题目文字或重新拍摄。") : "修正稿已再次核验，请确认题目。", Boolean(result.needsClarification));
    } catch (error) {
      button.disabled = false;
      button.textContent = original;
      showRequestError(form, "修正稿核验", error, () => button.click());
    }
  });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const edits = Object.fromEntries(new FormData(form));
    const draft = { ...(state.draft || {}), ...edits };
    if (!String(draft.problemText || "").trim()) return toast("请至少补充题目文字，再确认。", true);
    if (!String(draft.goal || draft.proofGoal || "").trim()) return toast("请补充题目要求或求解目标，再确认。", true);
    if (isGeometryTask(draft) && !String(draft.diagramDescription || "").trim()) return toast("请补充图形转录，再确认。", true);
    // learningGoal is an AI teaching-plan field. Keep it in the in-memory
    // recognition snapshot only; never send it back through the draft form.
    const draftForServer = Object.fromEntries(Object.entries(draft).filter(([key]) => key !== "learningGoal"));
    setBusy(form, true, "正在生成学习任务…");
    try {
      const result = await api("/api/session", { method: "POST", body: JSON.stringify({ draftId: state.draftId || undefined, draft: draftForServer, analysis: draftForServer, ...draftForServer, grade: state.grade || draft.grade, imageData: state.problemImage?.dataUrl || undefined }) });
      acceptResponse(result);
      if (!state.session) throw new Error("服务没有返回会话，请重试。 ");
      if (!state.task) applyTask({ ...draft, grade: state.grade });
      renderStudent();
      toast(result.generation?.mode === "live-recovery"
        ? "题目已确认，开始先思。本题建议由老师复核。"
        : "题目已确认，开始先思。 ");
    } catch (error) {
      toast(error.message, true);
      setBusy(form, false);
      showRequestError(form, "生成学习任务", error, () => form.requestSubmit());
    }
  });
}

function bindAnswerImage(key) {
  wireImageInput({
    inputs: [$(`#${key}-answer-gallery`)],
    preview: $(`#${key}-answer-preview`),
    status: $(`#${key}-answer-status`),
    clear: $(`#${key}-answer-clear`),
    key,
    onImage: key === "help" ? () => updateHelpSubmitState() : undefined,
    onClear: key === "help" ? () => updateHelpSubmitState() : undefined
  });
  const image = state.answerImages[key];
  if (image) {
    const preview = $(`#${key}-answer-preview`);
    const clear = $(`#${key}-answer-clear`);
    const status = $(`#${key}-answer-status`);
    preview.src = image.dataUrl; preview.hidden = false; clear.hidden = false; status.textContent = imageStatusText(image);
  }
}

function formAnswer(form, key, textName = "text") {
  const text = String(form.elements.namedItem(textName)?.value || "").trim();
  const image = state.answerImages[key];
  return { text, imageData: image?.dataUrl || undefined, image };
}

function clearAnswerImageIfAdvanced(key, beforeStage) {
  if (canonicalStage(state.session?.stage) !== beforeStage) {
    state.answerImages[key] = null;
    delete state.formDrafts[key];
  }
}

function rememberFormDraft(key, draft) {
  state.formDrafts[key] = { ...(state.formDrafts[key] || {}), ...draft };
}

function restoreFormDrafts() {
  const initial = state.formDrafts.initial;
  if (initial) {
    if ($("#initialKnown") && initial.known !== undefined) $("#initialKnown").value = initial.known;
    if ($("#initialGoal") && initial.goal !== undefined) $("#initialGoal").value = initial.goal;
    if ($("#initial-answer-text") && initial.text !== undefined) $("#initial-answer-text").value = initial.text;
  }
  for (const key of ["help", "judgment", "transfer", "reflection"]) {
    const draft = state.formDrafts[key];
    const input = $(`#${key}-answer-text`);
    if (draft && input && draft.text !== undefined) input.value = draft.text;
  }
  const helpDraft = state.formDrafts.help;
  if (helpDraft?.selectedOptionId) {
    const selected = document.querySelector(`#helpForm input[name="selectedStuckPointId"][value="${CSS.escape(helpDraft.selectedOptionId)}"]`);
    if (selected) selected.checked = true;
  }
  const helpInputPanel = $("#helpInputPanel");
  if (helpInputPanel && helpDraft?.supplementOpen) helpInputPanel.open = true;
  if (state.formDrafts.judgment?.verdict) {
    const selected = document.querySelector(`#judgmentForm input[name="verdict"][value="${CSS.escape(state.formDrafts.judgment.verdict)}"]`);
    if (selected) selected.checked = true;
  }
  const reflection = state.formDrafts.reflection;
  if (reflection) {
    for (const field of ["selfWork", "aiHelp", "nextTime"]) {
      const input = $(`#${field}`);
      if (input && reflection[field] !== undefined) input.value = reflection[field];
    }
  }
  updateHelpSubmitState();
}

function updateHelpSubmitState() {
  const form = $("#helpForm");
  if (!form) return;
  const selected = String(form.elements.namedItem("selectedStuckPointId")?.value || "").trim();
  const text = String(form.elements.namedItem("text")?.value || "").trim();
  const hasInput = Boolean(selected || text || state.answerImages.help);
  const busy = form.dataset.busy === "true" || state.imageBusy;
  const primary = $("#helpPrimarySubmit");
  const teacher = $("#requestTeacherHelp");
  const finish = $("#finishHelp");
  if (primary) primary.disabled = busy || !hasInput;
  if (teacher) teacher.disabled = busy || !hasInput;
  if (finish) finish.disabled = busy || (!text && !state.answerImages.help);
}

function setHelpBusy(form, busy, label = "处理中…") {
  if (!form) return;
  setBusy(form, busy, label);
  form.querySelectorAll("input, textarea").forEach(control => { control.disabled = busy; });
  form.querySelectorAll("summary").forEach(summary => {
    summary.setAttribute("aria-disabled", String(busy));
    summary.tabIndex = busy ? -1 : 0;
  });
  updateHelpSubmitState();
}

async function recoverHelpSelection(error) {
  const sessionId = state.session?.id;
  if (!sessionId) throw error;
  const draft = { ...(state.formDrafts.help || {}) };
  const snapshot = await api(`/api/session/${encodeURIComponent(sessionId)}`);
  acceptResponse(snapshot);
  // The selected id is the only stale part. Keep the unconfirmed text, image,
  // and disclosure state so a student can choose from the refreshed round.
  state.formDrafts.help = { ...draft, selectedOptionId: "" };
  renderStudent();
  $("#helpStageHeading")?.focus({ preventScroll: true });
  toast("这轮卡点已更新，请重新选择");
}

function initialFormAnswer(form) {
  const known = String(form.elements.namedItem("known")?.value || "").trim();
  const goal = String(form.elements.namedItem("goal")?.value || "").trim();
  const supplement = formAnswer(form, "initial");
  const text = [known ? `已知：${known}` : "", goal ? `求证：${goal}` : "", supplement.text].filter(Boolean).join("\n");
  return { ...supplement, known, goal, text };
}

function hasAnswer(answer) {
  return Boolean(answer.text || answer.imageData);
}

function bindForms() {
  bindAiConfigForm();
  bindProblemForm();
  bindDraftForm();
  const answerForms = ["initialForm", "helpForm", "judgmentForm", "transferForm", "reflectionForm"];
  answerForms.forEach(id => {
    const form = $(`#${id}`);
    if (!form) return;
    const key = id.replace("Form", "");
    bindAnswerImage(key);
  });
  $("#initialForm")?.addEventListener("submit", async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const beforeStage = canonicalStage(state.session?.stage);
    if (state.imageBusy) return toast("图片还在处理中，请稍候。", true);
    const answer = initialFormAnswer(form);
    const stuckPoint = String(form.elements.stuckPoint?.value || "").trim();
    if (!stuckPoint && (!answer.goal || (!answer.imageData && !answer.known))) return toast(answer.imageData ? "手写图可以代替已知条件，但请确认并填写求解目标。" : "请分别填写题目条件和求解目标，或上传一张自己的手写整理图。", true);
    rememberFormDraft("initial", { known: answer.known, goal: answer.goal, text: answer.text });
    setBusy(form, true, "正在检查题目骨架…");
    try {
      const result = await api(`/api/session/${encodeURIComponent(state.session.id)}/initial`, { method: "POST", body: JSON.stringify({ text: answer.text, known: answer.known, goal: answer.goal, imageData: answer.imageData, ...(stuckPoint ? { stuckPoint } : {}) }) });
      acceptResponse(result); clearAnswerImageIfAdvanced("initial", beforeStage); renderStudent(); toast(stuckPoint ? "卡点已记录，进入求助。" : result.evaluation?.decision === "pass" ? "题目骨架已确认，进入求助。" : "已知和求证已记录，进入求助。 ");
    } catch (error) { setBusy(form, false); toast(error.message, true); showRequestError(form, "先思核验", error, () => form.requestSubmit()); }
  });
  $("#helpForm")?.addEventListener("submit", async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const beforeStage = canonicalStage(state.session?.stage);
    if (state.imageBusy || form.dataset.busy === "true") return toast("请求正在处理中，请稍候。", true);
    const answer = formAnswer(form, "help");
    const selectedStuckPointId = String(form.elements.namedItem("selectedStuckPointId")?.value || "").trim();
    if (!selectedStuckPointId && !hasAnswer(answer)) return toast("请先选择一个卡点，或补充文字/图片。", true);
    const panel = $("#helpInputPanel");
    rememberFormDraft("help", { text: answer.text, selectedOptionId: selectedStuckPointId, supplementOpen: Boolean(panel?.open) });
    state.lastHelpAction = "hint";
    setHelpBusy(form, true, "正在生成提示…");
    try {
      const payload = {
        action: "hint",
        ...(selectedStuckPointId ? { selectedStuckPointId } : {}),
        ...(answer.text ? { text: answer.text } : {}),
        ...(answer.imageData ? { imageData: answer.imageData } : {})
      };
      const result = await api(`/api/session/${encodeURIComponent(state.session.id)}/help`, { method: "POST", body: JSON.stringify(payload) });
      acceptResponse(result);
      clearAnswerImageIfAdvanced("help", beforeStage);
      if (state.lastHelpAction === "hint" && canonicalStage(state.session?.stage) === beforeStage) {
        state.formDrafts.help = { ...(state.formDrafts.help || {}), text: "", supplementOpen: false, checkOpen: false, selectedOptionId: "" };
        state.answerImages.help = null;
      }
      const stageAfterHelp = canonicalStage(state.session?.stage);
      const reply = replyMessage(result.reply);
      renderStudent();
      if (stageAfterHelp === "help") $("#helpStageHeading")?.focus({ preventScroll: true });
      toast(stageAfterHelp !== "help" ? "求助完成，进入判别。" : reply ? "收到一个针对当前卡点的提示。" : "已记录这次求助。 ");
    } catch (error) {
      if (error?.code === "INVALID_HELP_SELECTION") {
        try {
          await recoverHelpSelection(error);
        } catch (syncError) {
          setHelpBusy(form, false);
          toast(error.message, true);
          showRequestError(form, "求助提示", error, () => form.requestSubmit());
        }
        return;
      }
      setHelpBusy(form, false);
      toast(error.message, true);
      showRequestError(form, "求助提示", error, () => form.requestSubmit());
    }
  });
  $("#helpForm")?.querySelectorAll("input[name='selectedStuckPointId']").forEach(input => input.addEventListener("change", event => {
    rememberFormDraft("help", { selectedOptionId: event.currentTarget.value });
    updateHelpSubmitState();
  }));
  $("#helpForm textarea[name='text']")?.addEventListener("input", event => {
    rememberFormDraft("help", { text: event.currentTarget.value });
    updateHelpSubmitState();
  });
  $("#helpInputPanel")?.addEventListener("toggle", event => {
    rememberFormDraft("help", { supplementOpen: event.currentTarget.open, checkOpen: event.currentTarget.open });
    $("#checkHelp")?.setAttribute("aria-expanded", String(event.currentTarget.open));
  });
  $("#checkHelp")?.addEventListener("click", event => {
    const panel = $("#helpInputPanel");
    if (!panel) return;
    panel.open = !panel.open;
    rememberFormDraft("help", { supplementOpen: panel.open, checkOpen: panel.open });
    event.currentTarget.setAttribute("aria-expanded", String(panel.open));
    if (panel.open) $("#help-answer-text")?.focus({ preventScroll: true });
  });
  $("#finishHelp")?.addEventListener("click", async event => {
    const button = event.currentTarget;
    const form = button.form;
    const beforeStage = canonicalStage(state.session?.stage);
    if (state.imageBusy || form.dataset.busy === "true") return toast("请求正在处理中，请稍候。", true);
    const answer = formAnswer(form, "help");
    if (!hasAnswer(answer)) return toast("请写一句自己的理解，或上传手写说明。", true);
    const selectedStuckPointId = String(form.elements.namedItem("selectedStuckPointId")?.value || "").trim();
    rememberFormDraft("help", { text: answer.text, selectedOptionId: selectedStuckPointId, checkOpen: true, supplementOpen: true });
    state.lastHelpAction = "finish";
    setHelpBusy(form, true, "正在核验理解…");
    try {
      const result = await api(`/api/session/${encodeURIComponent(state.session.id)}/help`, { method: "POST", body: JSON.stringify({ action: "finish", text: answer.text, imageData: answer.imageData, ...(selectedStuckPointId ? { selectedStuckPointId } : {}) }) });
      acceptResponse(result); clearAnswerImageIfAdvanced("help", beforeStage);
      const stageAfterFinish = canonicalStage(state.session?.stage);
      const followUp = replyMessage(result.reply) || asText(result.evaluation?.nextPrompt);
      renderStudent();
      if (stageAfterFinish === "help") {
        const input = $("#help-answer-text");
        if (input) input.value = answer.text;
        toast(followUp || "请先用一句话说明你为什么这样做。 ");
      }
      else toast("理解说明通过，进入判别。 ");
    } catch (error) { setHelpBusy(form, false); toast(error.message, true); showRequestError(form, "理解核验", error, () => button.click()); }
  });
  $("#understoodHelp")?.addEventListener("click", async event => {
    const button = event.currentTarget;
    const form = button.form;
    const beforeStage = canonicalStage(state.session?.stage);
    if (state.imageBusy || form.dataset.busy === "true") return toast("请求正在处理中，请稍候。", true);
    const answer = formAnswer(form, "help");
    const selectedStuckPointId = String(form.elements.namedItem("selectedStuckPointId")?.value || "").trim();
    rememberFormDraft("help", { text: answer.text, selectedOptionId: selectedStuckPointId });
    state.lastHelpAction = "understood";
    setHelpBusy(form, true, "正在进入判别…");
    try {
      const result = await api(`/api/session/${encodeURIComponent(state.session.id)}/help`, { method: "POST", body: JSON.stringify({ action: "understood", text: "我懂了", ...(selectedStuckPointId ? { selectedStuckPointId } : {}) }) });
      acceptResponse(result); clearAnswerImageIfAdvanced("help", beforeStage);
      renderStudent();
      toast("已进入判别，请核验AI建议。 ");
    } catch (error) { setHelpBusy(form, false); toast(error.message, true); showRequestError(form, "进入判别", error, () => button.click()); }
  });
  $("#requestTeacherHelp")?.addEventListener("click", async event => {
    const button = event.currentTarget;
    const form = button.form;
    const beforeStage = canonicalStage(state.session?.stage);
    if (state.imageBusy || form.dataset.busy === "true") return toast("请求正在处理中，请稍候。", true);
    const answer = formAnswer(form, "help");
    const selectedStuckPointId = String(form.elements.namedItem("selectedStuckPointId")?.value || "").trim();
    if (!selectedStuckPointId && !hasAnswer(answer)) return toast("请先选择一个卡点，或补充文字/图片。", true);
    rememberFormDraft("help", { text: answer.text, selectedOptionId: selectedStuckPointId });
    state.lastHelpAction = "teacher";
    setHelpBusy(form, true, "正在提交给老师…");
    try {
      const result = await api(`/api/session/${encodeURIComponent(state.session.id)}/help`, { method: "POST", body: JSON.stringify({ action: "teacher", text: answer.text, imageData: answer.imageData, ...(selectedStuckPointId ? { selectedStuckPointId } : {}) }) });
      acceptResponse(result); clearAnswerImageIfAdvanced("help", beforeStage);
      const stageAfterTeacher = canonicalStage(state.session?.stage);
      const teacherReply = replyMessage(result.reply);
      renderStudent();
      toast(stageAfterTeacher === "help" ? (teacherReply || "已提交给老师，页面会留在求助阶段。") : "已提交给老师。 ");
    } catch (error) { setHelpBusy(form, false); toast(error.message, true); showRequestError(form, "提交教师看板", error, () => button.click()); }
  });
  $("#judgmentForm")?.addEventListener("submit", async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const beforeStage = canonicalStage(state.session?.stage);
    if (state.imageBusy) return toast("图片还在处理中，请稍候。", true);
    const selected = form.elements.verdict?.value;
    const answer = formAnswer(form, "judgment", "reason");
    if (!selected) return toast("请选择合理、不合理或信息不足。", true);
    if (!hasAnswer(answer)) return toast("请写出判断理由，或上传手写理由。", true);
    rememberFormDraft("judgment", { text: answer.text, verdict: selected });
    setBusy(form, true, "正在核验判断…");
    try {
      const result = await api(`/api/session/${encodeURIComponent(state.session.id)}/judgment`, { method: "POST", body: JSON.stringify({ verdict: selected, reason: answer.text, text: answer.text, imageData: answer.imageData }) });
      acceptResponse(result); clearAnswerImageIfAdvanced("judgment", beforeStage); renderStudent(); toast(canonicalStage(state.session?.stage) === "judgment" ? "已记录判断，再看看AI反馈。" : "判断已记录，进入迁移题。 ");
    } catch (error) { setBusy(form, false); toast(error.message, true); showRequestError(form, "判别核验", error, () => form.requestSubmit()); }
  });
  $("#transferForm")?.addEventListener("submit", async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const beforeStage = canonicalStage(state.session?.stage);
    if (state.imageBusy) return toast("图片还在处理中，请稍候。", true);
    const answer = formAnswer(form, "transfer", "answer");
    if (!hasAnswer(answer)) return toast("请至少写出主要推理，或上传手写证明。", true);
    rememberFormDraft("transfer", { text: answer.text });
    setBusy(form, true, "正在判断迁移证明…");
    try {
      const result = await api(`/api/session/${encodeURIComponent(state.session.id)}/transfer`, { method: "POST", body: JSON.stringify({ answer: answer.text, text: answer.text, imageData: answer.imageData }) });
      acceptResponse(result); clearAnswerImageIfAdvanced("transfer", beforeStage); renderStudent(); toast(canonicalStage(state.session?.stage) === "transfer" ? "已记录，再根据反馈补一次。" : "迁移证明已记录，请完成反思。 ");
    } catch (error) { setBusy(form, false); toast(error.message, true); showRequestError(form, "迁移核验", error, () => form.requestSubmit()); }
  });
  $("#reflectionForm")?.addEventListener("submit", async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const beforeStage = canonicalStage(state.session?.stage);
    if (state.imageBusy) return toast("图片还在处理中，请稍候。", true);
    const selfWork = String(form.elements.selfWork?.value || "").trim();
    const aiHelp = String(form.elements.aiHelp?.value || "").trim();
    const nextTime = String(form.elements.nextTime?.value || "").trim();
    const answer = formAnswer(form, "reflection", "text");
    if (!selfWork && !aiHelp && !nextTime && !answer.text && !answer.imageData) return toast("请至少完成一段反思，或上传一张手写反思图。", true);
    rememberFormDraft("reflection", { text: answer.text, selfWork, aiHelp, nextTime });
    setBusy(form, true, "正在整理学习摘要…");
    try {
      const result = await api(`/api/session/${encodeURIComponent(state.session.id)}/reflection`, { method: "POST", body: JSON.stringify({ selfWork, aiHelp, nextTime, text: answer.text, imageData: answer.imageData }) });
      acceptResponse(result); clearAnswerImageIfAdvanced("reflection", beforeStage); renderStudent(); toast(canonicalStage(state.session?.stage) === "completed" ? "五步学习已完成。" : "请根据反馈补充反思，当前作答仍保留。");
    } catch (error) { setBusy(form, false); toast(error.message, true); showRequestError(form, "反思整理", error, () => form.requestSubmit()); }
  });
  $("#newSession")?.addEventListener("click", () => {
    mobileFlowState.scroll = { topic: 0, learning: 0 };
    state.task = null; state.session = null; state.draft = null; state.draftId = ""; state.grade = ""; state.problemImage = null; state.answerImages = {}; state.formDrafts = Object.create(null); state.imageJobs = Object.create(null); state.imageBusy = false; state.evaluation = null; state.lastReply = null; state.summary = null; state.learningOutcome = null; state.lastResult = null; state.mobileScreen = "topic";
    $("#problemEmpty").hidden = false; $("#problemSummary").hidden = true;
    renderStudent();
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
  $("#refreshSession")?.addEventListener("click", () => renderStudent());
}

async function updateStatus() {
  const wasUnknown = state.modelStatus === null;
  try {
    const status = await api("/api/status");
    applyModelStatus(status);
    if (wasUnknown && !state.session) renderStudent();
  } catch {
    const pill = $("#apiStatus");
    pill.classList.add("is-offline");
    pill.querySelector("span:last-child").textContent = "本地服务不可用";
  }
}

state.lastAnalysis = null;
state.lastResult = null;
bindMobileFlow();
renderStudent();
updateStatus();
