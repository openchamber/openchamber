/**
 * The stores and OpenCode calls behind `continueWithModel`: what the session is
 * doing when the user continues (`readContinueSnapshot`) and the calls each
 * step makes (`continueWithModelDeps`). Kept apart from the sequence so its
 * tests drive the sequence with plain functions.
 */

import { opencodeClient } from "@/lib/opencode/client"
import type { Message } from "@/lib/opencode/model"
import type { ModelRefLike } from "@/lib/opencode/modelRef"
import { getRuntimeKey } from "@/lib/runtime-switch"
import { markPendingUserSendAnimation } from "@/lib/userSendAnimation"
import { useConfigStore } from "@/stores/useConfigStore"
import { useGlobalSessionsStore } from "@/stores/useGlobalSessionsStore"
import { useBackgroundShellsStore, type TrackedShell } from "./background-shells"
import {
  blockingCallsSettled,
  describeHandoffStop,
  findBlockingCalls,
  runningSubagentsBelow,
  type BlockingCalls,
  type ContinueDeps,
  type ContinueSelection,
  type ContinueSnapshot,
  type ContinueTarget,
  type RunningShell,
  type RunningWork,
} from "./continue-with-model"
import { useGlobalSessionStatusStore } from "./global-session-status"
import { useNotificationStore } from "./notification-store"
import { useSelectionStore } from "./selection-store"
import { dismissPermissionsAfterInterrupt, getSessionLiveActivity, optimisticSend } from "./session-actions"
import { resolveSendSelection, useSessionUIStore } from "./session-ui-store"
import { getAllSyncSessionMap, getDirectoryState, getSyncChildStores, getSyncSessionDirectory } from "./sync-refs"

/**
 * How long `keep` waits for OpenCode to hand the waited-on calls to the
 * background. The handoff is a few in-process steps after `session.background`
 * answers; the events that report it reach the client well within this.
 */
const BACKGROUND_HANDOFF_TIMEOUT_MS = 5_000

type SessionRecord = { parentID?: string; directory?: string; title?: string }

const findSessionRecord = (sessionId: string): SessionRecord | undefined => (
  getAllSyncSessionMap().get(sessionId) ?? useGlobalSessionsStore.getState().entityById.get(sessionId)
)

/**
 * The directory whose store holds the session's messages. That is usually the
 * target's own; a project's store can hold the sessions of its worktrees, so
 * the store that contains the session answers otherwise.
 */
const storeDirectoryOf = (target: ContinueTarget): string => {
  if (getDirectoryState(target.directory)?.message[target.sessionId]) return target.directory
  return getSyncSessionDirectory(target.sessionId) ?? target.directory
}

/** The newest error OpenCode reported live for the session after its last message. */
const reportedErrorAfter = (sessionId: string, since: number): string | undefined => {
  const list = useNotificationStore.getState().list
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const notification = list[index]
    if (notification.session !== sessionId || notification.type !== "error") continue
    if (notification.time < since) return undefined
    const name = notification.error?.name?.trim()
    const message = notification.error?.message?.trim()
    return name && message ? `${name}: ${message}` : message || name || undefined
  }
  return undefined
}

const lastAssistantModel = (sessionId: string, messages: readonly Message[]): ModelRefLike | undefined => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== "assistant" || !message.providerID || !message.modelID) continue
    return { providerID: message.providerID, modelID: message.modelID, variant: message.variant }
  }
  const model = getAllSyncSessionMap().get(sessionId)?.model
  return model ? { providerID: model.providerID, modelID: model.id, variant: model.variant } : undefined
}

/** The running shell commands of the session and its subagents. */
const runningShellsOf = (shellsById: ReadonlyMap<string, TrackedShell>, sessionIds: ReadonlySet<string>): RunningShell[] => {
  const shells: RunningShell[] = []
  for (const shell of shellsById.values()) {
    if (!sessionIds.has(shell.sessionID)) continue
    shells.push({
      shellID: shell.id,
      command: shell.command,
      sessionID: shell.sessionID,
      shellDirectory: shell.directory,
      background: shell.background,
    })
  }
  return shells.sort((left, right) => left.shellID.localeCompare(right.shellID))
}

/**
 * The shell commands and subagents running for the session, from the shell
 * index and the live status index the caller holds (the dialog subscribes to
 * both; the sequence reads them once).
 */
export function readRunningWork(
  target: ContinueTarget,
  sources: { shellsById: ReadonlyMap<string, TrackedShell>; activeSessionIds: ReadonlySet<string> },
): RunningWork {
  const subagents = runningSubagentsBelow({
    rootId: target.sessionId,
    activeSessionIds: sources.activeSessionIds,
    parentOf: (sessionId) => findSessionRecord(sessionId)?.parentID,
    describe: (sessionId) => {
      const record = findSessionRecord(sessionId)
      return record ? { directory: record.directory || target.directory, title: record.title } : undefined
    },
  })
  const owners = new Set([target.sessionId, ...subagents.map((subagent) => subagent.sessionID)])
  return { shells: runningShellsOf(sources.shellsById, owners), subagents }
}

