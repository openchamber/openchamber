/**
 * Session UI Store — ephemeral UI state only.
 *
 * Domain data (sessions, messages, parts, permissions, questions, status)
 * lives in sync child stores. This store owns ONLY transient UI concerns:
 * current selection, draft state, viewport anchors, model/agent preferences,
 * voice state, abort prompts, attached files, worktree metadata.
 *
 * Session↔worktree attachments are the authoritative exception: they live in
 * session-worktree-store (shared sync), and session-ui-store routes through it.
 *
 * SDK-calling actions that need domain data read it from sync-refs.
 */

import type { ContextPartMetadata } from "@/lib/messages/contextParts"
import { create } from "zustand"
import type { Session, Part, Message, TextPart } from "@opencode-ai/sdk/v2/client"
import type { AttachedFile, SessionContextUsage, SessionWorktreeAttachment } from "@/stores/types/sessionTypes"
import type { WorktreeMetadata } from "@/types/worktree"
import { opencodeClient } from "@/lib/opencode/client"
import { runtimeFetch } from "@/lib/runtime-fetch"
import { useConfigStore } from "@/stores/useConfigStore"
import { useProjectsStore } from "@/stores/useProjectsStore"
import { useSessionDisplayStore } from "@/stores/useSessionDisplayStore"
import { fetchSessionKnowledge, reportSessionKnowledgeDelivered } from "@/lib/sessionKnowledgeApi"
import { useGlobalSessionsStore, resolveGlobalSessionDirectory } from "@/stores/useGlobalSessionsStore"
import { useDirectoryStore } from "@/stores/useDirectoryStore"
import { useSessionFoldersStore } from "@/stores/useSessionFoldersStore"
import { useCommandsStore } from "@/stores/useCommandsStore"
import { useSkillsStore } from "@/stores/useSkillsStore"
import { getDeferredSafeStorage } from "@/stores/utils/safeStorage"
import { markPendingUserSendAnimation } from "@/lib/userSendAnimation"
import { normalizePath } from "@/lib/pathNormalization"
import { CHAT_DRAFT_PROJECT_ID, createChatDirectory, deleteChatDirectory, getChatsRootFromDirectory, warmChatsRootDirectory } from "@/lib/chatDirectories"
import { isVSCodeRuntime } from "@/lib/desktop"
import { flattenAssistantTextParts } from "@/lib/messages/messageText"
import { composeForkSessionMessage } from "@/lib/messages/executionMeta"
import { findLatestUserModelChoice } from "@/lib/messages/userModelChoice"
import { waitForPendingDraftWorktreeRequest } from "@/lib/worktrees/pendingDraftWorktree"
import { waitForWorktreeBootstrap } from "@/lib/worktrees/worktreeBootstrap"
import { getWorktreeSetupWaitEnabled } from "@/lib/openchamberConfig"
import { resolveProjectForSessionDirectory } from "@/lib/projectResolution"
import {
  getSyncSessions,
  getAllSyncSessions,
  getSyncMessages,
  getSyncParts,
  getDirectoryState,
  getSyncSessionDirectory,
} from "./sync-refs"
import {
  resolveSessionDirectoryFromSources,
  type SessionDirectoryResolution,
  type SessionDirectorySources,
} from "./session-directory-resolution"
import { markSessionViewed } from "./notification-store"
import { setActiveSession } from "./sync-context"
import {
  createSession as createSessionAction,
  deleteSession as deleteSessionAction,
  deleteSessions as deleteSessionsAction,
  archiveSession as archiveSessionAction,
  archiveSessions as archiveSessionsAction,
  unarchiveSession as unarchiveSessionAction,
  unarchiveSessions as unarchiveSessionsAction,
  updateSessionTitle as updateSessionTitleAction,
  shareSession as shareSessionAction,
  unshareSession as unshareSessionAction,
  optimisticSend,
  refetchSessionMessages,
  revertToMessage as revertToMessageAction,
  unrevertSession as unrevertSessionAction,
  forkFromMessage as forkFromMessageAction,
  fetchMessagesForSession,
  type ArchiveSessionsOptions,
  type DeleteSessionOptions,
  type DeleteSessionsOptions,
  type UnarchiveSessionsOptions,
} from "./session-actions"
import { useInputStore, type SyntheticContextPart } from "./input-store"
import { useSessionGoalArmStore } from "@/stores/useSessionGoalArmStore"
import { setSessionGoal } from "@/lib/sessionGoalActions"
import { wrapSystemReminder } from "@/lib/systemReminder"
import { useUIStore } from "@/stores/useUIStore"
import { useSelectionStore } from "./selection-store"
import { getViewportSessionMemory, useViewportStore, viewportSessionKey } from "./viewport-store"
import { useSessionWorktreeStore } from "./session-worktree-store"
import { getAttachedSessionDirectory } from "./session-worktree-contract"
import { setSessionOpener } from "./session-navigation"
import { getRuntimeKey } from "@/lib/runtime-switch"
import { clearLastActiveSession, persistLastActiveSession, readLastActiveSession } from "./last-session-cache"
import { persistWorktreeTopology, readPersistedWorktreeTopology } from "./worktree-topology-cache"
import { rememberRuntimeLiveStatus } from "./runtime-live-memory"
import { contextTokensFromBreakdown } from "@/stores/utils/tokenUtils"

export type { AttachedFile }

type GoalCommand = { name: string; template?: string }

export function expandSlashCommandGoalObjective(content: string, commands: GoalCommand[]): string {
  if (!content.startsWith("/")) return content
  const [head, ...tail] = content.split(" ")
  const command = commands.find((candidate) => candidate.name === head.slice(1))
  if (!command?.template?.trim()) return content
  const argumentsText = tail.join(" ")
  if (command.template.includes("$ARGUMENTS")) {
    return command.template.replaceAll("$ARGUMENTS", argumentsText)
  }

  const positions = [...command.template.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]))
  if (positions.length > 0) {
    const parsedArguments = [...argumentsText.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)]
      .map((match) => match[1] ?? match[2] ?? match[3] ?? "")
    const lastPosition = Math.max(...positions)
    return command.template.replace(/\$(\d+)/g, (_match, value: string) => {
      const position = Number(value)
      return position === lastPosition
        ? parsedArguments.slice(position - 1).join(" ")
        : (parsedArguments[position - 1] ?? "")
    })
  }

  return argumentsText ? `${command.template}\n\n${argumentsText}` : command.template
}

// ---------------------------------------------------------------------------
// Send routing — shell mode, slash commands, or normal prompt
// ---------------------------------------------------------------------------

export function routeMessage(params: {
  runtimeKey?: string
  sessionId: string
  directory?: string | null
  content: string
  providerID: string
  modelID: string
  agent?: string
  agentMentionName?: string
  variant?: string
  inputMode?: "normal" | "shell"
  files?: Array<{ type: "file"; mime: string; url: string; filename: string }>
  additionalParts?: Array<{ text: string; synthetic?: boolean; metadata?: ContextPartMetadata; files?: Array<{ type: "file"; mime: string; url: string; filename: string }> }>
  delivery?: 'steer'
}): Promise<void> {
  const requestDirectory = params.directory ?? undefined
  if (params.inputMode === "shell") {
    return opencodeClient.shellSession({
      runtimeKey: params.runtimeKey,
      sessionId: params.sessionId,
      directory: requestDirectory,
      agent: params.agent ?? "",
      model: { providerID: params.providerID, modelID: params.modelID },
      command: params.content,
    }).then(() => undefined)
  }

  // Slash commands — fire and forget, SSE delivers messages and status
  if (params.content.startsWith("/")) {
    const [head, ...tail] = params.content.split(" ")
    const cmdName = head.slice(1)

    const dirState = getDirectoryState(requestDirectory)
    const syncCommands = dirState?.command ?? []
    const storeCommands = useCommandsStore.getState().commands

    // OpenCode registers every skill as a command (source: "skill"), but the
    // commands store filters skills out and the synced command list is only
    // hydrated at bootstrap. Consult the live skills store so a skill selected
    // from the slash menu is invoked via session.command (injecting its
    // content) instead of being sent as a literal "/name" message (#1605).
    const isCommand = syncCommands.find((c) => c.name === cmdName)
      || storeCommands.find((c) => c.name === cmdName)
      || useSkillsStore.getState().skills.some((s) => s.name === cmdName)

    if (isCommand) {
      return optimisticSend({
        runtimeKey: params.runtimeKey,
        sessionId: params.sessionId,
        content: params.content,
        providerID: params.providerID,
        modelID: params.modelID,
        agent: params.agent,
        directory: requestDirectory,
        files: params.files,
        send: (messageID) => opencodeClient.sendCommand({
          runtimeKey: params.runtimeKey,
          id: params.sessionId,
          providerID: params.providerID,
          modelID: params.modelID,
          command: cmdName,
          arguments: tail.join(" "),
          agent: params.agent,
          variant: params.variant,
          files: params.files,
          messageId: messageID,
          directory: requestDirectory,
        }).then(() => {}),
      })
    }
  }

  // Normal prompt — optimistic insert so message appears instantly
  return optimisticSend({
    runtimeKey: params.runtimeKey,
    sessionId: params.sessionId,
    content: params.content,
    providerID: params.providerID,
    modelID: params.modelID,
    agent: params.agent,
    directory: requestDirectory,
    files: params.files,
    send: (messageID) => opencodeClient.sendMessage({
      runtimeKey: params.runtimeKey,
      id: params.sessionId,
      providerID: params.providerID,
      modelID: params.modelID,
      text: params.content,
      agent: params.agent,
      agentMentions: params.agentMentionName ? [{ name: params.agentMentionName }] : undefined,
      variant: params.variant,
      files: params.files,
      additionalParts: params.additionalParts,
      delivery: params.delivery,
      messageId: messageID,
      directory: requestDirectory,
    }).then(() => {}),
  })
}

type CapturedSendTarget = {
  runtimeKey: string
  sessionId: string
  directory: string
}

type SendMessageOptions = {
  target?: CapturedSendTarget
  sessionId?: string
  directory?: string
  /** Immutable copy of the new-session draft at submit time; used instead of the live draft. */
  draftSnapshot?: NewSessionDraftState
  delivery?: 'steer'
}

type AssistantMessageSessionExecution = {
  providerID: string
  modelID: string
  variant: string
  agent: string
  instructions: string
  createWorktree?: boolean
  runAsGoal?: boolean
}

