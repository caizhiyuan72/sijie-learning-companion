function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeStageChoice(value) {
  if (!Array.isArray(value?.options) || value.options.length < 3 || value.options.length > 4) return null;
  const options = value.options.map((option, index) => ({ id: `option-${index + 1}`, text: clean(option?.text ?? option) }));
  if (options.some(option => !option.text || option.text.length > 140) || new Set(options.map(option => option.text.replace(/\s+/g, ""))).size !== options.length) return null;
  const correctOption = Number.isInteger(value.correctIndex)
    ? options[value.correctIndex]
    : options.find(option => option.id === value.correctOptionId);
  return correctOption ? { options, correctOptionId: correctOption.id } : null;
}

export function publicStageOptions(choice, sessionId, stage) {
  const options = choice.options.map(({ id, text }) => ({ id, text }));
  const seed = stage === "transfer" ? sessionId?.slice(-6) : sessionId?.slice(-12, -6);
  const offset = (Number.parseInt(seed, 16) || 0) % options.length;
  return [...options.slice(offset), ...options.slice(0, offset)];
}

export function resolveStageChoice(choice, optionId, { verdict, correctVerdict } = {}) {
  const normalized = normalizeStageChoice(choice);
  const selected = normalized?.options.find(option => option.id === optionId);
  if (!selected) {
    throw Object.assign(new Error("请选择本题当前提供的选项。"), { status: 400, code: "INVALID_STAGE_CHOICE" });
  }
  const correct = selected.id === normalized.correctOptionId && (correctVerdict === undefined || verdict === correctVerdict);
  return {
    text: selected.text,
    evaluation: {
      decision: correct ? "pass" : "retry",
      evidence: "choice",
      feedback: correct ? "你选中了正确的依据或步骤。" : "这组选择还不成立。",
      nextPrompt: correct ? "" : "再对照题干，选出能支持判断的依据或步骤。"
    }
  };
}
