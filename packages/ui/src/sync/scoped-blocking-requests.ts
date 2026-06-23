import type { Session } from "@opencode-ai/sdk/v2"

type BlockingRequest = { id: string }

export const computeSubtreeIds = (sessions: Session[], rootId: string): Set<string> => {
  const childrenByParent = new Map<string, string[]>()
  for (const session of sessions) {
    if (!session.parentID) continue
    const list = childrenByParent.get(session.parentID) ?? []
    list.push(session.id)
    childrenByParent.set(session.parentID, list)
  }

  const ids = new Set<string>([rootId])
  const queue = [rootId]
  for (const id of queue) {
    const children = childrenByParent.get(id)
    if (!children) continue
    for (const childId of children) {
      if (ids.has(childId)) continue
      ids.add(childId)
      queue.push(childId)
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

export const collectScopedBlockingRequests = <T extends BlockingRequest>(
  sessions: Session[],
  requestsBySession: Record<string, T[] | undefined>,
  sessionID: string | null,
  empty: T[],
): T[] => {
  if (!sessionID) return empty

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
