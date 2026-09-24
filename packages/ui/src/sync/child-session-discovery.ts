import type { Session } from "@/lib/opencode/model"
import { normalizeProjectPath } from "@/lib/projectResolution"

export const childSessionsInDirectory = (sessions: readonly Session[], directory: string): Session[] => {
  const owner = normalizeProjectPath(directory)
  return sessions.filter((session) => normalizeProjectPath(session.directory) === owner)
}

export const newlyDiscoveredChildParents = (
  sessions: readonly Session[],
  knownSessions: ReadonlyMap<string, Pick<Session, "parentID" | "directory">>,
): Set<string> => {
  const parents = new Set<string>()
  for (const session of sessions) {
    const known = knownSessions.get(session.id)
    if (session.parentID && (known?.parentID !== session.parentID || known.directory !== session.directory)) parents.add(session.parentID)
  }
  return parents
}

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
