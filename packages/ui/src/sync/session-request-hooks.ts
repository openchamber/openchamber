import React, { useRef, useCallback } from "react"
import { useStore } from "zustand"
import type { FormRequest, PermissionRequest } from "@/lib/opencode/model"
import { subscribeDirectoryPermission, subscribeDirectoryPermissions, subscribeDirectoryForms } from "./child-store"
import { deriveRecoveredQuestions, useRecoverableQuestionsStore, type RecoveredQuestion } from "./recoverable-questions"
import { LOCATION_SCOPED_FORM_SESSION_ID } from "./location-scoped-forms"
import { useGlobalBlockingRequestsStore } from "./global-blocking-requests"
import type { State } from "./types"
import { areRequestArraysReferentiallyEqual, collectScopedBlockingRequests, computeSubtreeIds, isSubagentRequest, type SessionLookup } from "./scoped-blocking-requests"
import { sessionRecordLookup } from "./blocking-request-root"
import type { StoreApi } from "zustand"
import type { ChildStoreManager, DirectoryStore } from "./child-store"
import { useGlobalSessionsStore } from "@/stores/useGlobalSessionsStore"
import { useLiveSyncSelector } from "./live-session-hooks"
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

/** Pending forms for a specific session (fork: ModelControls holds the model while one is open). */
export function useSessionForms(sessionID: string, directory?: string) {
  return useDirectorySync(
    useCallback((state: State) => state.form[sessionID] ?? EMPTY_FORM_REQUESTS, [sessionID]),
    directory,
  )
}

type SessionBlockingRequests = {
  hasPermission: boolean
  hasForm: boolean
}

const NO_SESSION_BLOCKING_REQUESTS: SessionBlockingRequests = {
  hasPermission: false,
  hasForm: false,
}

export function useSessionBlockingRequests(
  scopes: readonly { directory: string; sessionIDs: readonly string[] }[],
): SessionBlockingRequests {
  const { childStores } = useSyncRuntime()
  const scopedStores = React.useMemo(() => scopes.map((scope) => ({
    sessionIDs: scope.sessionIDs,
    store: childStores.ensureChild(scope.directory, { bootstrap: false }),
  })), [childStores, scopes])
  React.useEffect(() => {
    for (const scope of scopes) childStores.pin(scope.directory)
    return () => {
      for (const scope of scopes) childStores.unpin(scope.directory)
    }
  }, [childStores, scopes])
  const snapshotRef = useRef(NO_SESSION_BLOCKING_REQUESTS)
  const getSnapshot = React.useCallback(() => {
    let hasPermission = false
    let hasForm = false
    const indexed = useGlobalBlockingRequestsStore.getState().bySession
    for (const { sessionIDs, store } of scopedStores) {
      const { permission: permissions, form: forms, status } = store.getState()
      const storeAuthoritative = status === "complete"
      for (const sessionID of sessionIDs) {
        const pending = indexed.get(sessionID)
        hasPermission ||= Boolean(permissions[sessionID]?.length)
          || (!storeAuthoritative && Boolean(pending?.permissions.length))
        hasForm ||= Boolean(forms[sessionID]?.length)
          || Boolean(pending?.pages.length)
          || (!storeAuthoritative && Boolean(pending?.forms.length))
      }
    }
    const previous = snapshotRef.current
    if (previous.hasPermission === hasPermission && previous.hasForm === hasForm) {
      return previous
    }
    const next = { hasPermission, hasForm }
    snapshotRef.current = next
    return next
  }, [scopedStores])
  const subscribe = React.useCallback((notify: () => void) => {
    const unsubscribers = [
      ...scopedStores.flatMap(({ sessionIDs, store }) => [
        subscribeDirectoryPermissions(store, sessionIDs, notify),
        subscribeDirectoryForms(store, sessionIDs, notify),
      ]),
      useGlobalBlockingRequestsStore.subscribe(notify),
    ]
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe()
    }
  }, [scopedStores])
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

const selectPermissionRequestsBySession = (state: State) => state.permission

const selectFormRequestsBySession = (state: State) => state.form

