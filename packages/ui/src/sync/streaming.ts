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

export type StreamPhase = "streaming" | "cooldown" | "completed"

export type MessageStreamState = {
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

/**
 * Called from the SyncBridge/flush handler when child store state changes.
 * Derives streaming state from session_status + messages.
 */
export function updateStreamingState(state: State) {
  const now = Date.now()
  const nextStreamingIds = new Map<string, string | null>()
  const nextStreamStates = new Map(useStreamingStore.getState().messageStreamStates)
  let changed = false

  for (const [sessionID, status] of Object.entries(state.session_status ?? {})) {
    const isBusy = (status as SessionStatus).type === "busy"
    const messages = state.message[sessionID]

    if (isBusy && messages && messages.length > 0) {
      // Find the last assistant message — that's the one streaming
      let streamingMsg: Message | null = null
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "assistant") {
          streamingMsg = messages[i]
          break
        }
      }

      if (streamingMsg) {
        const prevId = nextStreamingIds.get(sessionID)
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
        } else if (existing.lastUpdateAt !== now) {
          nextStreamStates.set(streamingMsg.id, {
            ...existing,
            lastUpdateAt: now,
          })
          changed = true
        }
      }
    } else {
      // Session is idle — check if we had a streaming message
      const prev = useStreamingStore.getState().streamingMessageIds.get(sessionID)
      if (prev) {
        nextStreamingIds.set(sessionID, null)
        const existing = nextStreamStates.get(prev)
        if (existing && existing.phase === "streaming") {
          // Transition to cooldown then completed
          nextStreamStates.set(prev, {
            ...existing,
            phase: "completed",
            completedAt: now,
          })
          changed = true
        }
      }
    }
  }

  // Also mark completed any streaming messages for sessions no longer in status
  const currentIds = useStreamingStore.getState().streamingMessageIds
  for (const [sessionID, msgId] of currentIds) {
    if (msgId && !state.session_status?.[sessionID]) {
      const existing = nextStreamStates.get(msgId)
      if (existing && existing.phase === "streaming") {
        nextStreamStates.set(msgId, {
          ...existing,
          phase: "completed",
          completedAt: now,
        })
        changed = true
      }
      nextStreamingIds.set(sessionID, null)
    }
  }

  if (changed) {
    useStreamingStore.setState({
      streamingMessageIds: nextStreamingIds,
      messageStreamStates: nextStreamStates,
    })
  }
}

// Selectors
export const selectStreamingMessageId = (sessionID: string) =>
  (state: StreamingStore) => state.streamingMessageIds.get(sessionID) ?? null

export const selectMessageStreamState = (messageID: string) =>
  (state: StreamingStore) => state.messageStreamStates.get(messageID) ?? null

export const selectIsStreaming = (sessionID: string) =>
  (state: StreamingStore) => state.streamingMessageIds.get(sessionID) != null
