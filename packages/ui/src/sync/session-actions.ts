/**
 * Session actions — SDK-calling operations for session management.
 * Replaces the action methods from the old useSessionStore.
 */

import type { OpencodeClient, Session, Message, Part } from "@opencode-ai/sdk/v2/client"
import { Binary } from "./binary"
import { useSessionUIStore } from "./session-ui-store"
import { useInputStore } from "./input-store"
import type { ChildStoreManager } from "./child-store"
import { computeSubtreeIds } from "./scoped-blocking-requests"
import { opencodeClient } from "@/lib/opencode/client"
import { mergeSessionDirectoryMetadata, useGlobalSessionsStore } from "@/stores/useGlobalSessionsStore"
import { useConfigStore } from "@/stores/useConfigStore"
import { registerSessionDirectory } from "./sync-refs"
import { isSyntheticPart } from "@/lib/messages/synthetic"
import { getSessionMaterializationStatus, materializeSessionSnapshots } from "./materialization"
import { retry } from "./retry"
import { isVSCodeRuntime } from "@/lib/desktop"
import { isMobileSurfaceRuntime } from "@/lib/runtimeSurface"
import { stripMessageDiffSnapshots, stripSessionDiffSnapshots } from "./sanitize"
import { sessionEvents } from "@/lib/sessionEvents"
import {
  getOriginalSessionID,
  getSessionMetadata,
  isReviewSession,
  withoutReviewSessionLink,
  type SessionMetadataRecord,
} from "@/lib/sessionReviewMetadata"

const MESSAGE_REFETCH_LIMIT = 100
const MESSAGE_REFETCH_SKIP_PARTS = new Set(["patch", "step-start", "step-finish"])
const UNREVERT_REFETCH_ATTEMPTS = 3
const UNREVERT_REFETCH_RETRY_MS = 150

// Self-heal busy status if the SSE idle event is lost after a successful
// SDK call. Window chosen to be longer than typical SSE delivery (ms-scale)
// but shorter than the 5s periodic status poll (`ACTIVE_SESSION_STATUS_POLL_INTERVAL_MS`),
// so the per-send watchdog recovers a wedged session a second or so before
// the next poll. (#2072)
const OPTIMISTIC_STATUS_WATCHDOG_MS = 4_000

// Per-session watchdog timers. A burst of `optimisticSend` calls on the same
// session would otherwise queue an arbitrary number of pending callbacks;
// the snapshot reconciliation is idempotent so the result is still correct,
// but the unbounded timer growth is wasteful. We replace the previous
// pending timer (if any) when a new one is scheduled for the same session.
const _optimisticStatusWatchdogTimers = new Map<string, ReturnType<typeof setTimeout>>()

// Reference set by SyncProvider — allows actions to access SDK and stores
let _sdk: OpencodeClient | null = null
let _childStores: ChildStoreManager | null = null
let _getDirectory: () => string = () => ""
type OptimisticAddInput = { sessionID: string; directory?: string | null; message: Message; parts: Part[] }
type OptimisticRemoveInput = { sessionID: string; directory?: string | null; messageID: string }

let _optimisticAdd: ((input: OptimisticAddInput) => void) | null = null
let _optimisticRemove: ((input: OptimisticRemoveInput) => void) | null = null

// Status-snapshot reconciliation function injected by SyncProvider so this
// module does not need to import from `sync-context` (which already imports
// us, creating a circular dependency). The watchdog uses it to lower a
// wedged busy status back to idle once the server confirms the session is
// no longer active. (#2072)
type StatusSnapshotEntry = {
  type: "idle" | "busy" | "retry"
  attempt?: number
  message?: string
  next?: number
}
type ApplySessionStatusSnapshotFn = (
  store: DirectoryStoreApi,
  snapshot: Record<string, StatusSnapshotEntry>,
  candidateSessionIds: string[],
  mode: "monotonic" | "authoritative",
) => boolean
let _applySessionStatusSnapshot: ApplySessionStatusSnapshotFn | null = null
export function setApplySessionStatusSnapshot(
  fn: ApplySessionStatusSnapshotFn | null,
): void {
  _applySessionStatusSnapshot = fn
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type SdkResult<T> = {
  data?: T
  error?: unknown
  response?: { status?: number }
}

function formatSdkError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message
    if (typeof message === "string" && message.length > 0) return message

    const data = (error as { data?: unknown }).data
    if (data && typeof data === "object") {
      const dataMessage = (data as { message?: unknown }).message
      if (typeof dataMessage === "string" && dataMessage.length > 0) return dataMessage
    }
  }
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

function assertSdkSuccess<T>(result: SdkResult<T>, operation: string): T | undefined {
  if (!result.error) return result.data
  const status = result.response?.status
  const error = new Error(`${operation} failed${status ? ` (${status})` : ""}: ${formatSdkError(result.error)}`) as Error & { status?: number }
  if (status !== undefined) error.status = status
  throw error
}

function assertSdkData<T>(result: SdkResult<T>, operation: string): T {
  const data = assertSdkSuccess(result, operation)
  if (data === undefined || data === null) {
    throw new Error(`${operation} failed: empty response`)
  }
  return data
}

export function setActionRefs(
  sdk: OpencodeClient,
  childStores: ChildStoreManager,
  getDirectory: () => string,
) {
  _sdk = sdk
  _childStores = childStores
  _getDirectory = getDirectory
}

export function setOptimisticRefs(
  add: (input: OptimisticAddInput) => void,
  remove: (input: OptimisticRemoveInput) => void,
) {
  _optimisticAdd = add
  _optimisticRemove = remove
}

function sdk() {
  if (!_sdk) throw new Error("SDK not initialized — is SyncProvider mounted?")
  return _sdk
}

function dirStore() {
  if (!_childStores) throw new Error("Child stores not initialized")
  const d = _getDirectory()
  if (!d) throw new Error("No current directory")
  return _childStores.ensureChild(d)
}

function dirStoreForDirectory(directory: string) {
  if (!_childStores) throw new Error("Child stores not initialized")
  if (!directory) throw new Error("No directory")
  return _childStores.ensureChild(directory)
}

