/**
 * Reproduction test for issue #2371: UI remains stuck when OpenCode shell
 * timeout leaves a subagent tool part running.
 *
 * The scenario:
 * 1. A parent session has a task tool part with state.status: "running"
 * 2. A child session runs a command with a timeout
 * 3. OpenCode kills the child process after timeout but does NOT send a
 *    final message.part.updated for the parent's task tool part
 * 4. The child session may transition to idle (session.idle)
 * 5. The parent session may still be shown as idle (session_status idle)
 * 6. BUT the tool part stays state.status: "running" indefinitely
 * 7. The UI shows "Waiting for subagent activity..." with no timeout
 *
 * This test verifies that NO client-side defensive mechanism exists to
 * transition a stale running tool part to a final status.
 */

import { describe, expect, test } from "bun:test"
import type { Part, SessionStatus, Event } from "@opencode-ai/sdk/v2/client"
import { applyDirectoryEvent } from "../event-reducer"
import type { State } from "../types"

/**
 * Helper to create a minimal State for testing.
 */
function state(overrides: Partial<State> = {}): State {
  return {
    status: "complete",
    agent: [],
    command: [],
    project: "",
    projectMeta: undefined,
    icon: undefined,
    provider: { all: [], connected: [], default: {} },
    config: {} as any,
    path: { state: "", config: "", worktree: "", directory: "", home: "" },
    session: [],
    sessionTotal: 0,
    session_status: {},
    session_diff: {},
    todo: {},
    message: {},
    part: {},
    permission: {},
    question: {},
    mcp: {},
    lsp: [],
    vcs: undefined,
    limit: 5,
    sessionEventRevision: {},
    sessionDeletedRevision: {},
    ...overrides,
  }
}

/**
 * Helper to create a task tool part in running status.
 * This is the state the part would be in when a subagent is actively working.
 */
function runningTaskToolPart(): Part {
  return {
    id: "task_1",
    messageID: "msg_parent",
    sessionID: "ses_parent",
    type: "tool",
    tool: "task",
    state: {
      status: "running",
      time: { start: 1000 },
      input: { subagent_type: "code" },
    },
  } as unknown as Part
}

/**
 * Helper to create a completed task tool part.
 * This is what the server SHOULD send when the subagent finishes.
 */
function completedTaskToolPart(): Part {
  return {
    id: "task_1",
    messageID: "msg_parent",
    sessionID: "ses_parent",
    type: "tool",
    tool: "task",
    state: {
      status: "completed",
      time: { start: 1000, end: 2000 },
      input: { subagent_type: "code" },
      metadata: { session_id: "ses_child" },
    },
  } as unknown as Part
}

