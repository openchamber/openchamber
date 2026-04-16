/**
 * Session UI Store — ephemeral UI state only.
 *
 * Domain data (sessions, messages, parts, permissions, questions, status)
 * lives in sync child stores. This store owns ONLY transient UI concerns:
 * current selection, draft state, viewport anchors, model/agent preferences,
 * voice state, abort prompts, attached files, worktree metadata.
 *
 * SDK-calling actions that need domain data read it from sync-refs.
 */

import { create } from "zustand"
import type { Session, Part, Message, TextPart } from "@opencode-ai/sdk/v2/client"
import type { AttachedFile, SessionContextUsage } from "@/stores/types/sessionTypes"
import type { WorktreeMetadata } from "@/types/worktree"
import { opencodeClient } from "@/lib/opencode/client"
import { useConfigStore } from "@/stores/useConfigStore"
import { useProjectsStore } from "@/stores/useProjectsStore"
import { useDirectoryStore } from "@/stores/useDirectoryStore"
import { useSessionFoldersStore } from "@/stores/useSessionFoldersStore"
import { useCommandsStore } from "@/stores/useCommandsStore"
import { getSafeStorage } from "@/stores/utils/safeStorage"
import { markPendingUserSendAnimation } from "@/lib/userSendAnimation"
import { flattenAssistantTextParts } from "@/lib/messages/messageText"
import { EXECUTION_FORK_META_TEXT } from "@/lib/messages/executionMeta"
import { waitForWorktreeBootstrap } from "@/lib/worktrees/worktreeBootstrap"
import { waitForPendingDraftWorktreeRequest } from "@/lib/worktrees/pendingDraftWorktree"
import type { ProjectEntry } from "@/lib/api/types"
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
} from "./session-actions"
import { useInputStore, type SyntheticContextPart } from "./input-store"
import { useSelectionStore } from "./selection-store"
import { useViewportStore } from "./viewport-store"

export type { AttachedFile }

// ---------------------------------------------------------------------------
// Send routing — shell mode, slash commands, or normal prompt
// ---------------------------------------------------------------------------