function dirStoreForSession(sessionId: string): { store: DirectoryStoreApi; directory?: string } {
  const directory = getSessionDirectory(sessionId)
  if (directory) {
    return { store: dirStoreForDirectory(directory), directory }
  }
  return { store: dirStore(), directory: dir() }
}

/**
 * Provider/model of the session's last assistant message — the authoritative
 * "session provider" for utility calls (notes distillation etc.), independent
 * of what the composer picker currently points at.
 */
export function getSessionLastAssistantModel(sessionId: string): { providerID: string; modelID: string } | null {
  try {
    const { store } = dirStoreForSession(sessionId)
    const messages = store.getState().message[sessionId]
    if (!messages) return null
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const info = messages[i] as { role?: string; providerID?: string; modelID?: string }
      if (info?.role === "assistant" && typeof info.providerID === "string" && info.providerID
        && typeof info.modelID === "string" && info.modelID) {
        return { providerID: info.providerID, modelID: info.modelID }
      }
    }
    return null
  } catch {
    return null
  }
}

function updateLiveSession(session: Session, directory?: string): void {
  const stores = _childStores
  if (!stores) return

  const candidates = directory
    ? [[directory, stores.getChild(directory)] as const]
    : stores.children

  for (const [, store] of candidates) {
    if (!store) continue
    const current = store.getState().session
    const index = current.findIndex((item) => item.id === session.id)
    if (index === -1) continue

    const next = [...current]
    next[index] = mergeSessionDirectoryMetadata(session, current[index])
    store.setState({ session: next })
    return
  }
}

function dir() {
  return _getDirectory() || undefined
}

function connectionLostError(): Error {
  const { hasEverConnected, lastDisconnectReason } = useConfigStore.getState()
  const suffix = lastDisconnectReason
    ? ` (${lastDisconnectReason})`
    : hasEverConnected
      ? ""
      : " (never connected)"
  return new Error(`Connection lost${suffix}. Please wait for reconnection.`)
}

// Wait briefly for the pipeline to re-establish connection before failing a
// send. Transient reconnects (heartbeat race, WS→SSE fallback, brief network
// blip) otherwise surface as a hard "Connection lost" toast even though the
// pipeline recovers within a second. While waiting, run bounded health probes
// inside the same grace window so stale disconnected state can recover quickly.
const CONNECTION_GRACE_MS = 2000
export async function waitForConnectionOrThrow(): Promise<void> {
  const deadline = Date.now() + CONNECTION_GRACE_MS
  while (Date.now() < deadline) {
    if (useConfigStore.getState().isConnected) return
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) break
    if (await useConfigStore.getState().probeConnection({ timeoutMs: Math.min(500, remainingMs) })) return
    const sleepMs = Math.min(100, deadline - Date.now())
    if (sleepMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, sleepMs))
    }
  }
  throw connectionLostError()
}

type SessionListSnapshot = {
  directory: string
  sessions: Session[]
}

type DirectoryStoreApi = ReturnType<ChildStoreManager["ensureChild"]>

function getGlobalSessionSnapshot(sessionId: string): Session | null {
  const global = useGlobalSessionsStore.getState()
  return [...global.activeSessions, ...global.archivedSessions].find((session) => session.id === sessionId) ?? null
}

function restoreGlobalSessionSnapshot(session: Session | null): void {
  if (!session) return
  useGlobalSessionsStore.getState().upsertSession(session)
}

function getSessionDirectory(sessionId: string): string | undefined {
  return findSessionDirectoryInChildStores(sessionId)
    || useSessionUIStore.getState().getDirectoryForSession(sessionId)
    || dir()
}

function findSessionDirectoryInChildStores(sessionId: string): string | null {
  const stores = _childStores
  if (!stores || !sessionId) return null

  for (const [directory, store] of stores.children) {
    const state = store.getState()
    if (
      state.session.some((session) => session.id === sessionId)
      || Object.prototype.hasOwnProperty.call(state.message, sessionId)
      || Object.prototype.hasOwnProperty.call(state.session_status ?? {}, sessionId)
      || Object.prototype.hasOwnProperty.call(state.permission ?? {}, sessionId)
      || Object.prototype.hasOwnProperty.call(state.question ?? {}, sessionId)
    ) {
      return directory
    }
  }

  return null
}

function getSessionReplyClient(sessionId?: string): OpencodeClient {
  const directory = sessionId
    ? useSessionUIStore.getState().getDirectoryForSession(sessionId)
    : null
  if (directory) {
    return opencodeClient.getScopedSdkClient(directory)
  }
  return sdk()
}

function restoreFilePartsToInput(fileParts: Array<Record<string, unknown>>): void {
  useInputStore.getState().clearAttachedFiles()
  for (const filePart of fileParts) {
    const url = typeof filePart.url === "string" ? filePart.url : ""
    const mime = typeof filePart.mime === "string" ? filePart.mime : "application/octet-stream"
    const filename = typeof filePart.filename === "string" ? filePart.filename : "attachment"
    if (url) {
      useInputStore.getState().addRestoredAttachment({ url, mimeType: mime, filename })
    }
  }
}

function resolveDirectoryForBlockingRequest(
  type: "permission" | "question",
  sessionId: string,
  requestId: string,
): string | null {
  const stores = _childStores
  if (!stores || !requestId) {
    return null
  }

  for (const [directory, store] of stores.children) {
    const state = store.getState()
    const requestMap = type === "permission" ? state.permission : state.question
    for (const requests of Object.values(requestMap) as Array<Array<{ id: string }> | undefined>) {
      if (requests?.some((request) => request.id === requestId)) {
        return directory
      }
    }
  }

  const sessionDirectory = useSessionUIStore.getState().getDirectoryForSession(sessionId)
  if (sessionDirectory) {
    return sessionDirectory
  }

  for (const [directory, store] of stores.children) {
    const state = store.getState()
    if (
      state.session.some((session) => session.id === sessionId)
      || Object.prototype.hasOwnProperty.call(state.message, sessionId)
      || Object.prototype.hasOwnProperty.call(state.session_status ?? {}, sessionId)
      || Object.prototype.hasOwnProperty.call(state.permission ?? {}, sessionId)
      || Object.prototype.hasOwnProperty.call(state.question ?? {}, sessionId)
    ) {
      return directory
    }
  }

  return null
}

