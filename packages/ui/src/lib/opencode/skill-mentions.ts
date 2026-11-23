export type SkillAttachmentRef = { id: string; name: string }

export const matchSkillMentions = (names: readonly string[], known: readonly SkillAttachmentRef[]) => {
  const attached: SkillAttachmentRef[] = []
  const unresolved: string[] = []
  for (const name of names) {
    const match = known.find((skill) => skill.name === name) ?? known.find((skill) => skill.id === name)
    if (!match) unresolved.push(name)
    else if (!attached.some((skill) => skill.id === match.id)) attached.push({ id: match.id, name })
  }
  return { attached, unresolved }
}