function routeMessage(params: {
  sessionId: string
  content: string
  providerID: string
  modelID: string
  agent?: string
  variant?: string
  inputMode?: "normal" | "shell"
  files?: Array<{ type: "file"; mime: string; url: string; filename: string }>
  additionalParts?: Array<{ text: string; synthetic?: boolean; files?: Array<{ type: "file"; mime: string; url: string; filename: string }> }>
}): Promise<void> {
  const sdk = opencodeClient.getSdkClient()

  if (params.inputMode === "shell") {
    const dir = opencodeClient.getDirectory() || undefined
    return sdk.session.shell({
      sessionID: params.sessionId,
      directory: dir,
      agent: params.agent,
      model: { providerID: params.providerID, modelID: params.modelID },
      command: params.content,
    }).then(() => {})
  }

  // Slash commands — fire and forget, SSE delivers messages and status
  if (params.content.startsWith("/")) {
    const [head, ...tail] = params.content.split(" ")
    const cmdName = head.slice(1)

    const dirState = getDirectoryState()
    const syncCommands = dirState?.command ?? []
    const storeCommands = useCommandsStore.getState().commands

    const isCommand = syncCommands.find((c) => c.name === cmdName)
      || storeCommands.find((c) => c.name === cmdName)

    if (isCommand) {
      const dir = opencodeClient.getDirectory() || undefined
      return sdk.session.command({
        sessionID: params.sessionId,
        directory: dir,
        command: cmdName,
        arguments: tail.join(" "),
        agent: params.agent,
        model: `${params.providerID}/${params.modelID}`,
        variant: params.variant,
        parts: params.files,
      }).then(() => {})
    }
  }

  // Normal prompt — optimistic insert so message appears instantly
  return optimisticSend({
    sessionId: params.sessionId,
    content: params.content,
    providerID: params.providerID,
    modelID: params.modelID,
    agent: params.agent,
    files: params.files,
    send: (messageID) => opencodeClient.sendMessage({
      id: params.sessionId,
      providerID: params.providerID,
      modelID: params.modelID,
      text: params.content,
      agent: params.agent,
      variant: params.variant,
      files: params.files,
      additionalParts: params.additionalParts,
      messageId: messageID,
    }).then(() => {}),
  })
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type { SyntheticContextPart } from "./input-store"
export type { SessionMemoryState } from "./viewport-store"
export type { VoiceStatus, VoiceMode } from "./voice-store"

export type NewSessionDraftState = {
  open: boolean
  requestKey: number
  selectedProjectId?: string | null
  directoryOverride: string | null
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

  // Actions — UI state management
  setCurrentSession: (id: string | null, directoryHint?: string | null) => void
  openNewSessionDraft: (options?: Partial<NewSessionDraftState>) => void
  closeNewSessionDraft: () => void
  setNewSessionDraftTarget: (target: { projectId?: string | null; selectedProjectId?: string | null; directoryOverride?: string | null }, options?: { force?: boolean }) => void
  setDraftPreserveDirectoryOverride: (value: boolean) => void
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
  ) => Promise<void>

  createSession: (title?: string, directoryOverride?: string | null, parentID?: string | null) => Promise<Session | null>
  deleteSession: (id: string, options?: Record<string, unknown>) => Promise<boolean>
  deleteSessions: (ids: string[], options?: Record<string, unknown>) => Promise<{ deletedIds: string[]; failedIds: string[] }>
  archiveSession: (id: string) => Promise<boolean>
  archiveSessions: (ids: string[], options?: Record<string, unknown>) => Promise<{ archivedIds: string[]; failedIds: string[] }>
  updateSessionTitle: (sessionId: string, title: string) => Promise<void>
  shareSession: (sessionId: string) => Promise<Session | null>
  unshareSession: (sessionId: string) => Promise<Session | null>
  revertToMessage: (sessionId: string, messageId: string) => Promise<void>
  forkFromMessage: (sessionId: string, messageId: string) => Promise<void>
  handleSlashUndo: (sessionId: string) => Promise<void>
  handleSlashRedo: (sessionId: string) => Promise<void>
  createSessionFromAssistantMessage: (sourceMessageId: string) => Promise<void>

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

const normalizePath = (value?: string | null): string | null => {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (!trimmed) return null
  const replaced = trimmed.replace(/\\/g, "/")
  if (replaced === "/") return "/"
  return replaced.length > 1 ? replaced.replace(/\/+$/, "") : replaced
}

const resolveDirectoryKey = (session: Session): string | null => {
  const sessionRecord = session as Session & {
    directory?: string | null
    project?: { worktree?: string | null } | null
  }
  return normalizePath(sessionRecord.directory ?? null)
    ?? normalizePath(sessionRecord.project?.worktree ?? null)
}

const safeStorage = getSafeStorage()
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

const resolveProjectForDirectory = (projects: ProjectEntry[], directory: string | null): ProjectEntry | null => {
  const nd = normalizePath(directory)
  if (!nd) return null
  let best: ProjectEntry | null = null
  for (const p of projects) {
    const pp = normalizePath(p.path)
    if (!pp) continue
    if (nd !== pp && !nd.startsWith(`${pp}/`)) continue
    if (!best || pp.length > (normalizePath(best.path)?.length ?? 0)) best = p
  }
  return best
}

const resolveProjectFromWorktreeDirectory = (
  projects: ProjectEntry[],
  availableWorktreesByProject: Map<string, WorktreeMetadata[]>,
  directory: string | null,
): ProjectEntry | null => {
  const nd = normalizePath(directory)
  if (!nd) return null
  let matchedWorktree: WorktreeMetadata | null = null
  let matchedProjectPath: string | null = null
  let bestLen = -1
  for (const [projectPath, worktrees] of availableWorktreesByProject.entries()) {
    for (const wt of worktrees) {
      const wp = normalizePath(wt.path)
      if (!wp) continue
      if (nd !== wp && !nd.startsWith(`${wp}/`)) continue
      if (wp.length > bestLen) {
        bestLen = wp.length
        matchedWorktree = wt
        matchedProjectPath = normalizePath(projectPath)
      }
    }
  }
  if (!matchedWorktree) return null
  const candidates = [normalizePath(matchedWorktree.projectDirectory), matchedProjectPath].filter((v): v is string => Boolean(v))
  for (const c of candidates) {
    const exact = projects.find((p) => normalizePath(p.path) === c) ?? null
    if (exact) return exact
    const nested = resolveProjectForDirectory(projects, c)
    if (nested) return nested
  }
  return null
}

const resolveDraftProjectForDirectory = (
  projects: ProjectEntry[],
  availableWorktreesByProject: Map<string, WorktreeMetadata[]>,
  directory: string | null,
): ProjectEntry | null =>
  resolveProjectFromWorktreeDirectory(projects, availableWorktreesByProject, directory) ??
  resolveProjectForDirectory(projects, directory)

const resolveSessionDirectory = (
  sessionId: string | null | undefined,
  getWtMeta: (id: string) => WorktreeMetadata | undefined,
): string | null => {
  if (!sessionId) return null
  const metaPath = getWtMeta(sessionId)?.path
  if (typeof metaPath === "string" && metaPath.trim().length > 0) return normalizePath(metaPath)
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
  requestKey: 0,
  directoryOverride: null,
  parentID: null,
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useSessionUIStore = create<SessionUIState>()((set, get) => ({
  currentSessionId: null,
  newSessionDraft: { ...DEFAULT_DRAFT },
  abortPromptSessionId: null,
  abortPromptExpiresAt: null,
  error: null,
  worktreeMetadata: new Map(),
  availableWorktrees: [],
  availableWorktreesByProject: new Map(),
  webUICreatedSessions: new Set(),
  sessionAbortFlags: new Map(),
  abortControllers: new Map(),
  isLoading: false,
  lastLoadedDirectory: null,
  sessionPlanAvailable: new Map(),

  // ---------------------------------------------------------------------------
  // setCurrentSession
  // ---------------------------------------------------------------------------
  setCurrentSession: (id, directoryHint?: string | null) => {
    if (id) {
      get().closeNewSessionDraft()
    }

    const previousSessionId = get().currentSessionId
    const directoryState = useDirectoryStore.getState()

    const sessionDir = resolveSessionDirectory(
      id,
      (sid) => get().worktreeMetadata.get(sid),
    )
    const fallbackDir = opencodeClient.getDirectory() ?? directoryState.currentDirectory ?? null
    const resolvedDir = (directoryHint ? normalizePath(directoryHint) : null) ?? sessionDir ?? fallbackDir

    try {
      if (resolvedDir && directoryState.currentDirectory !== resolvedDir) {
        directoryState.setDirectory(resolvedDir, { showOverlay: false })
      }
      opencodeClient.setDirectory(resolvedDir ?? undefined)
    } catch (e) {
      console.warn("Failed to set OpenCode directory for session switch:", e)
    }

    // Save viewport anchor for previous session
    if (previousSessionId && previousSessionId !== id) {
      const memState = useViewportStore.getState().sessionMemoryState.get(previousSessionId)
      if (!memState?.isStreaming) {
        const prevMessages = getSyncMessages(previousSessionId)
        if (prevMessages.length > 0) {
          useViewportStore.getState().updateViewportAnchor(previousSessionId, prevMessages.length - 1)
        }
      }
    }

    set({ currentSessionId: id })

    // Mark session viewed in notification store + update active session ref
    // Mark session viewed in notification store + update active session ref
    if (id) {
      markSessionViewed(id)
      setActiveSession(resolvedDir ?? "", id)
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
      if (explicitProject || explicitDirectory !== null) {
        return explicitProject ?? inferredProjectFromDir ?? fallbackProject
      }
      if (currentDirectory) return currentDirProject ?? fallbackProject
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

    set((s) => ({
      newSessionDraft: {
        open: true,
        requestKey: s.newSessionDraft.requestKey + 1,
        selectedProjectId: selectedProject?.id ?? null,
        directoryOverride: directory,
        pendingWorktreeRequestId: options?.pendingWorktreeRequestId ?? null,
        bootstrapPendingDirectory: normalizePath(options?.bootstrapPendingDirectory ?? null),
        preserveDirectoryOverride: options?.preserveDirectoryOverride === true,
        parentID: options?.parentID ?? null,
        title: options?.title,
        initialPrompt: options?.initialPrompt,
        syntheticParts: options?.syntheticParts,
        targetFolderId: options?.targetFolderId,
      },
      currentSessionId: null,
      error: null,
    }))

    if (options?.initialPrompt) {
      useInputStore.getState().setPendingInputText(options.initialPrompt)
    }

    void activateConfigForDirectory(directory)
  },

  // ---------------------------------------------------------------------------
  // closeNewSessionDraft
  // ---------------------------------------------------------------------------
  closeNewSessionDraft: () => {
    set((s) => ({
      newSessionDraft: {
        ...s.newSessionDraft,
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
      },
    }))
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
  },

  setDraftPreserveDirectoryOverride: (value) =>
    set((s) => {
      if (!s.newSessionDraft?.open) return s
      return { newSessionDraft: { ...s.newSessionDraft, preserveDirectoryOverride: value } }
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

    // Find last assistant message with token data
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

  setWorktreeMetadata: (sessionId, metadata) =>
    set((s) => {
      const map = new Map(s.worktreeMetadata)
      if (metadata) map.set(sessionId, metadata)
      else map.delete(sessionId)
      return { worktreeMetadata: map }
    }),

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

  // ---------------------------------------------------------------------------
  // sendMessage — calls SDK, reads domain data from sync
  // ---------------------------------------------------------------------------
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
  ) => {
    const draft = get().newSessionDraft
    const trimmedAgent = typeof agent === "string" && agent.trim().length > 0 ? agent.trim() : undefined

    // ---- New session from draft ----
    if (draft?.open) {
      const draftTargetFolderId = draft.targetFolderId
      let draftDirectoryOverride = draft.bootstrapPendingDirectory ?? draft.directoryOverride ?? null
      const draftProjectId = draft.selectedProjectId ?? null

      if (draft.pendingWorktreeRequestId) {
        draftDirectoryOverride = await waitForPendingDraftWorktreeRequest(draft.pendingWorktreeRequestId)
        get().resolvePendingDraftWorktreeTarget(draft.pendingWorktreeRequestId, draftDirectoryOverride)
      }

      const created = await get().createSession(draft.title, draftDirectoryOverride, draft.parentID ?? null)
      if (!created?.id) throw new Error("Failed to create session")

      persistDraftTarget({
        projectId: draftProjectId,
        directory: normalizePath(draftDirectoryOverride ?? created.directory ?? null),
      })

      const draftSyntheticParts = draft.syntheticParts
      await activateConfigForDirectory(draftDirectoryOverride ?? created.directory ?? null)

      const configState = useConfigStore.getState()
      const draftAgentName = configState.currentAgentName
      const effectiveDraftAgent = trimmedAgent ?? draftAgentName

      if (configState.currentProviderId && configState.currentModelId) {
        useSelectionStore.getState().saveSessionModelSelection(created.id, configState.currentProviderId, configState.currentModelId)
      }

      if (effectiveDraftAgent) {
        useSelectionStore.getState().saveSessionAgentSelection(created.id, effectiveDraftAgent)
        if (configState.currentProviderId && configState.currentModelId) {
          useSelectionStore.getState().saveAgentModelForSession(created.id, effectiveDraftAgent, configState.currentProviderId, configState.currentModelId)
          useSelectionStore.getState().saveAgentModelVariantForSession(created.id, effectiveDraftAgent, configState.currentProviderId, configState.currentModelId, variant)
        }
      }

      get().initializeNewOpenChamberSession(created.id, configState.agents ?? [])

      const createdDirectory = normalizePath(draftDirectoryOverride ?? created.directory ?? null)

      get().closeNewSessionDraft()
      get().setCurrentSession(created.id, createdDirectory)

      if (draftTargetFolderId) {
        const scopeKey = draftDirectoryOverride || created.directory || null
        if (scopeKey) {
          useSessionFoldersStore.getState().addSessionToFolder(scopeKey, draftTargetFolderId, created.id)
        }
      }

      const mergedAdditionalParts = draftSyntheticParts?.length
        ? [...(additionalParts || []), ...draftSyntheticParts]
        : additionalParts

      if (createdDirectory) {
        await waitForWorktreeBootstrap(createdDirectory)
      }

      markPendingUserSendAnimation(created.id)

      const files = attachments?.map((a) => ({
        type: "file" as const,
        mime: a.mimeType,
        url: a.dataUrl,
        filename: a.filename,
      }))

      await routeMessage({
        sessionId: created.id,
        content,
        providerID,
        modelID,
        agent: effectiveDraftAgent,
        variant,
        inputMode,
        files,
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
      return
    }

    // ---- Existing session ----
    const currentSessionId = get().currentSessionId
    const sessionAgentSelection = currentSessionId
      ? useSelectionStore.getState().getSessionAgentSelection(currentSessionId)
      : null
    const configAgentName = useConfigStore.getState().currentAgentName
    const effectiveAgent = trimmedAgent || sessionAgentSelection || configAgentName || undefined

    if (currentSessionId && effectiveAgent) {
      useSelectionStore.getState().saveSessionAgentSelection(currentSessionId, effectiveAgent)
      useSelectionStore.getState().saveAgentModelVariantForSession(currentSessionId, effectiveAgent, providerID, modelID, variant)
    }

    if (currentSessionId) {
      const viewportState = useViewportStore.getState()
      const memState = viewportState.sessionMemoryState.get(currentSessionId)
      if (!memState || !memState.lastUserMessageAt) {
        const newMemState = new Map(viewportState.sessionMemoryState)
        newMemState.set(currentSessionId, {
          viewportAnchor: memState?.viewportAnchor ?? 0,
          isStreaming: memState?.isStreaming ?? false,
          lastAccessedAt: Date.now(),
          backgroundMessageCount: memState?.backgroundMessageCount ?? 0,
          lastUserMessageAt: Date.now(),
        })
        useViewportStore.setState({ sessionMemoryState: newMemState })
      }
    }

    const currentSessionDirectory = currentSessionId
      ? normalizePath(get().getDirectoryForSession(currentSessionId))
      : null
    if (currentSessionDirectory) {
      await waitForWorktreeBootstrap(currentSessionDirectory)
    }

    if (currentSessionId) {
      fetch(`/api/sessions/${currentSessionId}/message-sent`, { method: "POST" })
        .catch(() => { /* ignore */ })
    }

    if (currentSessionId) {
      markPendingUserSendAnimation(currentSessionId)
    }

    const files = attachments?.map((a) => ({
      type: "file" as const,
      mime: a.mimeType,
      url: a.dataUrl,
      filename: a.filename,
    }))

    await routeMessage({
      sessionId: currentSessionId || "",
      content,
      providerID,
      modelID,
      agent: effectiveAgent,
      variant,
      inputMode,
      files,
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
  },

  // ---------------------------------------------------------------------------
  // createSession
  // ---------------------------------------------------------------------------
  createSession: async (title, directoryOverride, parentID) => {
    const draft = get().newSessionDraft
    const targetFolderId = draft.targetFolderId
    get().closeNewSessionDraft()

    try {
      const dir = directoryOverride ?? opencodeClient.getDirectory()
      const session = await createSessionAction(title, dir, parentID ?? null)
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
    const { revertToMessage: revert } = await import("./session-actions")
    await revert(sessionId, messageId)
  },

  // ---------------------------------------------------------------------------
  // handleSlashUndo — reads from sync
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
      const revertIndex = userMessages.findIndex((m) => m.id === revertToId)
      targetMessage = userMessages[revertIndex + 1]
    } else {
      targetMessage = userMessages[userMessages.length - 1]
    }

    if (!targetMessage) return

    const targetParts = getSyncParts(targetMessage.id)
    const textPart = targetParts.find((p: Part) => p.type === "text") as TextPart | undefined
    const preview = textPart?.text
      ? String(textPart.text).slice(0, 50) + (textPart.text.length > 50 ? "..." : "")
      : "[No text]"

    await get().revertToMessage(sessionId, targetMessage.id)

    const { toast } = await import("sonner")
    toast.success(`Undid to: ${preview}`)
  },

  // ---------------------------------------------------------------------------
  // handleSlashRedo — reads from sync
  // ---------------------------------------------------------------------------
  handleSlashRedo: async (sessionId) => {
    const sessions = getSyncSessions()
    const currentSession = sessions.find((s) => s.id === sessionId)
    const revertToId = currentSession?.revert?.messageID
    if (!revertToId) return

    const messages = getSyncMessages(sessionId)
    const userMessages = messages.filter((m) => m.role === "user")
    const revertIndex = userMessages.findIndex((m) => m.id === revertToId)
    const targetMessage = userMessages[revertIndex - 1]

    if (targetMessage) {
      const targetParts = getSyncParts(targetMessage.id)
      const textPart = targetParts.find((p: Part) => p.type === "text") as TextPart | undefined
      const preview = textPart?.text
        ? String(textPart.text).slice(0, 50) + (textPart.text.length > 50 ? "..." : "")
        : "[No text]"

      await get().revertToMessage(sessionId, targetMessage.id)

      const { toast } = await import("sonner")
      toast.success(`Redid to: ${preview}`)
    } else {
      // Full unrevert
      const { unrevertSession } = await import("./session-actions")
      await unrevertSession(sessionId)

      const { toast } = await import("sonner")
      toast.success("Restored all messages")
    }
  },

  // ---------------------------------------------------------------------------
  // forkFromMessage — delegates to session-actions (handles text + sidebar)
  // ---------------------------------------------------------------------------
  forkFromMessage: async (sessionId, messageId) => {
    const sessions = getSyncSessions()
    const existingSession = sessions.find((s) => s.id === sessionId)
    if (!existingSession) return

    try {
      const { forkFromMessage: fork } = await import("./session-actions")
      await fork(sessionId, messageId)

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
  createSessionFromAssistantMessage: async (sourceMessageId) => {
    if (!sourceMessageId) return

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

    const session = await get().createSession(undefined, directory ?? null, null)
    if (!session) return

    const { currentProviderId, currentModelId, currentAgentName } = useConfigStore.getState()
    const pID = currentProviderId || useSelectionStore.getState().lastUsedProvider?.providerID
    const mID = currentModelId || useSelectionStore.getState().lastUsedProvider?.modelID

    if (!pID || !mID) return

    await opencodeClient.sendMessage({
      id: session.id,
      providerID: pID,
      modelID: mID,
      text: assistantPlanText,
      prefaceText: EXECUTION_FORK_META_TEXT,
      agent: currentAgentName ?? undefined,
    })
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
    const sessions = getAllSyncSessions()
    const session = sessions.find((s) => s.id === sessionId)
    if (!session) return null
    return resolveDirectoryKey(session)
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

  setSessionDirectory: () => {
    // Session directory is owned by sync child stores via SSE events.
    // This is now a no-op — kept for interface compatibility during migration.
  },

  // ---------------------------------------------------------------------------
  // Plan mode availability tracking
  // ---------------------------------------------------------------------------
  markSessionPlanAvailable: (sessionId) => {
    set((state) => {
      const next = new Map(state.sessionPlanAvailable)
      next.set(sessionId, true)
      return { sessionPlanAvailable: next }
    })
  },

  isSessionPlanAvailable: (sessionId) => {
    return get().sessionPlanAvailable.get(sessionId) ?? false
  },
}))
