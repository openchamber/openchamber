import type { Session } from "@opencode-ai/sdk/v2/client"

/**
 * Pick the children a discovery listing adds to a directory store.
 *
 * The listing asks the server for active children only, but it is a plain
 * request with no ordering against local mutations: a response that left the
 * server before the user archived a parent still carries the children without
 * `time.archived`, and adding them back would show them as active orphans until
 * the next refresh. The global sessions cache learns about an archive before
 * the archive action resolves, so a child it already lists as archived is a
 * stale copy and is dropped here. Credit for spotting the race: #2580.
 */
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
