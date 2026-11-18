const DIRECT_ANSWER_PATTERNS = [
  /直接.{0,4}(答案|证明|过程)/u,
  /(完整|全部).{0,4}(答案|证明|过程)/u,
  /把.{0,4}(答案|证明|过程).{0,5}(全部|完整|写出来)/u,
  /(帮我|替我).{0,5}(写完|做完|证明)/u,
  /不要提示.{0,6}(答案|结果)/u,
  /只要.{0,4}(答案|证明)/u
];

const PERSONAL_INFO_PATTERNS = [
  /1\d{10}/u,
  /\b\d{15,18}[Xx]?\b/u,
  /(?:微信|手机号|身份证|住址|家庭地址)[:：]?/u
];

const STRONG_GEOMETRY_INPUT_PATTERNS = [
  /三角形面积(?:公式)?/u,
  /三角形.{0,8}(?:高和底|底和高|面积)/u,
  /(?:高和底|底和高).{0,8}(?:三角形|面积)/u
];

const GEOMETRY_TASK_PATTERN = /几何|三角形|全等|相似|垂直|平行|角平分线|中点|圆|面积|体积/u;

function taskText(task = {}) {
  return [
    task.subject,
    task.problemType,
    task.title,
    task.problemText,
    task.goal,
    task.proofGoal,
    task.learningGoal
  ].filter(Boolean).join(" ");
}

export function classifyStudentInput(text, context = {}) {
  const normalized = String(text || "").trim();
  const task = context?.task || context || {};
  const currentTaskText = taskText(task);
  const geometryTask = task.isGeometryProof === true || GEOMETRY_TASK_PATTERN.test(currentTaskText);
  const offTopic = Boolean(normalized && !geometryTask && STRONG_GEOMETRY_INPUT_PATTERNS.some(pattern => pattern.test(normalized)));
  return {
    directAnswerRequest: DIRECT_ANSWER_PATTERNS.some(pattern => pattern.test(normalized)),
    personalInfo: PERSONAL_INFO_PATTERNS.some(pattern => pattern.test(normalized)),
    irrelevant: normalized.length > 0 && !/[角边点线三角形全等垂直中点证明条件已知目标判定SSSASAU证明答提示不会不懂数量温度路面草坪分数小数百分比比例方程未知数代数函数概率统计平均数面积体积速度时间路程利润折扣单价总价计算求解关系公式单位元米千克摄氏度]/iu.test(normalized),
    offTopic,
    offTopicReason: offTopic ? "你提到的是三角形面积公式，但这道题要处理的是题目给出的数量和比例关系。" : ""
  };
}

export function isHelpCompletionSignal(text) {
  const normalized = String(text || "")
    .trim()
    .replace(/[，。；：、,.!！?？\s]/g, "");
  if (!normalized || /(不懂|没懂|没有懂|还不明白|不明白|不会|还需要|继续提示)/u.test(normalized)) return false;
  return /^(?:(?:我)?(?:已经)?(?:懂了|明白了|理解了|会了)(?:可以(?:继续|进入下一步))?|(?:我)?可以继续了?|进入下一步|(?:我)?不需要(?:更多)?提示了?)$/u.test(normalized);
}

function normalizeMath(text) {
  return String(text || "")
    .replace(/\s+/g, "")
    .replace(/[，。；：、,.!！?？()（）]/g, "")
    .replace(/⊥/g, "垂直")
    .replace(/≌/g, "全等")
    .toLowerCase();
}

export function detectLeak(text, task) {
  const normalized = normalizeMath(text);
  const hits = (task.protectedPhrases || []).filter(phrase => normalized.includes(normalizeMath(phrase)));
  const tooLong = String(text || "").length > 260;
  const multiStep = (String(text || "").match(/(?:所以|因此|从而|∴|=>|→)/g) || []).length >= 2;
  return { leaked: hits.length > 0 || tooLong || multiStep, hits, tooLong, multiStep };
}

export function safeFallback(task, level = 1) {
  const list = task.safeFallbacks || [];
  return list[Math.max(0, Math.min(list.length - 1, level - 1))] || "请先写出你当前能确定的一条数学关系。";
}

export function redactPersonalInfo(text) {
  return String(text || "")
    .replace(/1\d{10}/g, "[手机号已隐藏]")
    .replace(/\b\d{15,18}[Xx]?\b/g, "[证件号已隐藏]");
}
