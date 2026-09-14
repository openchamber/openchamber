import { beforeEach, describe, expect, test } from "bun:test"
import { useSessionUIStore } from "@/sync/session-ui-store"
import { isAbortPromptActive } from "./useKeyboardShortcuts"

describe("double Escape abort prompt", () => {
  beforeEach(() => {
    useSessionUIStore.setState({
      currentSessionId: "session-a",
      abortPromptSessionId: null,
      abortPromptExpiresAt: null,
      sessionAbortFlags: new Map([["session-a", { timestamp: 1, acknowledged: false }]]),
    })
  })

  test("arms only the current owner and does not acknowledge an abort on the first press", () => {
    const expiresAt = useSessionUIStore.getState().armAbortPrompt(3000)
    const state = useSessionUIStore.getState()

    expect(expiresAt).not.toBeNull()
    expect(state.abortPromptSessionId).toBe("session-a")
    expect(state.sessionAbortFlags.get("session-a")?.acknowledged).toBe(false)
  })

  test("rejects repeat keydown and invalidates priming after an owner switch", () => {
    const expiresAt = useSessionUIStore.getState().armAbortPrompt(3000)
    if (expiresAt === null) throw new Error("expected current session to arm the abort prompt")
    useSessionUIStore.setState({ currentSessionId: "session-b" })
    const prompt = useSessionUIStore.getState()

    expect(isAbortPromptActive(prompt, "session-b", Date.now(), true)).toBe(false)
    expect(isAbortPromptActive(prompt, "session-b", Date.now(), false)).toBe(false)
  })
})
