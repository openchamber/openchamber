import type { Session } from "@opencode-ai/sdk/v2"
import type { StoreApi } from "zustand"
import {
  subscribeDirectoryPermission,
  subscribeDirectorySessionHierarchy,
  type DirectoryStore,
} from "./child-store"

type BlockingRequest = { id: string }

const childrenBySessionList = new WeakMap<Session[], Map<string, string[]>>()

const getChildrenByParent = (sessions: Session[]): Map<string, string[]> => {
  const cached = childrenBySessionList.get(sessions)
  if (cached) return cached

  const childrenByParent = new Map<string, string[]>()
  for (const session of sessions) {
    if (!session.parentID) continue
    const list = childrenByParent.get(session.parentID) ?? []
    list.push(session.id)
    childrenByParent.set(session.parentID, list)
  }
  childrenBySessionList.set(sessions, childrenByParent)
  return childrenByParent
}

export const computeSubtreeIds = (
  sessions: Session[],
  rootId: string,
  excludedRootIds: readonly string[] = [],
): Set<string> => {
  const excluded = new Set(excludedRootIds)
  const childrenByParent = getChildrenByParent(sessions)

  const ids = new Set<string>([rootId])
  const queue = [rootId]
  for (const id of queue) {
    const children = childrenByParent.get(id)
    if (!children) continue
    for (const childId of children) {
      if (excluded.has(childId)) continue
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
  excludedRootIds: readonly string[] = [],
): T[] => {
  if (!sessionID) return empty

  const scopedIds = computeSubtreeIds(sessions, sessionID, excludedRootIds)
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

export const subscribeScopedPermissionRequests = (
  store: StoreApi<DirectoryStore>,
  sessionID: string | null,
  excludedRootIds: readonly string[],
  notify: () => void,
): (() => void) => {
  if (!sessionID) return () => undefined

  let permissionUnsubscribers: Array<() => void> = []
  const resubscribe = () => {
    permissionUnsubscribers.forEach((unsubscribe) => unsubscribe())
    permissionUnsubscribers = [...computeSubtreeIds(store.getState().session, sessionID, excludedRootIds)]
      .map((id) => subscribeDirectoryPermission(store, id, notify))
  }
  resubscribe()

  const unsubscribeSessions = subscribeDirectorySessionHierarchy(store, () => {
    resubscribe()
    notify()
  })
  return () => {
    unsubscribeSessions()
    permissionUnsubscribers.forEach((unsubscribe) => unsubscribe())
  }
}
