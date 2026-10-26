import { describe, expect, test } from "bun:test"
import type { Message, Part } from "@/lib/opencode/model"
import { hasActiveFormToolInCurrentTurn, recoverPendingFormWithRetry } from "./form-recovery"

const message = (role: "user" | "assistant", parts: Part[] = []) => ({
  info: { id: `${role}-${parts.length}`, sessionID: "ses_1", role } as Message,
  parts,
})

const formTool = (status: "pending" | "running" | "completed"): Part => {
  const state = status === "pending"
    ? { status: "pending" as const, input: {}, raw: "" }
    : status === "running"
      ? { status: "running" as const, input: {}, time: { start: 1 } }
      : { status: "completed" as const, input: {}, output: "", time: { start: 1, end: 2 } }
  return {
    id: `tool-${status}`,
    sessionID: "ses_1",
    messageID: "assistant-1",
    type: "tool",
    callID: `call-${status}`,
    tool: "question",
    state,
  }
}

describe("hasActiveFormToolInCurrentTurn", () => {
  test("detects a pending or running form in the current turn", () => {
    expect(hasActiveFormToolInCurrentTurn([message("user"), message("assistant", [formTool("pending")])])).toBe(true)
    expect(hasActiveFormToolInCurrentTurn([message("user"), message("assistant", [formTool("running")])])).toBe(true)
  })

  test("ignores completed forms and active forms from an older turn", () => {
    expect(hasActiveFormToolInCurrentTurn([message("assistant", [formTool("completed")])])).toBe(false)
    expect(hasActiveFormToolInCurrentTurn([
      message("assistant", [formTool("running")]),
      message("user"),
      message("assistant"),
    ])).toBe(false)
  })
})

describe("recoverPendingFormWithRetry", () => {
  test("retries the cold-start inconsistency with bounded delays and stops on recovery", async () => {
    const delays: number[] = []
    let attempts = 0

    const recovered = await recoverPendingFormWithRetry(
      async () => {
        attempts += 1
        return attempts === 3
      },
      { sleep: async (delayMs) => { delays.push(delayMs) } },
    )

    expect(recovered).toBe(true)
    expect(attempts).toBe(3)
    expect(delays).toEqual([500, 1500])
  })

  test("does no more work after cancellation", async () => {
    let attempts = 0
    const recovered = await recoverPendingFormWithRetry(
      async () => {
        attempts += 1
        return false
      },
      { isCancelled: () => true, sleep: async () => undefined },
    )

    expect(recovered).toBe(false)
    expect(attempts).toBe(0)
  })
})
