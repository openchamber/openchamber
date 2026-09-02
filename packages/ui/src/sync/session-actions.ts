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
import { mergeSessionDirectoryMetadata, resolveGlobalSessionDirectory, useGlobalSessionsStore } from "@/stores/useGlobalSessionsStore"
import { useConfigStore } from "@/stores/useConfigStore"
import { registerSessionDirectory } from "./sync-refs"
import { useGlobalSessionStatusStore } from "./global-session-status"
import { recordSendFailure } from "./send-failure-log"
import { isSyntheticPart } from "@/lib/messages/synthetic"
import { draftFromContextPayload, readContextPart, type ContextCarrierPart } from "@/lib/messages/contextParts"
import { useInlineCommentDraftStore, type InlineCommentDraftTarget } from "@/stores/useInlineCommentDraftStore"
import { materializeSessionSnapshots } from "./materialization"
import { stripMessageDiffSnapshots, stripSessionDiffSnapshots } from "./sanitize"
import { sessionEvents } from "@/lib/sessionEvents"
import {
  getOriginalSessionID,
  getSessionMetadata,
  isReviewSession,
  withoutReviewSessionLink,
  type SessionMetadataRecord,
} from "@/lib/sessionReviewMetadata"
import { withContextObligatoryMessage, type ContextObligatoryMessage } from "@/lib/contextObligatoryMessages"
import { getBtwOriginalSessionID, getBtwSessionID, isBtwSession, withoutBtwSessionLink } from "@/lib/sessionBtwMetadata"
import { withLinkedIssue, type LinkedIssue } from "@/lib/linkedIssues"
import { getImperativeSessionMessageLoader } from "./session-message-loader"
import { cleanupPersistedSessionState } from "./session-deletion-cleanup"
import { getRuntimeKey } from "@/lib/runtime-switch"
import { markAmbiguousTransportFailure } from "@/lib/relay/transport-error"
import { getErrorStatus, isAmbiguousSendFailure } from "./send-failure-classification"
import { getStaleRunningToolMessageID } from "./materialization"
import { normalizePath } from "@/lib/pathNormalization"
import { mergeMessages } from "./optimistic"
import { messagesBefore, messagesFrom } from "./message-ordering"
import { deleteChatDirectory } from "@/lib/chatDirectories"

const MESSAGE_REFETCH_LIMIT = 100
const SEND_CONFIRMATION_REFETCH_LIMIT = 30
// A relay-tunnel send fails when the tunnel drops, and the confirming refetch
// then has to travel over that same tunnel to answer "did my message land?".
// Two attempts 150ms apart always answered "no" on a remote connection, so an
// accepted prompt looked like a failed one and got re-sent — two AI responses
// for one user message. Wait for the connection to actually come back (an
// authoritative signal, not a blind sleep), then retry with backoff. A healthy
// connection skips the wait and answers on the first attempt.
const SEND_CONFIRMATION_REFETCH_ATTEMPTS = 3
const SEND_CONFIRMATION_REFETCH_BASE_RETRY_MS = 250
const SEND_CONFIRMATION_RECONNECT_TIMEOUT_MS = 3000
const SEND_CONFIRMATION_RECONNECT_POLL_MS = 100
const MESSAGE_REFETCH_SKIP_PARTS = new Set(["patch", "step-start", "step-finish"])
const UNREVERT_REFETCH_ATTEMPTS = 3
const UNREVERT_REFETCH_RETRY_MS = 150

// Reference set by SyncProvider — allows actions to access SDK and stores
let _sdk: OpencodeClient | null = null
let _childStores: ChildStoreManager | null = null
let _getDirectory: () => string = () => ""
// Optional ref into the sync layer's session-tail materialization queue. Used
// to reconcile a trailing running tool part after a blocking request is
// confirmed stale server-side (see recoverStaleBlockingRequest).
let _enqueueSessionMaterialization: ((directory: string, sessionID: string, messageID: string) => void) | null = null
type OptimisticAddInput = { sessionID: string; directory?: string | null; message: Message; parts: Part[] }
type OptimisticRemoveInput = { sessionID: string; directory?: string | null; messageID: string }
type OptimisticConfirmInput = OptimisticRemoveInput

let _optimisticAdd: ((input: OptimisticAddInput) => void) | null = null
let _optimisticRemove: ((input: OptimisticRemoveInput) => void) | null = null
let _optimisticConfirm: ((input: OptimisticConfirmInput) => void) | null = null

function sessionMutationPatch(
  state: ReturnType<DirectoryStoreApi["getState"]>,
  sessionId: string,
  deleted: boolean,
) {
  const revision = (state.sessionRevision ?? 0) + 1
  const sessionEventRevision = { ...(state.sessionEventRevision ?? {}) }
  const sessionDeletedRevision = { ...(state.sessionDeletedRevision ?? {}) }
  if (deleted) {
    sessionDeletedRevision[sessionId] = revision
    delete sessionEventRevision[sessionId]
  } else {
    sessionEventRevision[sessionId] = revision
    delete sessionDeletedRevision[sessionId]
  }
  return {
    sessionListSource: "live" as const,
    sessionRevision: revision,
    sessionEventRevision,
    sessionDeletedRevision,
  }
}

function invalidateSessionLoads(sessionId: string, directories: Iterable<string | null | undefined>): void {
  const loader = getImperativeSessionMessageLoader()
  if (!loader) return
  for (const directory of new Set(directories)) {
    if (directory) loader.invalidateSession({ directory, sessionID: sessionId })
  }
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
  // Wrapping loses the original error's identity: the transport's
  // "dispatched, outcome unknown" tag, a DOMException abort, a TypeError from
  // fetch. Re-tag the wrapper so `isAmbiguousSendFailure` still classifies it
  // as ambiguous instead of reading it as a definite server rejection.
  throw isAmbiguousSendFailure(result.error) ? markAmbiguousTransportFailure(error) : error
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
  enqueueSessionMaterialization?: (directory: string, sessionID: string, messageID: string) => void,
) {
  _sdk = sdk
  _childStores = childStores
  _getDirectory = getDirectory
  _enqueueSessionMaterialization = enqueueSessionMaterialization ?? null
}

export function setOptimisticRefs(
  add: (input: OptimisticAddInput) => void,
  remove: (input: OptimisticRemoveInput) => void,
  confirm?: (input: OptimisticConfirmInput) => void,
) {
  _optimisticAdd = add
  _optimisticRemove = remove
  _optimisticConfirm = confirm ?? null
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

function updateLiveSession(session: Session, directory?: string): boolean {
  const stores = _childStores
  if (!stores) return false

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
    return true
  }

  return false
}

function mirrorSessionIntoLiveStores(session: Session, directory?: string): void {
  if (directory && updateLiveSession(session, directory)) {
    return
  }
  updateLiveSession(session)
}

function moveRecordEntries<T>(
  source: Record<string, T>,
  destination: Record<string, T>,
  keys: Iterable<string>,
): { source: Record<string, T>; destination: Record<string, T> } {
  let nextSource = source
  let nextDestination = destination

  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue
    if (nextSource === source) nextSource = { ...source }
    if (nextDestination === destination) nextDestination = { ...destination }
    nextDestination[key] = source[key]
    delete nextSource[key]
  }

  return { source: nextSource, destination: nextDestination }
}

