import type { Session } from "@/lib/opencode/model"

type BlockingRequest = { id: string }

const NO_CHILDREN: readonly Session[] = []

const childrenByParentCache = new WeakMap<readonly Session[], ReadonlyMap<string, readonly Session[]>>()

const readChildrenByParent = (sessions: readonly Session[]): ReadonlyMap<string, readonly Session[]> => {
  const cached = childrenByParentCache.get(sessions)
  if (cached) return cached
  const childrenByParent = new Map<string, Session[]>()
  for (const session of sessions) {
    if (!session.parentID) continue
    const list = childrenByParent.get(session.parentID)
    if (list) list.push(session)
    else childrenByParent.set(session.parentID, [session])
  }
  childrenByParentCache.set(sessions, childrenByParent)
  return childrenByParent
}

export const readChildSessions = (sessions: readonly Session[], parentId: string): readonly Session[] => (
  readChildrenByParent(sessions).get(parentId) ?? NO_CHILDREN
)

export const computeSubtreeIds = (sessions: readonly Session[], rootId: string): Set<string> => {
  const childrenByParent = readChildrenByParent(sessions)
  const ids = new Set<string>([rootId])
  const queue = [rootId]
  for (const id of queue) {
    const children = childrenByParent.get(id)
    if (!children) continue
    for (const child of children) {
      if (ids.has(child.id)) continue
      ids.add(child.id)
      queue.push(child.id)
    }
  }
  return ids
}

export const areRequestArraysReferentiallyEqual = <T extends BlockingRequest>(left: T[], right: T[]): boolean => {
  if (left === right) return true
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

const hasAnyRequest = <T>(requestsBySession: Record<string, T[] | undefined>): boolean => {
  for (const sessionID in requestsBySession) {
    if (requestsBySession[sessionID]?.length) return true
  }
  return false
}

export const collectScopedBlockingRequests = <T extends BlockingRequest>(
  sessions: Session[],
  requestsBySession: Record<string, T[] | undefined>,
  sessionID: string | null,
  empty: T[],
): T[] => {
  if (!sessionID || !hasAnyRequest(requestsBySession)) return empty

  const scopedIds = computeSubtreeIds(sessions, sessionID)
  if (scopedIds.size === 0) return empty

  const seen = new Set<string>()
  const result: T[] = []
  for (const id of scopedIds) {
    const entries = requestsBySession[id]
    if (!entries) continue
    for (const entry of entries) {
      if (seen.has(entry.id)) continue
      seen.add(entry.id)
      result.push(entry)
    }
  }

  return result.length === 0 ? empty : result
}
