import React, { useRef, useCallback } from "react"
import type { Session, SessionStatus } from "@/lib/opencode/model"
import { ChildStoreManager } from "./child-store"
import { aggregateLiveSessions, aggregateLiveSessionStatuses, areSessionListsEquivalent, areStatusMapsEquivalent, findLiveSession } from "./live-aggregate"
import { countSyncPerformance } from "./performance-diagnostics"
import { getAllSyncSessions } from "./sync-refs"
import type { State } from "./types"
import { useSyncRuntime } from "./sync-runtime-context"
import { useDirectorySync, useDirectoryStore } from "./directory-sync-hooks"

function getLiveStates(childStores: ChildStoreManager): State[] {
  return Array.from(childStores.children.values(), (store) => store.getState())
}

function useLiveSyncSelector<T>(
  selector: (states: State[]) => T,
  isEqual: (left: T, right: T) => boolean = Object.is,
  subscribe?: (childStores: ChildStoreManager, notify: () => void) => () => void,
): T {
  const { childStores } = useSyncRuntime()
  const sourceRevisionRef = useRef(0)
  const cacheRef = useRef<{
    childStores: ChildStoreManager
    selector: (states: State[]) => T
    revision: number
    value: T
  } | null>(null)

  const getSnapshot = useCallback(() => {
    const cached = cacheRef.current
    if (
      cached
      && cached.childStores === childStores
      && cached.selector === selector
      && cached.revision === sourceRevisionRef.current
    ) {
      return cached.value
    }
    const next = selector(getLiveStates(childStores))
    const value = cached && isEqual(cached.value, next) ? cached.value : next
    cacheRef.current = { childStores, selector, revision: sourceRevisionRef.current, value }
    return value
  }, [childStores, isEqual, selector])

  const subscribeToSource = useCallback((notify: () => void) => {
    const invalidate = () => {
      sourceRevisionRef.current += 1
      notify()
    }
    sourceRevisionRef.current += 1
    return subscribe ? subscribe(childStores, invalidate) : childStores.subscribeAll(invalidate)
  }, [childStores, subscribe])

  return React.useSyncExternalStore(
    subscribeToSource,
    getSnapshot,
    getSnapshot,
  )
}

export function useAllSessionStatuses(): Record<string, SessionStatus> {
  return useLiveSyncSelector(
    useCallback((states) => aggregateLiveSessionStatuses(states), []),
    areStatusMapsEquivalent,
    useCallback(
      (childStores: ChildStoreManager, notify: () => void) => childStores.subscribeAllSelected(
        (state: State) => state.session_status,
        notify,
      ),
      [],
    ),
  )
}

const subscribeLiveSessionLists = (childStores: ChildStoreManager, notify: () => void) => childStores.subscribeAllSelected(
  (state: State) => state.session,
  notify,
)

export function useAllLiveSessions(): Session[] {
  return useLiveSyncSelector(
    useCallback((states) => {
      countSyncPerformance("liveSessionAggregateRuns")
      return aggregateLiveSessions(states)
    }, []),
    areSessionListsEquivalent,
    subscribeLiveSessionLists,
  )
}

const EMPTY_LIVE_SESSIONS: Session[] = []

export function useLiveSessionsExcluding(excludedIds: ReadonlySet<string>): Session[] {
  return useLiveSyncSelector(
    useCallback((states) => {
      countSyncPerformance("liveSessionAggregateRuns")
      const sessions = aggregateLiveSessions(states).filter((session) => !excludedIds.has(session.id))
      return sessions.length === 0 ? EMPTY_LIVE_SESSIONS : sessions
    }, [excludedIds]),
    areSessionListsEquivalent,
    subscribeLiveSessionLists,
  )
}

export function useSessions(directory?: string) {
  return useDirectorySync(
    useCallback((state: State) => state.session, []),
    directory,
  )
}

const haveSameStartTimes = (left: ReadonlyMap<string, number>, right: ReadonlyMap<string, number>): boolean => {
  if (left === right) return true
  if (left.size !== right.size) return false
  for (const [sessionID, created] of left) {
    if (right.get(sessionID) !== created) return false
  }
  return true
}

