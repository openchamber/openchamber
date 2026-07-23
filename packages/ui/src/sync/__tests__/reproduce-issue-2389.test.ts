import { describe, expect, test } from "bun:test"
import type { Event, SessionStatus } from "@opencode-ai/sdk/v2/client"
import { applyDirectoryEvent } from "../event-reducer"
import { INITIAL_STATE, type State } from "../types"
import { applyRetryOverlay } from "../../components/chat/lib/turns/applyRetryOverlay"
import type { ChatMessageEntry } from "../../components/chat/lib/turns/types"
import { isLikelyProviderAuthFailure, PROVIDER_AUTH_FAILURE_MESSAGE } from "../../lib/messages/providerAuthError"

const SESSION_ID = "ses-2389"

function state(overrides: Partial<State> = {}): State {
  return {
    ...INITIAL_STATE,
    message: {},
    part: {},
    session_status: {},
    ...overrides,
  }
}

/**
 * Reproduction: issue #2389
 *
 * When using a free model in OpenChamber, the OpenCode backend reports
 * "Free usage exceeded, subscribe to Go" as a session.status retry event.
 *
 * OpenChamber shows this as a retry overlay with "Opencode failed to send
 * a message. Retry attempt info: Free usage exceeded, subscribe to Go".
 *
 * The conversation gets stuck because:
 * 1. The session_status remains "retry" indefinitely if no session.idle
 *    or session.error event follows
 * 2. The UI shows "Retrying…" with a countdown, but the error is permanent
 * 3. No mechanism exists to gracefully handle permanent quota errors
 *    vs transient retryable errors
 */