function reconcileSessionMove(
  session: Session,
  sourceDirectory: string,
  destinationDirectory: string,
): Session {
  const stores = _childStores
  const sourceStore = stores?.getChild(sourceDirectory)
  const destinationStore = stores?.ensureChild(destinationDirectory, { bootstrap: false })
  const sourceState = sourceStore?.getState()
  const destinationState = destinationStore?.getState()
  const liveSession = sourceState?.session.find((candidate) => candidate.id === session.id) ?? session
  const movedSession = { ...liveSession, directory: destinationDirectory } as Session

  if (!destinationStore || !destinationState || sourceStore === destinationStore) {
    return movedSession
  }

  const destinationSessionIndex = destinationState.session.findIndex((candidate) => candidate.id === session.id)
  const destinationSessions = [...destinationState.session]
  if (destinationSessionIndex === -1) destinationSessions.push(movedSession)
  else destinationSessions[destinationSessionIndex] = movedSession

  if (!sourceStore || !sourceState) {
    destinationStore.setState({
      session: destinationSessions,
      sessionTotal: destinationSessionIndex === -1
        ? destinationState.sessionTotal + 1
        : destinationState.sessionTotal,
    })
    return movedSession
  }

  const sourceContainsSession = sourceState.session.some((candidate) => candidate.id === session.id)
  const status = moveRecordEntries(sourceState.session_status, destinationState.session_status, [session.id])
  const diffs = moveRecordEntries(sourceState.session_diff, destinationState.session_diff, [session.id])
  const todos = moveRecordEntries(sourceState.todo, destinationState.todo, [session.id])
  const permissions = moveRecordEntries(sourceState.permission, destinationState.permission, [session.id])
  const questions = moveRecordEntries(sourceState.question, destinationState.question, [session.id])
  const messages = moveRecordEntries(sourceState.message, destinationState.message, [session.id])
  const messageIds = sourceState.message[session.id]?.map((message) => message.id) ?? []
  const parts = moveRecordEntries(sourceState.part, destinationState.part, messageIds)

  sourceStore.setState({
    session: sourceState.session.filter((candidate) => candidate.id !== session.id),
    sessionTotal: sourceContainsSession ? Math.max(0, sourceState.sessionTotal - 1) : sourceState.sessionTotal,
    session_status: status.source,
    session_diff: diffs.source,
    todo: todos.source,
    permission: permissions.source,
    question: questions.source,
    message: messages.source,
    part: parts.source,
    ...sessionMutationPatch(sourceState, session.id, true),
  })
  destinationStore.setState({
    session: destinationSessions,
    sessionTotal: destinationSessionIndex === -1
      ? destinationState.sessionTotal + 1
      : destinationState.sessionTotal,
    session_status: status.destination,
    session_diff: diffs.destination,
    todo: todos.destination,
    permission: permissions.destination,
    question: questions.destination,
    message: messages.destination,
    part: parts.destination,
    ...sessionMutationPatch(destinationState, session.id, false),
  })

  return movedSession
}

export async function moveSessionToDirectory(
  session: Session,
  sourceDirectory: string,
  destinationDirectory: string,
  moveChanges = true,
): Promise<void> {
  const result = await opencodeClient.getSdkClient().experimental.controlPlane.moveSession({
    sessionID: session.id,
    destination: { directory: destinationDirectory },
    moveChanges,
  })
  assertSdkSuccess(result, "Move session")

  invalidateSessionLoads(session.id, [sourceDirectory, destinationDirectory])

  const moved = reconcileSessionMove(session, sourceDirectory, destinationDirectory)

  registerSessionDirectory(session.id, destinationDirectory)
  useGlobalSessionsStore.getState().upsertSession(moved)
  useSessionUIStore.getState().setSessionDirectory(session.id, destinationDirectory)
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
}

type DirectoryStoreApi = ReturnType<ChildStoreManager["ensureChild"]>

type DescendantSession = {
  session: Session
  directory: string
}

/** "unknown" means no live source covers this session right now, so no caller
 *  may treat it as idle on this answer. "idle" requires positive coverage. */
export type SessionLiveActivity = "unknown" | "idle" | "active"

/**
 * A session's live status can live in a different child store than the one that
 * wins the directory dedup, so any store reporting a non-idle status counts.
 * Read at the moment of use: a descendant can start working after the subtree
 * snapshot was taken.
 *
 * Absence of a non-idle status is not proof of idleness. Child stores are
 * evicted for background directories, and the global status index keeps only
 * non-idle entries, so "no report" and "idle" are different answers: report
 * "idle" only when a child store actually covers the session's directory.
 */
export function getSessionLiveActivity(sessionId: string): SessionLiveActivity {
  const stores = _childStores

  if (stores) {
    for (const [, store] of stores.children) {
      const status = store.getState().session_status?.[sessionId]
      if (status && status.type !== "idle") return "active"
    }
  }

  // Cross-directory live index: populated by global events and authoritative
  // per-directory status snapshots, and it survives child-store eviction.
  if (useGlobalSessionStatusStore.getState().statusById.has(sessionId)) return "active"

  if (!stores) return "unknown"
  return isSessionCoveredByChildStore(sessionId, stores) ? "idle" : "unknown"
}

function isSessionCoveredByChildStore(sessionId: string, stores: ChildStoreManager): boolean {
  if (findSessionDirectoryInChildStores(sessionId)) return true
  const directory = useSessionUIStore.getState().getDirectoryForSession(sessionId)
    ?? resolveKnownSessionDirectory(sessionId)
  if (!directory) return false
  return stores.children.has(normalizePath(directory) ?? directory)
}

function resolveKnownSessionDirectory(sessionId: string): string | null {
  const globalSession = getGlobalSessionSnapshot(sessionId)
  return globalSession ? resolveGlobalSessionDirectory(globalSession) : null
}

export function isSessionBusyNow(sessionId: string): boolean {
  return getSessionLiveActivity(sessionId) === "active"
}

async function abortDescendantIfBusy(sessionId: string, directory: string): Promise<void> {
  if (!isSessionBusyNow(sessionId)) return
  try {
    await sdk().session.abort({ sessionID: sessionId, directory })
  } catch {
    // ignore abort errors
  }
}

function getDescendantSessions(rootId: string): DescendantSession[] {
  const stores = _childStores
  if (!stores) return []

  const sessionsById = new Map<string, DescendantSession>()
  for (const [storeDirectory, store] of stores.children) {
    const state = store.getState()
    for (const session of state.session) {
      const directory = session.directory || storeDirectory
      const current = sessionsById.get(session.id)
      if (!current || session.directory) sessionsById.set(session.id, { session, directory })
    }
  }

  const subtreeIds = computeSubtreeIds(
    [...sessionsById.values()].map(({ session }) => session),
    rootId,
  )
  subtreeIds.delete(rootId)
  return [...subtreeIds]
    .map((id) => sessionsById.get(id))
    .filter((entry): entry is DescendantSession => !!entry)
}

function firstUserMessageAtOrAfter(messages: Message[], cutoff: number): Message | null {
  let target: Message | null = null
  for (const message of messages) {
    if (message.role !== "user" || message.time.created < cutoff) continue
    if (!target || message.time.created < target.time.created) target = message
  }
  return target
}

