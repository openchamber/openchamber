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
import { isSameModelRef, toModelRef, type Metadata, type ModelRef, type Part, type Session, type TextPart } from "@/lib/opencode/model"
import type { AttachedFile, SessionWorktreeAttachment } from "@/stores/types/sessionTypes"
import { permissionModeForNewSession, type PermissionMode } from "@/stores/utils/permissionAutoAccept"
import type { WorktreeMetadata } from "@/types/worktree"
import { opencodeClient, type SkillMentions } from "@/lib/opencode/client"
import { buildSkillMentionInstruction } from "@/lib/skillMentionInstruction"
import { runtimeFetch } from "@/lib/runtime-fetch"
import { useConfigStore } from "@/stores/useConfigStore"
import { runAfterOpenCodeStartup } from "./opencode-startup-gate"
import { useProjectsStore } from "@/stores/useProjectsStore"
import { useSessionDisplayStore } from "@/stores/useSessionDisplayStore"
import { syncSessionKnowledge } from "@/lib/sessionKnowledgeApi"
import { fetchResponseStyleInstruction } from "@/lib/responseStyle"
import { useGlobalSessionsStore, resolveGlobalSessionDirectory } from "@/stores/useGlobalSessionsStore"
import { isDirectoryUnknown, useDirectoryStore } from "@/stores/useDirectoryStore"
import { useSessionFoldersStore } from "@/stores/useSessionFoldersStore"
import { useSessionTabsStore } from "@/stores/useSessionTabsStore"
import { selectCommandsForDirectory, useCommandsStore } from "@/stores/useCommandsStore"
import { selectAvailableSkillsForDirectory, useSkillsStore } from "@/stores/useSkillsStore"
import { getDeferredSafeStorage } from "@/stores/utils/safeStorage"
import { markPendingUserSendAnimation } from "@/lib/userSendAnimation"
import { prepareUserMessageResume } from "./user-message-resume"
import { normalizePath } from "@/lib/pathNormalization"
import { descendingId } from "@/lib/opencode/ids"
import { CHAT_DRAFT_PROJECT_ID, captureChatDirectoryCleanup as captureChatCleanup, createChatDirectory, deleteChatDirectory, getChatsRootFromDirectory, isChatDirectoryPath, warmChatsRootDirectory } from "@/lib/chatDirectories"
import { isSpaceArchiveDirectory } from "@/lib/spaces/space-archives"
import { isSpaceDirectory } from "@/lib/spaces/space-route"
import { isSpaceDirectoryClosedToNewSessions } from "@/lib/spaces/spaces-store"
import { isVSCodeRuntime } from "@/lib/desktop"
import { isVSCodeWithoutWorkspace } from "@/lib/vscodeBootstrap"
import { composeForkSessionMessage } from "@/lib/messages/executionMeta"
import { findLatestUserModelChoice } from "@/lib/messages/userModelChoice"
import { noteDraftSendWaiting, waitForPendingDraftWorktreeRequest } from "@/lib/worktrees/pendingDraftWorktree"
import { waitForWorktreeBootstrap } from "@/lib/worktrees/worktreeBootstrap"
import { getWorktreeSetupWaitEnabled } from "@/lib/openchamberConfig"
import { resolveCreatedWorktreeStartDirectory, resolveStartDirectory, resolveWorktreeStartDirectory } from "@/lib/worktrees/worktreeStartDirectory"
import { resolveProjectForSessionDirectory } from "@/lib/projectResolution"
import { admitSession, isSessionAdmitted } from "./session-admission"
import { isSessionDirectoryAdmitted } from "./session-admission-rule"
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
  adoptSessionMove,
  createSession as createSessionAction,
  markSessionStatus,
  openPendingSessionTranscript,
  type SessionCreateSelection,
  deleteSession as deleteSessionAction,
  deleteSessions as deleteSessionsAction,
  archiveSession as archiveSessionAction,
  archiveSessions as archiveSessionsAction,
  unarchiveSession as unarchiveSessionAction,
  unarchiveSessions as unarchiveSessionsAction,
  updateSessionTitle as updateSessionTitleAction,
  optimisticSend,
  refetchSessionMessages,
  revertToMessage as revertToMessageAction,
  forkFromMessage as forkFromMessageAction,
  forkAfterMessage as forkAfterMessageAction,
  fetchMessagesForSession,
  type ArchiveSessionsOptions,
  type DeleteSessionOptions,
  type DeleteSessionsOptions,
  type UnarchiveSessionsOptions,
} from "./session-actions"
import { useInputStore, type SyntheticContextPart } from "./input-store"
import { useSessionGoalArmStore } from "@/stores/useSessionGoalArmStore"
import type { QueuedMessageGoal } from "@/stores/messageQueueStore"
import { setSessionGoal } from "@/lib/sessionGoalActions"
import { wrapSystemReminder } from "@/lib/systemReminder"
import { useUIStore } from "@/stores/useUIStore"
import { useSelectionStore } from "./selection-store"
import { getViewportSessionMemory, useViewportStore, viewportSessionKey } from "./viewport-store"
import { useSessionWorktreeStore } from "./session-worktree-store"
import { getAttachedSessionDirectory } from "./session-worktree-contract"
import { setSessionOpener } from "./session-navigation"
import { getRuntimeKey, isTransientRuntimeKey } from "@/lib/runtime-switch"
import { clearLastActiveSession, persistLastActiveSession, readLastActiveSession } from "./last-session-cache"
import { createSessionDraftId, useSessionDraftsStore } from "@/stores/useSessionDraftsStore"
import { persistWorktreeTopology, readPersistedWorktreeTopology } from "./worktree-topology-cache"
import { rememberRuntimeLiveStatus } from "./runtime-live-memory"
import {
  createInputHistoryIdentity,
  useInputHistoryStore,
  type InputHistorySubmission,
} from '@/stores/useInputHistoryStore'

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

/**
 * The model and agent a send has to switch the session to, or nothing.
 *
 * OpenCode 2.x keeps the selection on the session: `session.model` and
 * `session.agent` are what the next turn runs on. Passing the composer's
 * current pick on every prompt would re-switch the session constantly and
 * write a switch record into the transcript, so only a difference from the
 * session's own record travels.
 */
/**
 * The model/agent a send has to switch the session to, or nothing when the
 * session already runs on the desired selection. Sending them on every turn
 * would make OpenCode record a switch (and two round trips) each time.
 */
export function resolveSendSelection(
  sessionId: string,
  directory: string | undefined,
  desired: { providerID: string; modelID: string; variant?: string | null; agent?: string },
): { model?: ModelRef; agent?: string } {
  const sessions = getDirectoryState(directory)?.session ?? getAllSyncSessions()
  const session = sessions.find((candidate) => candidate.id === sessionId)
  // Compared in wire form: an explicit `Default` (null) switches the session
  // off an effort once, then matches the `"default"` OpenCode records for it.
  const model = toModelRef({ providerID: desired.providerID, id: desired.modelID, variant: desired.variant })
  const modelChanged = !session?.model || !isSameModelRef(session.model, model)
  const agentChanged = Boolean(desired.agent) && session?.agent !== desired.agent
  return {
    model: modelChanged ? model : undefined,
    agent: agentChanged ? desired.agent : undefined,
  }
}

