import type { StoreApi } from "zustand"
import type { Message, Part, SessionOutcome, StructuredError } from "@/lib/opencode/model"
import { type DirectoryStore } from "./child-store"

// external: https://github.com/anomalyco/opencode/issues/19023 Explicit turn-end evidence repairs assistant messages and tools that OpenCode leaves unfinished.
export function interruptedTurnToolParts(
  state: DirectoryStore,
  sessionID: string,
  now = Date.now(),
  failure?: StructuredError,
  recordedInterruption = false,
): { messageID: string; messages: Message[]; parts?: Part[] } | null {
  if ((state.form?.[sessionID] ?? []).length > 0) return null
  if ((state.permission?.[sessionID] ?? []).length > 0) return null
  const status = state.session_status?.[sessionID]
  if (status && status.type !== "idle") return null

  const messages = state.message[sessionID] ?? []
  let messageIndex = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index]
    if (candidate.role === "user") return null
    if (candidate.role !== "assistant") continue
    messageIndex = index
    break
  }
  if (messageIndex < 0) return null

  const message = messages[messageIndex]
  if (message.role !== "assistant") return null
  const completed = message.time.completed !== undefined
  if (completed && !recordedInterruption) {
    return null
  }

  const messageID = message.id
  const nextMessages = completed ? messages : [...messages]
  const error: StructuredError = failure ?? { type: "aborted", message: "aborted" }
  if (!completed) nextMessages[messageIndex] = {
    ...message,
    time: { ...message.time, completed: now },
    error,
    closedLocally: true,
  }

  let partsChanged = false
  const currentParts = state.part[messageID]
  const nextParts = currentParts?.map((part): Part => {
    if (part.type !== "tool") return part
    if (recordedInterruption && part.state.status === "error" && part.state.error === "Interrupted"
      && part.state.errorSource === undefined && part.state.errorType === undefined) {
      partsChanged = true
      return { ...part, state: { ...part.state, errorSource: "local" } }
    }
    if (part.state.status !== "pending" && part.state.status !== "running") return part
    partsChanged = true
    const start = part.state.status === "running" ? part.state.time.start : now
    return {
      ...part,
      state: {
        ...part.state,
        status: "error",
        error: "Interrupted",
        errorSource: "local",
        time: { start, end: now },
      },
    }
  })

  if (completed && !partsChanged) return null
  return {
    messageID,
    messages: nextMessages,
    parts: partsChanged ? nextParts : undefined,
  }
}

function recordedTurnEnd(
  state: DirectoryStore,
  sessionID: string,
): { outcome: SessionOutcome; error?: StructuredError } | undefined {
  const messages = state.message[sessionID] ?? []
  let end: { outcome: SessionOutcome; error?: StructuredError } | undefined
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role === "user") return undefined
    if (message.role === "assistant") return end
    if (message.role === "idle") end ??= { outcome: message.outcome, error: message.error }
  }
  return undefined
}

export function markRecordedInterruptedTurn(store: StoreApi<DirectoryStore>, sessionID: string): void {
  const state = store.getState()
  const end = recordedTurnEnd(state, sessionID)
  if (end?.outcome !== "interrupted" && end?.outcome !== "failed") return
  const interrupted = interruptedTurnToolParts(state, sessionID, Date.now(), end.outcome === "failed" ? end.error : undefined, true)
  if (!interrupted) return

  const interruptedParts = interrupted.parts
  if (!interruptedParts) {
    store.setState((current) => ({
      message: { ...current.message, [sessionID]: interrupted.messages },
    }))
    return
  }

  store.setState((current) => ({
    message: { ...current.message, [sessionID]: interrupted.messages },
    part: { ...current.part, [interrupted.messageID]: interruptedParts },
  }))
}
