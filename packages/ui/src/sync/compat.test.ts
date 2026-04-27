import { describe, expect, test } from "bun:test"
import type { Message, Part, Session } from "@opencode-ai/sdk/v2/client"
import type { HarnessMessage, HarnessPart, HarnessSession } from "@openchamber/harness-contracts"
import { INITIAL_STATE, type State } from "./types"
import {
  getOpenCodeCompatibleMessages,
  getOpenCodeCompatibleParts,
  getOpenCodeCompatibleSession,
  getOpenCodeCompatibleSessions,
} from "./compat"

describe("sync compatibility accessors", () => {
  test("preserve OpenCode session/message/part references", () => {
    const session = { id: "ses_1", title: "Session", projectID: "proj", time: { created: 1 } } as Session
    const message = { id: "msg_1", sessionID: "ses_1", role: "user", time: { created: 2 } } as Message
    const part = { id: "part_1", sessionID: "ses_1", messageID: "msg_1", type: "text", text: "hi" } as Part
    const state = {
      ...INITIAL_STATE,
      session: [session],
      message: { ses_1: [message] },
      part: { msg_1: [part] },
    }

    expect(getOpenCodeCompatibleSessions(state)[0]).toBe(session)
    expect(getOpenCodeCompatibleSession(state, "ses_1")).toBe(session)
    expect(getOpenCodeCompatibleMessages(state, "ses_1")[0]).toBe(message)
    expect(getOpenCodeCompatibleParts(state, "msg_1")[0]).toBe(part)
  })

  test("maps neutral session/message/part records to OpenCode-compatible views", () => {
    const session: HarnessSession = {
      id: "ses_1",
      backendId: "opencode",
      title: "Session",
      parentId: "ses_parent",
      time: { created: 1 },
    }
    const message: HarnessMessage = {
      id: "msg_1",
      sessionId: "ses_1",
      role: "assistant",
      time: { created: 2, completed: 3 },
      finish: "stop",
    }
    const part: HarnessPart = {
      id: "part_1",
      sessionId: "ses_1",
      messageId: "msg_1",
      kind: "text",
      text: "hi",
    }
    const state = {
      ...INITIAL_STATE,
      session: [session],
      message: { ses_1: [message] },
      part: { msg_1: [part] },
    } as unknown as State

    expect({
      id: getOpenCodeCompatibleSessions(state)[0]?.id,
      title: getOpenCodeCompatibleSessions(state)[0]?.title,
      parentID: (getOpenCodeCompatibleSessions(state)[0] as { parentID?: string } | undefined)?.parentID,
    }).toEqual({
      id: "ses_1",
      title: "Session",
      parentID: "ses_parent",
    })
    expect({
      id: getOpenCodeCompatibleMessages(state, "ses_1")[0]?.id,
      sessionID: (getOpenCodeCompatibleMessages(state, "ses_1")[0] as { sessionID?: string } | undefined)?.sessionID,
      role: getOpenCodeCompatibleMessages(state, "ses_1")[0]?.role,
      finish: (getOpenCodeCompatibleMessages(state, "ses_1")[0] as { finish?: string } | undefined)?.finish,
    }).toEqual({
      id: "msg_1",
      sessionID: "ses_1",
      role: "assistant",
      finish: "stop",
    })
    expect({
      id: getOpenCodeCompatibleParts(state, "msg_1")[0]?.id,
      sessionID: (getOpenCodeCompatibleParts(state, "msg_1")[0] as { sessionID?: string } | undefined)?.sessionID,
      messageID: (getOpenCodeCompatibleParts(state, "msg_1")[0] as { messageID?: string } | undefined)?.messageID,
      type: getOpenCodeCompatibleParts(state, "msg_1")[0]?.type,
      text: (getOpenCodeCompatibleParts(state, "msg_1")[0] as { text?: string } | undefined)?.text,
    }).toEqual({
      id: "part_1",
      sessionID: "ses_1",
      messageID: "msg_1",
      type: "text",
      text: "hi",
    })
  })
})