async function fetchSessionMessages(sessionId: string, directory?: string | null): Promise<Message[]> {
  const records = await opencodeClient.getSessionMessages(sessionId, undefined, directory)
  return records.map(({ info }) => info)
}

async function cascadeRevertToDescendants(rootId: string, cutoff: number): Promise<void> {
  for (const { session, directory } of getDescendantSessions(rootId)) {
    try {
      // A running descendant would keep writing messages past the revert
      // boundary, so stop it first for the same reason the parent is aborted.
      await abortDescendantIfBusy(session.id, directory)
      const messages = await fetchSessionMessages(session.id, directory)
      // Equal timestamps belong to the reverted side of the boundary. Keeping
      // them would rely on unrelated message IDs to decide chronology.
      const target = firstUserMessageAtOrAfter(messages, cutoff)
      if (!target) continue
      const reverted = await opencodeClient.revertSession(session.id, target.id, undefined, directory)
      mirrorSessionIntoLiveStores(reverted, directory)
    } catch (error) {
      console.error(`[session-actions] Failed to cascade revert to descendant ${session.id}:`, error)
    }
  }
}

async function cascadeUnrevertToDescendants(rootId: string): Promise<void> {
  for (const { session, directory } of getDescendantSessions(rootId)) {
    if (!session.revert) continue
    try {
      // Same reason as the revert cascade: a running descendant keeps writing
      // messages that the unrevert would race against.
      await abortDescendantIfBusy(session.id, directory)
      const result = await sdk().session.unrevert({ sessionID: session.id, directory })
      mirrorSessionIntoLiveStores(assertSdkData(result, "session.unrevert"), directory)
    } catch (error) {
      console.error(`[session-actions] Failed to cascade unrevert to descendant ${session.id}:`, error)
    }
  }
}

function getGlobalSessionSnapshot(sessionId: string): Session | null {
  const global = useGlobalSessionsStore.getState()
  return [...global.activeSessions, ...global.archivedSessions].find((session) => session.id === sessionId) ?? null
}

