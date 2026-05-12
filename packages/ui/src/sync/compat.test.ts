import { describe, expect, test } from "bun:test"
import type { Message, Part, Session } from "@opencode-ai/sdk/v2/client"
import type { HarnessMessage, HarnessPart, HarnessSession } from "@openchamber/harness-contracts"
import { INITIAL_STATE, type State } from "./types"
import {
  getOpenCodeCompatibleMessages,
  getOpenCodeCompatibleParts,
  getOpenCodeCompatibleSessions,
  getCompatibleMessageCreatedAt,
  getCompatibleMessageId,
  getCompatibleMessageRole,
  getCompatiblePartEndedAt,
  getCompatiblePartKind,
  getCompatiblePartText,
  getCompatibleSessionDirectory,
  getCompatibleSessionParentId,
  getCompatibleSessionProjectWorktree,
  getCompatibleSessionShareUrl,
  getCompatibleSessionSlug,
  getCompatibleSessionSummary,
  getCompatibleToolName,
  getCompatibleToolStatus,
  toOpenCodeCompatibleMessage,
  toOpenCodeCompatiblePart,
  toOpenCodeCompatibleSession,
} from "./compat"

describe("sync compatibility accessors", () => {
  test("preserve OpenCode session/message/part references", () => {
    const session = { id: "ses_1", title: "Session", projectID: "proj", time: { created: 1 } } as Session
    const message = { id: "msg_1", sessionID: "ses_1", role: "user", time: { created: 2 } } as Message
    const part = { id: "part_1", sessionID: "ses_1", messageID: "msg_1", type: "text", text: "hi" } as Part
    expect(toOpenCodeCompatibleSession(session)).toBe(session)
    expect(toOpenCodeCompatibleMessage(message)).toBe(message)
    expect(toOpenCodeCompatiblePart(part)).toBe(part)
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

  test("reads session fields from neutral records and raw OpenCode payloads", () => {
    const session: HarnessSession = {
      id: "ses_1",
      backendId: "opencode",
      title: "Session",
      directory: "/repo/worktree",
      parentId: "ses_parent",
      time: { created: 1, archived: 2 },
      raw: {
        id: "ses_1",
        slug: "session-slug",
        share: { url: "https://share.example/ses_1" },
        summary: { text: "summary" },
        project: { worktree: "/repo" },
      },
    }

    expect(getCompatibleSessionDirectory(session)).toBe("/repo/worktree")
    expect(getCompatibleSessionParentId(session)).toBe("ses_parent")
    expect(getCompatibleSessionShareUrl(session)).toBe("https://share.example/ses_1")
    expect(getCompatibleSessionSlug(session)).toBe("session-slug")
    expect(getCompatibleSessionSummary(session)).toEqual({ text: "summary" })
    expect(getCompatibleSessionProjectWorktree(session)).toBe("/repo")
  })

  test("reads message and part fields from neutral records and OpenCode payloads", () => {
    const message: HarnessMessage = {
      id: "msg_1",
      sessionId: "ses_1",
      role: "assistant",
      time: { created: 2 },
    }
    const textPart: HarnessPart = {
      id: "part_1",
      sessionId: "ses_1",
      messageId: "msg_1",
      kind: "text",
      text: "hello",
      raw: { time: { end: 3 } },
    }
    const toolPart: HarnessPart = {
      id: "part_2",
      sessionId: "ses_1",
      messageId: "msg_1",
      kind: "tool",
      tool: { id: "tool_1", name: "bash", category: "shell", status: "running" },
    }
    const legacyPart = { id: "part_3", sessionID: "ses_1", messageID: "msg_1", type: "text", text: "legacy" } as Part

    expect(getCompatibleMessageId(message)).toBe("msg_1")
    expect(getCompatibleMessageRole(message)).toBe("assistant")
    expect(getCompatibleMessageCreatedAt(message)).toBe(2)
    expect(getCompatiblePartKind(textPart)).toBe("text")
    expect(getCompatiblePartText(textPart)).toBe("hello")
    expect(getCompatiblePartEndedAt(textPart)).toBe(3)
    expect(getCompatiblePartKind(toolPart)).toBe("tool")
    expect(getCompatibleToolName(toolPart)).toBe("bash")
    expect(getCompatibleToolStatus(toolPart)).toBe("running")
    expect(getCompatiblePartKind(legacyPart)).toBe("text")
    expect(getCompatiblePartText(legacyPart)).toBe("legacy")
  })
})