export function isQuestionRequestNotFoundError(error: unknown): boolean {
  if (error && typeof error === "object") {
    const status = (error as { status?: unknown }).status
    if (status === 404) return true
  }

  let message = ""
  if (error instanceof Error) {
    message = error.message
  } else if (typeof error === "string") {
    message = error
  }

  return /Question(?:\.)?NotFoundError|Question request not found/i.test(message)
}

function removeQuestionRequestFromChildStores(sessionId: string, requestId: string): boolean {
  const stores = _childStores
  if (!stores || !requestId) return false

  let removed = false
  for (const [, store] of stores.children) {
    const current = store.getState().question ?? {}
    let nextQuestion: typeof current | null = null
    const sessionIds = new Set([sessionId, ...Object.keys(current)].filter(Boolean))

    for (const candidateSessionId of sessionIds) {
      const requests = current[candidateSessionId]
      if (!requests?.length) continue

      const nextRequests = requests.filter((request) => request.id !== requestId)
      if (nextRequests.length === requests.length) continue

      nextQuestion ??= { ...current }
      if (nextRequests.length > 0) {
        nextQuestion[candidateSessionId] = nextRequests
      } else {
        delete nextQuestion[candidateSessionId]
      }
      removed = true
    }

    if (nextQuestion) {
      store.setState({ question: nextQuestion })
    }
  }

  return removed
}

function getRequestReplyClient(
  type: "permission" | "question",
  sessionId: string,
  requestId: string,
): OpencodeClient {
  const requestDirectory = resolveDirectoryForBlockingRequest(type, sessionId, requestId)
  if (requestDirectory) {
    return opencodeClient.getScopedSdkClient(requestDirectory)
  }
  return getSessionReplyClient(sessionId)
}

// ---------------------------------------------------------------------------
// Session CRUD
// ---------------------------------------------------------------------------

export async function createSession(
  title?: string,
  directoryOverride?: string | null,
  parentID?: string | null,
  metadata?: Record<string, unknown>,
): Promise<Session | null> {
  try {
    const session = await opencodeClient.createSession({
      title,
      parentID: parentID ?? undefined,
      metadata,
    }, directoryOverride ?? dir())

    const sessionDirectory = (session as { directory?: string | null }).directory ?? null
    // Pre-populate routing index so SSE events arriving before session.created
    // can be routed to the correct child store
    if (sessionDirectory) {
      registerSessionDirectory(session.id, sessionDirectory)
    }
    useSessionUIStore.getState().setCurrentSession(session.id, sessionDirectory)
    useSessionUIStore.getState().markSessionAsOpenChamberCreated(session.id)
    useGlobalSessionsStore.getState().upsertSession(session)
    return session
  } catch (error) {
    console.error("[session-actions] createSession failed", error)
    return null
  }
}

export async function patchSessionMetadata(
  sessionId: string,
  directory: string | null | undefined,
  updater: (metadata: SessionMetadataRecord) => SessionMetadataRecord,
): Promise<Session> {
  const targetDirectory = directory ?? getSessionDirectory(sessionId)
  const current = await opencodeClient.getSession(sessionId, targetDirectory)
  const nextMetadata = updater(getSessionMetadata(current))
  const updated = await opencodeClient.updateSession(sessionId, { metadata: nextMetadata }, targetDirectory)
  useGlobalSessionsStore.getState().upsertSession(updated)
  const sessionDirectory = (updated as { directory?: string | null }).directory ?? targetDirectory
  if (sessionDirectory) registerSessionDirectory(updated.id, sessionDirectory)
  return updated
}

async function cleanupReviewMetadataBeforeDelete(sessionId: string, directory?: string | null): Promise<void> {
  let session: Session
  try {
    session = await opencodeClient.getSession(sessionId, directory ?? getSessionDirectory(sessionId))
  } catch {
    return
  }
  if (!isReviewSession(session)) return
  const originalSessionID = getOriginalSessionID(session)
  if (!originalSessionID) return
  try {
    await patchSessionMetadata(originalSessionID, directory ?? getSessionDirectory(originalSessionID), (metadata) =>
      withoutReviewSessionLink(metadata, sessionId),
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/not found/i.test(message)) return
    console.warn("[session-actions] review metadata cleanup failed before delete", error)
  }
}

/** Optimistically remove a session from every live child store that has it. */
function optimisticRemoveSession(sessionId: string, preferredDirectory?: string): SessionListSnapshot[] {
  if (!_childStores) return []

  const snapshots: SessionListSnapshot[] = []
  const visited = new Set<string>()
  const candidates: Array<[string, DirectoryStoreApi]> = []

  if (preferredDirectory) {
    const preferredStore = _childStores.children.get(preferredDirectory)
    if (preferredStore) {
      candidates.push([preferredDirectory, preferredStore])
      visited.add(preferredDirectory)
    }
  }

  for (const entry of _childStores.children.entries()) {
    if (visited.has(entry[0])) continue
    candidates.push(entry)
  }

  for (const [directory, store] of candidates) {
    const current = store.getState()
    if (!current.session.some((session) => session.id === sessionId)) {
      continue
    }
    snapshots.push({ directory, sessions: current.session })
    store.setState({ session: current.session.filter((session) => session.id !== sessionId) })
  }

  return snapshots
}

function restoreSessionListSnapshots(snapshots: SessionListSnapshot[]): void {
  if (!_childStores) return
  for (const snapshot of snapshots) {
    const store = _childStores.children.get(snapshot.directory)
    if (!store) continue
    store.setState({ session: snapshot.sessions })
  }
}

