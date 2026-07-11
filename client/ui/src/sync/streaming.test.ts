import { beforeEach, describe, expect, test } from "bun:test"
import type { Message, SessionStatus } from "@opencode-ai/sdk/v2/client"
import { INITIAL_STATE, type State } from "./types"
import { updateStreamingState, useStreamingStore } from "./streaming"

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
})
