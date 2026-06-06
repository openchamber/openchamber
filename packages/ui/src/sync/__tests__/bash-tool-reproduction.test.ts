/**
 * Reproduction test for #1549 — Agent stops responding after 3+ bash tool
 * invocations on Windows desktop v1.2.3.
 *
 * This test verifies that OpenChamber's event reducer does NOT auto-interrupt
 * or auto-abort a session after any number of consecutive bash tool calls.
 * The agent interruption (if it occurs on Windows) is not caused by
 * OpenChamber's event handling or session management code.
 */
import { describe, expect, test } from "bun:test"
import type { Event, Part, SessionStatus } from "@opencode-ai/sdk/v2/client"
import { applyDirectoryEvent } from "../event-reducer"
import { INITIAL_STATE, type State } from "../types"

function baseState(): State {
  return {
    ...INITIAL_STATE,
    message: {},
    part: {},
    session_status: {},
  }
}

function makeSessionStatusEvent(
  sessionID: string,
  status: SessionStatus,
): Event {
  return {
    type: "session.status",
    properties: { sessionID, status },
  } as unknown as Event
}

function makeMessageUpdatedEvent(
  sessionID: string,
  messageID: string,
): Event {
  return {
    type: "message.updated",
    properties: {
      info: {
        id: messageID,
        sessionID,
        role: "assistant",
        time: { created: Date.now() },
      },
    },
  } as unknown as Event
}

function makeBashToolPart(
  id: string,
  messageID: string,
  sessionID: string,
  status: string,
  command: string,
): Part {
  return {
    id,
    messageID,
    sessionID,
    type: "tool",
    tool: "bash",
    callID: `call_${id}` as unknown as undefined,
    command,
    state: { status },
    time: { created: Date.now() },
  } as unknown as Part
}

function makeToolPartUpdatedEvent(
  sessionID: string,
  messageID: string,
  partID: string,
  status: string,
  command: string,
): Event {
  return {
    type: "message.part.updated",
    properties: {
      part: makeBashToolPart(partID, messageID, sessionID, status, command),
    },
  } as unknown as Event
}

/**
 * Simulate N consecutive bash tool invocations on a session and verify the
 * session stays in "busy" status throughout — i.e., OpenChamber does NOT
 * auto-interrupt the agent.
 */
function simulateBashSequence(
  sessionID: string,
  messageID: string,
  count: number,
): State {
  const draft = baseState()

  // Create session
  applyDirectoryEvent(draft, {
    type: "session.created",
    properties: {
      info: {
        id: sessionID,
        slug: `slug-${sessionID}`,
        projectID: "proj_1",
        role: "assistant",
        directory: "/test",
        title: "Test session",
        version: 1,
        time: { created: Date.now() },
      },
    },
  } as unknown as Event)

  // Set status to busy
  applyDirectoryEvent(draft, makeSessionStatusEvent(sessionID, { type: "busy" }))

  // Create the assistant message
  applyDirectoryEvent(draft, makeMessageUpdatedEvent(sessionID, messageID))

  // Fire N bash tool invocations (each: running → completed)
  for (let i = 1; i <= count; i++) {
    const partID = `bash_${i}`
    // Tool starts running
    applyDirectoryEvent(
      draft,
      makeToolPartUpdatedEvent(sessionID, messageID, partID, "running", `cmd_${i}`),
    )
    // Tool completes
    applyDirectoryEvent(
      draft,
      makeToolPartUpdatedEvent(sessionID, messageID, partID, "completed", `cmd_${i}`),
    )

    // After each invocation, the session status must remain 'busy'
    expect(draft.session_status?.[sessionID]?.type).toBe("busy")
  }

  return draft
}