function cleanupSessionWorktreeMetadata(sessionId: string): void {
  useSessionUIStore.getState().setWorktreeMetadata(sessionId, null)
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function deleteSession(sessionId: string, _options?: Record<string, unknown>): Promise<boolean> {
  const sessionDirectory = getSessionDirectory(sessionId)
  const snapshots = optimisticRemoveSession(sessionId, sessionDirectory)
  const globalSnapshot = getGlobalSessionSnapshot(sessionId)
  useGlobalSessionsStore.getState().removeSessions([sessionId])

  const ui = useSessionUIStore.getState()
  if (ui.currentSessionId === sessionId) {
    ui.setCurrentSession(null)
  }
  try {
    await cleanupReviewMetadataBeforeDelete(sessionId, sessionDirectory)
    const deleted = await opencodeClient.deleteSession(sessionId, sessionDirectory)
    if (deleted !== true) {
      throw new Error("session.delete failed: server did not confirm deletion")
    }
    useGlobalSessionsStore.getState().removeSessions([sessionId])
    cleanupSessionWorktreeMetadata(sessionId)
    return true
  } catch (error) {
    console.error("[session-actions] deleteSession failed", error)
    // The server cascade-deletes child sessions when the parent is removed.
    // Subsequent delete attempts for those children return 404; treat as
    // success since the session was already deleted by the cascade.
    if ((error as { status?: number })?.status === 404) {
      cleanupSessionWorktreeMetadata(sessionId)
      return true
    }
    restoreSessionListSnapshots(snapshots)
    restoreGlobalSessionSnapshot(globalSnapshot)
    return false
  }
}

/** Delete a session specifying which directory it lives in. Used by agent groups for cross-directory deletes. */
export async function deleteSessionInDirectory(sessionId: string, directory: string): Promise<boolean> {
  if (!_childStores) return false
  const snapshots = optimisticRemoveSession(sessionId, directory)
  const globalSnapshot = getGlobalSessionSnapshot(sessionId)
  useGlobalSessionsStore.getState().removeSessions([sessionId])
  const ui = useSessionUIStore.getState()
  if (ui.currentSessionId === sessionId) ui.setCurrentSession(null)
  try {
    await cleanupReviewMetadataBeforeDelete(sessionId, directory)
    const deleted = await opencodeClient.deleteSession(sessionId, directory)
    if (deleted !== true) {
      throw new Error("session.delete failed: server did not confirm deletion")
    }
    useGlobalSessionsStore.getState().removeSessions([sessionId])
    cleanupSessionWorktreeMetadata(sessionId)
    return true
  } catch (error) {
    console.error("[session-actions] deleteSessionInDirectory failed", error)
    if ((error as { status?: number })?.status === 404) {
      cleanupSessionWorktreeMetadata(sessionId)
      return true
    }
    restoreSessionListSnapshots(snapshots)
    restoreGlobalSessionSnapshot(globalSnapshot)
    return false
  }
}

export async function archiveSession(sessionId: string): Promise<boolean> {
  const sessionDirectory = getSessionDirectory(sessionId)
  const snapshots = optimisticRemoveSession(sessionId, sessionDirectory)
  const globalSnapshot = getGlobalSessionSnapshot(sessionId)
  const archivedAt = Date.now()
  useGlobalSessionsStore.getState().archiveSessions([sessionId], archivedAt)
  const ui = useSessionUIStore.getState()
  if (ui.currentSessionId === sessionId) {
    ui.setCurrentSession(null)
  }
  try {
    await cleanupReviewMetadataBeforeDelete(sessionId, sessionDirectory)
    const archived = await opencodeClient.updateSession(sessionId, { time: { archived: archivedAt } }, sessionDirectory)
    if (!archived) {
      throw new Error("session.update failed: server did not return the archived session")
    }
    useGlobalSessionsStore.getState().upsertSession(archived)
    return true
  } catch (error) {
    console.error("[session-actions] archiveSession failed", error)
    restoreSessionListSnapshots(snapshots)
    restoreGlobalSessionSnapshot(globalSnapshot)
    return false
  }
}

export async function updateSessionTitle(sessionId: string, title: string): Promise<void> {
  const sessionDirectory = getSessionDirectory(sessionId)
  const session = await opencodeClient.updateSession(sessionId, { title }, sessionDirectory)
  useGlobalSessionsStore.getState().upsertSession(session)
}

export async function shareSession(sessionId: string): Promise<Session | null> {
  const sessionDirectory = getSessionDirectory(sessionId)
  const result = await sdk().session.share({ sessionID: sessionId, directory: sessionDirectory })
  const session = stripSessionDiffSnapshots(assertSdkData(result, "session.share"))
  useGlobalSessionsStore.getState().upsertSession(session)
  updateLiveSession(session, sessionDirectory)
  return session
}

export async function unshareSession(sessionId: string): Promise<Session | null> {
  const sessionDirectory = getSessionDirectory(sessionId)
  const result = await sdk().session.unshare({ sessionID: sessionId, directory: sessionDirectory })
  const session = stripSessionDiffSnapshots(assertSdkData(result, "session.unshare"))
  useGlobalSessionsStore.getState().upsertSession(session)
  updateLiveSession(session, sessionDirectory)
  return session
}

// ---------------------------------------------------------------------------
// Optimistic message send — insert user message before API call, rollback on error
// ---------------------------------------------------------------------------

// ID generator matching OpenCode's Identifier.ascending format.
// Uses BigInt(timestamp) * 0x1000 + counter, encoded as 6 hex bytes + random base62.
// This ensures client-generated IDs sort correctly with server-generated ones.
let lastIdTimestamp = 0
let idCounter = 0

function ascendingId(prefix: string): string {
  const now = Date.now()
  if (now !== lastIdTimestamp) {
    lastIdTimestamp = now
    idCounter = 0
  }
  idCounter += 1

  const value = BigInt(now) * BigInt(0x1000) + BigInt(idCounter)
  const bytes = new Uint8Array(6)
  for (let i = 0; i < 6; i++) {
    bytes[i] = Number((value >> BigInt(40 - 8 * i)) & BigInt(0xff))
  }

  let hex = ""
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0")
  }

  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
  let rand = ""
  for (let i = 0; i < 14; i++) {
    rand += chars[Math.floor(Math.random() * 62)]
  }

  return `${prefix}_${hex}${rand}`
}

