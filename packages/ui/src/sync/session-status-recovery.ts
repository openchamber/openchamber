import type { StoreApi } from "zustand"
import type { SessionStatus } from "@/lib/opencode/model"
import { type DirectoryStore } from "./child-store"
import { runBackgroundNetworkTask } from "@/lib/background-network"
import { selectHeldSessionStatuses } from "./directory-recovery-snapshots"
import { hasPromptInFlight, withPromptsInFlight } from "./prompts-in-flight"
import { getReconnectCandidateSessionIds } from "./reconnect-recovery"
import { opencodeClient } from "@/lib/opencode/client"
import { applyGlobalSessionStatusSnapshot, getDirectoryOwnedSessionIds } from "./global-session-status"
import { getViewedSessionMaterializationTarget } from "./viewed-sessions"

const syncSnapshotSignature = (value: unknown): string => JSON.stringify(value)

function haveEquivalentSyncSnapshots(left: unknown, right: unknown): boolean {
  return syncSnapshotSignature(left) === syncSnapshotSignature(right)
}

export const statusPollingDirectories = new Set<string>()

const pendingMessageCompletionPolls = new Map<string, ReturnType<typeof setTimeout>>()

export const MESSAGE_COMPLETION_STATUS_POLL_DELAY_MS = 750

const toSessionStatus = (status: SessionStatus | undefined): SessionStatus | undefined => status

export function getActiveSessionCandidateIds(directory: string, state: DirectoryStore): string[] {
  return getReconnectCandidateSessionIds(state, {
    directory,
    viewedSession: getViewedSessionMaterializationTarget(directory),
  })
}

export function getLiveSessionCandidateIds(state: DirectoryStore): string[] {
  return getReconnectCandidateSessionIds(state)
}

type DirectorySessionStatusSnapshot = NonNullable<
  Awaited<ReturnType<typeof opencodeClient.getActiveSessionStatuses>>
>

type StatusSnapshotMode = "monotonic" | "authoritative"

export function applySessionStatusSnapshot(
  store: StoreApi<DirectoryStore>,
  snapshot: DirectorySessionStatusSnapshot,
  candidateSessionIds: string[],
  mode: StatusSnapshotMode,
): boolean {
  if (candidateSessionIds.length === 0) return false

  let changed = false
  store.setState((state: DirectoryStore) => {
    const current = state.session_status ?? {}
    let next: Record<string, SessionStatus> | undefined
    let nextInvalidated: Record<string, true> | undefined
    const draft = () => (next ??= { ...current })

    for (const sessionId of candidateSessionIds) {
      const incoming = toSessionStatus(snapshot[sessionId])
      if (mode === "authoritative" && state.sessionStatusInvalidated?.[sessionId]) {
        nextInvalidated ??= { ...state.sessionStatusInvalidated }
        delete nextInvalidated[sessionId]
        changed = true
      }

      if (incoming && incoming.type !== "idle") {
        const held = current[sessionId]
        if (incoming.type === "busy" && held?.type === "retry" && (held.next === undefined || held.next > Date.now())) continue
        if (!haveEquivalentSyncSnapshots(current[sessionId], incoming)) {
          draft()[sessionId] = incoming
          changed = true
        }
        continue
      }

      if (mode === "monotonic" || hasPromptInFlight(sessionId)) continue

      const existing = current[sessionId]
      if (!existing || existing.type !== "idle") {
        draft()[sessionId] = { type: "idle" }
        changed = true
      }
    }

    if (!next && !nextInvalidated) return state
    const patch: Partial<DirectoryStore> = {}
    if (next) patch.session_status = next
    if (nextInvalidated) patch.sessionStatusInvalidated = nextInvalidated
    return patch
  })

  return changed
}

export async function resyncDirectorySessionStatuses(
  directory: string,
  store: StoreApi<DirectoryStore>,
  candidateSessionIds: string[],
  mode: StatusSnapshotMode,
  isStale?: () => boolean,
): Promise<DirectorySessionStatusSnapshot | null> {
  const invalidatedAtStart = store.getState().sessionStatusInvalidated
  const nextStatuses = await opencodeClient.getActiveSessionStatuses(directory)
  if (nextStatuses === null || isStale?.()) return null
  const currentInvalidated = store.getState().sessionStatusInvalidated
  const eligibleIds = candidateSessionIds.filter((id) => (
    !currentInvalidated?.[id] || currentInvalidated === invalidatedAtStart
  ))
  applySessionStatusSnapshot(store, nextStatuses, eligibleIds, mode)
  if (mode === "authoritative") {
    store.setState({ sessionStatusReady: true })
    const state = store.getState()
    applyGlobalSessionStatusSnapshot(
      directory,
      withPromptsInFlight(selectHeldSessionStatuses(nextStatuses, state.session), state.session_status),
      getDirectoryOwnedSessionIds(directory, state.session),
    )
  }
  return nextStatuses
}

export function maybePollStatusAfterMessageCompletion(
  directory: string,
  store: StoreApi<DirectoryStore>,
  sessionID: string,
): void {
  if (!directory || directory === "global" || !sessionID) return
  const current = store.getState().session_status?.[sessionID]
  if (!current || current.type === "idle") return

  const pendingKey = `${directory}\u0000${sessionID}`
  if (pendingMessageCompletionPolls.has(pendingKey)) return

  const timer = setTimeout(() => {
    pendingMessageCompletionPolls.delete(pendingKey)
    const latest = store.getState().session_status?.[sessionID]
    if (!latest || latest.type === "idle") return
    if (statusPollingDirectories.has(directory)) return

    statusPollingDirectories.add(directory)
    void (async () => {
      try {
        const statuses = await runBackgroundNetworkTask(() =>
          resyncDirectorySessionStatuses(directory, store, [sessionID], "monotonic"), "active-session")
        if (!statuses) return
        if (needsSnapshotAfterStatusPoll(store.getState(), sessionID, statuses[sessionID])) {
          await runBackgroundNetworkTask(() =>
            resyncDirectorySessionStatuses(directory, store, [sessionID], "authoritative"), "active-session")
        }
      } catch {
        // Best-effort — the watchdog poll retries on its own cadence.
      } finally {
        statusPollingDirectories.delete(directory)
      }
    })()
  }, MESSAGE_COMPLETION_STATUS_POLL_DELAY_MS)

  pendingMessageCompletionPolls.set(pendingKey, timer)
}

export function needsSnapshotAfterStatusPoll(
  state: DirectoryStore,
  sessionId: string,
  snapshotEntry: DirectorySessionStatusSnapshot[string] | undefined,
): boolean {
  const incoming = toSessionStatus(snapshotEntry)
  if (incoming && incoming.type !== "idle") return false
  if (hasPromptInFlight(sessionId)) return false
  const currentStatus = state.session_status?.[sessionId]
  return Boolean(currentStatus && currentStatus.type !== "idle")
}
