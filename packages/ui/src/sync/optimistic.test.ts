import { describe, expect, test } from "bun:test"
import type { HarnessMessage, HarnessPart } from "@openchamber/harness-contracts"
import { applyOptimisticAdd, applyOptimisticRemove, mergeOptimisticPage, type OptimisticStore } from "./optimistic"

describe("optimistic sync records", () => {
  test("adds and removes neutral optimistic records", () => {
    const message: HarnessMessage = {
      id: "msg_1",
      sessionId: "ses_1",
      role: "user",
      time: { created: 1 },
    }
    const part: HarnessPart = {
      id: "part_1",
      sessionId: "ses_1",
      messageId: "msg_1",
      kind: "text",
      text: "hello",
    }
    const draft: OptimisticStore = { message: {}, part: {} }

    applyOptimisticAdd(draft, { sessionID: "ses_1", message, parts: [part] })

    expect(draft.message.ses_1?.[0]).toBe(message)
    expect(draft.part.msg_1?.[0]).toBe(part)

    applyOptimisticRemove(draft, { sessionID: "ses_1", messageID: "msg_1" })

    expect(draft.message.ses_1).toEqual([])
    expect(draft.part.msg_1).toBe(undefined)
  })

  test("merges neutral optimistic records into fetched pages", () => {
    const optimisticMessage: HarnessMessage = {
      id: "msg_2",
      sessionId: "ses_1",
      role: "user",
      time: { created: 2 },
    }
    const optimisticPart: HarnessPart = {
      id: "part_2",
      sessionId: "ses_1",
      messageId: "msg_2",
      kind: "text",
      text: "pending",
    }

    const merged = mergeOptimisticPage(
      { session: [], part: [], complete: true },
      [{ message: optimisticMessage, parts: [optimisticPart] }],
    )

    expect(merged.session[0]).toBe(optimisticMessage)
    expect(merged.part[0]?.part[0]).toBe(optimisticPart)
  })
})
