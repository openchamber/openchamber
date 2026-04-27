import { describe, expect, test } from "bun:test"
import type { HarnessMessage, HarnessPart, HarnessSession } from "@openchamber/harness-contracts"
import { applyDirectoryEvent } from "./event-reducer"
import { getOpenCodeCompatibleParts } from "./compat"
import { INITIAL_STATE, type State } from "./types"

function createState(): State {
  return {
    ...INITIAL_STATE,
    session: [],
    message: {},
    part: {},
  }
}

describe("applyDirectoryEvent", () => {
  test("stores chat records as neutral harness records", () => {
    const state = createState()
    const session: HarnessSession = {
      id: "ses_1",
      backendId: "opencode",
      title: "Session",
      time: { created: 1 },
    }
    const message: HarnessMessage = {
      id: "msg_1",
      sessionId: "ses_1",
      role: "assistant",
      time: { created: 2 },
    }
    const part: HarnessPart = {
      id: "part_1",
      sessionId: "ses_1",
      messageId: "msg_1",
      kind: "text",
      text: "hi",
    }

    applyDirectoryEvent(state, { type: "session.upserted", session })
    applyDirectoryEvent(state, { type: "message.upserted", message })
    applyDirectoryEvent(state, { type: "part.upserted", part })

    expect(state.session[0]).toBe(session)
    expect(state.message.ses_1?.[0]).toBe(message)
    expect(state.part.msg_1?.[0]).toBe(part)
  })

  test("applies part deltas to neutral and compatible views", () => {
    const state = createState()
    const part: HarnessPart = {
      id: "part_1",
      sessionId: "ses_1",
      messageId: "msg_1",
      kind: "text",
      text: "hi",
      raw: { id: "part_1", sessionID: "ses_1", messageID: "msg_1", type: "text", text: "hi" },
    }
    state.part.msg_1 = [part]

    applyDirectoryEvent(state, {
      type: "part.delta",
      sessionId: "ses_1",
      messageId: "msg_1",
      partId: "part_1",
      field: "text",
      delta: " there",
    })

    expect(state.part.msg_1?.[0]?.kind).toBe("text")
    expect((state.part.msg_1?.[0] as { text?: string } | undefined)?.text).toBe("hi there")
    expect((getOpenCodeCompatibleParts(state, "msg_1")[0] as { text?: string } | undefined)?.text).toBe("hi there")
  })
})
