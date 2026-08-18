import { beforeEach, describe, expect, test } from "bun:test"
import type { Message, SessionStatus } from "@opencode-ai/sdk/v2/client"
import { INITIAL_STATE, type State } from "./types"
import {
  touchStreamingSession,
  updateChangedStreamingSessions,
  updateStreamingState,
  useStreamingStore,
} from "./streaming"
import {
  getSyncPerformanceDiagnostics,
  resetSyncPerformanceDiagnostics,
  setSyncPerformanceDiagnosticsEnabled,
} from "./performance-diagnostics"

const message = (id: string, role: "user" | "assistant"): Message => ({
  id,
  role,
} as unknown as Message)

const stateWithMessages = (messages: Message[], status: SessionStatus = { type: "busy" } as SessionStatus): State => ({
  ...INITIAL_STATE,
  session_status: {
    ses_1: status,
  },
  message: {
    ses_1: messages,
  },
})

describe("updateStreamingState", () => {
  beforeEach(() => {
    setSyncPerformanceDiagnosticsEnabled(false)
    useStreamingStore.setState({
      streamingMessageIds: new Map(),
      messageStreamStates: new Map(),
    })
  })

  test("does not mark a previous assistant message as streaming during a new user turn", () => {
    updateStreamingState(stateWithMessages([
      message("msg_user_1", "user"),
      message("msg_assistant_1", "assistant"),
    ]))
    expect(useStreamingStore.getState().streamingMessageIds.get("ses_1")).toBe("msg_assistant_1")

    updateStreamingState(stateWithMessages([
      message("msg_user_1", "user"),
      message("msg_assistant_1", "assistant"),
      message("msg_user_2", "user"),
    ]))

    expect(useStreamingStore.getState().streamingMessageIds.get("ses_1")).toBeNull()
    expect(useStreamingStore.getState().messageStreamStates.get("msg_assistant_1")?.phase).toBe("completed")
  })

  test("tracks the trailing assistant message once it appears", () => {
    updateStreamingState(stateWithMessages([
      message("msg_user_1", "user"),
      message("msg_assistant_1", "assistant"),
    ]))
    updateStreamingState(stateWithMessages([
      message("msg_user_1", "user"),
      message("msg_assistant_1", "assistant"),
      message("msg_user_2", "user"),
    ]))
    expect(useStreamingStore.getState().streamingMessageIds.get("ses_1")).toBeNull()

    updateStreamingState(stateWithMessages([
      message("msg_user_1", "user"),
      message("msg_assistant_1", "assistant"),
      message("msg_user_2", "user"),
      message("msg_assistant_2", "assistant"),
    ]))

    expect(useStreamingStore.getState().streamingMessageIds.get("ses_1")).toBe("msg_assistant_2")
  })

  test("completes the streaming message when the session becomes idle", () => {
    updateStreamingState(stateWithMessages([
      message("msg_user_1", "user"),
      message("msg_assistant_1", "assistant"),
    ]))
    expect(useStreamingStore.getState().streamingMessageIds.get("ses_1")).toBe("msg_assistant_1")

    updateStreamingState(stateWithMessages([
      message("msg_user_1", "user"),
      message("msg_assistant_1", "assistant"),
    ], { type: "idle" } as SessionStatus))

    expect(useStreamingStore.getState().streamingMessageIds.get("ses_1")).toBeNull()
    expect(useStreamingStore.getState().messageStreamStates.get("msg_assistant_1")?.phase).toBe("completed")
  })

  test("does no full or incremental scans for part-only updates across 50 busy sessions", () => {
    const session_status: NonNullable<State["session_status"]> = {}
    const messages: State["message"] = {}
    for (let index = 0; index < 50; index += 1) {
      const sessionID = `ses_${index}`
      session_status[sessionID] = { type: "busy" } as SessionStatus
      messages[sessionID] = [
        message(`msg_user_${index}`, "user"),
        message(`msg_assistant_${index}`, "assistant"),
      ]
    }
    const state: State = { ...INITIAL_STATE, session_status, message: messages }

    setSyncPerformanceDiagnosticsEnabled(true)
    updateStreamingState(state, 0)
    resetSyncPerformanceDiagnostics()

    for (let index = 0; index < 10_000; index += 1) {
      const next = { ...state, part: { ...state.part, changed: [] } }
      updateChangedStreamingSessions(next, state, 100)
      touchStreamingSession(`ses_${index % 50}`, 100)
    }

    const diagnostics = getSyncPerformanceDiagnostics()
    expect(diagnostics?.streamingFullReconciliations).toBe(0)
    expect(diagnostics?.streamingIncrementalReconciliations).toBe(0)
    expect(diagnostics?.streamingStatusEntriesVisited).toBe(0)
    expect(diagnostics?.streamingSessionCandidatesVisited).toBe(0)
    expect(diagnostics?.streamingMessagesVisited).toBe(0)
    expect(diagnostics?.streamingHeartbeatAttempts).toBe(10_000)
    expect(diagnostics?.streamingHeartbeatCommits).toBe(0)
  })

  test("updates heartbeat timestamps per session without rescanning directory state", () => {
    const state = stateWithMessages([
      message("msg_user_1", "user"),
      message("msg_assistant_1", "assistant"),
    ])
    setSyncPerformanceDiagnosticsEnabled(true)
    updateStreamingState(state, 0)
    resetSyncPerformanceDiagnostics()

    touchStreamingSession("ses_1", 999)
    touchStreamingSession("ses_1", 1_000)

    expect(useStreamingStore.getState().messageStreamStates.get("msg_assistant_1")?.lastUpdateAt).toBe(1_000)
    expect(getSyncPerformanceDiagnostics()?.streamingHeartbeatAttempts).toBe(2)
    expect(getSyncPerformanceDiagnostics()?.streamingHeartbeatCommits).toBe(1)
    expect(getSyncPerformanceDiagnostics()?.streamingFullReconciliations).toBe(0)
    expect(getSyncPerformanceDiagnostics()?.streamingSessionCandidatesVisited).toBe(0)
  })

  test("incrementally completes a replaced assistant message", () => {
    const previous = stateWithMessages([
      message("msg_user_1", "user"),
      message("msg_assistant_1", "assistant"),
    ])
    updateStreamingState(previous, 10)
    const next = stateWithMessages([
      message("msg_user_1", "user"),
      message("msg_assistant_1", "assistant"),
      message("msg_assistant_2", "assistant"),
    ])

    updateChangedStreamingSessions(next, previous, 20)

    const streaming = useStreamingStore.getState()
    expect(streaming.streamingMessageIds.get("ses_1")).toBe("msg_assistant_2")
    expect(streaming.messageStreamStates.get("msg_assistant_1")?.phase).toBe("completed")
    expect(streaming.messageStreamStates.get("msg_assistant_2")?.phase).toBe("streaming")
  })
})
