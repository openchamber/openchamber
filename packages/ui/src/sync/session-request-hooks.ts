import React, { useRef, useCallback, useMemo } from "react"
import { useStore } from "zustand"
import type { FormRequest, PermissionRequest, Session } from "@/lib/opencode/model"
import { subscribeDirectoryPermission, subscribeDirectoryPermissions, subscribeDirectoryForms } from "./child-store"
import { deriveRecoveredQuestions, useRecoverableQuestionsStore, type RecoveredQuestion } from "./recoverable-questions"
import { LOCATION_SCOPED_FORM_SESSION_ID } from "./location-scoped-forms"
import { selectIndexedBlockingRequests, useGlobalBlockingRequestsStore, type BlockingRequestKinds } from "./global-blocking-requests"
import type { State } from "./types"
import { areRequestArraysReferentiallyEqual, collectScopedBlockingRequests, computeSubtreeIds } from "./scoped-blocking-requests"
import { useDirectoryStore, useDirectorySync } from "./directory-sync-hooks"
import { EMPTY_PERMISSION_REQUESTS, EMPTY_FORM_REQUESTS } from "./sync-empty-values"
import { useSyncRuntime } from "./sync-runtime-context"

export function useSessionStatus(sessionID: string, directory?: string) {
  const store = useDirectoryStore(directory)
  const getSnapshot = useCallback(() => {
    if (!sessionID) return undefined
    return store.getState().session_status?.[sessionID]
  }, [sessionID, store])
  const subscribe = useCallback((notify: () => void) => {
    if (!sessionID) return () => undefined
    return store.subscribe((state, previous) => {
      if (state.session_status?.[sessionID] !== previous.session_status?.[sessionID]) notify()
    })
  }, [sessionID, store])
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function useSessionStatusSnapshotReady(directory?: string, sessionID?: string): boolean {
  const store = useDirectoryStore(directory)
  const getSnapshot = useCallback(() => {
    const state = store.getState()
    return state.sessionStatusReady === true && (!sessionID || !state.sessionStatusInvalidated?.[sessionID])
  }, [sessionID, store])
  const subscribe = useCallback((notify: () => void) => store.subscribe((state, previous) => {
    if (state.sessionStatusReady !== previous.sessionStatusReady
      || (sessionID && state.sessionStatusInvalidated?.[sessionID] !== previous.sessionStatusInvalidated?.[sessionID])) notify()
  }), [sessionID, store])
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function useSessionPermissions(sessionID: string, directory?: string, options?: { bootstrap?: boolean }) {
  const store = useDirectoryStore(directory, options)
  const getSnapshot = useCallback(() => {
    if (!sessionID) return EMPTY_PERMISSION_REQUESTS
    return store.getState().permission[sessionID] ?? EMPTY_PERMISSION_REQUESTS
  }, [sessionID, store])
  const subscribe = useCallback((notify: () => void) => {
    if (!sessionID) return () => undefined
    return subscribeDirectoryPermission(store, sessionID, notify)
  }, [sessionID, store])
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

const NO_SESSION_BLOCKING_REQUESTS: BlockingRequestKinds = {
  hasPermission: false,
  hasForm: false,
}

export function useSessionBlockingRequests(
  scopes: readonly { directory: string | null; sessionIDs: readonly string[] }[],
): BlockingRequestKinds {
  const { childStores } = useSyncRuntime()
  React.useEffect(() => {
    const directories = scopes.flatMap((scope) => (
      scope.directory && childStores.getChild(scope.directory) ? [scope.directory] : []
    ))
    for (const directory of directories) childStores.pin(directory)
    return () => {
      for (const directory of directories) childStores.unpin(directory)
    }
  }, [childStores, scopes])
  const snapshotRef = useRef(NO_SESSION_BLOCKING_REQUESTS)
  const getSnapshot = React.useCallback(() => {
    let hasPermission = false
    let hasForm = false
    const indexed = useGlobalBlockingRequestsStore.getState().bySession
    for (const { directory, sessionIDs } of scopes) {
      const store = directory ? childStores.getChild(directory) : undefined
      if (!store) {
        const pending = selectIndexedBlockingRequests(indexed, sessionIDs)
        hasPermission ||= pending.hasPermission
        hasForm ||= pending.hasForm
        continue
      }
      const { permission: permissions, form: forms, pendingRequestsReady } = store.getState()
      for (const sessionID of sessionIDs) {
        hasPermission ||= Boolean(permissions[sessionID]?.length)
        hasForm ||= Boolean(forms[sessionID]?.length)
          || Boolean(indexed.get(sessionID)?.pages.length)
      }
      if (!pendingRequestsReady) {
        const pending = selectIndexedBlockingRequests(indexed, sessionIDs)
        hasPermission ||= pending.hasPermission
        hasForm ||= pending.hasForm
      }
    }
    const previous = snapshotRef.current
    if (previous.hasPermission === hasPermission && previous.hasForm === hasForm) {
      return previous
    }
    const next = { hasPermission, hasForm }
    snapshotRef.current = next
    return next
  }, [childStores, scopes])
  const subscribe = React.useCallback((notify: () => void) => {
    const storeUnsubscribers = new Map<string, () => void>()
    let queued = false
    let active = true
    const announce = () => {
      if (queued) return
      queued = true
      queueMicrotask(() => {
        queued = false
        if (active) notify()
      })
    }
    const syncStoreSubscriptions = () => {
      const directories = new Set(scopes.flatMap((scope) => (scope.directory ? [scope.directory] : [])))
      for (const [directory, unsubscribe] of storeUnsubscribers) {
        if (directories.has(directory)) continue
        unsubscribe()
        storeUnsubscribers.delete(directory)
      }
      for (const scope of scopes) {
        const { directory } = scope
        if (!directory || storeUnsubscribers.has(directory)) continue
        const store = childStores.getChild(directory)
        if (!store) continue
        const unsubscribers = [
          subscribeDirectoryPermissions(store, scope.sessionIDs, notify),
          subscribeDirectoryForms(store, scope.sessionIDs, notify),
        ]
        storeUnsubscribers.set(directory, () => {
          for (const unsubscribe of unsubscribers) unsubscribe()
        })
      }
    }
    syncStoreSubscriptions()
    const unsubscribeRegistry = childStores.subscribeRegistry(() => {
      syncStoreSubscriptions()
      announce()
    })
    const unsubscribeIndex = useGlobalBlockingRequestsStore.subscribe(notify)
    return () => {
      active = false
      unsubscribeRegistry()
      unsubscribeIndex()
      for (const unsubscribe of storeUnsubscribers.values()) unsubscribe()
      storeUnsubscribers.clear()
    }
  }, [childStores, scopes])
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

const selectPermissionRequestsBySession = (state: State) => state.permission

const selectFormRequestsBySession = (state: State) => state.form

export const collectComposerForms = (
  sessions: Session[],
  formsBySession: Record<string, FormRequest[] | undefined>,
  sessionID: string | null,
  empty: FormRequest[],
): FormRequest[] => {
  const own = collectScopedBlockingRequests(sessions, formsBySession, sessionID, empty)
  const locationScoped = sessionID ? formsBySession[LOCATION_SCOPED_FORM_SESSION_ID] : undefined
  if (!locationScoped || locationScoped.length === 0) return own
  return own === empty ? locationScoped : [...own, ...locationScoped]
}

type ScopedBlockingRequestCache<T extends { id: string }> = {
  sessionID: string | null
  sessions: Session[] | null
  requestsBySession: Record<string, T[] | undefined> | null
  result: T[]
}

function useScopedBlockingRequests<T extends { id: string }>(
  sessionID: string | null,
  directory: string | undefined,
  selectRequestsBySession: (state: State) => Record<string, T[] | undefined>,
  empty: T[],
  collect: (
    sessions: Session[],
    requestsBySession: Record<string, T[] | undefined>,
    sessionID: string | null,
    empty: T[],
  ) => T[] = collectScopedBlockingRequests,
): T[] {
  const cacheRef = useRef<ScopedBlockingRequestCache<T>>({
    sessionID: null,
    sessions: null,
    requestsBySession: null,
    result: empty,
  })

  return useDirectorySync(
    useCallback((state: State) => {
      const requestsBySession = selectRequestsBySession(state)
      const cache = cacheRef.current
      if (
        cache.sessionID === sessionID
        && cache.sessions === state.session
        && cache.requestsBySession === requestsBySession
      ) {
        return cache.result
      }

      const next = collect(state.session, requestsBySession, sessionID, empty)
      const result = areRequestArraysReferentiallyEqual(cache.result, next) ? cache.result : next
      cacheRef.current = {
        sessionID,
        sessions: state.session,
        requestsBySession,
        result,
      }
      return result
    }, [collect, empty, selectRequestsBySession, sessionID]),
    directory,
  )
}

export function useScopedBlockingPermissions(sessionID: string | null, directory?: string): PermissionRequest[] {
  return useScopedBlockingRequests(sessionID, directory, selectPermissionRequestsBySession, EMPTY_PERMISSION_REQUESTS)
}

export function useScopedBlockingForms(sessionID: string | null, directory?: string): FormRequest[] {
  return useScopedBlockingRequests(sessionID, directory, selectFormRequestsBySession, EMPTY_FORM_REQUESTS, collectComposerForms)
}

export function useRecoveredQuestions(sessionID: string | null, directory?: string): RecoveredQuestion[] {
  const store = useDirectoryStore(directory)
  const sessions = useStore(store, (state) => state.session)
  const form = useStore(store, (state) => state.form)
  const part = useStore(store, (state) => state.part)
  const recovery = useRecoverableQuestionsStore()
  return useMemo(() => deriveRecoveredQuestions(
    { form, part },
    recovery,
    sessionID ? computeSubtreeIds(sessions, sessionID) : new Set<string>(),
  ), [form, part, recovery, sessionID, sessions])
}
