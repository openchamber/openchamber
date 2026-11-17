import type { Session } from "@/lib/opencode/model"

export const selectNewChildSessions = (
  listed: readonly Session[],
  existingIds: ReadonlySet<string>,
  parentIds: ReadonlySet<string>,
  isKnownArchived: (sessionId: string) => boolean,
): Session[] => {
  const children: Session[] = []
  for (const session of listed) {
    if (!session?.id || existingIds.has(session.id)) continue
    const parentId = session.parentID
    if (!parentId || !parentIds.has(parentId)) continue
    if (isKnownArchived(session.id)) continue
    children.push(session)
  }
  return children
}