function getSessionDirectory(sessionId: string): string | undefined {
  const globalSession = getGlobalSessionSnapshot(sessionId)
  return findSessionDirectoryInChildStores(sessionId)
    || useSessionUIStore.getState().getDirectoryForSession(sessionId)
    || (globalSession ? resolveGlobalSessionDirectory(globalSession) ?? undefined : undefined)
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

/**
 * Put a message's attached context (review comments, quotes, terminal
 * selections, annotations) back on the composer chips.
 *
 * Context rides out as synthetic parts carrying structured metadata, so a
 * reverted or forked message can be rebuilt into the drafts it came from.
 * Without this the context is simply gone: the message is pulled back into the
 * composer with its text and files, but the comments attached to it are not.
 *
 * The target's existing drafts are replaced, matching how text and file
 * attachments are restored — the composer ends up as the message was sent.
 */
function restoreContextPartsToInput(
  parts: readonly ContextCarrierPart[],
  target: InlineCommentDraftTarget,
): void {
  const store = useInlineCommentDraftStore.getState()
  store.clearDrafts(target)
  for (const part of parts) {
    const payload = readContextPart(part)
    if (!payload) continue
    const draft = draftFromContextPayload(payload)
    if (draft) store.addDraft(target, draft)
  }
}

/**
 * Server-confirmed directory that owns a session, from the session record
 * (`directory`, then `project.worktree`). Mirrors the authoritative source in
 * session-directory-resolution: holding a session in a child store proves
 * containment, not ownership — a project's session list legitimately includes
 * the sessions of its worktrees so the sidebar can group them — so reading
 * ownership from the containing store reports the parent for a session that
 * lives in a worktree, and every fetch is then addressed to a directory that
 * does not own it.
 */
function resolveSessionOwnedDirectory(session: Session): string | null {
  const record = session as Session & {
    directory?: string | null
    project?: { worktree?: string | null } | null
  }
  const raw = typeof record.directory === "string" && record.directory.trim().length > 0
    ? record.directory
    : typeof record.project?.worktree === "string" && record.project.worktree.trim().length > 0
      ? record.project.worktree
      : null
  return raw ? normalizePath(raw) : null
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
    for (const requests of Object.values(requestMap) as Array<Array<{ id: string; sessionID?: string }> | undefined>) {
      const request = requests?.find((candidate) => candidate.id === requestId)
      if (!request) continue

      // Ownership beats containment. The request belongs to one specific
      // session, and the reply must reach the instance that actually tracks
      // it — the directory the session record's server-confirmed `directory`
      // names. The containing store's key only proves containment: a project
      // store holds its worktree sessions too, and a reply addressed to the
      // parent instance makes the server answer QuestionNotFoundError while
      // the question stays pending in the worktree instance, leaving the
      // session stuck on the running question tool. Fall back to the store
      // key only when the session record carries no directory.
      const requestSessionID = typeof request.sessionID === "string" && request.sessionID.length > 0
        ? request.sessionID
        : sessionId
      const sessionRecord = requestSessionID
        ? state.session.find((s) => s.id === requestSessionID)
        : undefined
      const ownedDirectory = sessionRecord ? resolveSessionOwnedDirectory(sessionRecord) : null
      if (ownedDirectory) return ownedDirectory
      return directory
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

/**
 * Reconcile the trailing assistant tool part after a blocking request turned
 * out to be stale server-side (reply/reject answered with not-found). The
 * local request is removed (the server no longer tracks it), but the
 * question/permission tool part can remain `running` with the session busy —
 * the UI would stay on "asking question" with no recovery until the user
 * stops the run. Enqueue the sync layer's settled-running-tool tail
 * materialization so the part converges to the server's actual state.
 */
function recoverStaleBlockingRequest(sessionId: string): void {
  const stores = _childStores
  const enqueue = _enqueueSessionMaterialization
  if (!stores || !enqueue || !sessionId) return

  for (const [directory, store] of stores.children) {
    const state = store.getState()
    if (
      !state.session.some((session) => session.id === sessionId)
      && !Object.prototype.hasOwnProperty.call(state.message, sessionId)
      && !Object.prototype.hasOwnProperty.call(state.session_status ?? {}, sessionId)
      && !Object.prototype.hasOwnProperty.call(state.question ?? {}, sessionId)
    ) {
      continue
    }
    const messageID = getStaleRunningToolMessageID(state, sessionId)
    if (messageID) {
      enqueue(directory, sessionId, messageID)
    }
    return
  }
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

function isPermissionRequestNotFoundError(error: unknown): boolean {
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

  return /Permission(?:\.)?NotFoundError|Permission request not found/i.test(message)
}

function removePermissionRequestFromChildStores(sessionId: string, requestId: string): boolean {
  const stores = _childStores
  if (!stores || !requestId) return false

  let removed = false
  for (const [, store] of stores.children) {
    const current = store.getState().permission ?? {}
    let nextPermission: typeof current | null = null
    const sessionIds = new Set([sessionId, ...Object.keys(current)].filter(Boolean))

    for (const candidateSessionId of sessionIds) {
      const requests = current[candidateSessionId]
      if (!requests?.length) continue

      const nextRequests = requests.filter((request) => request.id !== requestId)
      if (nextRequests.length === requests.length) continue

      nextPermission ??= { ...current }
      if (nextRequests.length > 0) {
        nextPermission[candidateSessionId] = nextRequests
      } else {
        delete nextPermission[candidateSessionId]
      }
      removed = true
    }

    if (nextPermission) {
      store.setState({ permission: nextPermission })
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
  selectionTransition?: "submitted-draft",
): Promise<Session | null> {
  try {
    // Capture the effective directory used for session creation so we can fall
    // back to it when the server response omits the `directory` field.
    // Without this, setCurrentSession would fall through to a stale
    // opencodeClient.getDirectory() value and group the session under the
    // wrong project (closes #1637, #2270).
    const effectiveDirectory = directoryOverride ?? dir()
    const session = await opencodeClient.createSession({
      title,
      parentID: parentID ?? undefined,
      metadata,
    }, effectiveDirectory)

    const sessionDirectory = (session as { directory?: string | null }).directory ?? effectiveDirectory ?? null
    // Pre-populate routing index so SSE events arriving before session.created
    // can be routed to the correct child store
    if (sessionDirectory) {
      registerSessionDirectory(session.id, sessionDirectory)
    }
    useSessionUIStore.getState().setCurrentSession(session.id, sessionDirectory, selectionTransition)
    useSessionUIStore.getState().markSessionAsOpenChamberCreated(session.id)
    useGlobalSessionsStore.getState().upsertSession(session)
    return session
  } catch (error) {
    console.error("[session-actions] createSession failed", error)
    return null
  }
}

/**
 * True when a caller captured a runtime key before an asynchronous mutation and
 * that runtime is no longer the active one. Callers pass `undefined` when they
 * do not participate in runtime-scoped guarding, which keeps the previous
 * unguarded behavior.
 */
function isStaleRuntime(expectedRuntimeKey: string | undefined): boolean {
  return expectedRuntimeKey !== undefined && getRuntimeKey() !== expectedRuntimeKey
}

/**
 * Read a session, apply `updater` to its metadata, and persist the result.
 *
 * `expectedRuntimeKey` is optional here and unguarded when omitted, unlike the
 * archive and delete actions. When supplied, the runtime is rechecked before
 * the read, before the write, and before the global store is updated; a change
 * at any of those points **throws** `"runtime changed"` rather than returning a
 * value, because this function must resolve to a `Session`. Callers that pass a
 * key must therefore be prepared to catch that rejection.
 */
export async function patchSessionMetadata(
  sessionId: string,
  directory: string | null | undefined,
  updater: (metadata: SessionMetadataRecord) => SessionMetadataRecord,
  expectedRuntimeKey?: string,
): Promise<Session> {
  if (isStaleRuntime(expectedRuntimeKey)) throw new Error("runtime changed")
  const targetDirectory = directory ?? getSessionDirectory(sessionId)
  const current = await opencodeClient.getSession(sessionId, targetDirectory)
  if (isStaleRuntime(expectedRuntimeKey)) throw new Error("runtime changed")
  const nextMetadata = updater(getSessionMetadata(current))
  const updated = await opencodeClient.updateSession(sessionId, { metadata: nextMetadata }, targetDirectory)
  if (isStaleRuntime(expectedRuntimeKey)) throw new Error("runtime changed")
  useGlobalSessionsStore.getState().upsertSession(updated)
  const sessionDirectory = (updated as { directory?: string | null }).directory ?? targetDirectory
  if (sessionDirectory) registerSessionDirectory(updated.id, sessionDirectory)
  mirrorSessionIntoLiveStores(updated, sessionDirectory ?? undefined)
  return updated
}

export async function setLinkedIssue(
  sessionId: string,
  directory: string | null | undefined,
  issue: LinkedIssue,
  linked: boolean,
): Promise<Session> {
  return patchSessionMetadata(sessionId, directory, (metadata) =>
    withLinkedIssue(metadata, issue, linked))
}

export async function setContextObligatoryMessage(
  sessionId: string,
  directory: string | null | undefined,
  message: ContextObligatoryMessage,
  pinned: boolean,
): Promise<Session> {
  return patchSessionMetadata(sessionId, directory, (metadata) =>
    withContextObligatoryMessage(metadata, message, pinned))
}

async function cleanupReviewMetadataBeforeDelete(
  sessionId: string,
  directory?: string | null,
  expectedRuntimeKey?: string,
): Promise<void> {
  if (isStaleRuntime(expectedRuntimeKey)) return
  let session: Session
  try {
    session = await opencodeClient.getSession(sessionId, directory ?? getSessionDirectory(sessionId))
  } catch {
    return
  }
  if (isStaleRuntime(expectedRuntimeKey)) return

  const unlinkParent = async (originalSessionID: string, unlink: (metadata: SessionMetadataRecord) => SessionMetadataRecord) => {
    try {
      await patchSessionMetadata(originalSessionID, directory ?? getSessionDirectory(originalSessionID), unlink, expectedRuntimeKey)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/not found/i.test(message)) return
      console.warn("[session-actions] linked-session metadata cleanup failed before delete", error)
    }
  }

  if (isReviewSession(session)) {
    const originalSessionID = getOriginalSessionID(session)
    if (originalSessionID) await unlinkParent(originalSessionID, (metadata) => withoutReviewSessionLink(metadata, sessionId))
    return
  }

  if (isBtwSession(session)) {
    const originalSessionID = getBtwOriginalSessionID(session)
    if (originalSessionID) await unlinkParent(originalSessionID, (metadata) => withoutBtwSessionLink(metadata, sessionId))
    return
  }

  // Deleting or archiving a session that has an active btw fork also removes
  // the fork: it is a temporary session that only exists for its parent's
  // panel. Best-effort — a failed fork delete must not block the parent's
  // operation; the orphaned fork stays visible in the sidebar.
  const btwSessionID = getBtwSessionID(session)
  if (btwSessionID) {
    try {
      if (isStaleRuntime(expectedRuntimeKey)) return
      await deleteSession(btwSessionID, { expectedRuntimeKey })
    } catch (error) {
      console.warn("[session-actions] failed to delete btw fork before parent delete", error)
    }
  }
}

/** Remove a server-confirmed session from every live child store that has it. */
function removeSessionFromLiveStores(sessionId: string, preferredDirectory?: string): SessionListSnapshot[] {
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
    snapshots.push({ directory })
    store.setState({
      session: current.session.filter((session) => session.id !== sessionId),
      ...sessionMutationPatch(current, sessionId, true),
    })
  }

  return snapshots
}

function cleanupSessionWorktreeMetadata(sessionId: string): void {
  useSessionUIStore.getState().setWorktreeMetadata(sessionId, null)
}

/**
 * Commit a server-confirmed deletion.
 *
 * `expectedRuntimeKey` is the runtime the deletion was confirmed on. It is
 * forwarded to `cleanupPersistedSessionState`, which rejects an identity whose
 * runtime is no longer active. Passing the live `getRuntimeKey()` here would
 * make that existing check a tautology, so the captured key is required to keep
 * it meaningful. Callers must still reject a stale runtime themselves, because
 * the in-memory live/global/UI stores mutated below are not runtime-scoped.
 */
function finalizeConfirmedSessionDeletion(
  sessionId: string,
  sessionDirectory?: string,
  expectedRuntimeKey = getRuntimeKey(),
): void {
  const snapshots = removeSessionFromLiveStores(sessionId, sessionDirectory)
  invalidateSessionLoads(sessionId, [...snapshots.map((snapshot) => snapshot.directory), sessionDirectory])
  useGlobalSessionsStore.getState().removeSessions([sessionId])
  const ui = useSessionUIStore.getState()
  if (ui.currentSessionId === sessionId) ui.setCurrentSession(null)
  cleanupSessionWorktreeMetadata(sessionId)
  if (sessionDirectory) {
    cleanupPersistedSessionState({
      runtimeKey: expectedRuntimeKey,
      directory: sessionDirectory,
      sessionId,
    })
  }
}

async function cleanupDeletedChatDirectory(directory: string | undefined, deleteDirectory: boolean): Promise<void> {
  if (!directory || !deleteDirectory) return
  try {
    await deleteChatDirectory(directory)
  } catch (error) {
    console.warn("[session-actions] deleted chat directory cleanup failed", error)
  }
}

export type DeleteSessionOptions = {
  /**
   * Runtime key the deletion is scoped to. Defaults to the active runtime when
   * the action starts; callers may supply a key captured earlier when
   * confirmation spans a runtime switch.
   */
  expectedRuntimeKey?: string
}

/**
 * Delete one session.
 *
 * The runtime is rechecked before the request and again before any store is
 * reconciled, so a response produced by the previous runtime cannot mutate the
 * current runtime's state. Session IDs are not unique across runtimes, so
 * committing a stale deletion could otherwise evict an unrelated session and
 * erase its persisted queue, todos, drafts, folders, and pins.
 *
 * A `404` is treated as an already-completed deletion, but only when it is
 * still authoritative for the captured runtime. After a runtime change the
 * `404` describes either the previous runtime or a runtime this session never
 * belonged to; neither justifies committing cleanup here, so the action reports
 * failure and leaves reconciliation to the next authoritative load.
 */
export async function deleteSession(sessionId: string, options?: DeleteSessionOptions): Promise<boolean> {
  const expectedRuntimeKey = options?.expectedRuntimeKey ?? getRuntimeKey()
  if (isStaleRuntime(expectedRuntimeKey)) return false
  const sessionDirectory = getSessionDirectory(sessionId)
  const sessionSnapshot = getGlobalSessionSnapshot(sessionId)
  const deleteManagedDirectory = Boolean(sessionSnapshot && sessionSnapshot.parentID == null)
  try {
    await cleanupReviewMetadataBeforeDelete(sessionId, sessionDirectory, expectedRuntimeKey)
    if (isStaleRuntime(expectedRuntimeKey)) return false
    const deleted = await opencodeClient.deleteSession(sessionId, sessionDirectory)
    if (isStaleRuntime(expectedRuntimeKey)) return false
    if (deleted !== true) {
      throw new Error("session.delete failed: server did not confirm deletion")
    }
    finalizeConfirmedSessionDeletion(sessionId, sessionDirectory, expectedRuntimeKey)
    await cleanupDeletedChatDirectory(sessionDirectory, deleteManagedDirectory)
    return true
  } catch (error) {
    console.error("[session-actions] deleteSession failed", error)
    // The server cascade-deletes child sessions when the parent is removed.
    // Subsequent delete attempts for those children return 404; treat as
    // success since the session was already deleted by the cascade.
    if ((error as { status?: number })?.status === 404) {
      if (isStaleRuntime(expectedRuntimeKey)) return false
      finalizeConfirmedSessionDeletion(sessionId, sessionDirectory, expectedRuntimeKey)
      await cleanupDeletedChatDirectory(sessionDirectory, deleteManagedDirectory)
      return true
    }
    return false
  }
}

/** Delete a session specifying which directory it lives in. Used by agent groups for cross-directory deletes. */
export async function deleteSessionInDirectory(
  sessionId: string,
  directory: string,
  expectedRuntimeKey = getRuntimeKey(),
): Promise<boolean> {
  if (isStaleRuntime(expectedRuntimeKey)) return false
  const sessionSnapshot = getGlobalSessionSnapshot(sessionId)
  const deleteManagedDirectory = Boolean(sessionSnapshot && sessionSnapshot.parentID == null)
  try {
    await cleanupReviewMetadataBeforeDelete(sessionId, directory, expectedRuntimeKey)
    if (isStaleRuntime(expectedRuntimeKey)) return false
    const deleted = await opencodeClient.deleteSession(sessionId, directory)
    if (isStaleRuntime(expectedRuntimeKey)) return false
    if (deleted !== true) {
      throw new Error("session.delete failed: server did not confirm deletion")
    }
    finalizeConfirmedSessionDeletion(sessionId, directory, expectedRuntimeKey)
    await cleanupDeletedChatDirectory(directory, deleteManagedDirectory)
    return true
  } catch (error) {
    console.error("[session-actions] deleteSessionInDirectory failed", error)
    if ((error as { status?: number })?.status === 404) {
      if (isStaleRuntime(expectedRuntimeKey)) return false
      finalizeConfirmedSessionDeletion(sessionId, directory, expectedRuntimeKey)
      await cleanupDeletedChatDirectory(directory, deleteManagedDirectory)
      return true
    }
    return false
  }
}

export type DeleteSessionsOptions = {
  /**
   * Runtime key captured when the batch was confirmed. When supplied, the batch
   * stops as soon as the active runtime differs.
   */
  expectedRuntimeKey?: string
}

/**
 * Delete several sessions sequentially, preserving partial results.
 *
 * One failed session never blocks or erases the others: it is reported in
 * `failedIds` while the remaining IDs are still attempted. When the runtime
 * changes mid-batch, the sessions already committed on the captured runtime
 * stay in `deletedIds` and every ID that was not committed there is reported in
 * `failedIds`, so existing partial-failure feedback stays truthful.
 */
export async function deleteSessions(
  ids: string[],
  options?: DeleteSessionsOptions,
): Promise<{ deletedIds: string[]; failedIds: string[] }> {
  const deletedIds: string[] = []
  const failedIds: string[] = []
  const expectedRuntimeKey = options?.expectedRuntimeKey ?? getRuntimeKey()

  for (const [index, id] of ids.entries()) {
    if (isStaleRuntime(expectedRuntimeKey)) {
      failedIds.push(...ids.slice(index))
      break
    }
    if (await deleteSession(id, { expectedRuntimeKey })) deletedIds.push(id)
    else failedIds.push(id)
  }

  return { deletedIds, failedIds }
}

/**
 * Archive one session.
 *
 * `expectedRuntimeKey` defaults to the active runtime when the action starts.
 * Callers may supply a key captured earlier when confirmation spans a runtime
 * switch. When the runtime changes, the action stops and returns `false`
 * without reconciling any store, so a response
 * produced by the previous runtime cannot mutate the current runtime's live or
 * global session state. A session the server already archived before the switch
 * stays archived on that runtime and is re-read from the server the next time
 * the runtime is loaded.
 */
export async function archiveSession(sessionId: string, expectedRuntimeKey = getRuntimeKey()): Promise<boolean> {
  if (isStaleRuntime(expectedRuntimeKey)) return false
  const sessionDirectory = getSessionDirectory(sessionId)
  const archivedAt = Date.now()
  try {
    await cleanupReviewMetadataBeforeDelete(sessionId, sessionDirectory, expectedRuntimeKey)
    if (isStaleRuntime(expectedRuntimeKey)) return false
    const archived = await opencodeClient.updateSession(sessionId, { time: { archived: archivedAt } }, sessionDirectory)
    if (isStaleRuntime(expectedRuntimeKey)) return false
    if (!archived) {
      throw new Error("session.update failed: server did not return the archived session")
    }
    const snapshots = removeSessionFromLiveStores(sessionId, sessionDirectory)
    invalidateSessionLoads(sessionId, [...snapshots.map((snapshot) => snapshot.directory), sessionDirectory])
    useGlobalSessionsStore.getState().upsertSession(archived)
    const ui = useSessionUIStore.getState()
    if (ui.currentSessionId === sessionId) ui.setCurrentSession(null)
    return true
  } catch (error) {
    console.error("[session-actions] archiveSession failed", error)
    return false
  }
}

export type ArchiveSessionsOptions = {
  /**
   * Runtime key captured when the batch was confirmed. When supplied, the batch
   * stops as soon as the active runtime differs.
   */
  expectedRuntimeKey?: string
}

/**
 * Archive several sessions sequentially, preserving partial results.
 *
 * One failed session never blocks or erases the others: it is reported in
 * `failedIds` while the remaining IDs are still attempted. When
 * `expectedRuntimeKey` is supplied and the runtime changes mid-batch, the
 * already-confirmed sessions stay in `archivedIds` and every ID that was not
 * confirmed on the captured runtime is reported in `failedIds`, so callers keep
 * showing the existing partial-failure feedback instead of silently dropping
 * work.
 */
export async function archiveSessions(
  ids: string[],
  options?: ArchiveSessionsOptions,
): Promise<{ archivedIds: string[]; failedIds: string[] }> {
  const archivedIds: string[] = []
  const failedIds: string[] = []
  const expectedRuntimeKey = options?.expectedRuntimeKey ?? getRuntimeKey()

  for (const [index, id] of ids.entries()) {
    if (isStaleRuntime(expectedRuntimeKey)) {
      failedIds.push(...ids.slice(index))
      break
    }
    if (await archiveSession(id, expectedRuntimeKey)) archivedIds.push(id)
    else failedIds.push(id)
  }

  return { archivedIds, failedIds }
}

/**
 * Sentinel written to `time.archived` when restoring a session.
 *
 * The OpenCode server has no HTTP path to clear `time.archived` back to NULL:
 * `session.update` only applies the field when the payload carries a finite
 * number (`archived !== undefined`), so omitting the key is a no-op and `null`
 * is silently ignored. Writing `0` is the only value that makes every reader
 * treat the session as active again: the UI, the event reducer, and the
 * OpenCode app/TUI all classify archive state by truthiness of
 * `time.archived`, and `0` is falsy. The one place that still excludes such a
 * session is the server's own `time_archived IS NULL` list filter, so the
 * global session cache loads with the inclusive `archived` flag and splits
 * client-side instead of relying on that filter (see
 * `useGlobalSessionsStore.loadSessions`).
 */
const UNARCHIVED_TIMESTAMP = 0

/**
 * Restore one archived session back to the active list.
 *
 * Same contract as `archiveSession`: waits for server confirmation before
 * reconciling stores, and rejects stale runtimes so a response produced by a
 * previous runtime cannot mutate the current runtime's state. The global
 * session cache is updated directly (the sidebar reads active/archived
 * buckets from it); the live directory store is re-populated by the
 * authoritative `session.updated` event the server publishes for the update.
 */
export async function unarchiveSession(sessionId: string, expectedRuntimeKey = getRuntimeKey()): Promise<boolean> {
  if (isStaleRuntime(expectedRuntimeKey)) return false
  const sessionDirectory = getSessionDirectory(sessionId)
  try {
    const restored = await opencodeClient.updateSession(sessionId, { time: { archived: UNARCHIVED_TIMESTAMP } }, sessionDirectory)
    if (isStaleRuntime(expectedRuntimeKey)) return false
    if (!restored) {
      throw new Error("session.update failed: server did not return the restored session")
    }
    if (restored.time?.archived) {
      throw new Error("session.update failed: server kept the session archived")
    }
    useGlobalSessionsStore.getState().upsertSession(restored)
    if (sessionDirectory) registerSessionDirectory(sessionId, sessionDirectory)
    return true
  } catch (error) {
    console.error("[session-actions] unarchiveSession failed", error)
    return false
  }
}

export type UnarchiveSessionsOptions = {
  /**
   * Runtime key captured when the batch was confirmed. When supplied, the batch
   * stops as soon as the active runtime differs.
   */
  expectedRuntimeKey?: string
}

/**
 * Restore several archived sessions sequentially, preserving partial results.
 *
 * One failed session never blocks or erases the others: it is reported in
 * `failedIds` while the remaining IDs are still attempted. When
 * `expectedRuntimeKey` is supplied and the runtime changes mid-batch, the
 * already-confirmed sessions stay in `restoredIds` and every ID that was not
 * confirmed on the captured runtime is reported in `failedIds`, so callers keep
 * showing truthful partial-failure feedback.
 */
export async function unarchiveSessions(
  ids: string[],
  options?: UnarchiveSessionsOptions,
): Promise<{ restoredIds: string[]; failedIds: string[] }> {
  const restoredIds: string[] = []
  const failedIds: string[] = []
  const expectedRuntimeKey = options?.expectedRuntimeKey ?? getRuntimeKey()

  for (const [index, id] of ids.entries()) {
    if (isStaleRuntime(expectedRuntimeKey)) {
      failedIds.push(...ids.slice(index))
      break
    }
    if (await unarchiveSession(id, expectedRuntimeKey)) restoredIds.push(id)
    else failedIds.push(id)
  }

  return { restoredIds, failedIds }
}

export async function updateSessionTitle(sessionId: string, title: string): Promise<void> {
  const sessionDirectory = getSessionDirectory(sessionId)
  const session = await opencodeClient.updateSession(sessionId, { title }, sessionDirectory)
  useGlobalSessionsStore.getState().upsertSession(session)
  mirrorSessionIntoLiveStores(session, sessionDirectory)
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
  // A successful unshare is authoritative even when the upstream response
  // echoes the pre-mutation session with its old share URL. Normalize that
  // stale field at the action boundary before publishing to either store.
  const session = {
    ...stripSessionDiffSnapshots(assertSdkData(result, "session.unshare")),
    share: undefined,
  }
  useGlobalSessionsStore.getState().upsertSession(session)
  updateLiveSession(session, sessionDirectory)
  return session
}

// ---------------------------------------------------------------------------
// Optimistic message send — insert user message before API call, rollback on error
// ---------------------------------------------------------------------------

// ID generator matching OpenCode's Identifier.ascending wire format.
// Uses BigInt(timestamp) * 0x1000 + counter, encoded as 6 hex bytes + random base62.
// The 6-byte prefix rolls over, so this value is identity only; transcript
// chronology is always derived from message.time.created.
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
  runtimeKey?: string
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
  const optimisticAdd = _optimisticAdd
  const optimisticRemove = _optimisticRemove
  const optimisticConfirm = _optimisticConfirm

  const assertRuntimeUnchanged = () => {
    if (input.runtimeKey && input.runtimeKey !== getRuntimeKey()) {
      throw new Error("Message was not sent because the runtime changed.")
    }
  }

  assertRuntimeUnchanged()
  await waitForConnectionOrThrow()
  input.beforeOptimisticInsert?.()
  assertRuntimeUnchanged()

  const targetDirectory = input.directory ?? dir()
  const store = targetDirectory ? dirStoreForDirectory(targetDirectory) : dirStore()
  const stateBeforeSend = store.getState()
  const sessionBeforeSend = stateBeforeSend.session.find((session) => session.id === input.sessionId)
  const revertMessageID = sessionBeforeSend?.revert?.messageID
  const messagesBeforeSend = stateBeforeSend.message[input.sessionId] ?? []
  const revertedMessages = messagesFrom(messagesBeforeSend, revertMessageID)
  const revertedParts = new Map(
    revertedMessages.map((message) => [message.id, stateBeforeSend.part[message.id] ?? []] as const),
  )

  if (revertMessageID) {
    const session = stateBeforeSend.session.map((candidate) => (
      candidate.id === input.sessionId ? { ...candidate, revert: undefined } as Session : candidate
    ))
    const message = {
      ...stateBeforeSend.message,
      [input.sessionId]: messagesBefore(messagesBeforeSend, revertMessageID),
    }
    const part = { ...stateBeforeSend.part }
    for (const revertedMessage of revertedMessages) delete part[revertedMessage.id]
    store.setState({ session, message, part })

    // A server-backed user message can still remain in the loader's optimistic
    // shadow until a page fetch confirms it. Forget the reverted branch there
    // too, or the next tail refresh will merge those deleted messages back in.
    for (const revertedMessage of revertedMessages) {
      _optimisticConfirm?.({
        sessionID: input.sessionId,
        directory: targetDirectory,
        messageID: revertedMessage.id,
      })
    }
  }

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
  optimisticAdd({
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
    assertRuntimeUnchanged()
    await input.send(messageID)
  } catch (error) {
    const status = getErrorStatus(error)
    const ambiguousFailure = isAmbiguousSendFailure(error)
    const acceptedRecords = ambiguousFailure
      ? await fetchRecentSendConfirmationRecords(input.sessionId, messageID, targetDirectory)
      : null

    if (acceptedRecords) {
      materializeConfirmedSendRecords(store, input.sessionId, messageID, acceptedRecords)
      optimisticConfirm?.({
        sessionID: input.sessionId,
        directory: targetDirectory,
        messageID,
      })
      return
    }

    // The rollback below makes the user's message disappear with no other
    // trace, and the composer intentionally stays silent for transport-level
    // failures. Record the failure so the About dialog's diagnostics report can
    // answer "it disappeared and nothing happened" with an actual cause.
    // `reason` is truncated by the recorder: a rejected send echoes the
    // provider/OpenCode response body, which this log has no reason to keep.
    const failureRecord = {
      sessionId: input.sessionId,
      messageId: messageID,
      directory: targetDirectory ?? null,
      status,
      ambiguous: ambiguousFailure,
      confirmationChecked: ambiguousFailure,
      reason: error instanceof Error ? error.message : String(error),
    }
    recordSendFailure(failureRecord)
    console.warn("[session-actions] prompt send rejected; rolling back optimistic message", failureRecord)

    // Rollback via optimistic infrastructure
    optimisticRemove({
      sessionID: input.sessionId,
      directory: targetDirectory,
      messageID,
    })
    const rollbackState = store.getState()
    let session = rollbackState.session
    let message = rollbackState.message
    let part = rollbackState.part

    if (revertMessageID) {
      session = rollbackState.session.map((candidate) => (
        candidate.id === input.sessionId ? { ...candidate, revert: sessionBeforeSend?.revert } as Session : candidate
      ))
      message = {
        ...rollbackState.message,
        [input.sessionId]: mergeMessages(rollbackState.message[input.sessionId] ?? [], revertedMessages),
      }
      part = { ...rollbackState.part }
      for (const [revertedMessageID, parts] of revertedParts) {
        part[revertedMessageID] = parts
      }
    }

    store.setState({
      session,
      message,
      part,
      session_status: {
        ...rollbackState.session_status,
        [input.sessionId]: { type: "idle" as const },
      },
    })
    throw error
  }
}

async function fetchRecentSendConfirmationRecords(
  sessionId: string,
  messageID: string,
  directory?: string | null,
): Promise<Array<{ info: Message; parts?: Part[] }> | null> {
  // Bounded: a connection that never returns must still let the send fail
  // rather than hang the composer.
  const reconnectDeadline = Date.now() + SEND_CONFIRMATION_RECONNECT_TIMEOUT_MS
  while (!useConfigStore.getState().isConnected && Date.now() < reconnectDeadline) {
    await wait(SEND_CONFIRMATION_RECONNECT_POLL_MS)
  }

  for (let attempt = 0; attempt < SEND_CONFIRMATION_REFETCH_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await wait(SEND_CONFIRMATION_REFETCH_BASE_RETRY_MS * 2 ** (attempt - 1))
    try {
      const result = await sdk().session.messages({
        sessionID: sessionId,
        directory: directory ?? undefined,
        limit: SEND_CONFIRMATION_REFETCH_LIMIT,
      })
      const records = (assertSdkSuccess(result, "session.messages") ?? [])
        .filter((record: { info?: { id?: string } }) => !!record?.info?.id) as Array<{ info: Message; parts?: Part[] }>
      if (records.some((record) => record.info.id === messageID)) {
        return records
      }
    } catch {
      // Confirmation is best-effort; if it fails, keep the original send error path.
    }
  }
  return null
}

function materializeConfirmedSendRecords(
  store: DirectoryStoreApi,
  sessionId: string,
  messageID: string,
  records: Array<{ info: Message; parts?: Part[] }>,
): void {
  store.setState((state) => {
    const currentMessages = state.message[sessionId]
    const message = { ...state.message }
    const part = { ...state.part }
    if (currentMessages) {
      const nextMessages = currentMessages.filter((message) => message.id !== messageID)
      message[sessionId] = nextMessages
    }
    delete part[messageID]

    const materialized = materializeSessionSnapshots(
      { ...state, message, part },
      sessionId,
      records.map((record) => ({
        info: stripMessageDiffSnapshots(record.info),
        parts: record.parts ?? [],
      })),
      { skipPartTypes: MESSAGE_REFETCH_SKIP_PARTS },
    )
    return { message: materialized.message, part: materialized.part }
  })
}

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
  directoryOverride?: string,
): Promise<void> {
  await waitForConnectionOrThrow()
  const directory = directoryOverride
    || resolveDirectoryForBlockingRequest("permission", sessionId, requestId)
    || getSessionDirectory(sessionId)
    || dir()
  const client = directoryOverride
    ? opencodeClient.getScopedSdkClient(directoryOverride)
    : getRequestReplyClient("permission", sessionId, requestId)
  const result = await client.permission.reply({
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
  try {
    const result = await getRequestReplyClient("permission", sessionId, requestId).permission.reply({
      requestID: requestId,
      reply: "reject",
      ...(directory ? { directory } : {}),
    })
    if (assertSdkData(result, "permission.reply") !== true) {
      throw new Error("Permission dismissal failed")
    }
  } catch (error) {
    if (isPermissionRequestNotFoundError(error)) {
      removePermissionRequestFromChildStores(sessionId, requestId)
    }
    throw error
  }
}

/**
 * Dismiss every pending permission for the session subtree rooted at `sessionId`
 * (the session itself plus any subagent children). Used by the chat send path:
 * sending a message while a permission prompt is open must cancel/supersede the
 * open permission so it cannot linger or block the new turn.
 *
 * The permissions are removed from the local store OPTIMISTICALLY (before any
 * network call) so the prompt disappears instantly instead of waiting on the
 * `permission.reply` round-trip. Each permission is then formally rejected on
 * the backend via `permission.reply` with `reply: "reject"`, which fires
 * `permission.replied` for reconciliation.
 *
 * Returns true when at least one permission was dismissed. Rejection failures are
 * swallowed (a stranded permission must never block the send);
 * PermissionNotFoundError also clears the stale entry from the child store via
 * {@link dismissPermission}.
 *
 * NOTE: rejecting unblocks the agent's tool but does NOT end its turn. Callers
 * that need to send the next message right away (the chat send path) must also
 * queue the message so the OpenCode runner reaches `idle` — otherwise the new
 * prompt arrives while the run is still active and is discarded by the runner's
 * `ensureRunning`.
 */
export async function dismissOpenPermissionsForSession(sessionId: string): Promise<boolean> {
  if (!sessionId) return false
  const stores = _childStores
  if (!stores) return false

  const toDismiss: Array<{ sessionId: string; requestId: string }> = []
  for (const [, store] of stores.children) {
    const state = store.getState()
    const scopedIds = computeSubtreeIds(state.session, sessionId)
    if (scopedIds.size === 0) continue
    const permissionsBySession = state.permission ?? {}
    for (const scopedId of scopedIds) {
      const requests = permissionsBySession[scopedId]
      if (!requests) continue
      for (const request of requests) {
        toDismiss.push({ sessionId: scopedId, requestId: request.id })
      }
    }
  }

  if (toDismiss.length === 0) return false

  // Optimistically clear the permissions from the local store so the prompt
  // disappears immediately, before the reject round-trip.
  for (const { sessionId: scopedSessionId, requestId } of toDismiss) {
    removePermissionRequestFromChildStores(scopedSessionId, requestId)
  }

  await Promise.all(
    toDismiss.map(async ({ sessionId: scopedSessionId, requestId }) => {
      try {
        await dismissPermission(scopedSessionId, requestId)
      } catch (error) {
        if (isPermissionRequestNotFoundError(error)) return
        // Swallow: a failed dismissal must not block the send. The next
        // permission.asked / permission.replied event reconciles the store.
        console.error("[session-actions] Failed to dismiss open permission on send:", error)
      }
    }),
  )
  return true
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
    // A successful reply is authoritative: the backend resolved the question,
    // so clear it from the local store deterministically instead of waiting
    // for the SSE `question.replied` event. A lost event (SSE gap) would leave
    // the question pending forever, which keeps the session in "waiting for
    // answer" — the next task's thinking and final response never render
    // (issues #2911, #2448). The later SSE event is a no-op (the reducer only
    // removes when present).
    removeQuestionRequestFromChildStores(sessionId, requestId)
  } catch (error) {
    if (isQuestionRequestNotFoundError(error)) {
      removeQuestionRequestFromChildStores(sessionId, requestId)
      recoverStaleBlockingRequest(sessionId)
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
    // A successful rejection is authoritative: the backend resolved the
    // question, so clear it from the local store deterministically (see
    // respondToQuestion for the lost-SSE-event rationale — issues #2911,
    // #2448). The later SSE `question.rejected` event is a no-op.
    removeQuestionRequestFromChildStores(sessionId, requestId)
  } catch (error) {
    if (isQuestionRequestNotFoundError(error)) {
      removeQuestionRequestFromChildStores(sessionId, requestId)
      recoverStaleBlockingRequest(sessionId)
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
 *
 * A successful reject clears the local store deterministically (see
 * {@link rejectQuestion}) so a lost `question.rejected` SSE event cannot leave
 * the session in the pending "waiting for answer" state (issues #2911, #2448).
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

  const localTarget = state.message[sessionId]?.find((message) => message.id === messageId)
  const targetMessage = localTarget
    ?? (await fetchSessionMessages(sessionId, directory)).find((message) => message.id === messageId)
  if (!targetMessage) throw new Error(`Cannot revert session: message ${messageId} was not found`)

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
  let submittedContextParts: readonly ContextCarrierPart[] = []
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
    // Attached context (review comments, quotes, terminal selections) rides in
    // synthetic text parts and belongs back on the composer chips.
    submittedContextParts = parts
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
  const draftTarget: InlineCommentDraftTarget | null = directory
    ? { directory, sessionKey: sessionId }
    : null
  const prevDrafts = draftTarget ? useInlineCommentDraftStore.getState().getDrafts(draftTarget) : []

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
  if (draftTarget) restoreContextPartsToInput(submittedContextParts, draftTarget)

  // Call SDK and merge authoritative result into store
  try {
    // Descendants go first because OpenCode also restores file snapshots during
    // revert. All sessions share a directory, so the parent's snapshot must win.
    await cascadeRevertToDescendants(sessionId, targetMessage.time.created)
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
    if (draftTarget) {
      useInlineCommentDraftStore.getState().clearDrafts(draftTarget)
      useInlineCommentDraftStore.getState().restoreDrafts(draftTarget, prevDrafts)
    }
    throw err
  }
}

export async function refetchSessionMessages(sessionId: string): Promise<void> {
  const { store, directory } = dirStoreForSession(sessionId)
  const loader = getImperativeSessionMessageLoader()
  if (loader && directory) {
    await loader.refreshTail({ directory, sessionID: sessionId }, MESSAGE_REFETCH_LIMIT)
    const snapshot = loader.getSnapshot({ directory, sessionID: sessionId })
    if (snapshot.status === "error") throw snapshot.error ?? new Error("Session message refresh failed")
    return
  }

  // Actions can run in isolated tests before SyncProvider binds the shared
  // loader. The application runtime always takes the shared path above.
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

  // Descendants go first because unrevert can also restore shared file state.
  // Applying the parent last leaves the working tree at the parent's snapshot.
  await cascadeUnrevertToDescendants(sessionId)
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
  // The forked session is a fresh draft target, so the attached context of the
  // forked message follows the text into its composer.
  if (directory) {
    restoreContextPartsToInput(parts, { directory, sessionKey: forkedSession.id })
  }
}

export async function fetchMessagesForSession(sessionID: string, directory?: string | null): Promise<void> {
  const resolvedDir = directory ?? dir()
  if (!resolvedDir) return
  await getImperativeSessionMessageLoader()?.ensure(
    { directory: resolvedDir, sessionID },
    { reason: "navigation" },
  )
}