describe("Issue #1549 reproduction — multiple bash tool invocations", () => {
  test("4 consecutive bash tool invocations (reported threshold) do NOT auto-interrupt", () => {
    const state = simulateBashSequence("ses_1", "msg_1", 4)
    expect(state.session_status?.["ses_1"]?.type).toBe("busy")
  })

  test("10 consecutive bash tool invocations (exaggerated) do NOT auto-interrupt", () => {
    const state = simulateBashSequence("ses_2", "msg_2", 10)
    expect(state.session_status?.["ses_2"]?.type).toBe("busy")
  })

  test("session transitions to idle only when explicit session.status idle event arrives", () => {
    const draft = baseState()
    const sessionID = "ses_3"
    const messageID = "msg_3"

    // Create session
    applyDirectoryEvent(draft, {
      type: "session.created",
      properties: {
        info: {
          id: sessionID,
          slug: `slug-${sessionID}`,
          projectID: "proj_1",
          role: "assistant",
          directory: "/test",
          title: "Test session",
          version: 1,
          time: { created: Date.now() },
        },
      },
    } as unknown as Event)

    // Set busy
    applyDirectoryEvent(draft, makeSessionStatusEvent(sessionID, { type: "busy" }))

    // Create message
    applyDirectoryEvent(draft, makeMessageUpdatedEvent(sessionID, messageID))

    // 5 sequential bash tool calls
    for (let i = 1; i <= 5; i++) {
      const partID = `bash_${i}`
      applyDirectoryEvent(
        draft,
        makeToolPartUpdatedEvent(sessionID, messageID, partID, "running", `cmd_${i}`),
      )
      applyDirectoryEvent(
        draft,
        makeToolPartUpdatedEvent(sessionID, messageID, partID, "completed", `cmd_${i}`),
      )
    }

    // Still busy (OpenChamber does NOT auto-idle)
    expect(draft.session_status?.[sessionID]?.type).toBe("busy")

    // Now send an explicit idle event (what the OpenCode server sends when
    // the agent turn is done)
    applyDirectoryEvent(draft, makeSessionStatusEvent(sessionID, { type: "idle" }))

    // Now idle
    expect(draft.session_status?.[sessionID]?.type).toBe("idle")
  })

  test("session.error event also transitions to idle (normal flow)", () => {
    const draft = baseState()
    const sessionID = "ses_4"

    // Create session and set busy
    applyDirectoryEvent(draft, {
      type: "session.created",
      properties: {
        info: {
          id: sessionID,
          slug: `slug-${sessionID}`,
          projectID: "proj_1",
          role: "assistant",
          directory: "/test",
          title: "Test session",
          version: 1,
          time: { created: Date.now() },
        },
      },
    } as unknown as Event)
    applyDirectoryEvent(draft, makeSessionStatusEvent(sessionID, { type: "busy" }))

    // Add tool parts
    applyDirectoryEvent(draft, makeMessageUpdatedEvent(sessionID, "msg_4"))
    applyDirectoryEvent(
      draft,
      makeToolPartUpdatedEvent(sessionID, "msg_4", "b1", "running", "test"),
    )
    applyDirectoryEvent(
      draft,
      makeToolPartUpdatedEvent(sessionID, "msg_4", "b1", "completed", "test"),
    )

    // Send session.error
    applyDirectoryEvent(draft, {
      type: "session.error",
      properties: { sessionID },
    } as unknown as Event)

    expect(draft.session_status?.[sessionID]?.type).toBe("idle")
  })

  test("all tool parts are preserved in order after multiple bash invocations", () => {
    const draft = baseState()
    const sessionID = "ses_5"
    const messageID = "msg_5"

    // Create session
    applyDirectoryEvent(draft, {
      type: "session.created",
      properties: {
        info: {
          id: sessionID,
          slug: `slug-${sessionID}`,
          projectID: "proj_1",
          role: "assistant",
          directory: "/test",
          title: "Test session",
          version: 1,
          time: { created: Date.now() },
        },
      },
    } as unknown as Event)

    // Set busy
    applyDirectoryEvent(draft, makeSessionStatusEvent(sessionID, { type: "busy" }))

    // Create message
    applyDirectoryEvent(draft, makeMessageUpdatedEvent(sessionID, messageID))

    // Add 3 bash tools (the reported trigger count)
    for (let i = 1; i <= 3; i++) {
      const partID = `bash_${i}`
      applyDirectoryEvent(
        draft,
        makeToolPartUpdatedEvent(sessionID, messageID, partID, "running", `cmd_${i}`),
      )
      applyDirectoryEvent(
        draft,
        makeToolPartUpdatedEvent(sessionID, messageID, partID, "completed", `cmd_${i}`),
      )
    }

    // All 3 parts should be present (each running part replaced by its completed counterpart)
    expect(draft.part?.[messageID]).toBeTruthy()
    expect(draft.part?.[messageID]!.length).toBe(3)

    // Verify parts are of type tool
    const toolParts = draft.part?.[messageID]!.filter((p: { type: string }) => p.type === "tool")
    expect(toolParts.length).toBe(3)
  })

  test("multiple sessions with bash tools don't interfere with each other", () => {
    const draft = baseState()

    // Session A: 4 bash tools
    applyDirectoryEvent(draft, {
      type: "session.created",
      properties: {
        info: {
          id: "ses_a",
          slug: "slug-a",
          projectID: "proj_1",
          role: "assistant",
          directory: "/test",
          title: "Session A",
          version: 1,
          time: { created: Date.now() },
        },
      },
    } as unknown as Event)
    applyDirectoryEvent(draft, makeSessionStatusEvent("ses_a", { type: "busy" }))
    applyDirectoryEvent(draft, makeMessageUpdatedEvent("ses_a", "msg_a"))

    for (let i = 1; i <= 4; i++) {
      applyDirectoryEvent(
        draft,
        makeToolPartUpdatedEvent("ses_a", "msg_a", `a_bash_${i}`, "running", `cmd_a_${i}`),
      )
      applyDirectoryEvent(
        draft,
        makeToolPartUpdatedEvent("ses_a", "msg_a", `a_bash_${i}`, "completed", `cmd_a_${i}`),
      )
    }

    // Session B: 4 bash tools
    applyDirectoryEvent(draft, {
      type: "session.created",
      properties: {
        info: {
          id: "ses_b",
          slug: "slug-b",
          projectID: "proj_1",
          role: "assistant",
          directory: "/test",
          title: "Session B",
          version: 1,
          time: { created: Date.now() },
        },
      },
    } as unknown as Event)
    applyDirectoryEvent(draft, makeSessionStatusEvent("ses_b", { type: "busy" }))
    applyDirectoryEvent(draft, makeMessageUpdatedEvent("ses_b", "msg_b"))

    for (let i = 1; i <= 4; i++) {
      applyDirectoryEvent(
        draft,
        makeToolPartUpdatedEvent("ses_b", "msg_b", `b_bash_${i}`, "running", `cmd_b_${i}`),
      )
      applyDirectoryEvent(
        draft,
        makeToolPartUpdatedEvent("ses_b", "msg_b", `b_bash_${i}`, "completed", `cmd_b_${i}`),
      )
    }

    // Both sessions should be busy
    expect(draft.session_status?.["ses_a"]?.type).toBe("busy")
    expect(draft.session_status?.["ses_b"]?.type).toBe("busy")

    // Both should have all parts (running parts replaced by completed counterparts)
    expect(draft.part?.["msg_a"]?.length).toBe(4)
    expect(draft.part?.["msg_b"]?.length).toBe(4)
  })
})
