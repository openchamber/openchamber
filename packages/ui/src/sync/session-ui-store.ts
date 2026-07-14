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

import { create } from "zustand"
import type { Session, Part, Message, TextPart } from "@opencode-ai/sdk/v2/client"
import type { AttachedFile, SessionContextUsage, SessionWorktreeAttachment } from "@/stores/types/sessionTypes"
import type { WorktreeMetadata } from "@/types/worktree"
import { opencodeClient } from "@/lib/opencode/client"
import { runtimeFetch } from "@/lib/runtime-fetch"
import { useConfigStore } from "@/stores/useConfigStore"
import { useProjectsStore } from "@/stores/useProjectsStore"
import { useGlobalSessionsStore, resolveGlobalSessionDirectory } from "@/stores/useGlobalSessionsStore"
import { useDirectoryStore } from "@/stores/useDirectoryStore"
import { useSessionFoldersStore } from "@/stores/useSessionFoldersStore"
import { useCommandsStore } from "@/stores/useCommandsStore"
import { useSkillsStore } from "@/stores/useSkillsStore"
import { getDeferredSafeStorage } from "@/stores/utils/safeStorage"
import { markPendingUserSendAnimation } from "@/lib/userSendAnimation"
import { normalizePath } from "@/lib/pathNormalization"
import { flattenAssistantTextParts } from "@/lib/messages/messageText"
import { composeForkSessionMessage } from "@/lib/messages/executionMeta"
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
} from "./sync-refs"
import { markSessionViewed } from "./notification-store"
import { setActiveSession } from "./sync-context"
import {
  createSession as createSessionAction,
  deleteSession as deleteSessionAction,
  archiveSession as archiveSessionAction,
  updateSessionTitle as updateSessionTitleAction,
  shareSession as shareSessionAction,
  unshareSession as unshareSessionAction,
  optimisticSend,
  refetchSessionMessages,
  revertToMessage as revertToMessageAction,
  unrevertSession as unrevertSessionAction,
  forkFromMessage as forkFromMessageAction,
  fetchMessagesForSession,
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
import { rememberRuntimeLiveStatus } from "./runtime-live-memory"

export type { AttachedFile }

// ---------------------------------------------------------------------------
// Send routing — shell mode, slash commands, or normal prompt
// ---------------------------------------------------------------------------

export function routeMessage(params: {
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
  additionalParts?: Array<{ text: string; synthetic?: boolean; files?: Array<{ type: "file"; mime: string; url: string; filename: string }> }>
  delivery?: 'steer'
}): Promise<void> {
  const requestDirectory = params.directory ?? undefined
  if (params.inputMode === "shell") {
    return opencodeClient.shellSession({
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
        sessionId: params.sessionId,
        content: params.content,
        providerID: params.providerID,
        modelID: params.modelID,
        agent: params.agent,
        directory: requestDirectory,
        files: params.files,
        send: (messageID) => opencodeClient.sendCommand({
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
    sessionId: params.sessionId,
    content: params.content,
    providerID: params.providerID,
    modelID: params.modelID,
    agent: params.agent,
    directory: requestDirectory,
    files: params.files,
    send: (messageID) => opencodeClient.sendMessage({
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

type SendMessageOptions = {
  sessionId?: string
  delivery?: 'steer'
  draft?: NewSessionDraftState
}

type CreateSessionOptions = {
  select?: boolean
  targetFolderId?: string
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

export type { SyntheticContextPart } from "./input-store"
export type { SessionMemoryState } from "./viewport-store"

export type NewSessionDraftState = {
  open: boolean
  materializationKey?: object
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
  setCurrentSession: (id: string | null, directoryHint?: string | null) => void
  prepareForRuntimeSwitch: (apiBaseUrl?: string | null) => void
  restoreForRuntimeSwitch: (apiBaseUrl?: string | null) => void
  openNewSessionDraft: (options?: Partial<NewSessionDraftState>) => void
  closeNewSessionDraft: () => void
  setNewSessionDraftTarget: (target: { projectId?: string | null; selectedProjectId?: string | null; directoryOverride?: string | null }, options?: { force?: boolean }) => void
  setDraftPreserveDirectoryOverride: (value: boolean) => void
  setDraftPermissionAutoAcceptEnabled: (enabled: boolean) => void
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
    additionalParts?: Array<{ text: string; attachments?: AttachedFile[]; synthetic?: boolean }>,
    variant?: string,
    inputMode?: "normal" | "shell",
    options?: SendMessageOptions,
  ) => Promise<void>

  createSession: (title?: string, directoryOverride?: string | null, parentID?: string | null, metadata?: Record<string, unknown>, options?: CreateSessionOptions) => Promise<Session | null>
  deleteSession: (id: string, options?: Record<string, unknown>) => Promise<boolean>
  deleteSessions: (ids: string[], options?: Record<string, unknown>) => Promise<{ deletedIds: string[]; failedIds: string[] }>
  archiveSession: (id: string) => Promise<boolean>
  archiveSessions: (ids: string[], options?: Record<string, unknown>) => Promise<{ archivedIds: string[]; failedIds: string[] }>
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

const resolveSessionDirectory = (
  sessionId: string | null | undefined,
  getWtMeta: (id: string) => WorktreeMetadata | undefined,
): string | null => {
  if (!sessionId) return null
  const attachmentDirectory = getAttachedSessionDirectory(getAttachmentForSession(sessionId))
  if (attachmentDirectory) return attachmentDirectory
  const metaPath = getWtMeta(sessionId)?.path
  if (typeof metaPath === "string" && metaPath.trim().length > 0) return normalizePath(metaPath)
  const runtimeMemory = runtimeSessionMemory.get(runtimeMemoryKey())
  if (runtimeMemory?.sessionId === sessionId && runtimeMemory.directory) {
    return normalizePath(runtimeMemory.directory)
  }
  const sessions = getAllSyncSessions()
  const target = sessions.find((s) => s.id === sessionId)
  if (!target) return null
  return resolveDirectoryKey(target)
}

const activateConfigForDirectory = async (directory: string | null | undefined): Promise<void> => {
  await useConfigStore.getState().activateDirectory(normalizePath(directory))
}

const DEFAULT_DRAFT: NewSessionDraftState = {
  open: false,
  directoryOverride: null,
  parentID: null,
}

const activeSessionByRuntime = new Map<string, string | null>()
type RuntimeSessionMemory = {
  sessionId: string | null
  directory: string | null
  draft: NewSessionDraftState
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

const draftMaterializations = new WeakMap<object, Promise<MaterializedDraftSession | null>>()

export function materializeOpenDraftSession(selection: {
  providerID: string
  modelID: string
  agent?: string
  variant?: string
}, draftOverride?: NewSessionDraftState): Promise<MaterializedDraftSession | null> {
  const store = useSessionUIStore.getState()
  const draft = draftOverride ?? store.newSessionDraft
  if (!draft?.open) return Promise.resolve(null)
  const materializationKey = draft.materializationKey ?? draft

  const pending = draftMaterializations.get(materializationKey)
  if (pending) return pending

  const materialization = (async () => {
    const draftPermissionAutoAcceptEnabled = draft.permissionAutoAcceptEnabled === true
    const trimmedAgent = typeof selection.agent === "string" && selection.agent.trim().length > 0
      ? selection.agent.trim()
      : undefined
    let draftDirectoryOverride = draft.bootstrapPendingDirectory ?? draft.directoryOverride ?? null
    let pendingWorktreeRequestId = draft.pendingWorktreeRequestId
    const draftProjectId = draft.selectedProjectId ?? null

    const liveDraft = useSessionUIStore.getState().newSessionDraft
    if (liveDraft.open
      && (liveDraft.materializationKey ?? liveDraft) === materializationKey
      && liveDraft.pendingWorktreeRequestId !== pendingWorktreeRequestId) {
      pendingWorktreeRequestId = liveDraft.pendingWorktreeRequestId
      draftDirectoryOverride = liveDraft.bootstrapPendingDirectory ?? liveDraft.directoryOverride ?? draftDirectoryOverride
    }

    if (pendingWorktreeRequestId) {
      draftDirectoryOverride = await waitForPendingDraftWorktreeRequest(pendingWorktreeRequestId)
      store.resolvePendingDraftWorktreeTarget(pendingWorktreeRequestId, draftDirectoryOverride)
    }

    await waitForWorktreeBootstrapIfConfigured(draftDirectoryOverride, draftProjectId)

    const created = await store.createSession(draft.title, draftDirectoryOverride, draft.parentID ?? null, undefined, {
      select: false,
      targetFolderId: draft.targetFolderId,
    })
    if (!created?.id) throw new Error("Failed to create session")

    persistDraftTarget({
      projectId: draftProjectId,
      directory: normalizePath(draftDirectoryOverride ?? created.directory ?? null),
    })

    const draftSyntheticParts = draft.syntheticParts
    const createdDirectory = normalizePath(draftDirectoryOverride ?? created.directory ?? null)
    const configState = useConfigStore.getState()
    void activateConfigForDirectory(createdDirectory).catch((error) => {
      console.warn("Failed to activate directory after creating session:", error)
    })

    const effectiveDraftAgent = trimmedAgent ?? configState.currentAgentName

    useSelectionStore.getState().saveSessionModelSelection(created.id, selection.providerID, selection.modelID)

    if (effectiveDraftAgent) {
      useSelectionStore.getState().saveSessionAgentSelection(created.id, effectiveDraftAgent)
      useSelectionStore.getState().saveAgentModelForSession(created.id, effectiveDraftAgent, selection.providerID, selection.modelID)
      useSelectionStore.getState().saveAgentModelVariantForSession(created.id, effectiveDraftAgent, selection.providerID, selection.modelID, selection.variant)
    }

    store.initializeNewOpenChamberSession(created.id, configState.agents ?? [])

    const currentDraft = useSessionUIStore.getState().newSessionDraft
    if (currentDraft.open && (currentDraft.materializationKey ?? currentDraft) === materializationKey) {
      store.setCurrentSession(created.id, createdDirectory)
    }

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
  })()

  draftMaterializations.set(materializationKey, materialization)
  void materialization.catch(() => draftMaterializations.delete(materializationKey))
  return materialization
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
const WORKTREE_MAP_STORAGE_KEY = 'oc.worktreeMap'

const loadPersistedWorktreeMap = (): Map<string, WorktreeMetadata[]> => {
  try {
    const raw = getDeferredSafeStorage().getItem(WORKTREE_MAP_STORAGE_KEY)
    if (!raw) return new Map()
    const entries = JSON.parse(raw) as Array<[string, WorktreeMetadata[]]>
    if (!Array.isArray(entries)) return new Map()
    return new Map(
      entries.filter((entry) => Array.isArray(entry) && typeof entry[0] === 'string' && Array.isArray(entry[1])),
    )
  } catch {
    return new Map()
  }
}

const persistWorktreeMap = (serialized: string): void => {
  try {
    getDeferredSafeStorage().setItem(WORKTREE_MAP_STORAGE_KEY, serialized)
  } catch {
    // quota / serialization error — ignore; discovery still refreshes at runtime
  }
}

const flattenWorktreeMap = (map: Map<string, WorktreeMetadata[]>): WorktreeMetadata[] => {
  const out: WorktreeMetadata[] = []
  for (const list of map.values()) out.push(...list)
  return out
}

const PERSISTED_WORKTREE_MAP = loadPersistedWorktreeMap()

export const useSessionUIStore = create<SessionUIState>()((set, get) => ({
  currentSessionId: null,
  currentSessionDirectory: null,
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
  setCurrentSession: (id, directoryHint?: string | null) => {
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
    const resolvedDir = (directoryHint ? normalizePath(directoryHint) : null) ?? sessionDir ?? fallbackDir
    const projectsState = useProjectsStore.getState()
    const sessionProject = resolvedDir
      ? resolveProjectForSessionDirectory(
        projectsState.projects,
        get().availableWorktreesByProject,
        resolvedDir,
      )
      : null

    // Set the directory together with the session id so chat hooks read the
    // same child store that send/SSE events will update during startup races.
    set({ currentSessionId: id, currentSessionDirectory: id ? resolvedDir ?? null : null })
    writeRuntimeSessionMemory(key, { sessionId: id, directory: resolvedDir ?? null })

    // Kick off the message fetch on the same tick, before React commits the
    // state change and fires ChatContainer.useEffect. The fetch is
    // fire-and-forget — any transient failure gets retried by the reactive path.
    if (id) {
      void fetchMessagesForSession(id, resolvedDir)
    }

    try {
      if (resolvedDir && directoryState.currentDirectory !== resolvedDir) {
        directoryState.setDirectory(resolvedDir, { showOverlay: false })
      }
      if (sessionProject && projectsState.activeProjectId !== sessionProject.id) {
        projectsState.setActiveProjectIdOnly(sessionProject.id)
      }
      opencodeClient.setDirectory(resolvedDir ?? undefined)
    } catch (e) {
      console.warn("Failed to set OpenCode directory for session switch:", e)
    }

    // Defer viewport anchor save for previous session — not needed for the
    // skeleton to render and reads messages which can be expensive.
    if (previousSessionId && previousSessionId !== id) {
      const prevId = previousSessionId
      setTimeout(() => {
        const memState = getViewportSessionMemory(prevId)
        if (!memState?.isStreaming) {
          const prevMessages = getSyncMessages(prevId)
          if (prevMessages.length > 0) {
            useViewportStore.getState().updateViewportAnchor(prevId, prevMessages.length - 1)
          }
        }
      }, 0)
    }

    // Mark session viewed in notification store + update active session ref
    if (id) {
      markSessionViewed(id)
      setActiveSession(resolvedDir ?? "", id)
    }
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
    })
  },

  restoreForRuntimeSwitch: (apiBaseUrl?: string | null) => {
    const key = runtimeMemoryKey(apiBaseUrl)
    const memory = runtimeSessionMemory.get(key)
    const restoredSessionId = memory?.sessionId ?? activeSessionByRuntime.get(key) ?? null
    const restoredDraft = memory?.draft ? cloneDraft(memory.draft) : { ...DEFAULT_DRAFT }
    const restoredDirectory = memory?.directory ?? null
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
    const projectsState = useProjectsStore.getState()
    const projects = projectsState.projects
    const availableWorktreesByProject = get().availableWorktreesByProject
    const activeProject = projectsState.getActiveProject()
    const currentDirectory = normalizePath(useDirectoryStore.getState().currentDirectory ?? null)
    const persistedTarget = readPersistedDraftTarget()

    const explicitDirectory = options?.directoryOverride !== undefined
      ? normalizePath(options.directoryOverride)
      : null
    const explicitProject = options?.selectedProjectId
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

    const selectedProject = (() => {
      if (explicitProject) return explicitProject
      if (explicitDirectory !== null) return inferredProjectFromDir
      if (currentDirectory) return currentDirProject
      return persistedProjectByDir ?? persistedProjectById ?? fallbackProject
    })()

    const directory = (() => {
      if (explicitDirectory !== null) return explicitDirectory
      if (explicitProject) return normalizePath(explicitProject.path ?? null)
      if (currentDirectory) return currentDirectory
      if (persistedTarget?.directory) return persistedTarget.directory
      return normalizePath(selectedProject?.path ?? null)
    })()

    persistDraftTarget({ projectId: selectedProject?.id ?? null, directory })

    const nextDraft: NewSessionDraftState = {
      open: true,
      materializationKey: {},
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
    }

    set({
      newSessionDraft: {
        ...nextDraft,
      },
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
      })
    })

    if (directory && directory !== useDirectoryStore.getState().currentDirectory) {
      useDirectoryStore.getState().setDirectory(directory)
    }
  },

  // ---------------------------------------------------------------------------
  // closeNewSessionDraft
  // ---------------------------------------------------------------------------
  closeNewSessionDraft: () => {
    const nextDraft: NewSessionDraftState = {
        open: false,
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
    let nextDirectory: string | null = null
    set((s) => {
      nextDirectory = normalizePath(target.directoryOverride ?? s.newSessionDraft.directoryOverride)
      return {
        newSessionDraft: {
          ...s.newSessionDraft,
          selectedProjectId: target.projectId ?? target.selectedProjectId ?? s.newSessionDraft.selectedProjectId,
          directoryOverride: target.directoryOverride ?? s.newSessionDraft.directoryOverride,
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

    type AssistantTokens = { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
    let lastTokens: AssistantTokens | undefined
    let lastMessageId: string | undefined
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg.role !== "assistant") continue
      const tokens = (msg as { tokens?: AssistantTokens }).tokens
      if (!tokens) continue
      const total = tokens.input + tokens.output + tokens.reasoning + (tokens.cache?.read ?? 0) + (tokens.cache?.write ?? 0)
      if (total > 0) {
        lastTokens = tokens
        lastMessageId = msg.id
        break
      }
    }

    if (!lastTokens) return null

    const totalTokens = lastTokens.input + lastTokens.output + lastTokens.reasoning + (lastTokens.cache?.read ?? 0) + (lastTokens.cache?.write ?? 0)
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
    additionalParts?: Array<{ text: string; attachments?: AttachedFile[]; synthetic?: boolean }>,
    variant?: string,
    inputMode?: "normal" | "shell",
    options?: SendMessageOptions,
  ) => {
    // Clear non-Git changed-files bar on new user message for current session
    const sid = options?.sessionId ?? get().currentSessionId;
    if (sid) {
      const map = new Map(get().pendingChangesBarDismissed);
      map.delete(sid);
      set({ pendingChangesBarDismissed: map });
    }

    const draft = get().newSessionDraft
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
    const applyArmedGoal = (goalSessionId: string, goalDirectory: string | null | undefined) => {
      if (!goalArmed) return
      const uiState = useUIStore.getState()
      const tokenBudget = uiState.sessionGoalDefaultBudgetEnabled ? uiState.sessionGoalDefaultBudget : null
      const objective = goalArm.objectiveOverride?.trim() || content
      void setSessionGoal(goalSessionId, goalDirectory ?? undefined, { objective, tokenBudget }, null)
        .catch((error) => {
          console.warn("[session-ui-store] failed to set goal from armed send", error)
        })
    }

    // ---- New session from draft ----
    if (!options?.sessionId && (options?.draft?.open || draft?.open)) {
      const createdDraftSession = await materializeOpenDraftSession({
        providerID,
        modelID,
        agent: trimmedAgent,
        variant,
      }, options?.draft)
      if (!createdDraftSession) throw new Error("Failed to create session")

      const mergedAdditionalParts = createdDraftSession.syntheticParts?.length
        ? [...(additionalParts || []), ...createdDraftSession.syntheticParts]
        : additionalParts

      notifyMessageSent(createdDraftSession.sessionId)

      markPendingUserSendAnimation(createdDraftSession.sessionId)

      const files = attachments?.map((a) => ({
        type: "file" as const,
        mime: a.mimeType,
        url: a.dataUrl,
        filename: a.filename,
      }))

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
          files: p.attachments?.map((a: AttachedFile) => ({
            type: "file" as const,
            mime: a.mimeType,
            url: a.dataUrl,
            filename: a.filename,
          })),
        })),
      })
      applyArmedGoal(createdDraftSession.sessionId, createdDraftSession.directory)
      return
    }

    // ---- Existing session ----
    const targetSessionId = options?.sessionId ?? get().currentSessionId
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
      ? normalizePath(get().getDirectoryForSession(targetSessionId))
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

    await routeMessage({
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
      additionalParts: additionalParts?.map((p) => ({
        text: p.text,
        synthetic: p.synthetic,
        files: p.attachments?.map((a) => ({
          type: "file" as const,
          mime: a.mimeType,
          url: a.dataUrl,
          filename: a.filename,
        })),
      })),
    })
    if (targetSessionId) {
      applyArmedGoal(targetSessionId, currentSessionDirectory)
    }
  },

  // ---------------------------------------------------------------------------
  // createSession
  // ---------------------------------------------------------------------------
  createSession: async (title, directoryOverride, parentID, metadata, options) => {
    const draft = get().newSessionDraft
    const targetFolderId = options ? options.targetFolderId : draft.targetFolderId

    try {
      const dir = directoryOverride ?? opencodeClient.getDirectory()
      const session = await createSessionAction(title, dir, parentID ?? null, metadata, { select: options?.select })
      if (!session) return null

      if (targetFolderId) {
        const scopeKey = directoryOverride || get().lastLoadedDirectory || session.directory
        if (scopeKey) {
          useSessionFoldersStore.getState().addSessionToFolder(scopeKey, targetFolderId, session.id)
        }
      }

      return session
    } catch (e) {
      console.error("[session-ui-store] createSession failed", e)
      return null
    }
  },

  // ---------------------------------------------------------------------------
  // deleteSession — calls SDK, SSE event updates child store
  // ---------------------------------------------------------------------------
  deleteSession: (id) => deleteSessionAction(id),

  deleteSessions: async (ids) => {
    const deletedIds: string[] = []
    const failedIds: string[] = []
    for (const id of ids) {
      const ok = await deleteSessionAction(id)
      if (ok) deletedIds.push(id)
      else failedIds.push(id)
    }
    return { deletedIds, failedIds }
  },

  archiveSession: (id) => archiveSessionAction(id),

  archiveSessions: async (ids) => {
    const archivedIds: string[] = []
    const failedIds: string[] = []
    for (const id of ids) {
      const ok = await archiveSessionAction(id)
      if (ok) archivedIds.push(id)
      else failedIds.push(id)
    }
    return { archivedIds, failedIds }
  },

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
      targetMessage = [...userMessages].reverse().find((m) => m.id < revertToId)
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
    const targetMessage = userMessages.find((m) => m.id > revertToId)

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
    if (sessionId === get().currentSessionId && get().currentSessionDirectory) {
      return get().currentSessionDirectory
    }
    const resolved = resolveSessionDirectory(sessionId, (sid) => get().worktreeMetadata.get(sid))
    if (resolved) return resolved
    const attachmentDirectory = getAttachedSessionDirectory(getAttachmentForSession(sessionId))
    if (attachmentDirectory) return attachmentDirectory
    const sessions = getAllSyncSessions()
    const session = sessions.find((s) => s.id === sessionId)
    if (session) return resolveDirectoryKey(session)
    const globalStore = useGlobalSessionsStore.getState()
    const globalSession = [...globalStore.activeSessions, ...globalStore.archivedSessions]
      .find((s) => s.id === sessionId)
    if (globalSession) return resolveGlobalSessionDirectory(globalSession)
    return null
  },

  getLastUserChoice: (sessionId) => {
    const directory = get().getDirectoryForSession(sessionId) ?? undefined
    const messages = getSyncMessages(sessionId, directory)
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i] as Message & {
        model?: { providerID?: string; modelID?: string; variant?: string }
        variant?: string
        mode?: string
      }
      if (message.role !== "user") {
        continue
      }

      const providerID = typeof message.model?.providerID === "string" && message.model.providerID.trim().length > 0
        ? message.model.providerID
        : undefined
      const modelID = typeof message.model?.modelID === "string" && message.model.modelID.trim().length > 0
        ? message.model.modelID
        : undefined
      const agent = typeof message.agent === "string" && message.agent.trim().length > 0
        ? message.agent
        : (typeof message.mode === "string" && message.mode.trim().length > 0 ? message.mode : undefined)
      const variantCandidate = message.model?.variant ?? message.variant
      const variant = typeof variantCandidate === "string" && variantCandidate.trim().length > 0
        ? variantCandidate
        : undefined

      return { agent, providerID, modelID, variant }
    }
    return null
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

  setSessionDirectory: (sessionId, directory) => {
    const normalized = normalizePath(directory)
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
let lastPersistedWorktreeSerialized = ''
useSessionUIStore.subscribe((state, prev) => {
  if (state.availableWorktreesByProject !== prev.availableWorktreesByProject) {
    const serialized = JSON.stringify([...state.availableWorktreesByProject.entries()])
    if (serialized !== lastPersistedWorktreeSerialized) {
      lastPersistedWorktreeSerialized = serialized
      persistWorktreeMap(serialized)
    }
  }
})