const listsHaveSameStartTimes = (left: State["session"], right: State["session"]): boolean => {
  if (left === right) return true
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (left[index].id !== right[index].id || left[index].time.created !== right[index].time.created) return false
  }
  return true
}

export function useSessionStartTimes(directory?: string): ReadonlyMap<string, number> {
  const store = useDirectoryStore(directory)
  const cacheRef = useRef<{ sessions: State["session"]; startTimes: ReadonlyMap<string, number> } | null>(null)
  const getSnapshot = useCallback(() => {
    const sessions = store.getState().session
    const cached = cacheRef.current
    if (cached && listsHaveSameStartTimes(cached.sessions, sessions)) {
      cached.sessions = sessions
      return cached.startTimes
    }
    const next: ReadonlyMap<string, number> = new Map(sessions.map((session) => [session.id, session.time.created]))
    const startTimes = cached && haveSameStartTimes(cached.startTimes, next) ? cached.startTimes : next
    cacheRef.current = { sessions, startTimes }
    return startTimes
  }, [store])
  const subscribe = useCallback((notify: () => void) => store.subscribe((state, previous) => {
    if (state.session !== previous.session) notify()
  }), [store])
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

const sessionsByIdCache = new WeakMap<State["session"], Map<string, Session>>()

const getSessionById = (sessions: State["session"], sessionID?: string | null): Session | undefined => {
  if (!sessionID) return undefined
  let sessionsById = sessionsByIdCache.get(sessions)
  if (!sessionsById) {
    sessionsById = new Map(sessions.map((session) => [session.id, session]))
    sessionsByIdCache.set(sessions, sessionsById)
  }
  return sessionsById.get(sessionID)
}

export function useParentSession(sessionID: string | null, directory?: string): Session | null {
  return useDirectorySync(
    useCallback((state: State) => {
      if (!sessionID) return null
      const current = getSessionById(state.session, sessionID)
      if (!current?.parentID) return null
      return getSessionById(state.session, current.parentID)
        ?? getAllSyncSessions().find((s) => s.id === current.parentID)
        ?? null
    }, [sessionID]),
    directory,
  )
}

export function useSession(sessionID?: string | null, directory?: string) {
  const { childStores } = useSyncRuntime()
  const getSnapshot = useCallback(() => {
    if (directory) {
      const sessions = childStores.getChild(directory)?.getState().session
      return sessions ? getSessionById(sessions, sessionID) : undefined
    }
    return findLiveSession(getLiveStates(childStores), sessionID)
  }, [childStores, directory, sessionID])

  const subscribe = useCallback((notify: () => void) => {
    if (directory) {
      return childStores.ensureChild(directory, { bootstrap: false }).subscribe((state, previous) => {
        if (state.session !== previous.session) notify()
      })
    }
    return childStores.subscribeAllSelected((state) => state.session, notify)
  }, [childStores, directory])

  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function useSessionSelector<T>(
  sessionID: string | null | undefined,
  directory: string | undefined,
  select: (session: Session | undefined) => T,
  isEqual: (left: T, right: T) => boolean = Object.is,
): T {
  const { childStores } = useSyncRuntime()
  const cacheRef = useRef<{ value: T } | null>(null)
  const getSnapshot = useCallback(() => {
    let session: Session | undefined
    if (directory) {
      const sessions = childStores.getChild(directory)?.getState().session
      session = sessions ? getSessionById(sessions, sessionID) : undefined
    } else {
      session = findLiveSession(getLiveStates(childStores), sessionID)
    }
    const next = select(session)
    const cached = cacheRef.current
    if (cached && isEqual(cached.value, next)) return cached.value
    cacheRef.current = { value: next }
    return next
  }, [childStores, directory, isEqual, select, sessionID])

  const subscribe = useCallback((notify: () => void) => {
    if (directory) {
      return childStores.ensureChild(directory, { bootstrap: false }).subscribe((state, previous) => {
        if (state.session !== previous.session) notify()
      })
    }
    return childStores.subscribeAllSelected((state) => state.session, notify)
  }, [childStores, directory])

  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

const selectSessionDirectory = (session: Session | undefined): string | undefined => session?.directory ?? undefined

export function useSessionDirectory(sessionID?: string | null, directory?: string): string | undefined {
  return useSessionSelector(sessionID, directory, selectSessionDirectory)
}