describe("issue-2389: free usage exceeded retry stuck", () => {

  test("session stays stuck in retry state with 'Free usage exceeded' message", () => {
    const draft = state()

    // Simulate the OpenCode backend sending a session.status retry event
    // with the "Free usage exceeded" error (same as what happens with free models)
    const retryStatus: SessionStatus = {
      type: "retry",
      attempt: 1,
      message: "Free usage exceeded, subscribe to Go",
      next: 30000, // retry in 30 seconds
    }

    const retryEvent: Event = {
      type: "session.status",
      properties: {
        sessionID: SESSION_ID,
        status: retryStatus,
      },
    } as Event

    // Apply the retry event
    const changed = applyDirectoryEvent(draft, retryEvent)
    expect(changed).toBe(true)

    // Verify the session is now in retry state with the exact error message
    const storedStatus = draft.session_status[SESSION_ID]
    expect(storedStatus).toBeDefined()
    expect(storedStatus.type).toBe("retry")
    if (storedStatus.type === "retry") {
      expect(storedStatus.message).toBe("Free usage exceeded, subscribe to Go")
      expect(storedStatus.attempt).toBe(1)
      expect(storedStatus.next).toBe(30000)
    }

    // Simulate what happens when the retry fails again (OpenCode retries)
    const retryStatus2: SessionStatus = {
      type: "retry",
      attempt: 2,
      message: "Free usage exceeded, subscribe to Go",
      next: 60000, // retry in 60 seconds
    }

    const retryEvent2: Event = {
      type: "session.status",
      properties: {
        sessionID: SESSION_ID,
        status: retryStatus2,
      },
    } as Event

    applyDirectoryEvent(draft, retryEvent2)

    // Session is still stuck in retry (never transitions to idle)
    const updatedStatus = draft.session_status[SESSION_ID]
    expect(updatedStatus.type).toBe("retry")
    if (updatedStatus.type === "retry") {
      expect(updatedStatus.attempt).toBe(2)
    }

    // Without a subsequent session.idle or session.error event,
    // the session remains stuck in retry state forever.
    // The UI will show "Retrying... (attempt 2)" with countdown indefinitely.
  })

  test("retry overlay shows 'Free usage exceeded' as SessionRetry error", () => {
    // Simulate messages list where the retry overlay is applied
    const sessionId = SESSION_ID
    const userMessage: ChatMessageEntry = {
      info: {
        id: "msg_user_1",
        sessionID: sessionId,
        role: "user",
        time: { created: 1000, completed: 1001 },
      } as any,
      parts: [{ type: "text", text: "Hello, can you help me?" }] as any,
    }

    // applyRetryOverlay should insert a synthetic retry notice
    const result = applyRetryOverlay([userMessage], {
      sessionId,
      message: "Free usage exceeded, subscribe to Go",
      confirmedAt: undefined,
      fallbackTimestamp: 2000,
    })

    // The result should contain the user message and a synthetic retry notice
    expect(result.length).toBeGreaterThanOrEqual(1)

    // Find the synthetic retry notice
    const retryNotice = result.find(
      (msg) => (msg.info as any)?.role === "assistant" && (msg.info as any)?.error
    )

    expect(retryNotice).toBeDefined()
    const errorInfo = (retryNotice!.info as any)?.error as any
    expect(errorInfo).toBeDefined()
    expect(errorInfo.name).toBe("SessionRetry")
    expect(errorInfo.message).toBe("Free usage exceeded, subscribe to Go")

    // This error is what gets rendered in ChatMessage.tsx as:
    // "Opencode failed to send a message. Retry attempt info: Free usage exceeded, subscribe to Go"
  })

  test("no session.idle event means session stays retry forever", () => {
    const draft = state()

    // Set initial retry state
    const retryStatus: SessionStatus = {
      type: "retry",
      attempt: 3,
      message: "Free usage exceeded, subscribe to Go",
      next: 120000,
    }

    applyDirectoryEvent(draft, {
      type: "session.status",
      properties: { sessionID: SESSION_ID, status: retryStatus },
    } as Event)

    // The session stays in retry state across multiple reconciliation cycles
    // (simulating repeated status checks / polling)
    for (let cycle = 0; cycle < 10; cycle++) {
      const currentStatus = draft.session_status[SESSION_ID]
      expect(currentStatus.type).toBe("retry")
      if (currentStatus.type === "retry") {
        expect(currentStatus.message).toBe("Free usage exceeded, subscribe to Go")
      }

      // Re-apply the same status event (no change, no idle transition)
      const changed = applyDirectoryEvent(draft, {
        type: "session.status",
        properties: { sessionID: SESSION_ID, status: retryStatus },
      } as Event)
      expect(changed).toBe(false) // duplicate, no change
    }

    // The session is permanently stuck in retry until an explicit
    // session.idle or session.error event arrives
    expect(draft.session_status[SESSION_ID].type).toBe("retry")
  })

  test("session.error event clears retry to idle", () => {
    const draft = state()

    // Set up retry state
    applyDirectoryEvent(draft, {
      type: "session.status",
      properties: {
        sessionID: SESSION_ID,
        status: { type: "retry", attempt: 1, message: "Free usage exceeded, subscribe to Go", next: 30000 } as SessionStatus,
      },
    } as Event)
    expect(draft.session_status[SESSION_ID].type).toBe("retry")

    // OpenCode sends session.error which should clear to idle
    applyDirectoryEvent(draft, {
      type: "session.error",
      properties: { sessionID: SESSION_ID },
    } as Event)

    expect(draft.session_status[SESSION_ID].type).toBe("idle")
  })

  test("session.idle event clears retry to idle", () => {
    const draft = state()

    // Set up retry state
    applyDirectoryEvent(draft, {
      type: "session.status",
      properties: {
        sessionID: SESSION_ID,
        status: { type: "retry", attempt: 1, message: "Free usage exceeded, subscribe to Go", next: 30000 } as SessionStatus,
      },
    } as Event)

    // OpenCode sends session.idle which should clear to idle
    applyDirectoryEvent(draft, {
      type: "session.idle",
      properties: { sessionID: SESSION_ID },
    } as Event)

    expect(draft.session_status[SESSION_ID].type).toBe("idle")
  })
})