export async function routeMessage(params: {
  runtimeKey?: string
  sessionId: string
  directory?: string | null
  content: string
  providerID: string
  modelID: string
  agent?: string
  agentMentionName?: string
  /** `null` is an explicit `Default` thinking level. */
  variant?: string | null
  inputMode?: "normal" | "shell"
  files?: Array<{ type: "file"; mime: string; url: string; filename: string }>
  additionalParts?: Array<{ text: string; synthetic?: boolean; metadata?: ContextPartMetadata; files?: Array<{ type: "file"; mime: string; url: string; filename: string }> }>
  appendSubmissions?: () => void
  delivery?: 'steer'
  skills?: SkillMentions
  /**
   * What the request waits for: the session being created from a draft, its
   * project knowledge being written into it. A prompt's message appears
   * without waiting for it; only the request does. A rejection fails the send.
   */
  ready?: Promise<void>
  /** Runs right before the request that starts the turn leaves (the gate on a session's first send). */
  beforeSend?: () => void
  /**
   * Whether the optimistic insert marks the session busy. A session created
   * from a draft is marked once it exists, by its creator.
   */
  markBusy?: boolean
}): Promise<'command' | 'prompt' | 'shell'> {
  const assertRuntimeCurrent = () => {
    if (params.runtimeKey !== undefined && params.runtimeKey !== getRuntimeKey()) {
      throw new Error("Message was not sent because the runtime changed.")
    }
  }
  assertRuntimeCurrent()
  const requestDirectory = params.directory ?? undefined
  // The request goes to the directory the session lives in when it leaves:
  // a session created from a draft can end up elsewhere than where its first
  // message was shown, and its record is there.
  const sendDirectory = () => getSyncSessionDirectory(params.sessionId) ?? requestDirectory
  // The session carries its own model and agent server-side. Sending them on
  // every turn would switch the session to whatever the composer happens to
  // show, so only a genuine change travels with the prompt. Resolved when the
  // request is about to leave: a session created from a draft has its record,
  // with the model it was created on, only once `ready` settles.
  const sendSelection = () => resolveSendSelection(params.sessionId, sendDirectory(), {
    providerID: params.providerID,
    modelID: params.modelID,
    variant: params.variant,
    agent: params.agent,
  })
  // A context item becomes a synthetic message, which carries text only. Any
  // file it brought rides with the send so the attachment still arrives.
  const contextItems = (params.additionalParts ?? [])
    .filter((part) => part.text.trim().length > 0)
    .map((part) => ({ text: part.text, metadata: part.metadata }))
  // The command route takes no skill attachments, so the skills named in a
  // command's arguments are named in an instruction as before.
  const skillInstructionContext = (): Array<{ text: string }> => {
    const text = params.skills?.names.length ? params.skills.instructionFor(params.skills.names) : null
    return text ? [{ text }] : []
  }
  const contextFiles = (params.additionalParts ?? []).flatMap((part) => part.files ?? [])
  const sendFiles = [...(params.files ?? []), ...contextFiles]

  if (params.inputMode === "shell") {
    await params.ready
    assertRuntimeCurrent()
    params.beforeSend?.()
    await opencodeClient.shellSession({
      runtimeKey: params.runtimeKey,
      sessionId: params.sessionId,
      directory: sendDirectory(),
      command: params.content,
    })
    return 'shell'
  }

  let skills = params.skills
  // Slash commands use the command route; skills attach to a normal prompt.
  if (params.content.startsWith("/")) {
    const [head, ...tail] = params.content.split(" ")
    const cmdName = head.slice(1)

    // Commands and skills are resolved for the session's own directory. A
    // project root and one of its worktrees can define different commands
    // under the same name. OpenCode 2.x lists skills separately and accepts
    // them as prompt attachments rather than commands.
    let matchedCommand = selectCommandsForDirectory(useCommandsStore.getState(), requestDirectory)
      .find((c) => c.name === cmdName)
    let matchedSkill = selectAvailableSkillsForDirectory(useSkillsStore.getState(), requestDirectory)
      .find((s) => s.name === cmdName)

    // The command list is no longer pre-warmed at bootstrap (listing it
    // initializes the directory's whole MCP fleet), so a name known to neither
    // store gets one live, directory-scoped lookup. That lookup decides the
    // route: a successful no-match is a plain prompt, while a failed lookup is
    // a send failure, because treating it as a prompt would silently send the
    // raw "/name" text instead of running the command.
    // The skills list is loaded per directory on demand too, so a skill of a
    // directory the store has not loaded yet gets the same live lookup. A
    // failed skills load is a send failure for the same reason. Commands keep
    // precedence when both lookups match.
    if (!matchedCommand && !matchedSkill) {
      const [liveCommands, skillsLoaded] = await Promise.all([
        opencodeClient.listCommands(requestDirectory),
        useSkillsStore.getState().loadSkills(requestDirectory),
      ])
      matchedCommand = liveCommands.find((c) => c.name === cmdName)
      if (!matchedCommand) {
        if (!skillsLoaded) {
          throw new Error(`Could not load skills to resolve /${cmdName}`)
        }
        matchedSkill = selectAvailableSkillsForDirectory(useSkillsStore.getState(), requestDirectory)
          .find((s) => s.name === cmdName)
      }
    }

    if (matchedCommand) {
      // The command route takes files only, so attached context (a quoted
      // selection, prepared conflict instructions) is
      // admitted ahead of it as synthetic messages. Sending "/name args" as
      // a prompt instead would skip the command's template entirely: OpenCode
      // 2.x expands it only on the command route.
      //
      // `session.command` assigns the message id itself, so there is no id to
      // hang an optimistic user message on. The command's message arrives
      // through the stream instead.
      params.appendSubmissions?.()
      await params.ready
      assertRuntimeCurrent()
      const commandContext = [
        ...contextItems,
        ...skillInstructionContext(),
      ]
      const selection = sendSelection()
      await opencodeClient.sendCommand({
        runtimeKey: params.runtimeKey,
        id: params.sessionId,
        model: selection.model,
        agent: selection.agent,
        command: cmdName,
        arguments: tail.join(" "),
        files: sendFiles,
        context: commandContext.length > 0 ? commandContext : undefined,
        delivery: params.delivery,
        directory: sendDirectory(),
        beforeSend: params.beforeSend,
      })
      return 'command'
    }

    if (matchedSkill) {
      skills = {
        names: [...new Set([matchedSkill.name, ...(params.skills?.names ?? [])])],
        // Callers without a composer (multi-run) pass no builder; the skill
        // still has to be named when it cannot be attached.
        instructionFor: params.skills?.instructionFor ?? buildSkillMentionInstruction,
      }
    }
  }

  // Normal prompt — optimistic insert so message appears instantly.
  await optimisticSend({
    runtimeKey: params.runtimeKey,
    sessionId: params.sessionId,
    content: params.content,
    directory: requestDirectory,
    files: sendFiles,
    context: contextItems,
    ready: params.ready,
    markBusy: params.markBusy,
    appendSubmissions: params.appendSubmissions,
    send: async (messageID, context) => {
      assertRuntimeCurrent()
      const selection = sendSelection()
      return opencodeClient.sendMessage({
        runtimeKey: params.runtimeKey,
        id: params.sessionId,
        providerID: params.providerID,
        model: selection.model,
        agent: selection.agent,
        text: params.content,
        agentMentions: params.agentMentionName ? [{ name: params.agentMentionName }] : undefined,
        files: sendFiles,
        context: context.length > 0 ? context : undefined,
        delivery: params.delivery,
        messageId: messageID,
        directory: sendDirectory(),
        skills,
        beforeSend: params.beforeSend,
      }).then(() => {})
    },
  })
  return 'prompt'
}

type CapturedSendTarget = {
  runtimeKey: string
  sessionId: string
  directory: string
}

