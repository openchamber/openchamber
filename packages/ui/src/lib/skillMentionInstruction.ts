const INSTRUCTION_PREFIX = "The user explicitly mentioned these skills in their message: "
const INSTRUCTION_SUFFIX = ". Use the corresponding skill tool when it is relevant to accomplishing the user's request."

/**
 * Names skills in an instruction for the model. The fallback for skills that
 * cannot be attached to the prompt: queued messages (delivered later by the
 * server or the VS Code auto-send), the command route, and attachments
 * OpenCode rejected.
 */
export const buildSkillMentionInstruction = (skillNames: readonly string[]): string | null => {
  if (skillNames.length === 0) return null
  const formatted = skillNames.map((name) => `$${name}`).join(", ")
  return `${INSTRUCTION_PREFIX}${formatted}${INSTRUCTION_SUFFIX}`
}

/**
 * The skill tokens an instruction built by `buildSkillMentionInstruction`
 * names, or null for text this builder did not produce. Lets a queued
 * instruction stored without its skill ids be checked again on delivery.
 */
export const parseSkillMentionInstruction = (text: string): string[] | null => {
  if (!text.startsWith(INSTRUCTION_PREFIX) || !text.endsWith(INSTRUCTION_SUFFIX)) return null
  const list = text.slice(INSTRUCTION_PREFIX.length, text.length - INSTRUCTION_SUFFIX.length)
  const tokens = list.split(", ")
  if (tokens.some((token) => token.length < 2 || !token.startsWith("$"))) return null
  return tokens.map((token) => token.slice(1))
}