/**
 * Wraps an async send operation with optimistic user-message insertion.
 * Uses useSync()'s optimistic infrastructure — message + parts are inserted
 * into the store AND registered in the shadow Map. mergeOptimisticPage
 * handles deduplication when the server echoes back the real message.
 */
export async function optimisticSend(input: {
  sessionId: string
  content: string
  providerID: string
  modelID: string
  agent?: string
  directory?: string | null
  files?: Array<{ type: "file"; mime: string; url: string; filename: string }>
  onOptimisticInsert?: () => void
  onMessageID?: (messageID: string) => void
  beforeOptimisticInsert?: () => void
  /** The actual API call — receives the optimistic messageID so the server can use the same ID */
  send: (messageID: string) => Promise<void>
}): Promise<void> {
  if (!_optimisticAdd || !_optimisticRemove) {
    throw new Error("Optimistic refs not set — is useSync() mounted?")
  }

  await waitForConnectionOrThrow()
  input.beforeOptimisticInsert?.()

  const targetDirectory = input.directory ?? dir()
  const store = targetDirectory ? dirStoreForDirectory(targetDirectory) : dirStore()
  const messageID = ascendingId("msg")
  input.onMessageID?.(messageID)
  const textPartId = ascendingId("prt")

  const optimisticParts: Part[] = [
    { id: textPartId, type: "text", text: input.content } as Part,
  ]
  if (input.files) {
    for (const f of input.files) {
      optimisticParts.push({ id: ascendingId("prt"), type: "file", mime: f.mime, url: f.url, filename: f.filename } as Part)
    }
  }

  const optimisticMessage = {
    id: messageID,
    role: "user" as const,
    sessionID: input.sessionId,
    parentID: "",
    modelID: input.modelID,
    providerID: input.providerID,
    system: "",
    agent: input.agent ?? "",
    model: `${input.providerID}/${input.modelID}`,
    metadata: {} as Record<string, unknown>,
    time: { created: Date.now(), completed: 0 },
  } as unknown as Message

  // Insert into store + register in shadow Map (for mergeOptimisticPage cleanup)
  _optimisticAdd({
    sessionID: input.sessionId,
    directory: targetDirectory,
    message: optimisticMessage,
    parts: optimisticParts,
  })
  input.onOptimisticInsert?.()

  // Set busy status
  const current = store.getState()
  store.setState({
    session_status: {
      ...current.session_status,
      [input.sessionId]: { type: "busy" as const },
    },
  })

  try {
    await input.send(messageID)
  } catch (error) {
    // Rollback via optimistic infrastructure
    _optimisticRemove({
      sessionID: input.sessionId,
      directory: targetDirectory,
      messageID,
    })
    const s = store.getState()
    store.setState({
      session_status: {
        ...s.session_status,
        [input.sessionId]: { type: "idle" as const },
      },
    })
    throw error
  }

  // Self-heal: if the SSE idle event never lands, fetch the authoritative
  // status from the server after a short window and clear the busy flag if
  // the server confirms we are idle. Without this, a lost SSE event wedges
  // the session in a permanent "Gears turning ..." state and the next user
  // send is force-queued instead of sent. (#2072)
  scheduleOptimisticStatusWatchdog(store, input.sessionId, targetDirectory)
}

/**
 * Self-healing watchdog for the busy status set by `optimisticSend`.
 *
 * The success path of `optimisticSend` relies on the server's SSE
 * `session.status idle` event to clear the busy flag. If that event is
 * dropped (long-context session with heavy prepending, a transient network
 * blip, or any reason the event pipeline loses the tail), the busy flag
 * stays set forever, the composer shows "Gears turning ...", and the next
 * user send is force-queued because `useQueuedMessageAutoSend` gates on
 * `currentStatus !== 'idle'`.
 *
 * After a short grace window we re-read the authoritative status from the
 * server via `getSessionStatusForDirectory` and reconcile the local store
 * through the same `applySessionStatusSnapshot` helper used by the
 * reconnect/escalated-resync paths. A non-null response with the session
 * absent or marked `idle` lowers a wedged `busy` to `idle`; an explicit
 * `busy`/`retry` entry confirms the AI is still working. If the fetch
 * fails (`null`) we preserve the current state — a transient network blip
 * must not flip us to `idle` while the AI is genuinely still working.
 */
function scheduleOptimisticStatusWatchdog(
  store: DirectoryStoreApi,
  sessionId: string,
  directory: string | null | undefined,
): ReturnType<typeof setTimeout> {
  // Replace any pending watchdog for the same session — a burst of
  // `optimisticSend` calls must not pile up callbacks that fire long after
  // the latest send.
  const existing = _optimisticStatusWatchdogTimers.get(sessionId)
  if (existing !== undefined) clearTimeout(existing)

  const timer = setTimeout(() => {
    void runOptimisticStatusWatchdog(store, sessionId, directory)
  }, OPTIMISTIC_STATUS_WATCHDOG_MS)
  _optimisticStatusWatchdogTimers.set(sessionId, timer)
  return timer
}

/**
 * Body of the self-heal watchdog. Extracted as a separate function so tests
 * can invoke it directly without sleeping for the grace window.
 */
async function runOptimisticStatusWatchdog(
  store: DirectoryStoreApi,
  sessionId: string,
  directory: string | null | undefined,
): Promise<void> {
  // Always clear our timer registration, regardless of which branch we take.
  // The next scheduling pass (or a new send) owns the Map from this point on.
  _optimisticStatusWatchdogTimers.delete(sessionId)
  try {
    // SSE may have already moved us out of `busy`; only reconcile if still
    // wedged. This makes the watchdog a no-op in the normal case where the
    // idle event arrived within the grace window.
    const current = store.getState().session_status?.[sessionId]
    if (!current || current.type !== "busy") return

    const snapshot = await opencodeClient.getSessionStatusForDirectory(directory ?? null)
    // null = fetch failed. Preserve state; the next SSE event or a future
    // reconcile will recover. Do NOT flip to `idle` on a network blip.
    if (snapshot === null) return

    // `applySessionStatusSnapshot` is injected by SyncProvider to avoid a
    // circular import with `sync-context`. Without the ref we cannot recover;
    // a missing ref means the SyncProvider has not mounted yet, in which case
    // a later reconnect-driven resync will reconcile state.
    if (!_applySessionStatusSnapshot) return
    _applySessionStatusSnapshot(store, snapshot, [sessionId], "authoritative")
  } catch (error) {
    // The watchdog must never throw into the timer callback. Preserve the
    // local state and let the next SSE event / poll recover.
    console.error("[session-actions] optimistic status watchdog failed", error)
  }
}