function notifyMessageSent(sessionId: string): void {
  runtimeFetch(`/api/sessions/${sessionId}/message-sent`, { method: "POST" })
    .catch(() => { /* ignore */ })
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NewSessionDraftState = {
  draftId: number
  open: boolean
  selectedProjectId?: string | null
  directoryOverride: string | null
  permissionAutoAcceptEnabled?: boolean
  pendingWorktreeRequestId?: string | null
  bootstrapPendingDirectory?: string | null
  preserveDirectoryOverride?: boolean
  parentID: string | null
  title?: string
  initialPrompt?: string
  syntheticParts?: SyntheticContextPart[]
  targetFolderId?: string
  projectContextPins?: { notes: string[]; plans: string[] }
  target: "chat" | "project"
  preparedChatDirectory?: string | null
}

export type ViewportAnchor = {
  sessionId: string
  value: number
}

export type SessionHistoryMeta = {
  limit: number
  hasMore: boolean
  complete: boolean
  isLoading: boolean
  loading?: boolean
  nextCursor?: string
}

export type SessionUIState = {
  currentSessionId: string | null
  currentSessionDirectory: string | null
  materializedDraftSessionId: string | null
  newSessionDraft: NewSessionDraftState
  abortPromptSessionId: string | null
  abortPromptExpiresAt: number | null
  error: string | null
  worktreeMetadata: Map<string, WorktreeMetadata>
  availableWorktrees: WorktreeMetadata[]
  availableWorktreesByProject: Map<string, WorktreeMetadata[]>
  webUICreatedSessions: Set<string>
  sessionAbortFlags: Map<string, { timestamp: number; acknowledged: boolean }>
  abortControllers: Map<string, AbortController>
  isLoading: boolean
  lastLoadedDirectory: string | null
  // Plan mode - per-session plan file availability (set when plan_enter tool creates a plan)
  sessionPlanAvailable: Map<string, boolean>
  markSessionPlanAvailable: (sessionId: string) => void
  isSessionPlanAvailable: (sessionId: string) => boolean

  // Non-Git mode: dismissed signature hash per session, hides bar until new turn arrives
  pendingChangesBarDismissed: Map<string, string>
  dismissPendingChangesBar: (sessionId: string, signature: string | null) => void

  // Actions — UI state management
  setCurrentSession: (
    id: string | null,
    directoryHint?: string | null,
    transition?: "submitted-draft",
  ) => void
  clearMaterializedDraftSession: (sessionId: string) => void
  prepareForRuntimeSwitch: (apiBaseUrl?: string | null) => void
  restoreForRuntimeSwitch: (apiBaseUrl?: string | null) => void
  openNewSessionDraft: (options?: Partial<NewSessionDraftState> & { automatic?: boolean }) => void
  prepareChatDraftDirectory: () => Promise<string | null>
  closeNewSessionDraft: () => void
  setNewSessionDraftTarget: (target: { projectId?: string | null; selectedProjectId?: string | null; directoryOverride?: string | null }, options?: { force?: boolean }) => void
  setDraftPreserveDirectoryOverride: (value: boolean) => void
  setDraftPermissionAutoAcceptEnabled: (enabled: boolean) => void
  setDraftProjectContextPin: (kind: "note" | "plan", id: string, pinned: boolean) => void
  acknowledgeSessionAbort: (sessionId: string) => void
  clearAbortPrompt: () => void
  armAbortPrompt: (durationMs?: number) => number | null
  clearError: () => void
  markSessionAsOpenChamberCreated: (sessionId: string) => void
  isOpenChamberCreatedSession: (sessionId: string) => boolean
  getContextUsage: (contextLimit: number, outputLimit: number) => SessionContextUsage | null
  initializeNewOpenChamberSession: (sessionId: string, agents: unknown[]) => void
  setWorktreeMetadata: (sessionId: string, metadata: WorktreeMetadata | null) => void
  overrideNewSessionDraftTarget: (options: Record<string, unknown>) => void
  resolvePendingDraftWorktreeTarget: (requestId: string, directory: string | null, options?: Record<string, unknown>) => void
  setDraftBootstrapPendingDirectory: (directory: string | null) => void
  setPendingDraftWorktreeRequest: (requestId: string | null) => void
  getWorktreeMetadata: (sessionId: string) => WorktreeMetadata | undefined

  // Actions — SDK-calling operations (read domain data from sync-refs)
  sendMessage: (
    content: string,
    providerID: string,
    modelID: string,
    agent?: string,
    attachments?: AttachedFile[],
    agentMentionName?: string,
    additionalParts?: Array<{ text: string; attachments?: AttachedFile[]; synthetic?: boolean; metadata?: ContextPartMetadata }>,
    variant?: string,
    inputMode?: "normal" | "shell",
    options?: SendMessageOptions,
  ) => Promise<void>

  createSession: (
    title?: string,
    directoryOverride?: string | null,
    parentID?: string | null,
    metadata?: Record<string, unknown>,
  ) => Promise<Session | null>
  deleteSession: (id: string, options?: DeleteSessionOptions) => Promise<boolean>
  deleteSessions: (ids: string[], options?: DeleteSessionsOptions) => Promise<{ deletedIds: string[]; failedIds: string[] }>
  archiveSession: (id: string) => Promise<boolean>
  archiveSessions: (ids: string[], options?: ArchiveSessionsOptions) => Promise<{ archivedIds: string[]; failedIds: string[] }>
  unarchiveSession: (id: string) => Promise<boolean>
  unarchiveSessions: (ids: string[], options?: UnarchiveSessionsOptions) => Promise<{ restoredIds: string[]; failedIds: string[] }>
  updateSessionTitle: (sessionId: string, title: string) => Promise<void>
  shareSession: (sessionId: string) => Promise<Session | null>
  unshareSession: (sessionId: string) => Promise<Session | null>
  revertToMessage: (sessionId: string, messageId: string, options?: { skipRedoPush?: boolean }) => Promise<void>
  forkFromMessage: (sessionId: string, messageId: string) => Promise<void>
  handleSlashUndo: (sessionId: string) => Promise<void>
  handleSlashRedo: (sessionId: string, options?: { fullUnrevert?: boolean }) => Promise<void>
  createSessionFromAssistantMessage: (sourceMessageId: string, execution: AssistantMessageSessionExecution) => Promise<void>

  // Data access helpers (read from sync)
  getSessionsByDirectory: (directory: string) => Session[]
  getDirectoryForSession: (sessionId: string) => string | null
  getLastUserChoice: (sessionId: string) => { agent?: string; providerID?: string; modelID?: string; variant?: string } | null
  getCurrentAgent: (sessionId: string) => string | undefined
  debugSessionMessages: (sessionId: string) => Promise<void>
  pollForTokenUpdates: () => void
  setSessionDirectory: (sessionId: string, directory: string | null) => void
  /**
   * Replace a guessed selection directory with the authoritative one once sync
   * has indexed the session. Safe to call at any time: it only ever promotes a
   * guess, never overrides a confirmed selection.
   */
  adoptAuthoritativeSessionDirectory: (sessionId?: string) => void
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------


const resolveDirectoryKey = (session: Session): string | null => {
  const sessionRecord = session as Session & {
    directory?: string | null
    project?: { worktree?: string | null } | null
  }
  return normalizePath(sessionRecord.directory ?? null)
    ?? normalizePath(sessionRecord.project?.worktree ?? null)
}

const safeStorage = getDeferredSafeStorage()
const DRAFT_TARGET_STORAGE_KEY = "oc.chatInput.lastDraftTarget"

type PersistedDraftTarget = { projectId: string | null; directory: string | null }

const readPersistedDraftTarget = (): PersistedDraftTarget | null => {
  try {
    const raw = safeStorage.getItem(DRAFT_TARGET_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { projectId?: unknown; directory?: unknown }
    return {
      projectId: typeof parsed?.projectId === "string" ? parsed.projectId : null,
      directory: normalizePath(typeof parsed?.directory === "string" ? parsed.directory : null),
    }
  } catch {
    return null
  }
}

const persistDraftTarget = (target: PersistedDraftTarget): void => {
  try {
    safeStorage.setItem(DRAFT_TARGET_STORAGE_KEY, JSON.stringify(target))
  } catch { /* ignored */ }
}

const resolveDraftProjectForDirectory = resolveProjectForSessionDirectory

const getAttachmentForSession = (sessionId: string | null | undefined): SessionWorktreeAttachment | undefined => {
  if (!sessionId) return undefined
  return useSessionWorktreeStore.getState().getAttachment(sessionId)
}

/**
 * The directory that owns a session, from the two server-backed signals.
 *
 * `null` means "not indexed yet", never "no directory" — callers must fall back
 * rather than treat it as empty.
 *
 * The session's own record wins. Holding a session in a child store proves
 * containment, not ownership: a project's session list legitimately includes
 * the sessions of its worktrees so the sidebar can group them, so the parent
 * repository holds worktree sessions too. Reading ownership from store
 * membership therefore reports the parent for a session that lives in a
 * worktree, and every fetch is then addressed to a directory that does not own
 * it. Store membership remains the fallback for a session whose record carries
 * no directory.
 */
const getAuthoritativeSessionDirectory = (sessionId: string): string | null => {
  const target = getAllSyncSessions().find((s) => s.id === sessionId)
  const recordDirectory = target ? resolveDirectoryKey(target) : null
  if (recordDirectory) return normalizePath(recordDirectory)
  const owningDirectory = getSyncSessionDirectory(sessionId)
  return owningDirectory ? normalizePath(owningDirectory) : null
}

/**
 * Directory remembered for a session in this runtime, plus the one persisted
 * across restarts. Exported for diagnostics: a stale persisted directory is the
 * hardest source to observe and the one that survives reloads, so a report that
 * cannot show it cannot rule it out.
 */
export const getRememberedSessionDirectory = (sessionId: string): {
  runtime: string | null
  persisted: string | null
} => {
  const key = runtimeMemoryKey()
  const runtimeMemory = runtimeSessionMemory.get(key)
  const persisted = readLastActiveSession(key)
  return {
    runtime: runtimeMemory?.sessionId === sessionId ? normalizePath(runtimeMemory.directory) : null,
    persisted: persisted?.sessionId === sessionId ? normalizePath(persisted.directory) : null,
  }
}

/**
 * Session whose `currentSessionDirectory` is only the active directory, used
 * because the session's own directory was not known at selection time. Such a
 * value must never outrank a worktree assignment or reach persistence — it is
 * a guess, not a selection.
 */
let guessedSelectionSessionId: string | null = null

const collectSessionDirectorySources = (
  sessionId: string,
  getWtMeta: (id: string) => WorktreeMetadata | undefined,
  selected: string | null,
): SessionDirectorySources => ({
  authoritative: getAuthoritativeSessionDirectory(sessionId),
  selected: sessionId === guessedSelectionSessionId ? null : normalizePath(selected),
  attachment: getAttachedSessionDirectory(getAttachmentForSession(sessionId)),
  worktreeMetadata: normalizePath(getWtMeta(sessionId)?.path ?? null),
  remembered: getRememberedSessionDirectory(sessionId).runtime,
})

/**
 * Conflicts already warned about, so a stale directory logs once instead of on
 * every keystroke. Keyed by runtime *and* the exact pair of directories: the
 * same session ID means a different thing in another runtime, and a conflict
 * that reappears after being resolved is news worth logging again. Bounded so
 * a long-lived session cannot grow it without limit.
 */
const reportedDirectoryConflicts = new Set<string>()
const MAX_REPORTED_DIRECTORY_CONFLICTS = 200

const reportSessionDirectoryConflict = (
  sessionId: string,
  resolution: SessionDirectoryResolution,
): void => {
  if (!resolution.conflict) return
  const conflictKey = JSON.stringify([
    runtimeMemoryKey(),
    sessionId,
    resolution.directory,
    resolution.conflict.source,
    resolution.conflict.directory,
  ])
  if (reportedDirectoryConflicts.has(conflictKey)) return
  if (reportedDirectoryConflicts.size >= MAX_REPORTED_DIRECTORY_CONFLICTS) {
    reportedDirectoryConflicts.clear()
  }
  reportedDirectoryConflicts.add(conflictKey)
  console.warn(
    "[session-directory] session directory sources disagree; using the higher-authority one. "
    + "Run __opencodeDebug.diagnoseSessionDirectory() for the full picture.",
    {
      sessionId,
      using: resolution.source,
      directory: resolution.directory,
      conflictingSource: resolution.conflict.source,
      conflictingDirectory: resolution.conflict.directory,
    },
  )
}

const resolveSessionDirectory = (
  sessionId: string | null | undefined,
  getWtMeta: (id: string) => WorktreeMetadata | undefined,
  selected: string | null = null,
): string | null => {
  if (!sessionId) return null
  const resolution = resolveSessionDirectoryFromSources(
    collectSessionDirectorySources(sessionId, getWtMeta, selected),
  )
  reportSessionDirectoryConflict(sessionId, resolution)
  return resolution.directory
}

const activateConfigForDirectory = async (directory: string | null | undefined): Promise<void> => {
  await useConfigStore.getState().activateDirectory(normalizePath(directory))
}

const DEFAULT_DRAFT: NewSessionDraftState = {
  draftId: 0,
  open: false,
  directoryOverride: null,
  parentID: null,
  target: "chat",
}
let nextDraftId = 1
const pendingChatDirectoryByDraft = new Map<string, Promise<string | null>>()

const activeSessionByRuntime = new Map<string, string | null>()
type RuntimeSessionMemory = {
  sessionId: string | null
  directory: string | null
  draft: NewSessionDraftState
  worktreeMetadata: Map<string, WorktreeMetadata>
  availableWorktreesByProject: Map<string, WorktreeMetadata[]>
}
const runtimeSessionMemory = new Map<string, RuntimeSessionMemory>()

const runtimeMemoryKey = (value?: string | null): string => {
  const key = (value ?? getRuntimeKey()).trim()
  return key || "default"
}

const cloneDraft = (draft: NewSessionDraftState): NewSessionDraftState => ({ ...draft })

const writeRuntimeSessionMemory = (key: string, patch: Partial<RuntimeSessionMemory>): void => {
  const current = runtimeSessionMemory.get(key)
  runtimeSessionMemory.set(key, {
    sessionId: current?.sessionId ?? null,
    directory: current?.directory ?? null,
    draft: current?.draft ? cloneDraft(current.draft) : { ...DEFAULT_DRAFT },
    worktreeMetadata: current?.worktreeMetadata ?? new Map(),
    availableWorktreesByProject: current?.availableWorktreesByProject ?? new Map(),
    ...patch,
  })
}

type MaterializedDraftSession = {
  sessionId: string
  directory: string | null
  agent?: string
  syntheticParts?: SyntheticContextPart[]
}

const resolveProjectRefForWorktreeDirectory = (directory: string | null, projectId?: string | null): { id: string; path: string } | null => {
  const projectsState = useProjectsStore.getState()
  if (projectId) {
    const project = projectsState.projects.find((entry) => entry.id === projectId)
    if (project?.path) return { id: project.id, path: project.path }
  }
  const resolved = resolveProjectForSessionDirectory(projectsState.projects, useSessionUIStore.getState().availableWorktreesByProject, directory)
  return resolved?.path ? { id: resolved.id, path: resolved.path } : null
}

const waitForWorktreeBootstrapIfConfigured = async (directory: string | null, projectId?: string | null): Promise<void> => {
  if (!directory) return
  const project = resolveProjectRefForWorktreeDirectory(directory, projectId)
  if (project && await getWorktreeSetupWaitEnabled(project)) {
    await waitForWorktreeBootstrap(directory)
  }
}

const resolveActiveProjectDirectory = (draft: NewSessionDraftState): string | null => {
  const projectsState = useProjectsStore.getState()
  return normalizePath(
    projectsState.getActiveProject()?.path
      ?? (draft.selectedProjectId
        ? projectsState.projects.find((project) => project.id === draft.selectedProjectId)?.path
        : null)
      ?? null,
  )
}

/**
 * Regular new-chat drafts inherit the persisted current/last directory. If that
 * path is confirmed missing (deleted worktree), fall back to the active project.
 * Explicit worktree targets, in-flight worktree creation, and unknown/offline
 * probes stay unchanged so a temporary outage cannot rewrite the destination.
 * A concurrent rewrite of the same implicit draft to that fallback is accepted
 * instead of aborting create.
 */
const resolveCreatableDraftDirectory = async (
  draft: NewSessionDraftState,
  requestedDirectory: string | null | undefined,
): Promise<{ status: "ok"; directory: string | null | undefined } | { status: "aborted" }> => {
  const directory = requestedDirectory ?? opencodeClient.getDirectory() ?? null
  const isRecoverableDraftDirectory =
    draft.open
    && draft.preserveDirectoryOverride !== true
    && !draft.pendingWorktreeRequestId
    && !draft.bootstrapPendingDirectory
    && normalizePath(draft.directoryOverride) === normalizePath(directory)

  if (!isRecoverableDraftDirectory || !directory) {
    return { status: "ok", directory }
  }

  const activeProjectDirectory = resolveActiveProjectDirectory(draft)
  if (!activeProjectDirectory || normalizePath(directory) === activeProjectDirectory) {
    return { status: "ok", directory }
  }

  const runtimeKey = getRuntimeKey()
  const draftDirectory = draft.directoryOverride
  const availability = await opencodeClient.getDirectoryAvailability(directory)
  const currentDraft = useSessionUIStore.getState().newSessionDraft
  const currentDirectory = normalizePath(currentDraft.directoryOverride)
  const capturedDirectory = normalizePath(draftDirectory)
  // openNewSessionDraft may rewrite the same implicit draft to this fallback
  // while createSession's probe is still in flight. That is the intended
  // destination, not a user change, so do not abort the create.
  const recoveredToActiveProject = currentDirectory === activeProjectDirectory
    && capturedDirectory !== activeProjectDirectory
  const draftChanged = !currentDraft.open
    || currentDraft.preserveDirectoryOverride !== draft.preserveDirectoryOverride
    || currentDraft.pendingWorktreeRequestId !== draft.pendingWorktreeRequestId
    || (currentDirectory !== capturedDirectory && !recoveredToActiveProject)

  if (getRuntimeKey() !== runtimeKey || draftChanged) {
    return { status: "aborted" }
  }

  if (recoveredToActiveProject) {
    return { status: "ok", directory: activeProjectDirectory }
  }

  return {
    status: "ok",
    directory: availability === "missing" ? activeProjectDirectory : directory,
  }
}

const recoverStaleDraftDirectory = async (openedDraft: NewSessionDraftState): Promise<void> => {
  const resolved = await resolveCreatableDraftDirectory(openedDraft, openedDraft.directoryOverride)
  if (resolved.status !== "ok") return
  const recovered = normalizePath(resolved.directory ?? null)
  const original = normalizePath(openedDraft.directoryOverride)
  if (!recovered || recovered === original) return

  const currentDraft = useSessionUIStore.getState().newSessionDraft
  if (!currentDraft.open) return
  if (currentDraft.preserveDirectoryOverride === true) return
  if (currentDraft.pendingWorktreeRequestId) return
  if (normalizePath(currentDraft.directoryOverride) !== original) return

  const recoveredProject = useProjectsStore.getState().projects.find((project) => (
    normalizePath(project.path) === recovered
  ))
  const nextDraft: NewSessionDraftState = {
    ...currentDraft,
    selectedProjectId: recoveredProject?.id ?? currentDraft.selectedProjectId,
    directoryOverride: recovered,
  }
  useSessionUIStore.setState({ newSessionDraft: nextDraft })
  writeRuntimeSessionMemory(runtimeMemoryKey(), { draft: nextDraft })
  persistDraftTarget({ projectId: nextDraft.selectedProjectId ?? null, directory: recovered })
  void activateConfigForDirectory(recovered)
}

const createSessionWithDraftLifecycle = async (
  title?: string,
  directoryOverride?: string | null,
  parentID?: string | null,
  metadata?: Record<string, unknown>,
  selectionTransition?: "submitted-draft",
): Promise<Session | null> => {
  const store = useSessionUIStore.getState()
  const draft = store.newSessionDraft
  const targetFolderId = draft.targetFolderId

  try {
    const resolved = await resolveCreatableDraftDirectory(draft, directoryOverride)
    if (resolved.status === "aborted") return null
    const directory = resolved.directory
    const session = await createSessionAction(
      title,
      directory,
      parentID ?? null,
      metadata,
      selectionTransition,
    )
    if (!session) return null

    useSessionUIStore.getState().closeNewSessionDraft()

    if (targetFolderId) {
      const currentStore = useSessionUIStore.getState()
      const scopeDirectory = directory || currentStore.lastLoadedDirectory || session.directory
      const scopeKey = getChatsRootFromDirectory(scopeDirectory) ?? scopeDirectory
      if (scopeKey) {
        useSessionFoldersStore.getState().addSessionToFolder(scopeKey, targetFolderId, session.id)
      }
    }

    return session
  } catch (error) {
    console.error("[session-ui-store] createSession failed", error)
    return null
  }
}

export async function materializeOpenDraftSession(selection: {
  providerID: string
  modelID: string
  agent?: string
  variant?: string
}, draftOverride?: NewSessionDraftState): Promise<MaterializedDraftSession | null> {
  const store = useSessionUIStore.getState()
  const draft = draftOverride ?? store.newSessionDraft
  if (!draft?.open) return null
  const draftPermissionAutoAcceptEnabled = draft.permissionAutoAcceptEnabled === true

  const trimmedAgent = typeof selection.agent === "string" && selection.agent.trim().length > 0
    ? selection.agent.trim()
    : undefined
  let draftDirectoryOverride = draft.bootstrapPendingDirectory ?? draft.directoryOverride ?? null
  const draftProjectId = draft.selectedProjectId ?? null

  if (draft.pendingWorktreeRequestId) {
    draftDirectoryOverride = await waitForPendingDraftWorktreeRequest(draft.pendingWorktreeRequestId)
    store.resolvePendingDraftWorktreeTarget(draft.pendingWorktreeRequestId, draftDirectoryOverride)
  }

  const isChatDraft = draft.target === "chat"
  if (isChatDraft) {
    draftDirectoryOverride = await store.prepareChatDraftDirectory()
    if (!draftDirectoryOverride) throw new Error("Failed to prepare chat directory")
    const currentDraft = useSessionUIStore.getState().newSessionDraft
    if (currentDraft.draftId === draft.draftId) {
      useSessionUIStore.setState({
        newSessionDraft: { ...currentDraft, preparedChatDirectory: null },
      })
    }
  }

  await waitForWorktreeBootstrapIfConfigured(draftDirectoryOverride, draftProjectId)

  const draftPins = draft.projectContextPins ?? { notes: [], plans: [] }
  const created = await createSessionWithDraftLifecycle(
    draft.title,
    draftDirectoryOverride,
    draft.parentID ?? null,
    draftPins.notes.length > 0 || draftPins.plans.length > 0
      ? { openchamber: { project_context_pins: draftPins } }
      : undefined,
    "submitted-draft",
  )
  if (!created?.id) {
    if (isChatDraft && draftDirectoryOverride) {
      await deleteChatDirectory(draftDirectoryOverride).catch(() => undefined)
    }
    throw new Error("Failed to create session")
  }

  // The server response is authoritative. It may canonicalize a requested
  // worktree path (for example through a symlink or platform path casing).
  // Sending with the pre-canonical draft path can target a different
  // directory scope than the session that was just created.
  const createdDirectory = normalizePath(created.directory ?? draftDirectoryOverride ?? null)

  persistDraftTarget({
    projectId: draftProjectId,
    directory: createdDirectory,
  })

  const draftSyntheticParts = draft.syntheticParts
  const configState = useConfigStore.getState()
  void activateConfigForDirectory(createdDirectory).catch((error) => {
    console.warn("Failed to activate directory after creating session:", error)
  })

  const effectiveDraftAgent = trimmedAgent ?? configState.currentAgentName
  const variantOverride = configState.currentProviderId === selection.providerID
    && configState.currentModelId === selection.modelID
    && configState.currentAgentName === effectiveDraftAgent
    ? configState.currentVariantSelection.override ?? undefined
    : selection.variant

  useSelectionStore.getState().saveSessionModelSelection(created.id, selection.providerID, selection.modelID)

  if (effectiveDraftAgent) {
    useSelectionStore.getState().saveSessionAgentSelection(created.id, effectiveDraftAgent)
    useSelectionStore.getState().saveAgentModelForSession(created.id, effectiveDraftAgent, selection.providerID, selection.modelID)
    useSelectionStore.getState().saveAgentModelVariantForSession(created.id, effectiveDraftAgent, selection.providerID, selection.modelID, variantOverride)
  }

  store.initializeNewOpenChamberSession(created.id, configState.agents ?? [])

  if (draftPermissionAutoAcceptEnabled) {
    void import("@/stores/permissionStore")
      .then(({ usePermissionStore }) => usePermissionStore.getState().setSessionAutoAccept(created.id, true))
      .catch((error) => {
        console.warn("Failed to apply draft permission auto-accept to new session:", error)
      })
  }

  return {
    sessionId: created.id,
    directory: createdDirectory,
    agent: effectiveDraftAgent,
    syntheticParts: draftSyntheticParts,
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Persisted worktree map (stale-while-revalidate)
//
// Worktree discovery is async (git), so the worktree→project map isn't ready at
// startup. Persist it so (a) the sidebar worktree list paints instantly, and
// (b) useConfigStore.resolveConfigDirectory can map a worktree to its project on
// the FIRST launch — yielding a single project-scoped config load instead of a
// worktree+project double-load. Discovery refreshes it in the background.
// ---------------------------------------------------------------------------
const flattenWorktreeMap = (map: Map<string, WorktreeMetadata[]>): WorktreeMetadata[] => {
  const out: WorktreeMetadata[] = []
  for (const list of map.values()) out.push(...list)
  return out
}

const PERSISTED_WORKTREE_MAP = readPersistedWorktreeTopology(runtimeMemoryKey())

export const useSessionUIStore = create<SessionUIState>()((set, get) => ({
  currentSessionId: null,
  currentSessionDirectory: null,
  materializedDraftSessionId: null,
  newSessionDraft: { ...DEFAULT_DRAFT },
  abortPromptSessionId: null,
  abortPromptExpiresAt: null,
  error: null,
  worktreeMetadata: new Map(),
  availableWorktrees: flattenWorktreeMap(PERSISTED_WORKTREE_MAP),
  availableWorktreesByProject: PERSISTED_WORKTREE_MAP,
  webUICreatedSessions: new Set(),
  sessionAbortFlags: new Map(),
  abortControllers: new Map(),
  isLoading: false,
  lastLoadedDirectory: null,
  sessionPlanAvailable: new Map(),
  pendingChangesBarDismissed: new Map(),

  // ---------------------------------------------------------------------------
  // setCurrentSession
  // ---------------------------------------------------------------------------
  setCurrentSession: (id, directoryHint?: string | null, transition?: "submitted-draft") => {
    const materializedDraftSessionId = id && transition === "submitted-draft" ? id : null
    // Publish the transition identity before closing the draft. Those are two
    // separate store updates, and ChatContainer must never observe a closed
    // draft with the previous transition identity.
    if (get().materializedDraftSessionId !== materializedDraftSessionId) {
      set({ materializedDraftSessionId })
    }
    if (id) {
      get().closeNewSessionDraft()
    }

    const key = runtimeMemoryKey()
    activeSessionByRuntime.set(key, id)

    const previousSessionId = get().currentSessionId
    const directoryState = useDirectoryStore.getState()

    const sessionDir = resolveSessionDirectory(
      id,
      (sid) => get().worktreeMetadata.get(sid),
    )
    const fallbackDir = opencodeClient.getDirectory() ?? directoryState.currentDirectory ?? null
    const knownDir = (directoryHint ? normalizePath(directoryHint) : null) ?? sessionDir
    const resolvedDir = knownDir ?? fallbackDir
    // `fallbackDir` is the active directory, not this session's directory. It
    // keeps routing usable while the owning directory store bootstraps, but it
    // must never be remembered: a persisted guess outlives the race that
    // produced it and survives reloads and restarts.
    const isGuessedDir = knownDir === null
    const projectsState = useProjectsStore.getState()
    const sessionProject = resolvedDir
      ? resolveProjectForSessionDirectory(
        projectsState.projects,
        get().availableWorktreesByProject,
        resolvedDir,
      )
      : null

    // Start the message fetch before publishing the selection. React flushes
    // the discrete-event render in a microtask queued by `set`, so a fetch
    // started after it would only leave the browser once that whole render
    // finished. Started first, the request is on the wire while the render
    // runs. Fire-and-forget: any transient failure is retried by the reactive
    // path in ChatContainer.
    if (id) {
      void fetchMessagesForSession(id, resolvedDir)
    }

    // Set the directory together with the session id so chat hooks read the
    // same child store that send/SSE events will update during startup races.
    set({
      currentSessionId: id,
      currentSessionDirectory: id ? resolvedDir ?? null : null,
    })
    guessedSelectionSessionId = isGuessedDir && id ? id : null
    const rememberedDir = isGuessedDir ? null : resolvedDir ?? null
    writeRuntimeSessionMemory(key, { sessionId: id, directory: rememberedDir })
    // Keep the last NON-null session per runtime across app restarts (cold
    // mobile launches reopen it after the instance reconnects). Going back to
    // a draft intentionally does not erase it.
    if (id) {
      persistLastActiveSession(key, { sessionId: id, directory: rememberedDir })
    }

    try {
      if (resolvedDir && directoryState.currentDirectory !== resolvedDir) {
        directoryState.setDirectory(resolvedDir, { showOverlay: false })
      }
      if (sessionProject && projectsState.activeProjectId !== sessionProject.id) {
        projectsState.setActiveProjectIdOnly(sessionProject.id)
      }
      if (id && !isGuessedDir && sessionProject) {
        useSessionDisplayStore.getState().setSingleProjectId(sessionProject.id)
      }
      opencodeClient.setDirectory(resolvedDir ?? undefined)
    } catch (e) {
      console.warn("Failed to set OpenCode directory for session switch:", e)
    }

    // Defer viewport anchor save for previous session — not needed for the
    // skeleton to render and reads messages which can be expensive.
    if (previousSessionId && previousSessionId !== id) {
      const prevId = previousSessionId
      const newId = id
      // queueMicrotask runs after the current synchronous call stack (and
      // before the next macrotask / setTimeout(0) / paint), so the previous
      // session's anchor is saved before the new session's restoreSnapshot
      // effect fires. This eliminates the race where save and restore
      // interleave against the same viewport store entry.
      queueMicrotask(() => {
        // Bail if the user already switched again — save is now stale.
        const current = get().currentSessionId
        if (current !== newId) return
        const memState = getViewportSessionMemory(prevId)
        if (!memState?.isStreaming) {
          const prevMessages = getSyncMessages(prevId)
          if (prevMessages.length > 0) {
            useViewportStore.getState().updateViewportAnchor(prevId, prevMessages.length - 1)
          }
        }
      });
    }

    // Mark session viewed in notification store + update active session ref
    if (id) {
      markSessionViewed(id)
      setActiveSession(resolvedDir ?? "", id)
    }
  },

  clearMaterializedDraftSession: (sessionId) => {
    if (get().materializedDraftSessionId !== sessionId) return
    set({ materializedDraftSessionId: null })
  },

  prepareForRuntimeSwitch: (apiBaseUrl?: string | null) => {
    const key = runtimeMemoryKey(apiBaseUrl)
    const directory = useDirectoryStore.getState().currentDirectory || null
    const currentSessionId = get().currentSessionId
    const directorySnapshot = directory ? getDirectoryState(directory) : null
    rememberRuntimeLiveStatus({
      runtimeKey: key,
      directory,
      sessionId: currentSessionId,
      status: currentSessionId ? directorySnapshot?.session_status?.[currentSessionId] : null,
    })
    activeSessionByRuntime.set(key, get().currentSessionId)
    writeRuntimeSessionMemory(key, {
      sessionId: currentSessionId,
      directory,
      draft: cloneDraft(get().newSessionDraft),
      worktreeMetadata: new Map(get().worktreeMetadata),
      availableWorktreesByProject: new Map(get().availableWorktreesByProject),
    })
  },

  restoreForRuntimeSwitch: (apiBaseUrl?: string | null) => {
    const key = runtimeMemoryKey(apiBaseUrl)
    const memory = runtimeSessionMemory.get(key)
    const restoredSessionId = memory?.sessionId ?? activeSessionByRuntime.get(key) ?? null
    const restoredDraft = memory?.draft ? cloneDraft(memory.draft) : { ...DEFAULT_DRAFT }
    const restoredDirectory = memory?.directory ?? null
    const availableWorktreesByProject = memory?.availableWorktreesByProject
      ?? readPersistedWorktreeTopology(key)
    if (restoredDirectory) {
      useDirectoryStore.getState().setDirectory(restoredDirectory, { showOverlay: false })
    }
    set({
      currentSessionId: restoredSessionId,
      currentSessionDirectory: restoredSessionId ? restoredDirectory : null,
      newSessionDraft: restoredSessionId ? { ...DEFAULT_DRAFT } : restoredDraft,
      abortPromptSessionId: null,
      abortPromptExpiresAt: null,
      error: null,
      worktreeMetadata: memory?.worktreeMetadata ?? new Map(),
      availableWorktrees: flattenWorktreeMap(availableWorktreesByProject),
      availableWorktreesByProject,
      sessionAbortFlags: new Map(),
      pendingChangesBarDismissed: new Map(),
    })
    if (restoredSessionId) {
      setActiveSession(restoredDirectory ?? opencodeClient.getDirectory() ?? "", restoredSessionId)
    } else {
      setActiveSession("", "")
    }
  },

  // ---------------------------------------------------------------------------
  // openNewSessionDraft
  // ---------------------------------------------------------------------------
  openNewSessionDraft: (options) => {
    // A USER-initiated draft open is a navigation choice: the next cold launch
    // should land on the draft, not re-open the session left behind — drop the
    // persisted last-session pointer for this runtime. `automatic: true` marks
    // programmatic fallback opens (e.g. ChatContainer's "no session active"
    // auto-draft at boot), which must NOT consume the pointer — the cold-launch
    // restore races exactly that auto-open.
    if (!options?.automatic) {
      clearLastActiveSession(runtimeMemoryKey())
    }
    const projectsState = useProjectsStore.getState()
    const projects = projectsState.projects
    const availableWorktreesByProject = get().availableWorktreesByProject
    const activeProject = projectsState.getActiveProject()
    const currentDirectory = normalizePath(useDirectoryStore.getState().currentDirectory ?? null)
    const persistedTarget = readPersistedDraftTarget()

    const explicitDirectory = options?.directoryOverride !== undefined
      ? normalizePath(options.directoryOverride)
      : null
    let target = isVSCodeRuntime() ? "project" : options?.target
    if (!target) {
      const hasExplicitProjectTarget = options?.directoryOverride !== undefined
        || (options?.selectedProjectId !== undefined && options.selectedProjectId !== CHAT_DRAFT_PROJECT_ID)
        || isVSCodeRuntime()
      target = options?.selectedProjectId === CHAT_DRAFT_PROJECT_ID || !hasExplicitProjectTarget
        ? "chat"
        : "project"
    }
    const explicitProject = target === "project" && options?.selectedProjectId
      ? projects.find((p) => p.id === options.selectedProjectId) ?? null
      : null

    const inferredProjectFromDir = resolveDraftProjectForDirectory(projects, availableWorktreesByProject, explicitDirectory)
    const fallbackProject = (() => {
      if (activeProject) return activeProject
      if (projectsState.activeProjectId) return projects.find((p) => p.id === projectsState.activeProjectId) ?? null
      return projects[0] ?? null
    })()

    const persistedProjectById = persistedTarget?.projectId
      ? projects.find((p) => p.id === persistedTarget.projectId) ?? null
      : null
    const persistedProjectByDir = resolveDraftProjectForDirectory(projects, availableWorktreesByProject, persistedTarget?.directory ?? null)
    const currentDirProject = resolveDraftProjectForDirectory(projects, availableWorktreesByProject, currentDirectory)

    const selectedProject = target === "chat" ? null : (() => {
      if (explicitProject) return explicitProject
      if (explicitDirectory !== null) return inferredProjectFromDir
      if (currentDirectory) return currentDirProject
      return persistedProjectByDir ?? persistedProjectById ?? fallbackProject
    })()

    const directory = target === "chat" ? null : (() => {
      if (explicitDirectory !== null) return explicitDirectory
      if (explicitProject) return normalizePath(explicitProject.path ?? null)
      if (currentDirectory) return currentDirectory
      if (persistedTarget?.directory) return persistedTarget.directory
      return normalizePath(selectedProject?.path ?? null)
    })()

    if (target === "chat") {
      warmChatsRootDirectory()
    }

    persistDraftTarget({ projectId: selectedProject?.id ?? null, directory })

    const nextDraft: NewSessionDraftState = {
      draftId: nextDraftId++,
      open: true,
      target,
      preparedChatDirectory: null,
      selectedProjectId: selectedProject?.id ?? null,
      directoryOverride: directory,
      permissionAutoAcceptEnabled: options?.permissionAutoAcceptEnabled === true,
      pendingWorktreeRequestId: options?.pendingWorktreeRequestId ?? null,
      bootstrapPendingDirectory: normalizePath(options?.bootstrapPendingDirectory ?? null),
      preserveDirectoryOverride: options?.preserveDirectoryOverride === true,
      parentID: options?.parentID ?? null,
      title: options?.title,
      initialPrompt: options?.initialPrompt,
      syntheticParts: options?.syntheticParts,
      targetFolderId: options?.targetFolderId,
      projectContextPins: options?.projectContextPins,
    }

    set({
      newSessionDraft: nextDraft,
      currentSessionId: null,
      currentSessionDirectory: null,
      error: null,
    })

    writeRuntimeSessionMemory(runtimeMemoryKey(), { sessionId: null, directory, draft: nextDraft })
    // Clear composer attachments when opening a new session draft.
    // Attachments from the previous session (e.g. restored by revert) must
    // not bleed into the new session's input.
    useInputStore.getState().clearAttachedFiles()

    if (options?.initialPrompt) {
      useInputStore.getState().setPendingInputText(options.initialPrompt)
    }

    // Config (providers/agents/default model+agent) lives at the PROJECT level. When the user
    // came from a worktree session, `directory` is the worktree path, whose provider list does
    // not include project/global-scoped providers (e.g. the default agent's non-opencode model)
    // — resolving defaults against it would wrongly fall back to opencode/big-pickle. Activate
    // the project's config instead so the default cascade matches app startup, then re-apply it
    // (a fresh draft must start from defaults, not inherit the previous session's selection).
    const configDirectory = normalizePath(selectedProject?.path ?? null) ?? directory
    void activateConfigForDirectory(configDirectory).then(() => {
      useConfigStore.getState().applyDefaultModelAgentSelection({
        projectDefaultModel: selectedProject?.defaultModel,
        projectDefaultVariant: selectedProject?.defaultVariant,
      })
    })

    if (directory && directory !== useDirectoryStore.getState().currentDirectory) {
      useDirectoryStore.getState().setDirectory(directory)
    }

    void recoverStaleDraftDirectory(nextDraft)
  },

  prepareChatDraftDirectory: async () => {
    const draft = get().newSessionDraft
    if (!draft.open || draft.target !== "chat") return null
    if (draft.preparedChatDirectory) return draft.preparedChatDirectory

    const runtimeKey = getRuntimeKey()
    const key = `${runtimeKey}:${draft.draftId}`
    const existing = pendingChatDirectoryByDraft.get(key)
    if (existing) return existing

    const pending = createChatDirectory().then(async (directory) => {
      const current = get().newSessionDraft
      if (
        getRuntimeKey() !== runtimeKey
        || !current.open
        || current.target !== "chat"
        || current.draftId !== draft.draftId
      ) {
        await deleteChatDirectory(directory).catch(() => undefined)
        return null
      }
      set({ newSessionDraft: { ...current, preparedChatDirectory: directory } })
      return directory
    }).finally(() => {
      pendingChatDirectoryByDraft.delete(key)
    })
    pendingChatDirectoryByDraft.set(key, pending)
    return pending
  },

  // ---------------------------------------------------------------------------
  // closeNewSessionDraft
  // ---------------------------------------------------------------------------
  closeNewSessionDraft: () => {
    const currentDraft = get().newSessionDraft
    if (currentDraft.preparedChatDirectory) {
      void deleteChatDirectory(currentDraft.preparedChatDirectory).catch(() => undefined)
    }
    if (
      !currentDraft.open
      && currentDraft.selectedProjectId == null
      && currentDraft.directoryOverride == null
      && currentDraft.pendingWorktreeRequestId == null
      && currentDraft.bootstrapPendingDirectory == null
      && !currentDraft.preserveDirectoryOverride
      && currentDraft.parentID == null
      && currentDraft.title === undefined
      && currentDraft.initialPrompt === undefined
      && currentDraft.syntheticParts === undefined
      && currentDraft.targetFolderId === undefined
      && currentDraft.permissionAutoAcceptEnabled === undefined
    ) {
      return
    }
    const nextDraft: NewSessionDraftState = {
      draftId: currentDraft.draftId,
      open: false,
      target: "chat",
      preparedChatDirectory: null,
      selectedProjectId: null,
      directoryOverride: null,
      pendingWorktreeRequestId: null,
      bootstrapPendingDirectory: null,
      preserveDirectoryOverride: false,
      parentID: null,
      title: undefined,
      initialPrompt: undefined,
      syntheticParts: undefined,
      targetFolderId: undefined,
    }
    set({
      newSessionDraft: nextDraft,
    })
    writeRuntimeSessionMemory(runtimeMemoryKey(), { draft: nextDraft })
  },

  setNewSessionDraftTarget: (target) => {
    if (isVSCodeRuntime() && target.projectId === CHAT_DRAFT_PROJECT_ID) return
    const previousDraft = get().newSessionDraft
    if (previousDraft.preparedChatDirectory && target.projectId !== CHAT_DRAFT_PROJECT_ID) {
      void deleteChatDirectory(previousDraft.preparedChatDirectory).catch(() => undefined)
    }
    let nextDirectory: string | null = null
    set((s) => {
      nextDirectory = normalizePath(target.directoryOverride ?? s.newSessionDraft.directoryOverride)
      return {
        newSessionDraft: {
          ...s.newSessionDraft,
          target: target.projectId === CHAT_DRAFT_PROJECT_ID ? "chat" : "project",
          preparedChatDirectory: target.projectId === CHAT_DRAFT_PROJECT_ID ? s.newSessionDraft.preparedChatDirectory : null,
          selectedProjectId: target.projectId ?? target.selectedProjectId ?? s.newSessionDraft.selectedProjectId,
          directoryOverride: target.projectId === CHAT_DRAFT_PROJECT_ID ? null : target.directoryOverride ?? s.newSessionDraft.directoryOverride,
        },
      }
    })
    void activateConfigForDirectory(nextDirectory)

    if (nextDirectory && nextDirectory !== useDirectoryStore.getState().currentDirectory) {
      useDirectoryStore.getState().setDirectory(nextDirectory)
    }
  },

  setDraftPreserveDirectoryOverride: (value) =>
    set((s) => {
      if (!s.newSessionDraft?.open) return s
      return { newSessionDraft: { ...s.newSessionDraft, preserveDirectoryOverride: value } }
    }),

  setDraftPermissionAutoAcceptEnabled: (enabled) =>
    set((s) => {
      if (!s.newSessionDraft?.open) return s
      return { newSessionDraft: { ...s.newSessionDraft, permissionAutoAcceptEnabled: enabled } }
    }),

  setDraftProjectContextPin: (kind, id, pinned) =>
    set((s) => {
      if (!s.newSessionDraft?.open) return s
      const pins = s.newSessionDraft.projectContextPins ?? { notes: [], plans: [] }
      const key = kind === "note" ? "notes" : "plans"
      const next = new Set(pins[key])
      if (pinned) next.add(id)
      else next.delete(id)
      return {
        newSessionDraft: {
          ...s.newSessionDraft,
          projectContextPins: { ...pins, [key]: [...next] },
        },
      }
    }),

  acknowledgeSessionAbort: (sessionId) =>
    set((s) => {
      const flags = new Map(s.sessionAbortFlags)
      const existing = flags.get(sessionId)
      if (existing) flags.set(sessionId, { ...existing, acknowledged: true })
      return { sessionAbortFlags: flags }
    }),

  clearAbortPrompt: () => set({ abortPromptSessionId: null, abortPromptExpiresAt: null }),

  armAbortPrompt: (durationMs = 5000) => {
    const { currentSessionId } = get()
    if (!currentSessionId) return null
    const expiresAt = Date.now() + durationMs
    set({ abortPromptSessionId: currentSessionId, abortPromptExpiresAt: expiresAt })
    return expiresAt
  },

  clearError: () => set({ error: null }),

  markSessionAsOpenChamberCreated: (sessionId) =>
    set((s) => {
      const next = new Set(s.webUICreatedSessions)
      next.add(sessionId)
      return { webUICreatedSessions: next }
    }),

  isOpenChamberCreatedSession: (sessionId) => get().webUICreatedSessions.has(sessionId),

  getContextUsage: (contextLimit: number, outputLimit: number) => {
    if (get().newSessionDraft?.open) return null
    const sessionId = get().currentSessionId
    if (!sessionId) return null

    const messages = getSyncMessages(sessionId)
    if (messages.length === 0) return null

    type AssistantTokens = { total?: number; input: number; output: number; reasoning: number; cache: { read: number; write: number } }
    let lastTokens: AssistantTokens | undefined
    let lastMessageId: string | undefined
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg.role !== "assistant") continue
      const tokens = (msg as { tokens?: AssistantTokens }).tokens
      if (!tokens) continue
      const total = contextTokensFromBreakdown(tokens)
      if (total > 0) {
        lastTokens = tokens
        lastMessageId = msg.id
        break
      }
    }

    if (!lastTokens) return null

    const totalTokens = contextTokensFromBreakdown(lastTokens)
    const thresholdLimit = contextLimit > 0 ? contextLimit : 200000
    const percentage = contextLimit > 0 ? Math.round((totalTokens / contextLimit) * 100) : 0
    const normalizedOutput = outputLimit > 0 ? Math.round((lastTokens.output / outputLimit) * 100) : undefined

    return {
      totalTokens,
      percentage,
      contextLimit: contextLimit || 0,
      outputLimit: outputLimit || undefined,
      normalizedOutput,
      thresholdLimit,
      lastMessageId,
    }
  },

  initializeNewOpenChamberSession: () => {
    // Stub — was a no-op in old store
  },

  setWorktreeMetadata: (sessionId, metadata) => {
    // Write to authoritative session-worktree-store
    if (metadata) {
      useSessionWorktreeStore.getState().setAttachment(sessionId, {
        worktreeRoot: metadata.worktreeRoot ?? metadata.path ?? null,
        cwd: metadata.path ?? null,
        branch: metadata.branch ?? null,
        headState: metadata.headState ?? (metadata.branch ? 'branch' : 'detached'),
        worktreeStatus: metadata.worktreeStatus ?? 'ready',
        worktreeSource: metadata.worktreeSource ?? null,
        legacy: false,
        degraded: false,
      })
    } else {
      useSessionWorktreeStore.getState().clearAttachment(sessionId)
    }
    // Also keep local map for backward compatibility
    set((s) => {
      const map = new Map(s.worktreeMetadata)
      if (metadata) map.set(sessionId, metadata)
      else map.delete(sessionId)
      return { worktreeMetadata: map }
    })
  },

  overrideNewSessionDraftTarget: (options) => {
    let nextDirectory: string | null = null
    set((s) => {
      const nextDraft = { ...s.newSessionDraft, ...options }
      nextDirectory = normalizePath(
        typeof nextDraft.directoryOverride === "string" ? nextDraft.directoryOverride : null,
      )
      return { newSessionDraft: nextDraft }
    })
    void activateConfigForDirectory(nextDirectory)

    if (nextDirectory && nextDirectory !== useDirectoryStore.getState().currentDirectory) {
      useDirectoryStore.getState().setDirectory(nextDirectory)
    }
  },

  resolvePendingDraftWorktreeTarget: (requestId, directory, options) =>
    set((s) => {
      if (!s.newSessionDraft?.open || s.newSessionDraft.pendingWorktreeRequestId !== requestId) return s
      return {
        newSessionDraft: {
          ...s.newSessionDraft,
          selectedProjectId: (options as Record<string, unknown> | undefined)?.projectId as string ?? s.newSessionDraft.selectedProjectId ?? null,
          directoryOverride: normalizePath(directory),
          pendingWorktreeRequestId: null,
          bootstrapPendingDirectory: normalizePath((options as Record<string, unknown> | undefined)?.bootstrapPendingDirectory as string ?? s.newSessionDraft.bootstrapPendingDirectory ?? null),
          preserveDirectoryOverride: ((options as Record<string, unknown> | undefined)?.preserveDirectoryOverride ?? true) as boolean,
        },
      }
    }),

  setDraftBootstrapPendingDirectory: (directory) =>
    set((s) => {
      if (!s.newSessionDraft?.open) return s
      return { newSessionDraft: { ...s.newSessionDraft, bootstrapPendingDirectory: normalizePath(directory) } }
    }),

  setPendingDraftWorktreeRequest: (requestId) =>
    set((s) => {
      if (!s.newSessionDraft?.open) return s
      return { newSessionDraft: { ...s.newSessionDraft, pendingWorktreeRequestId: requestId } }
    }),

  getWorktreeMetadata: (sessionId) => get().worktreeMetadata.get(sessionId),

  dismissPendingChangesBar: (sessionId, signature) => {
    const map = new Map(get().pendingChangesBarDismissed);
    if (signature === null) {
      map.delete(sessionId);
    } else {
      map.set(sessionId, signature);
    }
    set({ pendingChangesBarDismissed: map });
  },

  // ---------------------------------------------------------------------------
  // sendMessage — calls SDK, reads domain data from sync
  // ---------------------------------------------------------------------------
  // Armed goal (composer target button): the sent prompt becomes the goal
  // objective; budget comes from the global default setting. Fire-and-forget —
  // a failed metadata patch must not fail the send.
  sendMessage: async (
    content: string,
    providerID: string,
    modelID: string,
    agent?: string,
    attachments?: AttachedFile[],
    agentMentionName?: string,
    additionalParts?: Array<{ text: string; attachments?: AttachedFile[]; synthetic?: boolean; metadata?: ContextPartMetadata }>,
    variant?: string,
    inputMode?: "normal" | "shell",
    options?: SendMessageOptions,
  ) => {
    const capturedTarget = options?.target
    if (capturedTarget && capturedTarget.runtimeKey !== getRuntimeKey()) {
      throw new Error("Message was not sent because the runtime changed.")
    }

    // Clear non-Git changed-files bar on new user message for current session
    const sid = capturedTarget?.sessionId ?? options?.sessionId ?? get().currentSessionId;
    if (sid) {
      const map = new Map(get().pendingChangesBarDismissed);
      map.delete(sid);
      set({ pendingChangesBarDismissed: map });
    }

    const draft = options?.draftSnapshot ?? get().newSessionDraft
    const trimmedAgent = typeof agent === "string" && agent.trim().length > 0 ? agent.trim() : undefined

    const goalArm = inputMode !== "shell" && content.trim().length > 0
      ? useSessionGoalArmStore.getState().consume()
      : { armed: false, objectiveOverride: null }
    const goalArmed = goalArm.armed
    if (goalArmed) {
      // Teach the agent the goal protocol from turn one — without this it
      // only learns about goal mode from the first server continuation.
      const uiState = useUIStore.getState()
      const budgetLine = uiState.sessionGoalDefaultBudgetEnabled
        ? ` A token budget of ${uiState.sessionGoalDefaultBudget} tokens applies to this goal.`
        : ""
      const goalIntro = wrapSystemReminder(
        "Goal mode is active for this session. The user message above defines the goal objective. "
        + "Work toward it across turns; whenever you stop before the objective is verifiably complete, the system will automatically prompt you to continue. "
        + "Progress is evaluated independently after each turn, so end every turn with a clear, factual statement of what is done, what was verified, and what remains."
        + budgetLine,
      )
      additionalParts = [...(additionalParts ?? []), { text: goalIntro, synthetic: true }]
    }
    const applyArmedGoal = async (goalSessionId: string, goalDirectory: string | null | undefined) => {
      if (!goalArmed) return
      const uiState = useUIStore.getState()
      const tokenBudget = uiState.sessionGoalDefaultBudgetEnabled ? uiState.sessionGoalDefaultBudget : null
      let objective = goalArm.objectiveOverride?.trim() || content
      if (!goalArm.objectiveOverride && content.startsWith("/")) {
        const directoryCommands = getDirectoryState(goalDirectory ?? undefined)?.command ?? []
        const storedCommands = useCommandsStore.getState().commands
        const knownCommands = [...directoryCommands, ...storedCommands]
        objective = expandSlashCommandGoalObjective(content, knownCommands)
        if (objective === content) {
          try {
            objective = expandSlashCommandGoalObjective(
              content,
              await opencodeClient.listCommandsWithDetails(goalDirectory),
            )
          } catch {
            // Command dispatch remains authoritative; raw invocation is a safe objective fallback.
          }
        }
      }
      try {
        await setSessionGoal(goalSessionId, goalDirectory ?? undefined, { objective, tokenBudget }, null)
      } catch (error) {
        useSessionGoalArmStore.getState().setArmed(true, goalArm.objectiveOverride)
        throw error
      }
    }

    // ---- New session from draft ----
    if (!capturedTarget && !options?.sessionId && draft?.open) {
      const createdDraftSession = await materializeOpenDraftSession({
        providerID,
        modelID,
        agent: trimmedAgent,
        variant,
      }, options?.draftSnapshot)
      if (!createdDraftSession) throw new Error("Failed to create session")

      const draftParts = createdDraftSession.syntheticParts?.length
        ? [...(additionalParts || []), ...createdDraftSession.syntheticParts]
        : additionalParts
      // The server decides what this session still owes and assembles it; the
      // client only carries it and reports it delivered.
      const draftKnowledge = await fetchSessionKnowledge(
        createdDraftSession.directory,
        createdDraftSession.sessionId,
      )
      const draftPrefixParts: Array<{ text: string; attachments?: AttachedFile[]; synthetic?: boolean; metadata?: ContextPartMetadata }> =
        draftKnowledge.text ? [{ text: draftKnowledge.text, synthetic: true }] : []
      // Left undefined when nothing was added, as before: an empty array is not
      // the same as no additional parts to everything downstream.
      const mergedAdditionalParts = draftPrefixParts.length > 0
        ? [...draftPrefixParts, ...(draftParts || [])]
        : draftParts

      notifyMessageSent(createdDraftSession.sessionId)

      markPendingUserSendAnimation(createdDraftSession.sessionId)

      const files = attachments?.map((a) => ({
        type: "file" as const,
        mime: a.mimeType,
        url: a.dataUrl,
        filename: a.filename,
      }))

      await applyArmedGoal(createdDraftSession.sessionId, createdDraftSession.directory)
      await routeMessage({
        sessionId: createdDraftSession.sessionId,
        directory: createdDraftSession.directory,
        content,
        providerID,
        modelID,
        agent: createdDraftSession.agent,
        agentMentionName,
        variant,
        inputMode,
        files,
        delivery: options?.delivery,
        additionalParts: mergedAdditionalParts?.map((p) => ({
          text: p.text,
          synthetic: p.synthetic,
          metadata: p.metadata,
          files: p.attachments?.map((a: AttachedFile) => ({
            type: "file" as const,
            mime: a.mimeType,
            url: a.dataUrl,
            filename: a.filename,
          })),
        })),
      })
      // Recorded only after the send resolves: a failed send must carry the
      // pinned context again rather than assume the agent already saw it.
      if (draftKnowledge.text) {
        void reportSessionKnowledgeDelivered(
          createdDraftSession.directory,
          createdDraftSession.sessionId,
          draftKnowledge.signature,
        )
      }
      return
    }

    // ---- Existing session ----
    const targetSessionId = capturedTarget?.sessionId ?? options?.sessionId ?? get().currentSessionId
    const sessionAgentSelection = targetSessionId
      ? useSelectionStore.getState().getSessionAgentSelection(targetSessionId)
      : null
    const configAgentName = useConfigStore.getState().currentAgentName
    const effectiveAgent = trimmedAgent || sessionAgentSelection || configAgentName || undefined

    if (targetSessionId) {
      useSelectionStore.getState().saveSessionModelSelection(targetSessionId, providerID, modelID)
    }

    if (targetSessionId && effectiveAgent) {
      useSelectionStore.getState().saveSessionAgentSelection(targetSessionId, effectiveAgent)
      useSelectionStore.getState().saveAgentModelForSession(targetSessionId, effectiveAgent, providerID, modelID)
      useSelectionStore.getState().saveAgentModelVariantForSession(targetSessionId, effectiveAgent, providerID, modelID, variant)
    }

    if (targetSessionId) {
      const viewportState = useViewportStore.getState()
      const memState = getViewportSessionMemory(targetSessionId)
      if (!memState || !memState.lastUserMessageAt) {
        const newMemState = new Map(viewportState.sessionMemoryState)
        newMemState.set(viewportSessionKey(targetSessionId), {
          viewportAnchor: 0,
          isStreaming: false,
          lastAccessedAt: Date.now(),
          backgroundMessageCount: 0,
          ...memState,
          lastUserMessageAt: Date.now(),
        })
        useViewportStore.setState({ sessionMemoryState: newMemState })
      }
    }

    const currentSessionDirectory = targetSessionId
      ? normalizePath(capturedTarget?.directory ?? options?.directory ?? get().getDirectoryForSession(targetSessionId))
      : null
    if (targetSessionId) {
      notifyMessageSent(targetSessionId)
    }

    if (targetSessionId) {
      markPendingUserSendAnimation(targetSessionId)
    }

    const files = attachments?.map((a) => ({
      type: "file" as const,
      mime: a.mimeType,
      url: a.dataUrl,
      filename: a.filename,
    }))

    if (targetSessionId) {
      await applyArmedGoal(targetSessionId, currentSessionDirectory)
    }

    // Standing project context — pinned notes and plans, and the memory index.
    // Prepended so it reads as background before the message it accompanies,
    // and empty unless the session is actually missing it.
    const knowledge = await fetchSessionKnowledge(currentSessionDirectory, targetSessionId || "")
    const prefixParts: Array<{ text: string; attachments?: AttachedFile[]; synthetic?: boolean; metadata?: ContextPartMetadata }> =
      knowledge.text ? [{ text: knowledge.text, synthetic: true }] : []
    const partsWithPinnedContext = prefixParts.length > 0
      ? [...prefixParts, ...(additionalParts || [])]
      : additionalParts

    await routeMessage({
      runtimeKey: capturedTarget?.runtimeKey,
      sessionId: targetSessionId || "",
      directory: currentSessionDirectory,
      content,
      providerID,
      modelID,
      agent: effectiveAgent,
      agentMentionName,
      variant,
      inputMode,
      files,
      delivery: options?.delivery,
      additionalParts: partsWithPinnedContext?.map((p) => ({
        text: p.text,
        synthetic: p.synthetic,
        metadata: p.metadata,
        files: p.attachments?.map((a) => ({
          type: "file" as const,
          mime: a.mimeType,
          url: a.dataUrl,
          filename: a.filename,
        })),
      })),
    })
    if (knowledge.text) {
      void reportSessionKnowledgeDelivered(currentSessionDirectory, targetSessionId || "", knowledge.signature)
    }
  },

  // ---------------------------------------------------------------------------
  // createSession
  // ---------------------------------------------------------------------------
  createSession: (title, directoryOverride, parentID, metadata) =>
    createSessionWithDraftLifecycle(title, directoryOverride, parentID, metadata),

  // ---------------------------------------------------------------------------
  // deleteSession — calls SDK, SSE event updates child store
  // ---------------------------------------------------------------------------
  deleteSession: async (id, options) => deleteSessionAction(id, options),

  deleteSessions: async (ids, options) => {
    const result = await deleteSessionsAction(ids, options)

    return result
  },

  archiveSession: (id) => archiveSessionAction(id),

  archiveSessions: (ids, options) => archiveSessionsAction(ids, options),

  unarchiveSession: (id) => unarchiveSessionAction(id),

  unarchiveSessions: (ids, options) => unarchiveSessionsAction(ids, options),

  // ---------------------------------------------------------------------------
  // updateSessionTitle — calls SDK, SSE event updates child store
  // ---------------------------------------------------------------------------
  updateSessionTitle: async (sessionId, title) => {
    await updateSessionTitleAction(sessionId, title)
  },

  shareSession: async (sessionId) => {
    return shareSessionAction(sessionId)
  },

  unshareSession: async (sessionId) => {
    return unshareSessionAction(sessionId)
  },

  // ---------------------------------------------------------------------------
  // revertToMessage — delegates to session-actions (single implementation)
  // ---------------------------------------------------------------------------
  revertToMessage: async (sessionId, messageId) => {
    // Ensure the complete message range is present before applying the revert
    // marker. Reverted UI is derived from session.revert + stored messages.
    await refetchSessionMessages(sessionId)
    await revertToMessageAction(sessionId, messageId)
  },

  // ---------------------------------------------------------------------------
  // handleSlashUndo — reads from sync, records history for redo
  // ---------------------------------------------------------------------------
  handleSlashUndo: async (sessionId) => {
    const messages = getSyncMessages(sessionId)
    const sessions = getSyncSessions()
    const currentSession = sessions.find((s) => s.id === sessionId)

    const userMessages = messages.filter((m) => m.role === "user")
    if (userMessages.length === 0) return

    const revertToId = currentSession?.revert?.messageID
    let targetMessage: typeof messages[number] | undefined
    if (revertToId) {
      const revertIndex = userMessages.findIndex((message) => message.id === revertToId)
      targetMessage = revertIndex > 0 ? userMessages[revertIndex - 1] : undefined
    } else {
      targetMessage = userMessages[userMessages.length - 1]
    }

    if (!targetMessage) return

    // Read target message parts BEFORE calling revertToMessage.
    // revertToMessage optimistically deletes messages from the sync store
    // before the API call, so getSyncParts must run first.
    const targetParts = getSyncParts(targetMessage.id)
    const textPart = targetParts.find((p: Part) => p.type === "text") as TextPart | undefined
    const preview = textPart?.text
      ? String(textPart.text).slice(0, 50) + (textPart.text.length > 50 ? "..." : "")
      : "[No text]"

    // revertToMessage handles the redo stack push internally
    await get().revertToMessage(sessionId, targetMessage.id)

    const { toast } = await import("sonner")
    const { useI18nStore, formatMessage } = await import("@/lib/i18n/store")
    const { dictionary } = useI18nStore.getState()
    toast.success(formatMessage(dictionary, "chat.revert.toast.undo", { preview }))
  },

  // ---------------------------------------------------------------------------
  // handleSlashRedo — moves the authoritative revert marker forward
  // ---------------------------------------------------------------------------
  handleSlashRedo: async (sessionId, options) => {
    if (options?.fullUnrevert) {
      const { unrevertSession } = await import("./session-actions")
      await unrevertSession(sessionId)
      const { toast } = await import("sonner")
      const { useI18nStore, formatMessage } = await import("@/lib/i18n/store")
      const { dictionary } = useI18nStore.getState()
      toast.success(formatMessage(dictionary, "chat.revert.toast.restored"))
      return
    }

    const sessions = getSyncSessions()
    const currentSession = sessions.find((s) => s.id === sessionId)
    const revertToId = currentSession?.revert?.messageID
    if (!revertToId) return

    await refetchSessionMessages(sessionId)
    const messages = getSyncMessages(sessionId)
    const userMessages = messages.filter((m) => m.role === "user")
    const revertIndex = userMessages.findIndex((message) => message.id === revertToId)
    const targetMessage = revertIndex >= 0 ? userMessages[revertIndex + 1] : undefined

    if (targetMessage) {
      await get().revertToMessage(sessionId, targetMessage.id, { skipRedoPush: true })
      const { toast } = await import("sonner")
      const { useI18nStore, formatMessage } = await import("@/lib/i18n/store")
      const { dictionary } = useI18nStore.getState()
      toast.success(formatMessage(dictionary, "chat.revert.toast.redo"))
      return
    }

    await unrevertSessionAction(sessionId)
    const { toast } = await import("sonner")
    const { useI18nStore, formatMessage } = await import("@/lib/i18n/store")
    const { dictionary } = useI18nStore.getState()
    toast.success(formatMessage(dictionary, "chat.revert.toast.restored"))
  },

  // ---------------------------------------------------------------------------
  // forkFromMessage — delegates to session-actions (handles text + sidebar)
  // ---------------------------------------------------------------------------
  forkFromMessage: async (sessionId, messageId) => {
    const sessions = getSyncSessions()
    const existingSession = sessions.find((s) => s.id === sessionId)
    if (!existingSession) return

    try {
      await forkFromMessageAction(sessionId, messageId)

      const { toast } = await import("sonner")
      toast.success(`Forked from ${existingSession.title}`)
    } catch (error) {
      console.error("Failed to fork session:", error)
      const { toast } = await import("sonner")
      toast.error("Failed to fork session")
    }
  },

  // ---------------------------------------------------------------------------
  // createSessionFromAssistantMessage — reads from sync
  // ---------------------------------------------------------------------------
  createSessionFromAssistantMessage: async (sourceMessageId, execution) => {
    if (!sourceMessageId) return
    if (!execution?.instructions?.trim()) return

    // Find which session this message belongs to by scanning sync state
    const state = getDirectoryState()
    if (!state) return

    let sourceSessionId: string | undefined
    let sourceMessage: Message | undefined

    for (const [sid, msgs] of Object.entries(state.message ?? {})) {
      const found = msgs.find((m) => m.id === sourceMessageId)
      if (found) {
        sourceSessionId = sid
        sourceMessage = found
        break
      }
    }

    if (!sourceMessage || sourceMessage.role !== "assistant") return

    const sourceParts = getSyncParts(sourceMessageId)
    const assistantPlanText = flattenAssistantTextParts(sourceParts)
    if (!assistantPlanText.trim()) return

    const directory = resolveSessionDirectory(
      sourceSessionId ?? null,
      (sid) => get().worktreeMetadata.get(sid),
    )
    const sourceWorktreeMetadata = sourceSessionId ? get().worktreeMetadata.get(sourceSessionId) : undefined

    const pID = execution.providerID || useSelectionStore.getState().lastUsedProvider?.providerID
    const mID = execution.modelID || useSelectionStore.getState().lastUsedProvider?.modelID

    if (!pID || !mID) return

    const sourceDirectory = normalizePath(directory ?? opencodeClient.getDirectory() ?? null)
    let sessionDirectory = sourceDirectory
    let createdWorktree: WorktreeMetadata | null = null
    let createdWorktreeProject: { id: string; path: string } | null = null

    if (execution.createWorktree) {
      const projects = useProjectsStore.getState().projects
      const project = resolveProjectForSessionDirectory(
        projects,
        get().availableWorktreesByProject,
        sourceDirectory,
      ) ?? resolveProjectForSessionDirectory(
        projects,
        get().availableWorktreesByProject,
        sourceWorktreeMetadata?.projectDirectory ?? null,
      )
      if (!project?.path) {
        throw new Error("Project is not registered in OpenChamber")
      }

      const [branchNameModule, configModule, createModule] = await Promise.all([
        import("@/lib/git/branchNameGenerator"),
        import("@/lib/openchamberConfig"),
        import("@/lib/worktrees/worktreeCreate"),
      ])
      const branchName = branchNameModule.generateBranchName()
      createdWorktreeProject = { id: project.id, path: project.path }
      const setupCommands = await configModule.getWorktreeSetupCommands(createdWorktreeProject)
      createdWorktree = await createModule.createWorktreeWithDefaults(createdWorktreeProject, {
        preferredName: branchName,
        mode: "new",
        branchName,
        worktreeName: branchName,
        setupCommands,
        returnAfterDirectoryCreated: true,
      })
      sessionDirectory = normalizePath(createdWorktree.path)
      if (!sessionDirectory) {
        throw new Error("Worktree create missing name/path")
      }
      if (await configModule.getWorktreeSetupWaitEnabled(createdWorktreeProject)) {
        await waitForWorktreeBootstrap(sessionDirectory)
      }
    }

    const session = await get().createSession(undefined, sessionDirectory || null, null)
    if (!session) {
      if (createdWorktree && createdWorktreeProject) {
        const { removeProjectWorktree } = await import("@/lib/worktrees/worktreeManager")
        await removeProjectWorktree(createdWorktreeProject, createdWorktree, { deleteLocalBranch: true }).catch(() => undefined)
      }
      return
    }

    if (createdWorktree) {
      get().setWorktreeMetadata(session.id, {
        ...createdWorktree,
        kind: "standard",
      })
      useDirectoryStore.getState().setDirectory(createdWorktree.path, { showOverlay: false })
    }

    // "Run as goal" rides the same arm mechanism as the composer target
    // button: sendMessage consumes the flag, stamps the goal (objective =
    // the composed fork message) and attaches the goal-mode intro part.
    // Set explicitly either way so a stray armed flag cannot leak into a
    // non-goal fork.
    useSessionGoalArmStore.getState().setArmed(execution.runAsGoal === true)

    await get().sendMessage(
      composeForkSessionMessage(execution.instructions, assistantPlanText),
      pID,
      mID,
      execution.agent || undefined,
      undefined,
      undefined,
      undefined,
      execution.variant || undefined,
      undefined,
      { sessionId: session.id },
    )
  },

  // ---------------------------------------------------------------------------
  // Data access helpers — read from sync
  // ---------------------------------------------------------------------------
  getSessionsByDirectory: (directory) => {
    const nd = normalizePath(directory)
    if (!nd) return []
    const sessions = getAllSyncSessions()
    return sessions.filter((s) => resolveDirectoryKey(s) === nd)
  },

  getDirectoryForSession: (sessionId) => {
    // The selection-time directory participates in resolution, it does not
    // short-circuit it. For a worktree session selected before its directory
    // store finished bootstrapping, that value is a startup fallback pointing
    // at the parent repository; letting it win would route every send, queue
    // key, and send-confirmation lookup to a directory that does not own the
    // session.
    const selected = sessionId === get().currentSessionId ? get().currentSessionDirectory : null
    const resolved = resolveSessionDirectory(
      sessionId,
      (sid) => get().worktreeMetadata.get(sid),
      selected,
    )
    if (resolved) return resolved
    const globalStore = useGlobalSessionsStore.getState()
    const globalSession = [...globalStore.activeSessions, ...globalStore.archivedSessions]
      .find((s) => s.id === sessionId)
    if (globalSession) return resolveGlobalSessionDirectory(globalSession)
    return null
  },

  getLastUserChoice: (sessionId) => {
    const directory = get().getDirectoryForSession(sessionId) ?? undefined
    const messages = getSyncMessages(sessionId, directory)
    const choice = findLatestUserModelChoice(
      messages,
      (messageId) => getSyncParts(messageId, directory),
    )
    if (!choice) {
      return null
    }
    return {
      agent: choice.agent,
      providerID: choice.providerID,
      modelID: choice.modelID,
      variant: choice.variant,
    }
  },

  getCurrentAgent: (sessionId) => {
    return useSelectionStore.getState().sessionAgentSelections.get(sessionId) ?? undefined
  },

  debugSessionMessages: async (sessionId) => {
    const msgs = getSyncMessages(sessionId)
    const sessions = getSyncSessions()
    const session = sessions.find((s) => s.id === sessionId)
    console.log(`Debug session ${sessionId}:`, {
      session,
      messageCount: msgs.length,
      messages: msgs.map((m) => ({
        id: m.id,
        role: m.role,
        tokens: m.role === "assistant" ? m.tokens : undefined,
      })),
    })
  },

  pollForTokenUpdates: () => {
    // Handled by sync system's SSE stream
  },

  adoptAuthoritativeSessionDirectory: (sessionId) => {
    const target = sessionId ?? get().currentSessionId
    // Only a guess is promoted. A confirmed selection outranks anything sync
    // learns later, and a selection that has since moved on must not be
    // rewritten by a directory that finished bootstrapping in the background.
    if (!target || target !== guessedSelectionSessionId) return
    if (target !== get().currentSessionId) return

    const authoritative = getAuthoritativeSessionDirectory(target)
    if (!authoritative) return

    // The selection stops being a guess even when the directory is unchanged:
    // the value has now been confirmed by the store that owns the session.
    guessedSelectionSessionId = null
    if (authoritative !== get().currentSessionDirectory) {
      set({ currentSessionDirectory: authoritative })
    }
    writeRuntimeSessionMemory(runtimeMemoryKey(), { sessionId: target, directory: authoritative })
  },

  setSessionDirectory: (sessionId, directory) => {
    const normalized = normalizePath(directory)
    // Callers set this from a confirmed destination (a completed move, a
    // created worktree), so the selection is no longer a guess.
    if (sessionId === guessedSelectionSessionId) {
      guessedSelectionSessionId = null
    }
    if (sessionId === get().currentSessionId) {
      set({ currentSessionDirectory: normalized })
      writeRuntimeSessionMemory(runtimeMemoryKey(), { sessionId, directory: normalized })
    }
  },

  // ---------------------------------------------------------------------------
  // Plan mode availability tracking
  // ---------------------------------------------------------------------------
  markSessionPlanAvailable: (sessionId) => {
    set((state) => {
      if (state.sessionPlanAvailable.get(sessionId) === true) {
        return state
      }
      const next = new Map(state.sessionPlanAvailable)
      next.set(sessionId, true)
      return { sessionPlanAvailable: next }
    })
  },

  isSessionPlanAvailable: (sessionId) => {
    return get().sessionPlanAvailable.get(sessionId) ?? false
  },
}))

setSessionOpener((sessionID, directory) => {
  useSessionUIStore.getState().setCurrentSession(sessionID, directory)
})

// Write-through persist of the worktree map whenever discovery refreshes it.
// Reference-equality guard filters hot session updates; the serialized
// comparison avoids redundant localStorage writes when the Map reference
// changed but the content is identical (e.g., re-discovery that found the
// same worktrees).
const lastPersistedWorktreeSerializedByRuntime = new Map<string, string>()
useSessionUIStore.subscribe((state, prev) => {
  if (state.availableWorktreesByProject !== prev.availableWorktreesByProject) {
    const runtimeKey = runtimeMemoryKey()
    const serialized = JSON.stringify([...state.availableWorktreesByProject.entries()])
    if (serialized !== lastPersistedWorktreeSerializedByRuntime.get(runtimeKey)) {
      lastPersistedWorktreeSerializedByRuntime.set(runtimeKey, serialized)
      persistWorktreeTopology(runtimeKey, state.availableWorktreesByProject)
    }
  }
})
