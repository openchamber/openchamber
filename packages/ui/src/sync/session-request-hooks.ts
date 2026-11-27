import React, { useRef, useCallback } from "react"
import { useStore } from "zustand"
import type { FormRequest, PermissionRequest, Session } from "@/lib/opencode/model"
import { subscribeDirectoryPermission, subscribeDirectoryPermissions, subscribeDirectoryForms } from "./child-store"
import { deriveRecoveredQuestions, useRecoverableQuestionsStore, type RecoveredQuestion } from "./recoverable-questions"
import { LOCATION_SCOPED_FORM_SESSION_ID } from "./location-scoped-forms"
import { useGlobalBlockingRequestsStore, type PendingBlockingRequests } from "./global-blocking-requests"
import { getDirectoryState } from "./sync-refs"
import { normalizePath } from "@/lib/pathNormalization"
import { revealRequest, revealWaitingPage } from "./request-reveal"
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

type SessionBlockingRequests = {
  hasPermission: boolean
  hasForm: boolean
}

const NO_SESSION_BLOCKING_REQUESTS: SessionBlockingRequests = {
  hasPermission: false,
  hasForm: false,
}

type RequestState = Pick<State, "permission" | "form" | "status" | "requestCoverage">

const storeAnswersFor = (state: RequestState | undefined, sessionID: string): boolean => (
  state?.status === "complete" && Boolean(state.requestCoverage?.has(sessionID))
)

const firstPendingPermission = (state: RequestState | undefined, indexed: PendingBlockingRequests | undefined, sessionID: string) => (
  state?.permission[sessionID]?.[0] ?? (storeAnswersFor(state, sessionID) ? undefined : indexed?.permissions[0])
)

const firstPendingForm = (state: RequestState | undefined, indexed: PendingBlockingRequests | undefined, sessionID: string) => (
  state?.form[sessionID]?.[0] ?? (storeAnswersFor(state, sessionID) ? undefined : indexed?.forms[0])
)

export type BlockingRequestKind = "permission" | "form"

type BlockingRequestTarget = {
  sessionID: string
  directory: string
  reveal: { kind: "request"; requestID: string } | { kind: "page" }
}

export const findBlockingRequestTarget = (
  sessions: readonly { sessionID: string; directory: string }[],
  kind: BlockingRequestKind,
): BlockingRequestTarget | null => {
  const indexedBySession = useGlobalBlockingRequestsStore.getState().bySession
  for (const { sessionID, directory: rawDirectory } of sessions) {
    const directory = normalizePath(rawDirectory) ?? rawDirectory
    const state = getDirectoryState(directory)
    const indexed = indexedBySession.get(sessionID)
    if (kind === "permission") {
      const permission = firstPendingPermission(state, indexed, sessionID)
      if (permission) return { sessionID, directory, reveal: { kind: "request", requestID: permission.id } }
      continue
    }
    const form = firstPendingForm(state, indexed, sessionID)
    if (form) return { sessionID, directory, reveal: { kind: "request", requestID: form.id } }
    if (indexed?.pages.length) return { sessionID, directory, reveal: { kind: "page" } }
  }
  return null
}

export const openBlockingRequestTarget = (
  target: BlockingRequestTarget,
  openSession: (sessionID: string, directory: string) => void,
): void => {
  if (target.reveal.kind === "page") {
    revealWaitingPage(target.sessionID)
    openSession(target.sessionID, target.directory)
    return
  }
  openSession(target.sessionID, target.directory)
  revealRequest(target.reveal.requestID)
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
      const state = store.getState()
      for (const sessionID of sessionIDs) {
        const pending = indexed.get(sessionID)
        hasPermission ||= Boolean(firstPendingPermission(state, pending, sessionID))
        hasForm ||= Boolean(pending?.pages.length) || Boolean(firstPendingForm(state, pending, sessionID))
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