type SendMessageOptions = {
  /** Explicit composer intent; automated continuations must not restore archives. */
  userInitiated?: boolean
  target?: CapturedSendTarget
  sessionId?: string
  directory?: string
  historySubmissions?: InputHistorySubmission[]
  /** Immutable copy of the new-session draft at submit time; used instead of the live draft. */
  draftSnapshot?: NewSessionDraftState
  delivery?: 'steer'
  /** Skills named inline, attached to the prompt once the session exists. */
  skills?: SkillMentions
  /**
   * A queued message carries its own goal intent. Set (a goal or `null`), it
   * replaces the composer's armed goal, which belongs to the composer text.
   */
  queuedGoal?: QueuedMessageGoal | null
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

type AssistantMessageSessionSource = {
  sessionId: string
  directory: string
  text: string
}

/**
 * Index in `userMessages` of the user message a staged revert took back. The
 * marker may sit on that message's context carriers rather than on the message
 * itself, so it is the first user message at or after the marker.
 */
function revertedUserMessageIndex(
  messages: readonly { id: string }[],
  userMessages: readonly { id: string }[],
  revertMessageID: string,
): number {
  const markerIndex = messages.findIndex((message) => message.id === revertMessageID)
  if (markerIndex < 0) return -1
  const reverted = messages.slice(markerIndex).find((message) => userMessages.includes(message))
  return reverted ? userMessages.indexOf(reverted) : -1
}

function notifyMessageSent(sessionId: string): void {
  runtimeFetch(`/api/sessions/${sessionId}/message-sent`, { method: "POST" })
    .catch(() => { /* ignore */ })
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type NewSessionDraftTarget = "chat" | "project"

export type NewSessionDraftState = {
  draftId: number
  open: boolean
  selectedProjectId?: string | null
  directoryOverride: string | null
  /** Chosen with the composer's shield button; absent means the new session takes the default from Settings. */
  permissionMode?: PermissionMode
  pendingWorktreeRequestId?: string | null
  bootstrapPendingDirectory?: string | null
  /**
   * Composer discovery follows this folder; the target picker keeps the root.
   * A null directory means resolution is pending.
   */
  worktreeStartDirectory?: { worktreeRoot: string; directory: string | null } | null
  preserveDirectoryOverride?: boolean
  parentID: string | null
  title?: string
  initialPrompt?: string
  syntheticParts?: SyntheticContextPart[]
  targetFolderId?: string
  projectContextPins?: { notes: string[]; plans: string[] }
  target: NewSessionDraftTarget
  preparedChatDirectory?: string | null
  /**
   * The draft's id in the server's shared drafts, which the sidebar lists
   * once the user leaves it. Set for every opened draft; a draft reopened
   * from the sidebar carries the id it was saved under.
   */
  workDraftId?: string
}

export type SetCurrentSessionOptions = {
  /** The session materialized a submitted draft, which the chat announces as its own transition. */
  transition?: "submitted-draft"
  /** Launch restoration preserves the device's sidebar project selection. */
  keepSingleProject?: boolean
}

export type SessionUIState = {
  currentSessionId: string | null
  currentSessionDirectory: string | null
  currentSessionKeepsSingleProject: boolean
  materializedDraftSessionId: string | null
  /** First sends in flight, by the id of the session they create. */
  pendingDraftSends: ReadonlyMap<string, PendingDraftSend>
  newSessionDraft: NewSessionDraftState
  abortPromptSessionId: string | null
  abortPromptExpiresAt: number | null
  error: string | null
  worktreeMetadata: Map<string, WorktreeMetadata>
  availableWorktrees: WorktreeMetadata[]
  availableWorktreesByProject: Map<string, WorktreeMetadata[]>
  worktreeDiscoveryByProject: ReadonlyMap<string, 'loading' | 'ready' | 'error'>
  webUICreatedSessions: Set<string>
  sessionAbortFlags: Map<string, { timestamp: number; acknowledged: boolean }>
  abortControllers: Map<string, AbortController>
  isLoading: boolean
  lastLoadedDirectory: string | null
  // Non-Git mode: dismissed signature hash per session, hides bar until new turn arrives

  // Actions — UI state management
  setCurrentSession: (
    id: string | null,
    directoryHint?: string | null,
    options?: SetCurrentSessionOptions,
  ) => void
  clearMaterializedDraftSession: (sessionId: string) => void
  prepareForRuntimeSwitch: (apiBaseUrl?: string | null) => void
  restoreForRuntimeSwitch: (apiBaseUrl?: string | null, previousRuntimeKey?: string | null) => void
  openNewSessionDraft: (options?: Partial<NewSessionDraftState> & { automatic?: boolean }) => void
  prepareChatDraftDirectory: () => Promise<string | null>
  closeNewSessionDraft: () => void
  setNewSessionDraftTarget: (target: { projectId?: string | null; selectedProjectId?: string | null; directoryOverride?: string | null }, options?: { force?: boolean }) => void
  setDraftPreserveDirectoryOverride: (value: boolean) => void
  setDraftPermissionMode: (mode: PermissionMode) => void
  setDraftProjectContextPin: (kind: "note" | "plan", id: string, pinned: boolean) => void
  acknowledgeSessionAbort: (sessionId: string) => void
  clearAbortPrompt: () => void
  /** Arms "press Esc again to stop" for `sessionId`, the selected session by default. */
  armAbortPrompt: (durationMs?: number, sessionId?: string) => number | null
  clearError: () => void
  markSessionAsOpenChamberCreated: (sessionId: string) => void
  isOpenChamberCreatedSession: (sessionId: string) => boolean
  initializeNewOpenChamberSession: (sessionId: string, agents: unknown[]) => void
  /** `cwd` is where the session runs inside the checkout; it defaults to the worktree root. */
  setWorktreeMetadata: (sessionId: string, metadata: WorktreeMetadata | null, cwd?: string) => void
  overrideNewSessionDraftTarget: (options: Record<string, unknown>) => void
  resolvePendingDraftWorktreeTarget: (requestId: string, directory: string | null, options?: Record<string, unknown>) => void
  setDraftBootstrapPendingDirectory: (directory: string | null) => void
  setDraftWorktreeStartDirectory: (draftId: number, worktreeRoot: string, directory: string | null) => void
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
    /** `null` is an explicit `Default` thinking level. */
    variant?: string | null,
    inputMode?: "normal" | "shell",
    options?: SendMessageOptions,
  ) => Promise<void>

  createSession: (
    title?: string,
    directoryOverride?: string | null,
    metadata?: Metadata,
    selection?: SessionCreateSelection,
  ) => Promise<Session | null>
  deleteSession: (id: string, options?: DeleteSessionOptions) => Promise<boolean>
  deleteSessions: (ids: string[], options?: DeleteSessionsOptions) => Promise<{ deletedIds: string[]; failedIds: string[] }>
  archiveSession: (id: string) => Promise<boolean>
  archiveSessions: (ids: string[], options?: ArchiveSessionsOptions) => Promise<{ archivedIds: string[]; failedIds: string[] }>
  unarchiveSession: (id: string) => Promise<boolean>
  unarchiveSessions: (ids: string[], options?: UnarchiveSessionsOptions) => Promise<{ restoredIds: string[]; failedIds: string[] }>
  updateSessionTitle: (sessionId: string, title: string) => Promise<void>
  revertToMessage: (sessionId: string, messageId: string, options?: { skipRedoPush?: boolean }) => Promise<void>
  forkFromMessage: (sessionId: string, messageId: string) => Promise<void>
  forkAfterMessage: (sessionId: string, messageId: string) => Promise<void>
  handleSlashUndo: (sessionId: string) => Promise<void>
  handleSlashRedo: (sessionId: string) => Promise<void>
  createSessionFromAssistantMessage: (source: AssistantMessageSessionSource, execution: AssistantMessageSessionExecution) => Promise<void>

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

// `target` records which side of the composer's target selector the user last
// worked on, so a plain "new session" reopens there instead of always landing
// on Chat. Records written before this field existed carry no kind — they stay
// `null` and leave the Chat default in place rather than guessing one.
type PersistedDraftTarget = {
  projectId: string | null
  directory: string | null
  target: NewSessionDraftTarget | null
}

const readPersistedDraftTarget = (): PersistedDraftTarget | null => {
  try {
    const raw = safeStorage.getItem(DRAFT_TARGET_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { projectId?: unknown; directory?: unknown; target?: unknown }
    return {
      projectId: typeof parsed?.projectId === "string" ? parsed.projectId : null,
      directory: normalizePath(typeof parsed?.directory === "string" ? parsed.directory : null),
      target: parsed?.target === "chat" || parsed?.target === "project" ? parsed.target : null,
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
  // The sidebar can know this session before its directory store bootstraps.
  // Use that record's own directory before falling back to local routing hints.
  const globalSession = useGlobalSessionsStore.getState().entityById.get(sessionId)
  const globalDirectory = normalizePath(globalSession?.directory)
  if (globalDirectory) return globalDirectory
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
let admissionNavigationRevision = 0

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

const activateConfigForDirectory = async (
  directory: string | null | undefined,
  options?: { preserveManualModel?: boolean },
): Promise<void> => {
  await useConfigStore.getState().activateDirectory(normalizePath(directory), options)
}

const applyDraftTargetSelectionDefaults = (
  draft: NewSessionDraftState,
  availableWorktreesByProject: Map<string, WorktreeMetadata[]>,
  selectedProjectOverride?: {
    path?: string | null
    defaultAgent?: string | null
    defaultModel?: string | null
    defaultVariant?: string | null
  } | null,
  previousDraft?: NewSessionDraftState,
): void => {
  if (!draft.open) return
  const projects = useProjectsStore.getState().projects
  const selectedProject = draft.target !== "project"
    ? null
    : (selectedProjectOverride
      ?? (draft.selectedProjectId
        ? projects.find((project) => project.id === draft.selectedProjectId) ?? null
        : resolveDraftProjectForDirectory(
          projects,
          availableWorktreesByProject,
          normalizePath(draft.directoryOverride ?? null),
        )))

  const configDirectory = normalizePath(draft.directoryOverride ?? null)
    ?? normalizePath(selectedProject?.path ?? null)

  if (previousDraft?.open && previousDraft.draftId === draft.draftId && previousDraft.target === draft.target) {
    const previousProject = previousDraft.target !== 'project' ? null
      : projects.find((project) => project.id === previousDraft.selectedProjectId)
        ?? resolveDraftProjectForDirectory(projects, availableWorktreesByProject, normalizePath(previousDraft.directoryOverride ?? null))
    const previousConfigDirectory = normalizePath(previousDraft.directoryOverride ?? null)
      ?? normalizePath(previousProject?.path ?? null)
    if (previousConfigDirectory === configDirectory && draft.worktreeStartDirectory?.directory !== null) return
  }

  const runtimeKey = getRuntimeKey()
  const revision = ++draftDefaultsRevision
  const projectChanged = !previousDraft || previousDraft.target !== draft.target
    || previousDraft.selectedProjectId !== draft.selectedProjectId
  const applyDefaults = () => {
    if (!projectChanged) return
    const currentProject = selectedProject?.path
      ? useProjectsStore.getState().projects.find((project) => normalizePath(project.path) === normalizePath(selectedProject.path))
      : undefined
    useConfigStore.getState().applyDefaultModelAgentSelection({
      projectDefaultAgent: currentProject?.defaultAgent,
      projectDefaultModel: currentProject?.defaultModel,
      projectDefaultVariant: currentProject?.defaultVariant,
    })
  }
  const activationOptions = { preserveManualModel: !projectChanged && draft.target === 'project' }
  // The first session of a worktree starts in the project's OpenCode folder,
  // so the agents and models offered are the ones that folder's config defines.
  // The preview stays quiet: the send reports a fallback to the worktree root.
  const worktreeProject = projectOfWorktreeRoot(configDirectory, draft.selectedProjectId, availableWorktreesByProject)
  // Until the start folder resolves, the composer lists no commands for the root.
  if (configDirectory && worktreeProject) {
    useSessionUIStore.getState().setDraftWorktreeStartDirectory(draft.draftId, configDirectory, null)
  }
  const activation = configDirectory && worktreeProject
    // A worktree that failed to populate has no folder to read; its root is the fallback.
    ? resolveStartDirectory(worktreeProject, configDirectory).then(({ directory }) => directory, () => configDirectory).then(async (directory) => {
      const current = useSessionUIStore.getState()
      if (revision !== draftDefaultsRevision || getRuntimeKey() !== runtimeKey
        || !current.newSessionDraft.open || current.newSessionDraft.draftId !== draft.draftId) return
      useSessionUIStore.getState().setDraftWorktreeStartDirectory(draft.draftId, configDirectory, directory)
      await activateConfigForDirectory(directory, activationOptions)
    })
    : activateConfigForDirectory(configDirectory, activationOptions)
  applyDefaults()
  void activation.then(() => {
    const current = useSessionUIStore.getState()
    if (revision !== draftDefaultsRevision || getRuntimeKey() !== runtimeKey
      || current.currentSessionId || !current.newSessionDraft.open
      || current.newSessionDraft.draftId !== draft.draftId
      || current.newSessionDraft.target !== draft.target
      || current.newSessionDraft.selectedProjectId !== draft.selectedProjectId
      || useConfigStore.getState().selectionSource === 'manual'
      || useConfigStore.getState().agentSelectionSource === 'manual'
      || useConfigStore.getState().currentVariantSelection.override !== undefined) return
    applyDefaults()
  })
}

let draftDefaultsRevision = 0

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

/**
 * A session's first send, from Enter in its draft until the request that
 * starts the turn has left. The chat already shows the session; while
 * `sessionCreated` is false the server has not answered its creation yet.
 */
export type PendingDraftSend = {
  draftId: number
  sessionCreated: boolean
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
  // A space runs its setup commands itself, and its creation holds the first message for them.
  if (!directory || isSpaceDirectory(directory)) return
  const project = resolveProjectRefForWorktreeDirectory(directory, projectId)
  if (project && await getWorktreeSetupWaitEnabled(project)) {
    await waitForWorktreeBootstrap(directory)
  }
}

/**
 * The project of a draft aimed at a worktree's root, or null for any other
 * directory, such as a project root or a folder already inside a worktree.
 * Only a worktree's root starts in the project's configured OpenCode folder.
 */
const projectOfWorktreeRoot = (
  directory: string | null,
  projectId: string | null | undefined,
  availableWorktreesByProject: ReadonlyMap<string, readonly WorktreeMetadata[]>,
): { id: string; path: string } | null => {
  if (!directory) return null
  const target = normalizePath(directory)
  const isWorktreeRoot = [...availableWorktreesByProject.values()]
    .some((worktrees) => worktrees.some((worktree) => normalizePath(worktree.path) === target))
  return isWorktreeRoot ? resolveProjectRefForWorktreeDirectory(directory, projectId) : null
}

/** Where the draft's first session starts; a fallback to the worktree root is reported to the user. */
const resolveDraftStartDirectory = async (directory: string | null, projectId?: string | null): Promise<string | null> => {
  const project = projectOfWorktreeRoot(directory, projectId, useSessionUIStore.getState().availableWorktreesByProject)
  return directory && project ? resolveWorktreeStartDirectory(project, directory) : directory
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
 * Whether `directory` is a remembered target of an implicit draft, which the
 * draft may leave for the active project when it turns out to be gone. A
 * space's directory exists inside the space only: the host's probe would
 * call it missing and start the chat in the project.
 */
const isRecoverableDraftDirectory = (draft: NewSessionDraftState, directory: string | null): directory is string =>
  Boolean(directory)
  && draft.open
  && draft.preserveDirectoryOverride !== true
  && !isSpaceDirectory(directory)
  && !draft.pendingWorktreeRequestId
  && !draft.bootstrapPendingDirectory
  && normalizePath(draft.directoryOverride) === normalizePath(directory)

/**
 * `directory`, or the active project's when the directory the implicit draft
 * remembered is confirmed gone (a deleted worktree). For a draft that is
 * already a session on screen: the probe's answer cannot be outrun by a
 * change to the draft, so none is checked for.
 */
const recoverMissingDraftDirectory = async (draft: NewSessionDraftState, directory: string | null): Promise<string | null> => {
  if (!isRecoverableDraftDirectory(draft, directory)) return directory
  const activeProjectDirectory = resolveActiveProjectDirectory(draft)
  if (!activeProjectDirectory || normalizePath(directory) === activeProjectDirectory) return directory
  const availability = await opencodeClient.getDirectoryAvailability(directory)
  return availability === "missing" ? activeProjectDirectory : directory
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
  if (!isRecoverableDraftDirectory(draft, directory)) {
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
  // A managed Chat deliberately has no project directory. Its live directory
  // may still point at an unregistered external path, which is not a stale
  // project target for this recovery to repair.
  if (openedDraft.target !== "project") return

  const resolved = await resolveCreatableDraftDirectory(openedDraft, openedDraft.directoryOverride)
  if (resolved.status !== "ok") return
  const recovered = normalizePath(resolved.directory ?? null)
  const original = normalizePath(openedDraft.directoryOverride)
  if (!recovered || recovered === original) return

  const currentDraft = useSessionUIStore.getState().newSessionDraft
  if (!currentDraft.open) return
  if (currentDraft.target !== "project") return
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
  persistDraftTarget({ projectId: nextDraft.selectedProjectId ?? null, directory: recovered, target: nextDraft.target })
  void activateConfigForDirectory(recovered)
}

const createSessionWithDraftLifecycle = async (
  title?: string,
  directoryOverride?: string | null,
  metadata?: Metadata,
  selectionTransition?: "submitted-draft",
  selection?: SessionCreateSelection,
): Promise<Session | null> => {
  const store = useSessionUIStore.getState()
  const draft = store.newSessionDraft
  const targetFolderId = draft.targetFolderId

  try {
    const resolved = await resolveCreatableDraftDirectory(draft, directoryOverride)
    if (resolved.status === "aborted") return null
    const directory = resolved.directory
    const session = await createSessionAction(title, directory, metadata, selectionTransition, selection)
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

/**
 * The effort a send should record for its session.
 *
 * A send carries `undefined` both when no effort was ever chosen and when the
 * user explicitly picked "Default", so the sent value alone cannot tell the two
 * apart, and recording it raw clears a real "Default". The live selection can
 * tell them apart, because its `override` keeps `null` for "Default" — but only
 * while it still describes the agent and model being sent to. Otherwise the
 * send's own value is all there is to go on.
 */
const resolveVariantToRecord = (
  agentName: string | undefined,
  providerID: string,
  modelID: string,
  sentVariant: string | null | undefined,
): string | null | undefined => {
  const config = useConfigStore.getState()
  const describesThisSend = config.currentProviderId === providerID
    && config.currentModelId === modelID
    && config.currentAgentName === agentName
  return describesThisSend ? config.currentVariantSelection.override : sentVariant
}

type DraftSessionSelection = {
  providerID: string
  modelID: string
  agent?: string
  /** `null` is an explicit `Default` thinking level. */
  variant?: string | null
}

const trimAgent = (agent: string | undefined): string | undefined => (
  typeof agent === "string" && agent.trim().length > 0 ? agent.trim() : undefined
)

/** The model and agent a draft's session is created on, so the first send needs no switch (which v2 would record in the transcript). */
const draftSessionCreateSelection = (selection: DraftSessionSelection): SessionCreateSelection => ({
  model: { providerID: selection.providerID, id: selection.modelID, variant: selection.variant },
  agent: trimAgent(selection.agent),
})

const draftSessionMetadata = (draft: NewSessionDraftState): Metadata | undefined => {
  const draftPins = draft.projectContextPins ?? { notes: [], plans: [] }
  return draftPins.notes.length > 0 || draftPins.plans.length > 0
    ? { openchamber: { project_context_pins: draftPins } }
    : undefined
}

/**
 * The directory a draft's session is shown in from its first message on: known
 * once a worktree still being made exists and a chat's folder is prepared.
 * Where the server creates the session can still differ, see
 * `resolveDraftCreateDirectory`.
 */
const resolveDraftTargetDirectory = async (draft: NewSessionDraftState): Promise<string | null> => {
  const store = useSessionUIStore.getState()
  let directory = draft.bootstrapPendingDirectory ?? draft.directoryOverride ?? null

  if (draft.pendingWorktreeRequestId) {
    const requestId = draft.pendingWorktreeRequestId
    noteDraftSendWaiting(requestId, true)
    try {
      directory = await waitForPendingDraftWorktreeRequest(requestId)
    } finally {
      noteDraftSendWaiting(requestId, false)
    }
    store.resolvePendingDraftWorktreeTarget(requestId, directory)
  }

  if (draft.target === "chat") {
    directory = await store.prepareChatDraftDirectory()
    if (!directory) throw new Error("Failed to prepare chat directory")
    // The folder is the session's now: closing the draft must not remove it.
    const currentDraft = useSessionUIStore.getState().newSessionDraft
    if (currentDraft.draftId === draft.draftId) {
      useSessionUIStore.setState({
        newSessionDraft: { ...currentDraft, preparedChatDirectory: null },
      })
    }
  }

  return directory
}

/**
 * Where the server creates a draft's session, after the waits that need no
 * open draft: a worktree's setup commands, the project's start folder inside
 * a worktree, and the probe that moves an implicit draft off a deleted
 * directory. Reads the project's setup over the network, so it runs while
 * the first message is already on screen.
 */
const resolveDraftCreateDirectory = async (draft: NewSessionDraftState, directory: string | null): Promise<string | null> => {
  const draftProjectId = draft.selectedProjectId ?? null
  await waitForWorktreeBootstrapIfConfigured(directory, draftProjectId)
  const startDirectory = await resolveDraftStartDirectory(directory, draftProjectId)
  return recoverMissingDraftDirectory(draft, startDirectory)
}

/**
 * Where the draft's session will live, once every wait before its creation
 * is over, for a caller that keeps the draft open until then.
 */
const resolveDraftSessionDirectory = async (
  draft: NewSessionDraftState,
  chatDirectoryCleanup: CapturedChatDirectoryCleanup | null,
): Promise<string | null | undefined> => {
  const draftProjectId = draft.selectedProjectId ?? null
  let directory = await resolveDraftTargetDirectory(draft)
  await waitForWorktreeBootstrapIfConfigured(directory, draftProjectId)
  directory = await resolveDraftStartDirectory(directory, draftProjectId)
  const resolved = await resolveCreatableDraftDirectory(draft, directory)
  if (resolved.status === "aborted") {
    if (draft.target === "chat") await deletePreparedChatDirectory(directory, chatDirectoryCleanup)
    throw new Error("Failed to create session")
  }
  return resolved.directory
}

/**
 * Records what the session created from `draft` carries, once the server has
 * it, and answers the directory the server put it in. The response is
 * authoritative: it may canonicalize a requested worktree path (through a
 * symlink or platform path casing), and sending with the pre-canonical path
 * can target a different directory scope than the session itself.
 */
const finishDraftSession = (
  draft: NewSessionDraftState,
  created: Session,
  requestedDirectory: string | null | undefined,
): string | null => {
  const isChatDraft = draft.target === "chat"
  const createdDirectory = normalizePath(created.directory ?? requestedDirectory ?? null)

  // A chat started while the Chats section is hidden would be listed nowhere
  // in the sidebar, so starting one brings the section back.
  if (isChatDraft && !useSessionDisplayStore.getState().showChatsSection) {
    useSessionDisplayStore.getState().setShowChatsSection(true)
    void import("@/lib/persistence")
      .then(({ updateDesktopSettings }) => updateDesktopSettings({ sidebarShowChatsSection: true }))
      .catch((error) => {
        console.warn("Failed to save the shown Chats section:", error)
      })
  }

  persistDraftTarget({
    projectId: draft.selectedProjectId ?? null,
    directory: createdDirectory,
    target: draft.target,
  })

  void activateConfigForDirectory(createdDirectory).catch((error) => {
    console.warn("Failed to activate directory after creating session:", error)
  })

  const permissionMode = permissionModeForNewSession(
    draft.permissionMode,
    isSpaceDirectory(createdDirectory),
    useUIStore.getState().permissionDefaultMode,
  )
  if (permissionMode) {
    void import("@/stores/permissionStore")
      .then(({ usePermissionStore }) => usePermissionStore.getState().setSessionMode(created.id, permissionMode))
      .catch((error) => {
        console.warn("Failed to apply the draft permission mode to the new session:", error)
      })
  }

  if (draft.targetFolderId) {
    const scopeDirectory = requestedDirectory || useSessionUIStore.getState().lastLoadedDirectory || created.directory
    const scopeKey = getChatsRootFromDirectory(scopeDirectory) ?? scopeDirectory
    if (scopeKey) {
      useSessionFoldersStore.getState().addSessionToFolder(scopeKey, draft.targetFolderId, created.id)
    }
  }

  return createdDirectory
}

/** Saves the selection a draft's session starts on under its id; answers the agent the first send runs on. */
const saveDraftSessionSelection = (sessionId: string, selection: DraftSessionSelection): string | undefined => {
  const configState = useConfigStore.getState()
  const effectiveDraftAgent = trimAgent(selection.agent) ?? configState.currentAgentName
  const variantOverride = resolveVariantToRecord(
    effectiveDraftAgent,
    selection.providerID,
    selection.modelID,
    selection.variant,
  )

  useSelectionStore.getState().saveSessionModelSelection(sessionId, selection.providerID, selection.modelID)

  if (effectiveDraftAgent) {
    useSelectionStore.getState().saveSessionAgentSelection(sessionId, effectiveDraftAgent)
    if (configState.selectionSource === "manual") {
      useSelectionStore.getState().saveAgentModelForSession(sessionId, effectiveDraftAgent, selection.providerID, selection.modelID)
    }
    useSelectionStore.getState().saveAgentModelVariantForSession(sessionId, effectiveDraftAgent, selection.providerID, selection.modelID, variantOverride)
  }

  useSessionUIStore.getState().initializeNewOpenChamberSession(sessionId, configState.agents ?? [])
  return effectiveDraftAgent
}

type CapturedChatDirectoryCleanup = (directory: string) => Promise<void>

/**
 * Capture the folder's owner before preparation can yield to a runtime switch.
 */
const captureChatDirectoryCleanup = async (
  target: NewSessionDraftState["target"],
  expectedRuntimeKey: string,
): Promise<CapturedChatDirectoryCleanup | null> => {
  return target === "chat" ? captureChatCleanup(expectedRuntimeKey) : null
}

/**
 * Only the captured owner may remove a folder prepared by this operation.
 */
const deletePreparedChatDirectory = async (
  directory: string | null | undefined,
  cleanup: CapturedChatDirectoryCleanup | null,
): Promise<void> => {
  if (!directory) return
  await cleanup?.(directory)
}

export async function materializeOpenDraftSession(
  selection: DraftSessionSelection,
  draftOverride?: NewSessionDraftState,
  expectedRuntimeKey = getRuntimeKey(),
): Promise<MaterializedDraftSession | null> {
  const draft = draftOverride ?? useSessionUIStore.getState().newSessionDraft
  if (!draft?.open) return null
  const assertRuntimeCurrent = () => {
    if (getRuntimeKey() !== expectedRuntimeKey) throw new Error("Message was not sent because the runtime changed.")
  }
  assertRuntimeCurrent()
  const chatDirectoryCleanup = await captureChatDirectoryCleanup(draft.target, expectedRuntimeKey)
  assertRuntimeCurrent()

  const directory = await resolveDraftSessionDirectory(draft, chatDirectoryCleanup)
  if (getRuntimeKey() !== expectedRuntimeKey) {
    if (draft.target === "chat") await deletePreparedChatDirectory(directory, chatDirectoryCleanup)
    assertRuntimeCurrent()
  }
  const created = await createSessionAction(
    draft.title,
    directory,
    draftSessionMetadata(draft),
    "submitted-draft",
    draftSessionCreateSelection(selection),
    "open",
    undefined,
    expectedRuntimeKey,
  )
  if (!created?.id) {
    if (draft.target === "chat") await deletePreparedChatDirectory(directory, chatDirectoryCleanup)
    assertRuntimeCurrent()
    throw new Error("Failed to create session")
  }
  assertRuntimeCurrent()
  useSessionUIStore.getState().closeNewSessionDraft()

  const createdDirectory = finishDraftSession(draft, created, directory)
  const agent = saveDraftSessionSelection(created.id, selection)

  return {
    sessionId: created.id,
    directory: createdDirectory,
    agent,
    syntheticParts: draft.syntheticParts,
  }
}

/**
 * A send from a draft that failed, and where its text belongs now: the
 * session, when the server created it before the send failed, or the draft,
 * which is open again.
 */
export class DraftSendError extends Error {
  constructor(
    readonly sessionId: string,
    readonly directory: string,
    readonly sessionCreated: boolean,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = "DraftSendError"
  }
}

// A draft is sent once. Its id joins here when its send starts and leaves only
// when that send fails before the session exists, so the user can try again.
const sentDraftIds = new Set<number>()

const setPendingDraftSend = (sessionId: string, state: PendingDraftSend | null): void => {
  useSessionUIStore.setState((current) => {
    if (state === null && !current.pendingDraftSends.has(sessionId)) return current
    const next = new Map(current.pendingDraftSends)
    if (state === null) next.delete(sessionId)
    else next.set(sessionId, state)
    return { pendingDraftSends: next }
  })
}

/**
 * The server did not create the session: the chat shows the draft again,
 * where the composer gets the text back. A user who moved on meanwhile is
 * left where they are; their draft stays listed for a return.
 */
const reopenDraftAfterFailedCreation = (
  draft: NewSessionDraftState,
  sessionId: string,
  directory: string,
  runtimeKey: string,
): void => {
  sentDraftIds.delete(draft.draftId)
  // A worktree the draft waited for exists by now and its request is settled,
  // so the draft reopens on that directory; a chat prepares a new folder.
  const reopened: NewSessionDraftState = {
    ...draft,
    preparedChatDirectory: null,
    pendingWorktreeRequestId: null,
    directoryOverride: draft.target === "chat" ? draft.directoryOverride : directory,
  }
  if (getRuntimeKey() !== runtimeKey) {
    // The composer moved to another runtime: the captured one keeps the open
    // draft and forgets the empty session, so switching back shows the text
    // instead of a session that was never created. A draft or session the
    // user opened after sending stays as it is.
    const capturedKey = runtimeMemoryKey(runtimeKey)
    const capturedMemory = runtimeSessionMemory.get(capturedKey)
    if (capturedMemory && capturedMemory.sessionId !== sessionId) return
    writeRuntimeSessionMemory(capturedKey, {
      sessionId: null,
      directory: reopened.directoryOverride ?? null,
      draft: reopened,
    })
    activeSessionByRuntime.set(capturedKey, null)
    clearLastActiveSession(capturedKey)
    return
  }
  const store = useSessionUIStore.getState()
  if (store.currentSessionId !== sessionId) return
  store.setCurrentSession(null, reopened.directoryOverride)
  useSessionUIStore.setState({ newSessionDraft: reopened })
  writeRuntimeSessionMemory(runtimeMemoryKey(), { sessionId: null, directory: reopened.directoryOverride ?? null, draft: reopened })
  clearLastActiveSession(runtimeMemoryKey())
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
  currentSessionKeepsSingleProject: false,
  materializedDraftSessionId: null,
  pendingDraftSends: new Map(),
  newSessionDraft: { ...DEFAULT_DRAFT },
  abortPromptSessionId: null,
  abortPromptExpiresAt: null,
  error: null,
  worktreeMetadata: new Map(),
  availableWorktrees: flattenWorktreeMap(PERSISTED_WORKTREE_MAP),
  availableWorktreesByProject: PERSISTED_WORKTREE_MAP,
  worktreeDiscoveryByProject: new Map(),
  webUICreatedSessions: new Set(),
  sessionAbortFlags: new Map(),
  abortControllers: new Map(),
  isLoading: false,
  lastLoadedDirectory: null,

  // ---------------------------------------------------------------------------
  // setCurrentSession
  // ---------------------------------------------------------------------------
  setCurrentSession: (id, directoryHint?: string | null, options?: SetCurrentSessionOptions) => {
    const navigationRevision = ++admissionNavigationRevision
    if (id) {
      const record = useGlobalSessionsStore.getState().entityById.get(id)
      const directory = (record ? resolveGlobalSessionDirectory(record) : null)
        ?? resolveSessionDirectory(id, (sid) => get().worktreeMetadata.get(sid))
        ?? normalizePath(directoryHint)
      if (!directory || !isSessionAdmitted(directory)) {
        const runtimeKey = getRuntimeKey()
        const stillSelected = () => navigationRevision === admissionNavigationRevision && runtimeKey === getRuntimeKey()
        void (async () => {
          // Session detail starts no OpenCode location. Resolve unknown links
          // before trusting any fallback to the currently selected project.
          const destination = directory ?? resolveGlobalSessionDirectory(await opencodeClient.getSession(id))
          if (!destination || !stillSelected() || !await admitSession(id, destination, true) || !stillSelected()) return
          get().setCurrentSession(id, destination, options)
        })().catch((error) => console.warn('[session-admission] Could not open the session:', error))
        return
      }
      directoryHint = directory
    }
    const materializedDraftSessionId = id && options?.transition === "submitted-draft" ? id : null
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
      currentSessionKeepsSingleProject: Boolean(id && options?.keepSingleProject),
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
      if (id && !isGuessedDir && sessionProject && !options?.keepSingleProject) {
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
    } else {
      setActiveSession("", "")
    }
  },

  clearMaterializedDraftSession: (sessionId) => {
    if (get().materializedDraftSessionId !== sessionId) return
    set({ materializedDraftSessionId: null })
  },

  prepareForRuntimeSwitch: (apiBaseUrl?: string | null) => {
    draftDefaultsRevision += 1
    const key = runtimeMemoryKey(apiBaseUrl)
    // Not remembered: an unknown directory, which would pin the host to "/"
    // when restored, and anything under a key that names no host.
    const directoryState = useDirectoryStore.getState()
    const directory = isTransientRuntimeKey(key) || isDirectoryUnknown(directoryState)
      ? null
      : directoryState.currentDirectory || null
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

  restoreForRuntimeSwitch: (apiBaseUrl?: string | null, previousRuntimeKey?: string | null) => {
    const key = runtimeMemoryKey(apiBaseUrl)
    const memory = runtimeSessionMemory.get(key)
    const restoredSessionId = memory?.sessionId ?? activeSessionByRuntime.get(key) ?? null
    const restoredDraft = memory?.draft ? cloneDraft(memory.draft) : { ...DEFAULT_DRAFT }
    const restoredDirectory = memory?.directory ?? null
    const availableWorktreesByProject = memory?.availableWorktreesByProject
      ?? readPersistedWorktreeTopology(key)
    const admitted = restoredSessionId && isSessionDirectoryAdmitted(restoredDirectory, useProjectsStore.getState().projects, availableWorktreesByProject)
    if (restoredDirectory && (!restoredSessionId || admitted)) {
      useDirectoryStore.getState().setDirectory(restoredDirectory, { showOverlay: false })
    } else if (previousRuntimeKey && previousRuntimeKey !== key && !isTransientRuntimeKey(previousRuntimeKey)) {
      // Nothing is remembered here and the directory was in use on the host
      // just left, so it is forgotten instead of carried over. Coming from no
      // host (a cold launch that connects through a switch) the directory is
      // the one this window started with and stays.
      useDirectoryStore.getState().resetForRuntimeSwitch()
    }
    set({
      currentSessionId: admitted ? restoredSessionId : null,
      currentSessionDirectory: admitted ? restoredDirectory : null,
      currentSessionKeepsSingleProject: false,
      newSessionDraft: restoredSessionId ? { ...DEFAULT_DRAFT } : restoredDraft,
      abortPromptSessionId: null,
      abortPromptExpiresAt: null,
      error: null,
      worktreeMetadata: memory?.worktreeMetadata ?? new Map(),
      availableWorktrees: flattenWorktreeMap(availableWorktreesByProject),
      availableWorktreesByProject,
      sessionAbortFlags: new Map(),
        })
    if (admitted) {
      setActiveSession(restoredDirectory ?? opencodeClient.getDirectory() ?? "", restoredSessionId)
    } else {
      setActiveSession("", "")
      if (!restoredSessionId && restoredDraft.open && restoredDraft.worktreeStartDirectory?.directory === null) {
        applyDraftTargetSelectionDefaults(restoredDraft, availableWorktreesByProject, undefined, restoredDraft)
      }
      if (restoredSessionId) get().setCurrentSession(restoredSessionId, restoredDirectory)
    }
  },

  // ---------------------------------------------------------------------------
  // openNewSessionDraft
  // ---------------------------------------------------------------------------


  openNewSessionDraft: (options) => {
    if (!options?.automatic) admissionNavigationRevision += 1
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

    // Callers that forward "the current session's directory" forward it for
    // chat sessions too, and a chat session's scratch directory names no
    // project. Treating it as an explicit project target would force a project
    // draft rooted in scratch; it is a request for another chat. The archive
    // directory of a deleted isolated space is the same: a chat opened from
    // the Archive page leaves it behind as the current one, and a draft rooted
    // there would make a live session inside the archive.
    const isScratchDirectory = (directory: string): boolean => isChatDirectoryPath(directory) || isSpaceArchiveDirectory(directory)
    const rawExplicitDirectory = options?.directoryOverride !== undefined
      ? normalizePath(options.directoryOverride)
      : null
    const explicitDirectoryIsChat = rawExplicitDirectory !== null && isScratchDirectory(rawExplicitDirectory)
    const explicitDirectory = explicitDirectoryIsChat ? null : rawExplicitDirectory
    const persistedProjectById = persistedTarget?.projectId
      ? projects.find((p) => p.id === persistedTarget.projectId) ?? null
      : null
    const persistedProjectByDir = resolveDraftProjectForDirectory(projects, availableWorktreesByProject, persistedTarget?.directory ?? null)
    const currentDirProject = resolveDraftProjectForDirectory(projects, availableWorktreesByProject, currentDirectory)
    // A user-initiated implicit open from an external path outside every
    // project is a Chat for this draft: forcing the live path into a project
    // draft is wrong, and the live location is not a target choice that should
    // erase the project the user last picked. A managed chat scratch directory
    // is not external; the recorded project still reopens from it.
    const isImplicitExternalChatFallback = currentDirectory !== null
      && !isScratchDirectory(currentDirectory)
      && currentDirProject === null
      && options?.automatic !== true
      && options?.target === undefined
      && options?.directoryOverride === undefined
      && options?.selectedProjectId === undefined
    const persistedProject = persistedProjectById ?? persistedProjectByDir

    // Nothing explicit was asked for: reopen on the side the user last worked
    // on. Only a recorded project target that still resolves to an existing
    // project beats Chat — a project removed since must not open a draft
    // pointing at a directory that is no longer registered — and the live
    // directory must not itself be an unregistered external path.
    const restoresProjectTarget = !isVSCodeRuntime()
      && !options?.target
      && options?.directoryOverride === undefined
      && options?.selectedProjectId === undefined
      && persistedTarget?.target === "project"
      && persistedProject !== null
      && !isImplicitExternalChatFallback

    let target = isVSCodeRuntime()
      ? isVSCodeWithoutWorkspace() ? "chat" : "project"
      : options?.target
    if (!target) {
      const hasExplicitProjectTarget = (options?.directoryOverride !== undefined && !explicitDirectoryIsChat)
        || (options?.selectedProjectId !== undefined && options.selectedProjectId !== CHAT_DRAFT_PROJECT_ID)
        || isVSCodeRuntime()
      target = options?.selectedProjectId === CHAT_DRAFT_PROJECT_ID
        ? "chat"
        : hasExplicitProjectTarget || restoresProjectTarget
          ? "project"
          : "chat"
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

    const selectedProject = target === "chat" ? null : (() => {
      if (explicitProject) return explicitProject
      if (explicitDirectory !== null) return inferredProjectFromDir
      // A chat session leaves a managed scratch directory behind as the current
      // one; it owns no project, so it must not decide this draft's project —
      // the recorded target below knows which project the user last chose.
      if (currentDirectory && !isScratchDirectory(currentDirectory)) return currentDirProject
      return persistedProject ?? fallbackProject
    })()

    // A space that cannot take a new session (its making failed, its container
    // is gone, its machine is out of reach) is no place to reopen a draft in:
    // the draft goes to the project root instead.
    const keepsDraft = (dir: string): boolean => !isScratchDirectory(dir) && !isSpaceDirectoryClosedToNewSessions(dir)
    const directory = target === "chat" ? null : (() => {
      if (explicitDirectory !== null) return explicitDirectory
      if (explicitProject) return normalizePath(explicitProject.path ?? null)
      // A chat session's directory is a managed scratch folder, never a
      // project: letting it through would open a project draft rooted in it.
      if (currentDirectory && keepsDraft(currentDirectory)) return currentDirectory
      if (persistedTarget?.directory && keepsDraft(persistedTarget.directory)) return persistedTarget.directory
      return normalizePath(selectedProject?.path ?? null)
    })()

    if (target === "chat") {
      warmChatsRootDirectory()
    }

    // An unregistered live path falls back to managed Chat for this draft, but
    // it is not a user choice that should discard the recorded project target.
    if (!(target === "chat" && isImplicitExternalChatFallback)) {
      persistDraftTarget({ projectId: selectedProject?.id ?? null, directory, target })
    }

    const nextDraft: NewSessionDraftState = {
      draftId: nextDraftId++,
      workDraftId: options?.workDraftId ?? createSessionDraftId(),
      open: true,
      target,
      preparedChatDirectory: null,
      selectedProjectId: selectedProject?.id ?? null,
      directoryOverride: directory,
      pendingWorktreeRequestId: options?.pendingWorktreeRequestId ?? null,
      bootstrapPendingDirectory: normalizePath(options?.bootstrapPendingDirectory ?? null),
      // A draft in a space is pinned wherever it opens from (a saved draft's
      // row, a restore): the space is not listed until its journey is read.
      preserveDirectoryOverride: options?.preserveDirectoryOverride === true || isSpaceDirectory(directory),
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
      currentSessionKeepsSingleProject: false,
      error: null,
    })

    writeRuntimeSessionMemory(runtimeMemoryKey(), { sessionId: null, directory, draft: nextDraft })
    if (options?.initialPrompt) {
      useInputStore.getState().setPendingInputText(options.initialPrompt)
    }

    // Config (providers/agents/default model+agent) lives at the PROJECT level. When the user
    // came from a worktree session, `directory` is the worktree path, whose provider list does
    // not include project/global-scoped providers (e.g. the default agent's non-opencode model)
    // — resolving defaults against it would wrongly fall back to opencode/big-pickle. Activate
    // the project's config instead so the default cascade matches app startup, then re-apply it
    // (a fresh draft must start from defaults, not inherit the previous session's selection).
    applyDraftTargetSelectionDefaults(nextDraft, availableWorktreesByProject, selectedProject)

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

    const pending = (async () => {
      const cleanup = await captureChatDirectoryCleanup("chat", runtimeKey)
      if (getRuntimeKey() !== runtimeKey) return null
      const directory = await createChatDirectory()
      const current = get().newSessionDraft
      if (
        getRuntimeKey() !== runtimeKey
        || !current.open
        || current.target !== "chat"
        || current.draftId !== draft.draftId
      ) {
        await deletePreparedChatDirectory(directory, cleanup)
        return null
      }
      set({ newSessionDraft: { ...current, preparedChatDirectory: directory } })
      return directory
    })().finally(() => {
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
      && currentDraft.permissionMode === undefined
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
    if (isVSCodeRuntime() && !isVSCodeWithoutWorkspace() && target.projectId === CHAT_DRAFT_PROJECT_ID) return
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

    applyDraftTargetSelectionDefaults(get().newSessionDraft, get().availableWorktreesByProject, undefined, previousDraft)

    const nextDraft = get().newSessionDraft
    // Persist the chosen draft target so reopening the composer restores the
    // last side the user worked on.
    persistDraftTarget({
      projectId: nextDraft.target === "chat" ? null : nextDraft.selectedProjectId ?? null,
      directory: normalizePath(nextDraft.directoryOverride ?? null),
      target: nextDraft.target,
    })

    if (nextDirectory && nextDirectory !== useDirectoryStore.getState().currentDirectory) {
      useDirectoryStore.getState().setDirectory(nextDirectory)
    }
  },

  setDraftPreserveDirectoryOverride: (value) =>
    set((s) => {
      if (!s.newSessionDraft?.open) return s
      return { newSessionDraft: { ...s.newSessionDraft, preserveDirectoryOverride: value } }
    }),

  setDraftPermissionMode: (mode) =>
    set((s) => {
      if (!s.newSessionDraft?.open) return s
      return { newSessionDraft: { ...s.newSessionDraft, permissionMode: mode } }
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

  armAbortPrompt: (durationMs = 5000, sessionId) => {
    const target = sessionId ?? get().currentSessionId
    if (!target) return null
    const expiresAt = Date.now() + durationMs
    set({ abortPromptSessionId: target, abortPromptExpiresAt: expiresAt })
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

  initializeNewOpenChamberSession: () => {
    // Stub — was a no-op in old store
  },

  setWorktreeMetadata: (sessionId, metadata, cwd) => {
    // Write to authoritative session-worktree-store
    if (metadata) {
      useSessionWorktreeStore.getState().setAttachment(sessionId, {
        worktreeRoot: metadata.worktreeRoot ?? metadata.path ?? null,
        cwd: cwd ?? metadata.path ?? null,
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
    const previousDraft = get().newSessionDraft
    let nextDirectory: string | null = null
    set((s) => {
      const nextDraft = { ...s.newSessionDraft, ...options }
      nextDirectory = normalizePath(
        typeof nextDraft.directoryOverride === "string" ? nextDraft.directoryOverride : null,
      )
      return { newSessionDraft: nextDraft }
    })
    applyDraftTargetSelectionDefaults(get().newSessionDraft, get().availableWorktreesByProject, undefined, previousDraft)

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

  setDraftWorktreeStartDirectory: (draftId, worktreeRoot, directory) =>
    set((s) => {
      if (!s.newSessionDraft?.open || s.newSessionDraft.draftId !== draftId) return s
      return { newSessionDraft: { ...s.newSessionDraft, worktreeStartDirectory: { worktreeRoot, directory } } }
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
    /** `null` is an explicit `Default` thinking level. */
    variant?: string | null,
    inputMode?: "normal" | "shell",
    options?: SendMessageOptions,
  ) => {
    const capturedTarget = options?.target
    const capturedRuntimeKey = capturedTarget?.runtimeKey ?? getRuntimeKey()
    if (capturedTarget && capturedTarget.runtimeKey !== getRuntimeKey()) {
      throw new Error("Message was not sent because the runtime changed.")
    }
    // A message sent while OpenCode is still starting waits for it here, ahead
    // of session creation, commands and shell, all of which need OpenCode.
    // Held sends go out one after another, in the order they were made.
    return runAfterOpenCodeStartup(async () => {
      const draft = options?.draftSnapshot ?? get().newSessionDraft
      const trimmedAgent = typeof agent === "string" && agent.trim().length > 0 ? agent.trim() : undefined
      if (capturedRuntimeKey !== getRuntimeKey()) {
        throw new Error("Message was not sent because the runtime changed.")
      }
      // The style goes into the session's instructions right before the send,
      // so a send carries the setting as it is now. The read runs alongside
      // the send: the message appears without waiting for it, only the prompt
      // request does.
      const responseStyleInstruction = inputMode === "shell"
        ? undefined
        : fetchResponseStyleInstruction().catch(() => undefined)

      const queuedGoal = options?.queuedGoal
      const goalArm = inputMode === "shell" || content.trim().length === 0
        ? { armed: false, objectiveOverride: null }
        : queuedGoal !== undefined
          ? { armed: queuedGoal !== null, objectiveOverride: queuedGoal?.objective ?? null }
          : useSessionGoalArmStore.getState().consume()
      const goalArmed = goalArm.armed
      // A queued goal keeps the budget it was queued with.
      const goalUiState = useUIStore.getState()
      const goalTokenBudget = queuedGoal
        ? queuedGoal.tokenBudget
        : (goalUiState.sessionGoalDefaultBudgetEnabled ? goalUiState.sessionGoalDefaultBudget : null)
      if (goalArmed) {
        // Teach the agent the goal protocol from turn one — without this it
        // only learns about goal mode from the first server continuation.
        const budgetLine = goalTokenBudget
          ? ` A token budget of ${goalTokenBudget} tokens applies to this goal.`
          : ""
        const goalIntro = wrapSystemReminder(
          "Goal mode is active for this session. The user message above defines the goal objective. "
          + "Work toward it across turns; whenever you stop before the objective is verifiably complete, the system will automatically prompt you to continue."
          + budgetLine
          // Same text as GOAL_REPORT_INSTRUCTIONS in the server's session-goal/audit.js.
          + "\n\nBefore you end a turn, stop every background command you started that does not finish on its own, such as a dev server or a watcher. Start it again in a later turn if you need it.\n"
          + "\nProgress is checked independently after each turn, from your final message only. End every turn with a short status block, in the language of your reply, with exactly these four lines:\n"
          + "- Done: what is finished.\n"
          + "- Verified: how you checked it (the command, test or file), or \"not verified\".\n"
          + "- Remaining: the parts of the objective you still have to do yourself, or \"nothing\".\n"
          + "- Needs from the user: what only the user can provide before you can go on (a decision, credentials, access), or \"nothing\".\n"
          + "Testing in the app, review and committing are the user's steps after the work, not remaining work and not blockers.",
        )
        additionalParts = [...(additionalParts ?? []), { text: goalIntro, synthetic: true }]
      }
      const applyArmedGoal = async (goalSessionId: string, goalDirectory: string | null | undefined) => {
        if (!goalArmed) return
        const tokenBudget = goalTokenBudget
        let objective = goalArm.objectiveOverride?.trim() || content
        if (!goalArm.objectiveOverride && content.startsWith("/")) {
          // Same directory-scoped resolution as routeMessage: the objective must
          // come from this directory's command, not a same-named one elsewhere.
          // OpenCode 2.x serves commands without their templates, so an unknown
          // command's raw invocation stays the objective.
          const knownCommands = selectCommandsForDirectory(useCommandsStore.getState(), goalDirectory)
          objective = expandSlashCommandGoalObjective(content, knownCommands)
        }
        try {
          await setSessionGoal(goalSessionId, goalDirectory ?? undefined, { objective, tokenBudget }, null, capturedRuntimeKey)
        } catch (error) {
          // A queued message keeps its goal for the retry; only the composer's arm comes back.
          if (queuedGoal === undefined) useSessionGoalArmStore.getState().setArmed(true, goalArm.objectiveOverride)
          throw error
        }
      }

      // ---- New session from draft ----
      if (!capturedTarget && !options?.sessionId && draft?.open) {
        // The draft's first Enter made it a session; a later send with the same
        // draft would make a second one.
        if (sentDraftIds.has(draft.draftId)) throw new Error("The session is still being created.")
        sentDraftIds.add(draft.draftId)
        const selection: DraftSessionSelection = { providerID, modelID, agent: trimmedAgent, variant }
        let directory: string | null = null
        let chatDirectoryCleanup: CapturedChatDirectoryCleanup | null = null
        try {
          chatDirectoryCleanup = await captureChatDirectoryCleanup(draft.target, capturedRuntimeKey)
          if (getRuntimeKey() !== capturedRuntimeKey) throw new Error("Message was not sent because the runtime changed.")
          // The waits that decide where the session shows, with the draft
          // still open: a worktree being made, a chat folder being prepared.
          directory = (await resolveDraftTargetDirectory(draft)) ?? opencodeClient.getDirectory() ?? null
          if (!directory) throw new Error("Failed to create session")
          if (getRuntimeKey() !== capturedRuntimeKey) {
            throw new Error("Message was not sent because the runtime changed.")
          }
        } catch (error) {
          if (draft.target === "chat") await deletePreparedChatDirectory(directory, chatDirectoryCleanup)
          sentDraftIds.delete(draft.draftId)
          throw error
        }
        const sessionDirectory = directory

        // The session's id is minted here and sent with the create request, so
        // the chat can switch to it and show the message at once; the server
        // creates the session under this id while the message is on screen.
        const sessionId = descendingId("ses")
        const draftAgent = saveDraftSessionSelection(sessionId, selection)
        openPendingSessionTranscript(sessionId, sessionDirectory)
        get().setCurrentSession(sessionId, sessionDirectory, { transition: "submitted-draft" })
        setPendingDraftSend(sessionId, { draftId: draft.draftId, sessionCreated: false })
        const releaseGate = () => setPendingDraftSend(sessionId, null)

        // Whether the server has the session: answered by the create response
        // alone, since the goal and knowledge writes after it can fail with
        // the session already there.
        let resolveSessionCreated!: (created: boolean) => void
        const sessionCreatedOutcome = new Promise<boolean>((resolve) => { resolveSessionCreated = resolve })
        const creation = (async () => {
          try {
            const createDirectory = await resolveDraftCreateDirectory(draft, sessionDirectory)
            const created = await createSessionAction(
              draft.title,
              createDirectory,
              draftSessionMetadata(draft),
              undefined,
              draftSessionCreateSelection(selection),
              "preserve",
              sessionId,
              capturedRuntimeKey,
            )
            if (!created?.id) throw new Error("Failed to create session")
            if (created.id !== sessionId) {
              // The prompt must never go to a session that does not exist, and
              // the one the server made under another id is not this one: it
              // is empty, so it goes, best effort, before the draft comes back.
              console.error("[session-ui-store] the server created the session under another id", { requested: sessionId, created: created.id })
              void deleteSessionAction(created.id).catch(() => undefined)
              throw new Error("Failed to create session")
            }
            resolveSessionCreated(true)
            setPendingDraftSend(sessionId, { draftId: draft.draftId, sessionCreated: true })
            // The draft is a session now: it leaves the drafts every client lists.
            if (draft.workDraftId) void useSessionDraftsStore.getState().discard(draft.workDraftId, { final: true }).catch(() => undefined)
            const createdDirectory = finishDraftSession(draft, created, createDirectory) ?? sessionDirectory
            if (createdDirectory !== normalizePath(sessionDirectory)) {
              // The session lives elsewhere than where its first message was
              // shown (a start folder inside the worktree, a deleted directory
              // left for the project, a path the server canonicalized): the
              // transcript follows the record there.
              adoptSessionMove(sessionId, sessionDirectory, createdDirectory)
              if (get().currentSessionId === sessionId) get().setCurrentSession(sessionId, createdDirectory, { transition: "submitted-draft" })
            }
            // The session exists: from here its turn is the agent's.
            markSessionStatus(sessionId, createdDirectory, "busy")
            await applyArmedGoal(sessionId, createdDirectory)
            // The server writes the project knowledge and the response style
            // into the new session while the message is already on screen:
            // only the prompt request waits.
            if (inputMode !== "shell") await syncSessionKnowledge(createdDirectory, sessionId, await responseStyleInstruction, capturedRuntimeKey)
          } finally {
            resolveSessionCreated(false)
          }
        })()
        // The send below observes the outcome; nothing else has to.
        creation.catch(() => undefined)

        const draftParts: Array<{ text: string; attachments?: AttachedFile[]; synthetic?: boolean; metadata?: ContextPartMetadata }> | undefined = draft.syntheticParts?.length
          ? [...(additionalParts || []), ...draft.syntheticParts]
          : additionalParts
        const historyIdentity = createInputHistoryIdentity(capturedRuntimeKey, sessionDirectory, sessionId)
        const historySubmissions = options?.historySubmissions
        const appendSubmissions = historyIdentity && historySubmissions?.length
          ? () => useInputHistoryStore.getState().appendSubmissions(historyIdentity, historySubmissions)
          : undefined

        notifyMessageSent(sessionId)
        // Sending a message means working in the session: its tab stays.
        useSessionTabsStore.getState().pinTab(sessionId)

        markPendingUserSendAnimation(sessionId)

        const files = attachments?.map((a) => ({
          type: "file" as const,
          mime: a.mimeType,
          url: a.dataUrl,
          filename: a.filename,
        }))

        try {
          await routeMessage({
            runtimeKey: capturedRuntimeKey,
            sessionId,
            directory: sessionDirectory,
            content,
            providerID,
            modelID,
            agent: draftAgent,
            agentMentionName,
            variant,
            inputMode,
            files,
            appendSubmissions,
            delivery: options?.delivery,
            skills: options?.skills,
            ready: creation,
            beforeSend: releaseGate,
            markBusy: false,
            additionalParts: draftParts?.map((p) => ({
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
        } catch (error) {
          // The send can fail before the create response (a lost connection,
          // a command lookup): the creation still settles, and what the
          // server answered decides whether the draft comes back or the
          // session stays with the text in its composer.
          const sessionCreated = await sessionCreatedOutcome
          releaseGate()
          const liveDirectory = getSyncSessionDirectory(sessionId) ?? sessionDirectory
          if (sessionCreated) {
            // Nothing reached the agent: a session marked busy on creation
            // for a send that failed before its request is idle.
            markSessionStatus(sessionId, liveDirectory, "idle")
          } else {
            await deletePreparedChatDirectory(sessionDirectory, chatDirectoryCleanup)
            reopenDraftAfterFailedCreation(draft, sessionId, sessionDirectory, capturedRuntimeKey)
          }
          throw new DraftSendError(sessionId, liveDirectory, sessionCreated, error)
        }
        return
      }

      // ---- Existing session ----
      const targetSessionId = capturedTarget?.sessionId ?? options?.sessionId ?? get().currentSessionId
      const resumeAfterSend = options?.userInitiated && inputMode !== 'shell' && targetSessionId
        ? prepareUserMessageResume(targetSessionId, capturedRuntimeKey)
        : undefined
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
        useSelectionStore.getState().saveAgentModelVariantForSession(
          targetSessionId,
          effectiveAgent,
          providerID,
          modelID,
          resolveVariantToRecord(effectiveAgent, providerID, modelID, variant),
        )
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
        useSessionTabsStore.getState().pinTab(targetSessionId)
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

      // Standing project context (pinned notes and plans, the memory index) and
      // the response style, written into the session alongside the goal write
      // and while the optimistic message is already on screen: only the prompt
      // request waits for it.
      const knowledgeSync = responseStyleInstruction
        ? responseStyleInstruction.then((style) => syncSessionKnowledge(currentSessionDirectory, targetSessionId, style, capturedRuntimeKey))
        : undefined

      if (targetSessionId) {
        await applyArmedGoal(targetSessionId, currentSessionDirectory)
      }
      const historyIdentity = createInputHistoryIdentity(
        capturedRuntimeKey,
        currentSessionDirectory ?? '',
        targetSessionId || '',
      )
      const historySubmissions = options?.historySubmissions
      const appendSubmissions = historyIdentity && historySubmissions?.length
        ? () => useInputHistoryStore.getState().appendSubmissions(historyIdentity, historySubmissions)
        : undefined

      await routeMessage({
        runtimeKey: capturedRuntimeKey,
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
        appendSubmissions,
        delivery: options?.delivery,
        skills: options?.skills,
        ready: knowledgeSync,
        additionalParts: additionalParts?.map((p) => ({
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
      // Keep restore failures outside the send promise and its retry path.
      void resumeAfterSend?.().catch(console.warn)
    })
  },

  // ---------------------------------------------------------------------------
  // createSession
  // ---------------------------------------------------------------------------
  createSession: (title, directoryOverride, metadata, selection) =>
    createSessionWithDraftLifecycle(title, directoryOverride, metadata, undefined, selection),

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
    await updateSessionTitleAction(sessionId, title, { byUser: true })
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
      const revertIndex = revertedUserMessageIndex(messages, userMessages, revertToId)
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
  handleSlashRedo: async (sessionId) => {
    const sessions = getSyncSessions()
    const currentSession = sessions.find((s) => s.id === sessionId)
    const revertToId = currentSession?.revert?.messageID
    if (!revertToId) return

    await refetchSessionMessages(sessionId)
    const messages = getSyncMessages(sessionId)
    const userMessages = messages.filter((m) => m.role === "user")
    const revertIndex = revertedUserMessageIndex(messages, userMessages, revertToId)
    const targetMessage = revertIndex >= 0 ? userMessages[revertIndex + 1] : undefined

    if (targetMessage) {
      await get().revertToMessage(sessionId, targetMessage.id, { skipRedoPush: true })
      const { toast } = await import("sonner")
      const { useI18nStore, formatMessage } = await import("@/lib/i18n/store")
      const { dictionary } = useI18nStore.getState()
      toast.success(formatMessage(dictionary, "chat.revert.toast.redo"))
    }
    // A committed revert has no server-side undo in OpenCode 2.x: once the
    // marker is at the newest user message there is nothing further to redo.
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

  forkAfterMessage: async (sessionId, messageId) => {
    const existingSession = getSyncSessions().find((s) => s.id === sessionId)
    if (!existingSession) return

    try {
      await forkAfterMessageAction(sessionId, messageId)

      const { toast } = await import("sonner")
      toast.success(`Forked from ${existingSession.title}`)
    } catch (error) {
      console.error("Failed to fork session:", error)
      const { toast } = await import("sonner")
      toast.error("Failed to fork session")
    }
  },

  // ---------------------------------------------------------------------------
  // createSessionFromAssistantMessage — uses the rendered source context
  // ---------------------------------------------------------------------------
  createSessionFromAssistantMessage: async (source, execution) => {
    if (!source.sessionId) return
    if (!execution?.instructions?.trim()) return
    const assistantPlanText = source.text
    if (!assistantPlanText.trim()) return

    const sourceDirectory = normalizePath(source.directory)
    if (!sourceDirectory) {
      throw new Error("Source session directory is unavailable")
    }
    const sourceWorktreeMetadata = get().worktreeMetadata.get(source.sessionId)

    const providerID = execution.providerID || useSelectionStore.getState().lastUsedProvider?.providerID
    const modelID = execution.modelID || useSelectionStore.getState().lastUsedProvider?.modelID

    if (!providerID || !modelID) return

    let sessionDirectory: string | null = sourceDirectory
    let createdWorktree: WorktreeMetadata | null = null
    let createdWorktreeProject: { id: string; path: string } | null = null

    if (execution.createWorktree) {
      // A worktree of the host project would hold none of the space's changes.
      if (isSpaceDirectory(sourceDirectory)) {
        throw new Error("A fork of a session in an isolated space stays in the space")
      }
      const projects = useProjectsStore.getState().projects
      const project = resolveProjectForSessionDirectory(
        projects,
        get().availableWorktreesByProject,
        sourceWorktreeMetadata?.projectDirectory ?? null,
      ) ?? resolveProjectForSessionDirectory(
        projects,
        get().availableWorktreesByProject,
        sourceDirectory,
      )
      if (!project?.path) {
        throw new Error("Project is not registered in OpenChamber")
      }

      const [branchNameModule, configModule, trustModule, createModule] = await Promise.all([
        import("@/lib/git/branchNameGenerator"),
        import("@/lib/openchamberConfig"),
        import("@/lib/sharedTrustConfirmation"),
        import("@/lib/worktrees/worktreeCreate"),
      ])
      const branchName = branchNameModule.generateBranchName()
      createdWorktreeProject = { id: project.id, path: project.path }
      const setupCommands = await trustModule.resolveWorktreeSetupCommands(createdWorktreeProject)
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
      sessionDirectory = await resolveCreatedWorktreeStartDirectory(createdWorktreeProject, createdWorktree)
    }

    const session = await get().createSession(undefined, sessionDirectory)
    if (!session) {
      if (createdWorktree && createdWorktreeProject) {
        const { removeProjectWorktree } = await import("@/lib/worktrees/worktreeManager")
        await removeProjectWorktree(createdWorktreeProject, createdWorktree, { deleteLocalBranch: true }).catch(() => undefined)
      }
      throw new Error("Failed to create session")
    }

    if (createdWorktree) {
      get().setWorktreeMetadata(session.id, {
        ...createdWorktree,
        kind: "standard",
      }, sessionDirectory)
      useDirectoryStore.getState().setDirectory(sessionDirectory, { showOverlay: false })
    }

    // "Run as goal" rides the same arm mechanism as the composer target
    // button: sendMessage consumes the flag, stamps the goal (objective =
    // the composed fork message) and attaches the goal-mode intro part.
    // Set explicitly either way so a stray armed flag cannot leak into a
    // non-goal fork.
    useSessionGoalArmStore.getState().setArmed(execution.runAsGoal === true)

    await get().sendMessage(
      composeForkSessionMessage(execution.instructions, assistantPlanText),
      providerID,
      modelID,
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
    setActiveSession(authoritative, target)
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
      if (normalized && !isSessionAdmitted(normalized)) {
        get().setCurrentSession(null)
        get().setCurrentSession(sessionId, normalized)
        return
      }
      set({ currentSessionDirectory: normalized })
      setActiveSession(normalized ?? "", sessionId)
      writeRuntimeSessionMemory(runtimeMemoryKey(), { sessionId, directory: normalized })
    }
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
