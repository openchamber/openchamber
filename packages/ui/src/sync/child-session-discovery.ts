import type { Session } from "@/lib/opencode/model"

export const selectNewChildSessions = (
  listed: readonly Session[],
  existingIds: ReadonlySet<string>,
  parentIds: ReadonlySet<string>,
  isKnownArchived: (sessionId: string) => boolean,
): Session[] => {
  const childrenByParent = new Map<string, Session[]>()
  for (const session of listed) {
    if (!session?.id || !session.parentID) continue
    const siblings = childrenByParent.get(session.parentID)
    if (siblings) siblings.push(session)
    else childrenByParent.set(session.parentID, [session])
  }
  const added: Session[] = []
  const visited = new Set(parentIds)
  const queue = [...parentIds]
  for (const parentId of queue) {
    if (isKnownArchived(parentId)) continue
    for (const session of childrenByParent.get(parentId) ?? []) {
      if (visited.has(session.id) || isKnownArchived(session.id)) continue
      visited.add(session.id)
      queue.push(session.id)
      if (!existingIds.has(session.id)) added.push(session)
    }
  }
  return added
}