// Exported under a `__test` prefix so production code paths are the only
// callers — the body is not part of the public API. The codebase has no
// other `__test*` exports today; the prefix is a hard "do not import from
// feature code" signal. (#2072)
export const __testRunOptimisticStatusWatchdog = runOptimisticStatusWatchdog

// ---------------------------------------------------------------------------
// Abort
// ---------------------------------------------------------------------------

export async function abortCurrentOperation(sessionId: string): Promise<void> {
  // The abort must carry the SESSION'S directory, not the active UI directory:
  // OpenCode routes the request to the per-directory instance, and an abort
  // sent to the wrong instance cancels nothing while still returning 200 true
  // (the "stop button does nothing" report — sessions in another project/
  // worktree than the UI's current directory could never be aborted).
  const { directory } = dirStoreForSession(sessionId)
  try {
    await sdk().session.abort({ sessionID: sessionId, directory })
  } catch (error) {
    console.error("[session-actions] abort failed", error)
  }
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

export async function respondToPermission(
  sessionId: string,
  requestId: string,
  response: "once" | "always" | "reject",
): Promise<void> {
  await waitForConnectionOrThrow()
  const directory = resolveDirectoryForBlockingRequest("permission", sessionId, requestId)
    || getSessionDirectory(sessionId)
    || dir()
  const result = await getRequestReplyClient("permission", sessionId, requestId).permission.reply({
    requestID: requestId,
    reply: response,
    ...(directory ? { directory } : {}),
  })
  if (assertSdkData(result, "permission.reply") !== true) {
    throw new Error("Permission reply failed")
  }
}

export async function dismissPermission(
  sessionId: string,
  requestId: string,
): Promise<void> {
  await waitForConnectionOrThrow()
  const directory = resolveDirectoryForBlockingRequest("permission", sessionId, requestId)
    || getSessionDirectory(sessionId)
    || dir()
  const result = await getRequestReplyClient("permission", sessionId, requestId).permission.reply({
    requestID: requestId,
    reply: "reject",
    ...(directory ? { directory } : {}),
  })
  if (assertSdkData(result, "permission.reply") !== true) {
    throw new Error("Permission dismissal failed")
  }
}

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

export async function respondToQuestion(
  sessionId: string,
  requestId: string,
  answers: string[] | string[][],
): Promise<void> {
  await waitForConnectionOrThrow()
  const directory = resolveDirectoryForBlockingRequest("question", sessionId, requestId)
    || getSessionDirectory(sessionId)
    || dir()
  try {
    const normalizedAnswers = answers.length === 0
      ? []
      : Array.isArray(answers[0])
        ? answers as string[][]
        : [answers as string[]]
    const result = await getRequestReplyClient("question", sessionId, requestId).question.reply({
      requestID: requestId,
      answers: normalizedAnswers,
      ...(directory ? { directory } : {}),
    })
    if (assertSdkData(result, "question.reply") !== true) {
      throw new Error("Question reply failed")
    }
  } catch (error) {
    if (isQuestionRequestNotFoundError(error)) {
      removeQuestionRequestFromChildStores(sessionId, requestId)
    }
    throw error
  }
}

export async function rejectQuestion(
  sessionId: string,
  requestId: string,
): Promise<void> {
  await waitForConnectionOrThrow()
  const directory = resolveDirectoryForBlockingRequest("question", sessionId, requestId)
    || getSessionDirectory(sessionId)
    || dir()
  try {
    const result = await getRequestReplyClient("question", sessionId, requestId).question.reject({
      requestID: requestId,
      ...(directory ? { directory } : {}),
    })
    if (assertSdkData(result, "question.reject") !== true) {
      throw new Error("Question rejection failed")
    }
  } catch (error) {
    if (isQuestionRequestNotFoundError(error)) {
      removeQuestionRequestFromChildStores(sessionId, requestId)
    }
    throw error
  }
}

/**
 * Dismiss every pending question for the session subtree rooted at `sessionId`
 * (the session itself plus any subagent children). Used by the chat send path:
 * sending a message while a question prompt is open must cancel/supersede the
 * open question so it cannot linger or strand the session in a half-answered
 * state.
 *
 * The questions are removed from the local store OPTIMISTICALLY (before any
 * network call) so the prompt disappears instantly instead of waiting on the
 * `question.reject` round-trip. Each question is then formally rejected on the
 * backend, which fires `question.rejected` for reconciliation.
 *
 * Returns true when at least one question was dismissed. Rejection failures are
 * swallowed (a stranded question must never block the send);
 * QuestionNotFoundError also clears the stale entry from the child store via
 * {@link rejectQuestion}.
 *
 * NOTE: rejecting unblocks the agent's tool but does NOT end its turn. Callers
 * that need to send the next message right away (the chat send path) must also
 * abort the session so the OpenCode runner reaches `idle` — otherwise the new
 * prompt arrives while the run is still active and is discarded by the runner's
 * `ensureRunning`.
 */
export async function dismissOpenQuestionsForSession(sessionId: string): Promise<boolean> {
  if (!sessionId) return false
  const stores = _childStores
  if (!stores) return false

  const toDismiss: Array<{ sessionId: string; requestId: string }> = []
  for (const [, store] of stores.children) {
    const state = store.getState()
    const scopedIds = computeSubtreeIds(state.session, sessionId)
    if (scopedIds.size === 0) continue
    const questionsBySession = state.question ?? {}
    for (const scopedId of scopedIds) {
      const requests = questionsBySession[scopedId]
      if (!requests) continue
      for (const request of requests) {
        toDismiss.push({ sessionId: scopedId, requestId: request.id })
      }
    }
  }

  if (toDismiss.length === 0) return false

  // Optimistically clear the questions from the local store so the prompt
  // disappears immediately, before the reject round-trip.
  for (const { sessionId: scopedSessionId, requestId } of toDismiss) {
    removeQuestionRequestFromChildStores(scopedSessionId, requestId)
  }

  await Promise.all(
    toDismiss.map(async ({ sessionId: scopedSessionId, requestId }) => {
      try {
        await rejectQuestion(scopedSessionId, requestId)
      } catch (error) {
        if (isQuestionRequestNotFoundError(error)) return
        // Swallow: a failed dismissal must not block the send. The next
        // question.asked / question.rejected event reconciles the store.
        console.error("[session-actions] Failed to dismiss open question on send:", error)
      }
    }),
  )
  return true
}

// ---------------------------------------------------------------------------
// Message history
// ---------------------------------------------------------------------------

/**
 * Revert to a specific user message.
 *
 * 1. Abort if session is busy
 * 2. Extract text from the target message for prompt restoration
 * 3. Optimistically set revert marker so messages hide immediately
 * 4. Call the runtime revert endpoint and merge returned session
 * 5. Set pendingInputText so the reverted message text appears in the input
 */
export async function revertToMessage(sessionId: string, messageId: string): Promise<void> {
  const { store, directory } = dirStoreForSession(sessionId)
  const state = store.getState()

  // Abort if busy before mutating session state
  const status = state.session_status[sessionId]
  if (status && status.type !== "idle") {
    try {
      await sdk().session.abort({ sessionID: sessionId, directory })
    } catch {
      // ignore abort errors
    }
  }

  // Extract message text for prompt restoration (only non-synthetic text parts —
  // the server adds file content as synthetic text parts that should not be restored)
  const messages = state.message[sessionId] ?? []
  const targetMsg = messages.find((m) => m.id === messageId)
  let messageText = ""
  let submittedFileParts: Array<Record<string, unknown>> = []
  if (targetMsg && targetMsg.role === "user") {
    const parts = state.part[messageId] ?? []
    const textParts = parts.filter((p) => p.type === "text" && !isSyntheticPart(p))
    messageText = textParts
      .map((p: Record<string, unknown>) => (p as { text?: string }).text || (p as { content?: string }).content || "")
      .join("\n")
      .trim()
    // Snapshot file parts for later restoration to the input.
    // Exclude synthetic file parts (server-generated file content that should
    // not be restored to the composer).
    submittedFileParts = parts.filter((p) => p.type === "file" && !isSyntheticPart(p)) as Array<Record<string, unknown>>
  }

  // Optimistically set only the revert marker. Keep messages and parts in the
  // local store; visible-message selectors derive the displayed timeline from
  // session.revert. This matches the server model and preserves reverted
  // messages for the restore dock without maintaining a separate shadow copy.
  const prevRevert = (() => {
    const s = state.session.find((s) => s.id === sessionId)
    return (s as Session & { revert?: unknown })?.revert
  })()
  const sessions = [...state.session]
  const sessionIdx = sessions.findIndex((s) => s.id === sessionId)

  const patch: Record<string, unknown> = {}

  if (sessionIdx >= 0) {
    sessions[sessionIdx] = { ...sessions[sessionIdx], revert: { messageID: messageId } } as Session
    patch.session = sessions
  }

  store.setState(patch)

  // Save input store state before mutations — if the API fails we need to
  // roll back both text and attachments to their previous values.
  const prevInputAttachments = [...useInputStore.getState().attachedFiles]
  const prevInputText = useInputStore.getState().pendingInputText
  const prevInputMode = useInputStore.getState().pendingInputMode

  // Restore reverted message text and file attachments to input
  if (messageText) {
    useInputStore.setState({
      pendingInputText: messageText,
      pendingInputMode: "replace" as const,
    })
  }

  // Restore file/image attachments from the target message.
  // Clear existing attachments first — previous revert's attachments
  // must not carry over, even when the current message has no files.
  restoreFilePartsToInput(submittedFileParts)

  // Call SDK and merge authoritative result into store
  try {
    const revertedSession = await opencodeClient.revertSession(sessionId, messageId, undefined, directory)
    const current = store.getState()
    const updated = [...current.session]
    const idx = updated.findIndex((s) => s.id === sessionId)
    if (idx >= 0) {
      updated[idx] = revertedSession
      store.setState({ session: updated })
    }
    if (directory) {
      sessionEvents.requestGitRefresh({ directory })
    }
  } catch (err) {
    // Rollback: restore removed messages + revert marker
    const current = store.getState()
    const rollback = [...current.session]
    const idx = rollback.findIndex((s) => s.id === sessionId)
    if (idx >= 0) {
      rollback[idx] = { ...rollback[idx], revert: prevRevert } as Session
    }
    store.setState({
      session: rollback,
    })
    // Rollback input store: restore previous text and attachments
    useInputStore.setState({
      pendingInputText: prevInputText,
      pendingInputMode: prevInputMode,
      attachedFiles: prevInputAttachments,
    })
    throw err
  }
}

export async function refetchSessionMessages(sessionId: string): Promise<void> {
  const { store, directory } = dirStoreForSession(sessionId)
  const result = await sdk().session.messages({ sessionID: sessionId, directory, limit: MESSAGE_REFETCH_LIMIT })
  const records = (assertSdkSuccess(result, "session.messages") ?? [])
    .filter((record: { info?: { id?: string } }) => !!record?.info?.id)
  if (records.length === 0) return

  store.setState((state) => {
    const materialized = materializeSessionSnapshots(
      state,
      sessionId,
      records.map((record: { info: Message; parts?: Part[] }) => ({
        info: stripMessageDiffSnapshots(record.info),
        parts: record.parts ?? [],
      })),
      { skipPartTypes: MESSAGE_REFETCH_SKIP_PARTS },
    )
    return { message: materialized.message, part: materialized.part }
  })
}

/**
 * Unrevert — restore all previously reverted messages.
 * Restore all previously reverted messages. Aborts if busy, merges result.
 */
export async function unrevertSession(sessionId: string): Promise<void> {
  const { store, directory } = dirStoreForSession(sessionId)
  const state = store.getState()
  const previousMessageCount = state.message[sessionId]?.length ?? 0

  // Abort if busy
  const status = state.session_status[sessionId]
  if (status && status.type !== "idle") {
    try {
      await sdk().session.abort({ sessionID: sessionId, directory })
    } catch {
      // ignore
    }
  }

  const result = await sdk().session.unrevert({ sessionID: sessionId, directory })
  const unrevertedSession = assertSdkData(result, "session.unrevert")
  const current = store.getState()
  const sessions = [...current.session]
  const idx = sessions.findIndex((s) => s.id === sessionId)
  if (idx >= 0) {
    sessions[idx] = unrevertedSession
    store.setState({ session: sessions })
  }
  for (let attempt = 0; attempt < UNREVERT_REFETCH_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await wait(UNREVERT_REFETCH_RETRY_MS)
    await refetchSessionMessages(sessionId)
    const nextMessageCount = store.getState().message[sessionId]?.length ?? 0
    if (nextMessageCount > previousMessageCount) return
  }
}

/**
 * Fork from a user message.
 *
 * 1. Extract text from the message for input restoration
 * 2. Call the runtime fork endpoint
 * 3. Insert the new session into the child store (so sidebar updates immediately)
 * 4. Switch to new session and set pending input text
 */
export async function forkFromMessage(sessionId: string, messageId: string): Promise<void> {
  const { store, directory } = dirStoreForSession(sessionId)
  const state = store.getState()

  // Extract message text and file attachments for input restoration.
  // Only non-synthetic text parts — the server adds file content as synthetic
  // text parts that should not be restored. File parts (images, pasted
  // screenshots) are user-originated and must be restored.
  const parts = state.part[messageId] ?? []
  let messageText = ""
  const textParts = parts.filter((p) => p.type === "text" && !isSyntheticPart(p))
  messageText = textParts
    .map((p: Part) => ((p as Record<string, unknown>).text as string) || ((p as Record<string, unknown>).content as string) || "")
    .join("\n")
    .trim()
  const fileParts = parts.filter((p) => p.type === "file" && !isSyntheticPart(p)) as Array<Record<string, unknown>>

  const forkedSession = await opencodeClient.forkSession(sessionId, messageId, directory)

  // Insert new session into child store so sidebar updates immediately
  const current = store.getState()
  const sessions = [...current.session]
  const searchResult = Binary.search(sessions, forkedSession.id, (s) => s.id)
  if (!searchResult.found) {
    sessions.splice(searchResult.index, 0, forkedSession)
    store.setState({ session: sessions })
  }

  // Switch to new session
  useSessionUIStore.getState().setCurrentSession(forkedSession.id)

  // Restore forked message text and file attachments to input
  if (messageText) {
    useInputStore.setState({
      pendingInputText: messageText,
      pendingInputMode: "replace" as const,
    })
  }
  // Clear existing attachments and restore file parts from the forked message.
  restoreFilePartsToInput(fileParts)
}

// ---------------------------------------------------------------------------
// Imperative fetch path — starts message loading on the same tick as
// setCurrentSession, before the React commit cycle fires useEffect.
// ---------------------------------------------------------------------------

const FETCH_MESSAGES_LOADING = new Set<string>()
const DESKTOP_INITIAL_PAGE_SIZE = 50
const CONSTRAINED_INITIAL_PAGE_SIZE = 30

const getFetchPageSize = () => {
  if (isVSCodeRuntime() || isMobileSurfaceRuntime()) return CONSTRAINED_INITIAL_PAGE_SIZE
  return DESKTOP_INITIAL_PAGE_SIZE
}

export async function fetchMessagesForSession(sessionID: string, directory?: string | null): Promise<void> {
  const resolvedDir = directory ?? dir()
  if (!resolvedDir) return

  const loadingKey = `${resolvedDir}:${sessionID}`
  if (FETCH_MESSAGES_LOADING.has(loadingKey)) return

  FETCH_MESSAGES_LOADING.add(loadingKey)

  try {
    const s = sdk()
    const store = directory
      ? dirStoreForDirectory(directory)
      : dirStore()

    if (getSessionMaterializationStatus(store.getState(), sessionID).renderable) return

    const result = await retry(async () => {
      const response = await s.session.messages({
        sessionID,
        directory: resolvedDir,
        limit: getFetchPageSize(),
      })
      return response
    })

    const records = (assertSdkSuccess(result, "session.messages") ?? [])
      .filter((record: { info?: { id?: string } }) => !!record?.info?.id)
    if (records.length === 0) return

    // Staleness guard: a rapid session switch may have moved the user off this
    // session while the fetch was in flight. Skip the write so a slow fetch
    // can't repopulate (and un-evict) a session already navigated away from.
    if (useSessionUIStore.getState().currentSessionId !== sessionID) return

    const latestState = store.getState()
    const latestStatus = getSessionMaterializationStatus(latestState, sessionID)
    if (latestStatus.renderable && (latestState.message[sessionID]?.length ?? 0) >= records.length) return

    store.setState((state) => {
      const materialized = materializeSessionSnapshots(
        state,
        sessionID,
        records.map((record: { info: Message; parts?: Part[] }) => ({
          info: stripMessageDiffSnapshots(record.info),
          parts: record.parts ?? [],
        })),
        { skipPartTypes: MESSAGE_REFETCH_SKIP_PARTS },
      )
      if (!materialized.messagesChanged && !materialized.partsChanged) return state
      return { message: materialized.message, part: materialized.part }
    })
  } catch {
    // Transient failure — the reactive path in ChatContainer will retry
  } finally {
    FETCH_MESSAGES_LOADING.delete(loadingKey)
  }
}
