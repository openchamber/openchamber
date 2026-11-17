export const buildSkillMentionInstruction = (skillNames: readonly string[]): string | null => {
  if (skillNames.length === 0) return null
  const formatted = skillNames.map((name) => `$${name}`).join(", ")
  return `The user explicitly mentioned these skills in their message: ${formatted}. Use the corresponding skill tool when it is relevant to accomplishing the user's request.`
}
