/**
 * A deliberately small, data-only geometry drawing contract.
 *
 * Models may describe a diagram with this structure, but they never get to
 * return HTML, SVG, CSS, or arbitrary paths.  The browser can render this
 * allow-listed data with its own SVG renderer.
 */

const MAX_POINTS = 64;
const MAX_SEGMENTS = 96;
const MAX_LABELS = 64;
const MAX_ANNOTATIONS = 64;

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function number(value, fallback = null) {
  const result = typeof value === "number" ? value : Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function invalid(message) {
  const error = new Error(message);
  error.code = "INVALID_DIAGRAM_SPEC";
  error.status = 400;
  throw error;
}

function pointId(value) {
  const id = clean(value);
  return /^[A-Za-z][A-Za-z0-9]{0,7}$/.test(id) ? id : "";
}

function normalizePoint(item) {
  if (!item || typeof item !== "object") invalid("图形点必须是对象。");
  const id = pointId(item.id ?? item.name ?? item.label);
  const x = number(item.x);
  const y = number(item.y);
  if (!id || x === null || y === null || x < 0 || x > 1000 || y < 0 || y > 1000) {
    invalid("图形点需要合法名称和0—1000范围内的坐标。");
  }
  return { id, x, y, label: clean(item.label) || id };
}

function normalizeSegment(item, knownPoints) {
  if (!item || typeof item !== "object") invalid("图形线段必须是对象。");
  const from = pointId(item.from ?? item.start ?? item.a);
  const to = pointId(item.to ?? item.end ?? item.b);
  if (!from || !to || from === to || !knownPoints.has(from) || !knownPoints.has(to)) {
    invalid("图形线段只能连接已定义的两个不同点。");
  }
  const style = ["solid", "dashed", "dotted"].includes(item.style) ? item.style : "solid";
  return { from, to, style };
}

function normalizeLabel(item, knownPoints) {
  if (typeof item === "string") {
    const point = pointId(item);
    if (point && knownPoints.has(point)) return { text: point, point };
    invalid("图形文字标注引用了未定义的点。");
  }
  if (!item || typeof item !== "object") invalid("图形标注必须是对象。");
  const text = clean(item.text ?? item.label ?? item.value);
  const point = pointId(item.point ?? item.at);
  if (!text || (point && !knownPoints.has(point))) invalid("图形标注内容或锚点无效。");
  const x = number(item.x);
  const y = number(item.y);
  if (!point && (x === null || y === null || x < 0 || x > 1000 || y < 0 || y > 1000)) {
    invalid("自由图形标注需要合法坐标。");
  }
  return { text: text.slice(0, 80), ...(point ? { point } : { x, y }) };
}

function normalizeAnnotation(item, knownPoints) {
  if (!item || typeof item !== "object") invalid("图形角标注必须是对象。");
  const kind = ["right_angle", "angle", "equal_mark", "parallel_mark"].includes(item.kind)
    ? item.kind
    : "";
  if (!kind) invalid("图形标注类型不受支持。");
  const points = Array.isArray(item.points) ? item.points.map(pointId).filter(Boolean) : [];
  if (points.length && points.some(id => !knownPoints.has(id))) invalid("图形标注引用了未定义的点。");
  if (kind === "right_angle" && points.length !== 3) invalid("直角标注需要三个点。");
  if (kind === "angle" && points.length !== 3) invalid("角标注需要三个点。");
  if (kind === "equal_mark" && points.length !== 2) invalid("等长标记需要两个点。");
  if (kind === "parallel_mark" && points.length !== 4) invalid("平行标记需要四个点。");
  return { kind, points };
}

/**
 * Validate and normalize the model's diagram description.
 * Missing diagrams are represented by null; malformed supplied diagrams are
 * rejected so callers never accidentally render untrusted model output.
 */
export function normalizeDiagramSpec(input, { allowEmpty = true } = {}) {
  if (input === undefined || input === null || input === "") return allowEmpty ? null : invalid("缺少图形数据。");
  if (typeof input !== "object" || Array.isArray(input)) invalid("diagramSpec必须是结构化对象。");
  const forbidden = ["svg", "html", "markup", "path", "paths", "script", "javascript", "raw", "innerHTML"];
  if (forbidden.some(key => Object.hasOwn(input, key))) invalid("diagramSpec不能包含HTML、SVG或脚本内容。");

  const width = number(input.width, 600);
  const height = number(input.height, 420);
  if (width < 120 || width > 1600 || height < 120 || height > 1200) invalid("图形画布尺寸超出允许范围。");

  const rawPoints = Array.isArray(input.points ?? input.vertices) ? (input.points ?? input.vertices) : [];
  if (rawPoints.length > MAX_POINTS) invalid("图形点数量过多。");
  const points = rawPoints.map(normalizePoint);
  const pointSet = new Set();
  for (const point of points) {
    if (pointSet.has(point.id)) invalid("图形中不能重复定义同名点。");
    pointSet.add(point.id);
  }

  const rawSegments = Array.isArray(input.segments ?? input.lines ?? input.edges) ? (input.segments ?? input.lines ?? input.edges) : [];
  if (rawSegments.length > MAX_SEGMENTS) invalid("图形线段数量过多。");
  const segments = rawSegments.map(item => normalizeSegment(item, pointSet));

  const rawLabels = Array.isArray(input.labels) ? input.labels : [];
  if (rawLabels.length > MAX_LABELS) invalid("图形文字标注数量过多。");
  const labels = rawLabels.map(item => normalizeLabel(item, pointSet));

  const rawAnnotations = Array.isArray(input.annotations ?? input.marks) ? (input.annotations ?? input.marks) : [];
  if (rawAnnotations.length > MAX_ANNOTATIONS) invalid("图形关系标注数量过多。");
  const annotations = rawAnnotations.map(item => normalizeAnnotation(item, pointSet));

  if (!points.length && !segments.length && !labels.length && !annotations.length) {
    invalid("diagramSpec至少需要一个图形元素。");
  }
  return { width, height, points, segments, labels, annotations };
}

export function isSafeDiagramSpec(input) {
  try {
    normalizeDiagramSpec(input, { allowEmpty: true });
    return true;
  } catch {
    return false;
  }
}

/** Return a JSON-safe copy while intentionally dropping unknown properties. */
export function safeDiagramSpec(input) {
  return normalizeDiagramSpec(input, { allowEmpty: true });
}

export const diagramLimits = Object.freeze({ MAX_POINTS, MAX_SEGMENTS, MAX_LABELS, MAX_ANNOTATIONS });