export const collectComposerForms = (
  formsBySession: Record<string, FormRequest[] | undefined>,
  sessionID: string | null,
  lookup: SessionLookup,
  empty: FormRequest[],
): FormRequest[] => {
  const own = collectScopedBlockingRequests(formsBySession, sessionID, lookup, empty)
  const locationScoped = sessionID ? formsBySession[LOCATION_SCOPED_FORM_SESSION_ID] : undefined
  if (!locationScoped || locationScoped.length === 0) return own
  return own === empty ? locationScoped : [...own, ...locationScoped]
}
/**
 * Notifies when an input of a blocking-request lineage changes: the session
 * slice of any directory store, which `getAllSyncSessionMap` indexes, the
 * records of the global session list, or the permission and form slices of
 * `store`, which holds the requests. Message, part and status updates notify
 * nothing, so streamed deltas never run a lineage hook's snapshot.
 */
const subscribeBlockingRequestLineage = (
  childStores: ChildStoreManager,
  store: StoreApi<DirectoryStore>,
  notify: () => void,
) => {
  const unsubscribers = [
    childStores.subscribeAllSelected((state) => state.session, notify),
    store.subscribe((state, previous) => {
      if (state.permission !== previous.permission || state.form !== previous.form) notify()
    }),
    useGlobalSessionsStore.subscribe((state, previous) => {
      if (state.entityById !== previous.entityById) notify()
    }),
  ]
  return () => {
    for (const unsubscribe of unsubscribers) unsubscribe()
  }
}

function useScopedBlockingRequests<T extends { id: string }>(
  sessionID: string | null,
  directory: string | undefined,
  selectRequestsBySession: (state: State) => Record<string, T[] | undefined>,
  empty: T[],
  collect: (
    requestsBySession: Record<string, T[] | undefined>,
    sessionID: string | null,
    lookup: SessionLookup,
    empty: T[],
  ) => T[] = collectScopedBlockingRequests,
): T[] {
  const store = useDirectoryStore(directory)
  // Runs only after the lineage subscription reports a change; renders in
  // between reuse the last result.
  return useLiveSyncSelector(
    useCallback(
      () => collect(selectRequestsBySession(store.getState()), sessionID, sessionRecordLookup(), empty),
      [collect, empty, selectRequestsBySession, sessionID, store],
    ),
    areRequestArraysReferentiallyEqual,
    useCallback((childStores: ChildStoreManager, notify: () => void) => subscribeBlockingRequestLineage(childStores, store, notify), [store]),
  )
}

export function useScopedBlockingPermissions(sessionID: string | null, directory?: string): PermissionRequest[] {
  return useScopedBlockingRequests(sessionID, directory, selectPermissionRequestsBySession, EMPTY_PERMISSION_REQUESTS)
}

export function useScopedBlockingForms(sessionID: string | null, directory?: string): FormRequest[] {
  return useScopedBlockingRequests(sessionID, directory, selectFormRequestsBySession, EMPTY_FORM_REQUESTS, collectComposerForms)
}

/** A docked request comes from a subagent below the viewed session, by the lineage the dock follows. */
export function useSubagentRequest(requestSessionID: string, viewedSessionID: string | null, directory?: string): boolean {
  const store = useDirectoryStore(directory)
  return useLiveSyncSelector(
    useCallback(
      () => isSubagentRequest(requestSessionID, viewedSessionID, sessionRecordLookup()),
      [requestSessionID, viewedSessionID],
    ),
    Object.is,
    useCallback((childStores: ChildStoreManager, notify: () => void) => subscribeBlockingRequestLineage(childStores, store, notify), [store]),
  )
}

const NO_RECOVERED_QUESTIONS: RecoveredQuestion[] = []

const sameRecoveredQuestions = (left: readonly RecoveredQuestion[], right: readonly RecoveredQuestion[]): boolean => (
  left.length === right.length
  && left.every((question, index) => {
    const other = right[index]
    return question.form === other.form
      && question.directory === other.directory
      && question.sessionID === other.sessionID
      && question.toolMessageID === other.toolMessageID
      && question.evidence === other.evidence
  })
)

export function useRecoveredQuestions(sessionID: string | null, directory?: string): RecoveredQuestion[] {
  const store = useDirectoryStore(directory)
  const recovery = useRecoverableQuestionsStore()
  const previousRef = useRef(NO_RECOVERED_QUESTIONS)
  const select = useCallback((state: State) => {
    const next = !sessionID || recovery.seen.size === 0
      ? NO_RECOVERED_QUESTIONS
      : deriveRecoveredQuestions(state, recovery, computeSubtreeIds(state.session, sessionID))
    if (sameRecoveredQuestions(previousRef.current, next)) return previousRef.current
    previousRef.current = next
    return next
  }, [recovery, sessionID])
  return useStore(store, select)
}
