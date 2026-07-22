/**
 * Streaming lifecycle tracking.
 *
 * Derives streaming state from the sync child store's session_status and
 * message/part updates. Components read this to know which messages are
 * currently streaming and their lifecycle phase.
 */

import { create } from "zustand"
import type { Message, SessionStatus } from "@opencode-ai/sdk/v2/client"
import type { State } from "./types"
import { countSyncPerformance } from "./performance-diagnostics"

type StreamPhase = "streaming" | "cooldown" | "completed"

type MessageStreamState = {
  phase: StreamPhase
  startedAt: number
  lastUpdateAt: number
  completedAt?: number
}

export type StreamingStore = {
  /** Currently streaming message per session */
  streamingMessageIds: Map<string, string | null>
  /** Lifecycle phase per message */
  messageStreamStates: Map<string, MessageStreamState>
}

export const useStreamingStore = create<StreamingStore>()(() => ({
  streamingMessageIds: new Map(),
  messageStreamStates: new Map(),
}))

export function resetStreamingState() {
  useStreamingStore.setState({
    streamingMessageIds: new Map(),
    messageStreamStates: new Map(),
  })
}

/**
 * Called from the SyncBridge/flush handler when child store state changes.
 * Derives streaming state from session_status + messages.
 */
/** Only update lastUpdateAt every this many ms to avoid 60Hz store churn */
const STREAMING_HEARTBEAT_MS = 1000

const findTrailingAssistantMessage = (messages: Message[] | undefined): Message | null => {
  if (!messages) return null

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    countSyncPerformance("streamingMessagesVisited")
    if (messages[index].role === "user") return null
    if (messages[index].role === "assistant") return messages[index]
  }

  return null
}

export function updateStreamingState(state: State, now = Date.now()) {
  countSyncPerformance("streamingFullReconciliations")
  const currentStore = useStreamingStore.getState()
  const currentStreamingIds = currentStore.streamingMessageIds
  const currentStreamStates = currentStore.messageStreamStates

  const nextStreamingIds = new Map<string, string | null>()
  const nextStreamStates = new Map(currentStreamStates)
  let changed = false

  // Fast path: only scan sessions that are actually busy.
  // Idle sessions are handled by checking against currentStreamingIds below.
  const busySessionIds = new Set<string>()
  for (const [sessionID, status] of Object.entries(state.session_status ?? {})) {
    countSyncPerformance("streamingStatusEntriesVisited")
    if ((status as SessionStatus).type === "busy") {
      busySessionIds.add(sessionID)
    }
  }

  const completeStreamingMessage = (sessionID: string, msgId: string) => {
    nextStreamingIds.set(sessionID, null)
    const existing = nextStreamStates.get(msgId)
    if (existing && existing.phase === "streaming") {
      nextStreamStates.set(msgId, {
        ...existing,
        phase: "completed",
        completedAt: now,
      })
    }
    changed = true
  }

  for (const sessionID of busySessionIds) {
    countSyncPerformance("streamingSessionCandidatesVisited")
    const messages = state.message[sessionID]
    if (!messages || messages.length === 0) continue

    // Only the trailing assistant turn can be streaming. If a new user turn is
    // last, the next assistant message has not arrived yet.
    const streamingMsg = findTrailingAssistantMessage(messages)

    if (!streamingMsg) {
      const prevId = currentStreamingIds.get(sessionID)
      if (prevId) {
        completeStreamingMessage(sessionID, prevId)
      }
      continue
    }

    const prevId = currentStreamingIds.get(sessionID)
    if (prevId !== streamingMsg.id) changed = true
    nextStreamingIds.set(sessionID, streamingMsg.id)

    const existing = nextStreamStates.get(streamingMsg.id)
    if (!existing || existing.phase !== "streaming") {
      nextStreamStates.set(streamingMsg.id, {
        phase: "streaming",
        startedAt: existing?.startedAt ?? now,
        lastUpdateAt: now,
      })
      changed = true
    } else if (now - existing.lastUpdateAt >= STREAMING_HEARTBEAT_MS) {
      // Throttle lastUpdateAt writes to ~1Hz instead of 60Hz
      nextStreamStates.set(streamingMsg.id, {
        ...existing,
        lastUpdateAt: now,
      })
      changed = true
    }
  }

  // Mark completed any previously streaming sessions that are now idle or gone
  for (const [sessionID, msgId] of currentStreamingIds) {
    if (!msgId) continue
    const isStillBusy = busySessionIds.has(sessionID)
    if (isStillBusy) continue

    completeStreamingMessage(sessionID, msgId)
  }

  if (changed) {
    useStreamingStore.setState({
      streamingMessageIds: nextStreamingIds,
      messageStreamStates: nextStreamStates,
    })
  }
}