/** What the session is doing now, read from the live stores. */
export function readContinueSnapshot(target: ContinueTarget): ContinueSnapshot {
  const storeDirectory = storeDirectoryOf(target)
  const state = getDirectoryState(storeDirectory)
  const messages = state?.message[target.sessionId] ?? []
  const partsOf = (messageID: string) => state?.part[messageID] ?? []
  const permissions = state?.permission[target.sessionId] ?? []
  const lastMessageTime = messages.at(-1)?.time.created ?? 0
  const running = readRunningWork(target, {
    shellsById: useBackgroundShellsStore.getState().byId,
    activeSessionIds: useGlobalSessionStatusStore.getState().activeSessionIds,
  })
  return {
    stop: describeHandoffStop({
      messages,
      partsOf,
      active: getSessionLiveActivity(target.sessionId) === "active",
      hasQuestion: (state?.form[target.sessionId] ?? []).length > 0,
      hasPermission: permissions.length > 0,
      reportedError: reportedErrorAfter(target.sessionId, lastMessageTime),
    }),
    from: lastAssistantModel(target.sessionId, messages),
    shells: running.shells,
    subagents: running.subagents,
    blocking: findBlockingCalls({
      messages,
      partsOf,
      permissionCallIDs: new Set(permissions.flatMap((permission) => (permission.source ? [permission.source.id] : []))),
    }),
  }
}

/** Resolves once every blocking call has settled in the session's store, or false at the timeout. */
const waitForBlockingCalls = (target: ContinueTarget, blocking: BlockingCalls): Promise<boolean> => {
  const store = getSyncChildStores().getChild(storeDirectoryOf(target))
  if (!store) return Promise.resolve(false)
  const settled = () => blockingCallsSettled(blocking, store.getState().part[blocking.messageID] ?? [])
  if (settled()) return Promise.resolve(true)
  return new Promise((resolve) => {
    const finish = (result: boolean) => {
      clearTimeout(timer)
      unsubscribe()
      resolve(result)
    }
    const timer = setTimeout(() => finish(settled()), BACKGROUND_HANDOFF_TIMEOUT_MS)
    const unsubscribe = store.subscribe(() => {
      if (settled()) finish(true)
    })
  })
}

/**
 * Records the choice where the composer reads it, the way a send does, so the
 * composer shows the model the session now runs on. The open session's
 * composer takes it at once, when its catalog lists the model; otherwise it
 * follows the session's switch on its own, as for a switch made elsewhere.
 */
const rememberSelection = (sessionId: string, selection: ContinueSelection): void => {
  const selections = useSelectionStore.getState()
  selections.saveSessionModelSelection(sessionId, selection.providerID, selection.modelID)
  if (selection.agent) {
    selections.saveSessionAgentSelection(sessionId, selection.agent)
    selections.saveAgentModelForSession(sessionId, selection.agent, selection.providerID, selection.modelID)
    selections.saveAgentModelVariantForSession(sessionId, selection.agent, selection.providerID, selection.modelID, selection.variant)
  }
  if (useSessionUIStore.getState().currentSessionId !== sessionId) return
  const config = useConfigStore.getState()
  const listed = config.providers.some((provider) => (
    provider.id === selection.providerID && provider.models.some((model) => model.id === selection.modelID)
  ))
  if (!listed) return
  config.setProvider(selection.providerID)
  config.setModel(selection.modelID)
  config.setCurrentVariantOverride(selection.variant, undefined)
}

/** The calls `continueWithModel` makes against OpenCode and the stores. */
export function createContinueWithModelDeps(): ContinueDeps {
  const runtimeKey = getRuntimeKey()
  return {
    isRuntimeCurrent: () => getRuntimeKey() === runtimeKey,
    moveBlockingWorkToBackground: (target) => opencodeClient.backgroundSessionWork(target.sessionId, target.directory),
    waitForBlockingCalls,
    interrupt: async (target) => {
      await opencodeClient.abortSession(target.sessionId, target.directory)
    },
    clearInterruptedPermissions: (target, scope) => dismissPermissionsAfterInterrupt(target.sessionId, scope),
    switchSelection: async (target, selection) => {
      const change = resolveSendSelection(target.sessionId, storeDirectoryOf(target), selection)
      if (change.model) await opencodeClient.switchSessionModel(target.sessionId, change.model, target.directory)
      if (change.agent) await opencodeClient.switchSessionAgent(target.sessionId, change.agent, target.directory)
      rememberSelection(target.sessionId, selection)
    },
    admitNote: (target, note) => opencodeClient.admitSessionNote({ sessionID: target.sessionId, directory: target.directory, note }),
    stopShells: (owner, shells) => opencodeClient.stopBackgroundShells({ sessionID: owner.sessionID, sessionDirectory: owner.directory, shells }),
    stopSubagent: (subagent) => opencodeClient.stopSubagent({
      sessionID: subagent.parentID,
      directory: subagent.directory,
      childSessionID: subagent.sessionID,
      description: subagent.description,
    }),
    sendContinue: async (target, prompt, selection) => {
      markPendingUserSendAnimation(target.sessionId)
      await optimisticSend({
        runtimeKey,
        sessionId: target.sessionId,
        content: prompt,
        directory: target.directory,
        onOptimisticInsert: () => {
          window.dispatchEvent(new CustomEvent("openchamber:chat-force-scroll-bottom", { detail: { sessionId: target.sessionId } }))
        },
        // The session already runs on the selection: the switch came first.
        send: (messageID) => opencodeClient.sendMessage({
          runtimeKey,
          id: target.sessionId,
          directory: target.directory,
          providerID: selection.providerID,
          text: prompt,
          messageId: messageID,
        }).then(() => undefined),
      })
    },
  }
}