describe("Reproduction: stale running tool part after shell timeout (#2371)", () => {
  test("1. Tool part stays `running` after child session goes idle — no defensive transition", () => {
    // Setup: parent session with messages and a running task tool part
    const draft = state({
      session: [
        { id: "ses_parent", time: { created: 1 } } as any,
        { id: "ses_child", time: { created: 2 }, parentID: "ses_parent" } as any,
      ],
      message: {
        ses_parent: [
          { id: "msg_parent", sessionID: "ses_parent", role: "assistant", time: { created: 10 } } as any,
        ],
        ses_child: [
          { id: "msg_child", sessionID: "ses_child", role: "assistant", time: { created: 20 } } as any,
        ],
      },
      part: {
        msg_parent: [runningTaskToolPart()],
      },
      session_status: {
        ses_parent: { type: "busy" },
        ses_child: { type: "busy" },
      },
    })

    // Simulate: the child session transitions to idle (subagent finished or timed out),
    // but no message.part.updated for the parent's task tool part arrives.
    const idleEvent: Event = {
      type: "session.idle",
      properties: { sessionID: "ses_child" },
    } as any

    const result = applyDirectoryEvent(draft, idleEvent)
    expect(result).toBe(true) // Event was applied

    // The session_status for child is now idle
    expect(draft.session_status.ses_child).toEqual({ type: "idle" })

    // BUT: The parent's task tool part is STILL running - no defensive transition
    const parentParts = draft.part.msg_parent
    expect(parentParts).toBeDefined()
    expect(parentParts!.length).toBe(1)
    const partState = parentParts![0] as any
    expect(partState.state?.status).toBe("running")
    // CRITICAL BUG: Even though the child session has been idle,
    // the parent's tool part remains "running" with no end time.
    // The UI will show "Waiting for subagent activity..." forever.
    // BUG: no end time because the part never got a final update
    expect(partState.state?.time?.end === undefined).toBe(true)

    // Simulate parent session also going idle
    const parentIdleEvent: Event = {
      type: "session.status",
      properties: { sessionID: "ses_parent", status: { type: "idle" } as SessionStatus },
    } as any
    applyDirectoryEvent(draft, parentIdleEvent)
    expect(draft.session_status.ses_parent).toEqual({ type: "idle" })

    // TOOL PART IS STILL RUNNING despite session being idle:
    const parentPartsAfterIdle = draft.part.msg_parent
    expect(parentPartsAfterIdle![0]).toBe(parentParts![0]) // Same reference, not updated
    const partStateAfterIdle = parentPartsAfterIdle![0] as any
    expect(partStateAfterIdle.state?.status).toBe("running")
    // BUG CONFIRMED: part remains "running" even after session goes idle
  })

  test("2. No code transitions `running` to `timeout` based on wall-clock staleness", () => {
    // Setup: parent session with a tool part stuck in "running"
    const draft = state({
      session: [{ id: "ses_parent", time: { created: 1 } } as any],
      message: {
        ses_parent: [
          { id: "msg_parent", sessionID: "ses_parent", role: "assistant", time: { created: 10 } } as any,
        ],
      },
      part: {
        msg_parent: [runningTaskToolPart()],
      },
      session_status: {
        ses_parent: { type: "busy" },
      },
    })

    // Simulate 5 minutes passing: no events arrive from server
    // The watchdog polls session_status every 5s, but only checks session-level status
    // No code inspects individual tool part status durations

    // Apply a session.status idle event (simulates the watchdog eventually 
    // catching up that the session is really idle)
    const idleEvent: Event = {
      type: "session.status",
      properties: { sessionID: "ses_parent", status: { type: "idle" } as SessionStatus },
    } as any
    applyDirectoryEvent(draft, idleEvent)

    // Session is idle now
    expect(draft.session_status.ses_parent).toEqual({ type: "idle" })

    // But the tool part is STILL running - no staleness/timeout check was performed
    const parentParts = draft.part.msg_parent
    const partState = parentParts![0] as any
    expect(partState.state?.status).toBe("running")
    // There should be a check like:
    //   if (status === "running" && !time?.end) { transition to timeout }
    // But there is none.

    // BUG CONFIRMED: No defensive timeout mechanism for stuck tool parts
  })

  test("3. Parent materialization triggered by child idle does not fix the part if server snapshot also stale", () => {
    const draft = state({
      session: [
        { id: "ses_parent", time: { created: 1 } } as any,
        { id: "ses_child", time: { created: 2 }, parentID: "ses_parent" } as any,
      ],
      message: {
        ses_parent: [
          { id: "msg_parent", sessionID: "ses_parent", role: "assistant", time: { created: 10 } } as any,
        ],
      },
      part: {
        msg_parent: [runningTaskToolPart()],
      },
      session_status: {
        ses_parent: { type: "busy" },
        ses_child: { type: "busy" },
      },
    })

    // Simulate child session idle -> parent materialization applies a snapshot
    // that also has the part as "running" (server didn't update it either).
    const materializedPartUpdate: Event = {
      type: "message.part.updated",
      properties: {
        part: {
          id: "task_1",
          messageID: "msg_parent",
          sessionID: "ses_parent",
          type: "tool",
          tool: "task",
          state: {
            status: "running",  // Server also didn't update it
            time: { start: 1000 },
            input: { subagent_type: "code" },
          },
        },
      },
    } as any

    const result = applyDirectoryEvent(draft, materializedPartUpdate)
    // shouldPreserveExistingPart: both are running - not a final state regression.
    // So the update is accepted (returns true), and the part stays running.
    expect(result).toBe(true)

    const parentParts = draft.part.msg_parent
    const partState = parentParts![0] as any
    expect(partState.state?.status).toBe("running")
    // Still running - materialization didn't help because the server also
    // has stale data
  })

  test("4. Server fix would be to send final part update — currently no client fallback", () => {
    // This test verifies that IF the server sends the correct final state,
    // the client handles it properly (happy path)
    const draft = state({
      session: [
        { id: "ses_parent", time: { created: 1 } } as any,
      ],
      message: {
        ses_parent: [
          { id: "msg_parent", sessionID: "ses_parent", role: "assistant", time: { created: 10 } } as any,
        ],
      },
      part: {
        msg_parent: [runningTaskToolPart()],
      },
      session_status: {
        ses_parent: { type: "busy" },
      },
    })

    // Server sends the fix: tool part transitions to "timeout"
    const timeoutPartUpdate: Event = {
      type: "message.part.updated",
      properties: {
        part: {
          id: "task_1",
          messageID: "msg_parent",
          sessionID: "ses_parent",
          type: "tool",
          tool: "task",
          state: {
            status: "timeout",
            time: { start: 1000, end: 2200000 },
            input: { subagent_type: "code" },
            error: "timeout",
          },
        },
      },
    } as any

    const result = applyDirectoryEvent(draft, timeoutPartUpdate)
    expect(result).toBe(true)

    const parentParts = draft.part.msg_parent
    const partState = parentParts![0] as any
    expect(partState.state?.status).toBe("timeout")
    // This is correct behavior - when server does send the update,
    // the client processes it properly.

    // But the problem is: the server DOESN'T always send this update.
    // See test 2 for the gap.
  })

  test("5. shouldPreserveExistingPart prevents finalized->running regression but nothing prevents running->stuck", () => {
    // This proves the only protection is against final status regression,
    // not against stuck non-final statuses
    
    const draft = state({
      session: [{ id: "ses_parent", time: { created: 1 } } as any],
      message: {
        ses_parent: [
          { id: "msg_parent", sessionID: "ses_parent", role: "assistant", time: { created: 10 } } as any,
        ],
      },
      part: {
        msg_parent: [completedTaskToolPart()],
      },
      session_status: {
        ses_parent: { type: "idle" },
      },
    })

    // Attempt to regress the completed part back to "running"
    const badUpdate: Event = {
      type: "message.part.updated",
      properties: {
        part: {
          id: "task_1",
          messageID: "msg_parent",
          sessionID: "ses_parent",
          type: "tool",
          tool: "task",
          state: {
            status: "running",  // Trying to regress to non-final
            time: { start: 1000 },
            input: { subagent_type: "code" },
          },
        },
      },
    } as any

    // shouldPreserveExistingPart returns true (existing is finalized, next is not)
    // So the update is REJECTED - part stays completed
    const result = applyDirectoryEvent(draft, badUpdate)
    expect(result).toBe(false)

    const parentParts = draft.part.msg_parent
    const partState = parentParts![0] as any
    expect(partState.state?.status).toBe("completed")

    // KEY INSIGHT: The protection is ONE-WAY - it only prevents final->non-final
    // regression. There is NO protection against a "running" part staying
    // "running" forever when no further updates arrive.
  })
})