const collectChangedSessionIds = (
  current: Record<string, unknown> | undefined,
  previous: Record<string, unknown> | undefined,
  changed: Set<string>,
  countStatusEntries = false,
) => {
  const currentRecord = current ?? {}
  const previousRecord = previous ?? {}
  for (const sessionID of Object.keys(currentRecord)) {
    if (countStatusEntries) countSyncPerformance("streamingStatusEntriesVisited")
    if (currentRecord[sessionID] !== previousRecord[sessionID]) changed.add(sessionID)
  }
  for (const sessionID of Object.keys(previousRecord)) {
    if (Object.prototype.hasOwnProperty.call(currentRecord, sessionID)) continue
    if (countStatusEntries) countSyncPerformance("streamingStatusEntriesVisited")
    changed.add(sessionID)
  }
}

export function updateChangedStreamingSessions(state: State, previous: State, now = Date.now()): void {
  const statusChanged = state.session_status !== previous.session_status
  const messagesChanged = state.message !== previous.message
  if (!statusChanged && !messagesChanged) return

  countSyncPerformance("streamingIncrementalReconciliations")
  const changedSessionIds = new Set<string>()
  if (statusChanged) {
    collectChangedSessionIds(
      state.session_status as Record<string, unknown> | undefined,
      previous.session_status as Record<string, unknown> | undefined,
      changedSessionIds,
      true,
    )
  }
  if (messagesChanged) {
    collectChangedSessionIds(
      state.message as Record<string, unknown> | undefined,
      previous.message as Record<string, unknown> | undefined,
      changedSessionIds,
    )
  }
  if (changedSessionIds.size === 0) return

  const currentStore = useStreamingStore.getState()
  const nextStreamingIds = new Map(currentStore.streamingMessageIds)
  const nextStreamStates = new Map(currentStore.messageStreamStates)
  let changed = false

  const complete = (sessionID: string, messageID: string) => {
    if (nextStreamingIds.get(sessionID) !== null) {
      nextStreamingIds.set(sessionID, null)
      changed = true
    }
    const existing = nextStreamStates.get(messageID)
    if (existing?.phase === "streaming") {
      nextStreamStates.set(messageID, { ...existing, phase: "completed", completedAt: now })
      changed = true
    }
  }

  for (const sessionID of changedSessionIds) {
    countSyncPerformance("streamingSessionCandidatesVisited")
    const previousMessageID = currentStore.streamingMessageIds.get(sessionID)
    if (state.session_status?.[sessionID]?.type !== "busy") {
      if (previousMessageID) complete(sessionID, previousMessageID)
      continue
    }

    const streamingMessage = findTrailingAssistantMessage(state.message[sessionID])

    if (!streamingMessage) {
      if (previousMessageID) complete(sessionID, previousMessageID)
      continue
    }

    if (previousMessageID && previousMessageID !== streamingMessage.id) {
      complete(sessionID, previousMessageID)
    }
    if (nextStreamingIds.get(sessionID) !== streamingMessage.id) {
      nextStreamingIds.set(sessionID, streamingMessage.id)
      changed = true
    }

    const existing = nextStreamStates.get(streamingMessage.id)
    if (!existing || existing.phase !== "streaming") {
      nextStreamStates.set(streamingMessage.id, {
        phase: "streaming",
        startedAt: existing?.startedAt ?? now,
        lastUpdateAt: now,
      })
      changed = true
    }
  }

  if (changed) {
    useStreamingStore.setState({
      streamingMessageIds: nextStreamingIds,
      messageStreamStates: nextStreamStates,
    })
  }
}

export function touchStreamingSession(sessionID: string, now = Date.now()): void {
  countSyncPerformance("streamingHeartbeatAttempts")
  const current = useStreamingStore.getState()
  const messageID = current.streamingMessageIds.get(sessionID)
  if (!messageID) return
  const existing = current.messageStreamStates.get(messageID)
  if (!existing || existing.phase !== "streaming" || now - existing.lastUpdateAt < STREAMING_HEARTBEAT_MS) return

  const messageStreamStates = new Map(current.messageStreamStates)
  messageStreamStates.set(messageID, { ...existing, lastUpdateAt: now })
  countSyncPerformance("streamingHeartbeatCommits")
  useStreamingStore.setState({ messageStreamStates })
}
