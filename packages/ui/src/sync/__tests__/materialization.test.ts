import { describe, expect, test } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { getSessionMaterializationStatus, materializeSessionSnapshots } from "../materialization"

function message(id: string, sessionID = "ses_1"): Message {
  return { id, sessionID, role: "assistant", time: { created: 1 } } as Message
}

function userMessage(id: string, sessionID = "ses_1"): Message {
  return { id, sessionID, role: "user", time: { created: 1 } } as Message
}

function part(id: string, messageID: string, type = "text", text = id): Part {
  return { id, messageID, sessionID: "ses_1", type, text } as Part
}

describe("materializeSessionSnapshots", () => {
  test("marks an empty successful page as materialized", () => {
    const result = materializeSessionSnapshots(
      { message: {}, part: {} },
      "ses_1",
      [],
    )

    expect(result.message.ses_1).toEqual([])
    expect(result.messagesChanged).toBe(true)
    expect(getSessionMaterializationStatus(result, "ses_1")).toEqual({
      hasMessages: true,
      renderable: true,
      missingPartMessageIDs: [],
    })
  })

  test("materializes messages and parts together", () => {
    const result = materializeSessionSnapshots(
      { message: {}, part: {} },
      "ses_1",
      [{ info: message("msg_1"), parts: [part("prt_1", "msg_1")] }],
    )

    expect(result.message.ses_1.map((item) => item.id)).toEqual(["msg_1"])
    expect(result.part.msg_1.map((item) => item.id)).toEqual(["prt_1"])
    expect(result.messagesChanged).toBe(true)
    expect(result.partsChanged).toBe(true)
  })

  test("preserves unchanged references", () => {
    const existingMessage = message("msg_1")
    const existingPart = part("prt_1", "msg_1")
    const state = { message: { ses_1: [existingMessage] }, part: { msg_1: [existingPart] } }

    const result = materializeSessionSnapshots(
      state,
      "ses_1",
      [{ info: existingMessage, parts: [existingPart] }],
    )

    expect(result.message).toBe(state.message)
    expect(result.part).toBe(state.part)
    expect(result.messagesChanged).toBe(false)
    expect(result.partsChanged).toBe(false)
  })

  test("skips non-rendered part types", () => {
    const result = materializeSessionSnapshots(
      { message: {}, part: {} },
      "ses_1",
      [{ info: message("msg_1"), parts: [part("prt_patch", "msg_1", "patch"), part("prt_text", "msg_1")] }],
      { skipPartTypes: new Set(["patch"]) },
    )

    expect(result.part.msg_1.map((item) => item.id)).toEqual(["prt_text"])
  })

  test("preserves newer live streaming text when a stale snapshot materializes", () => {
    const livePart = part("prt_1", "msg_1", "text", "First chunk ")
    const stalePart = part("prt_1", "msg_1", "text", "")
    const state = {
      message: { ses_1: [message("msg_1")] },
      part: { msg_1: [livePart] },
    }

    const result = materializeSessionSnapshots(
      state,
      "ses_1",
      [{ info: message("msg_1"), parts: [stalePart] }],
    )

    expect(result.part.msg_1[0]).toBe(livePart)
    expect((result.part.msg_1[0] as { text?: string })?.text).toBe("First chunk ")
  })

  test("preserves live streaming parts omitted by a stale snapshot", () => {
    const livePart = part("prt_1", "msg_1", "text", "First chunk ")
    const state = {
      message: { ses_1: [message("msg_1")] },
      part: { msg_1: [livePart] },
    }

    const result = materializeSessionSnapshots(
      state,
      "ses_1",
      [{ info: message("msg_1"), parts: [] }],
    )

    expect(result.part.msg_1[0]).toBe(livePart)
  })

  test("does not preserve omitted optimistic user text parts beside server snapshot parts", () => {
    const optimisticPart = { id: "prt_optimistic", messageID: "msg_1", type: "text", text: "Hello" } as Part
    const serverPart = part("prt_server", "msg_1", "text", "Hello")
    const state = {
      message: { ses_1: [userMessage("msg_1")] },
      part: { msg_1: [optimisticPart] },
    }

    const result = materializeSessionSnapshots(
      state,
      "ses_1",
      [{ info: userMessage("msg_1"), parts: [serverPart] }],
    )

    expect(result.part.msg_1).toEqual([serverPart])
  })

  test("preserves tool part state.time.start when snapshot has state.time.end but no start", () => {
    const localTool = {
      id: "prt_1",
      messageID: "msg_1",
      sessionID: "ses_1",
      type: "tool",
      callID: "call_1",
      tool: "bash",
      state: { status: "completed", time: { start: 2000, end: 32000 } },
    } as Part
    const snapshotTool = {
      id: "prt_1",
      messageID: "msg_1",
      sessionID: "ses_1",
      type: "tool",
      callID: "call_1",
      tool: "bash",
      state: { status: "completed", time: { end: 32000 } },
    } as Part
    const state = {
      message: { ses_1: [message("msg_1")] },
      part: { msg_1: [localTool] },
    }

    const result = materializeSessionSnapshots(
      state,
      "ses_1",
      [{ info: message("msg_1"), parts: [snapshotTool] }],
    )

    expect(result.partsChanged).toBe(true)
    const merged = result.part.msg_1[0] as { state?: { time?: { start?: number; end?: number } } }
    expect(merged.state?.time?.start).toBe(2000)
    expect(merged.state?.time?.end).toBe(32000)
  })

  test("uses snapshot start time when both local and snapshot have state.time.start", () => {
    const localTool = {
      id: "prt_1",
      messageID: "msg_1",
      sessionID: "ses_1",
      type: "tool",
      callID: "call_1",
      tool: "bash",
      state: { status: "completed", time: { start: 2000, end: 32000 } },
    } as Part
    const snapshotTool = {
      id: "prt_1",
      messageID: "msg_1",
      sessionID: "ses_1",
      type: "tool",
      callID: "call_1",
      tool: "bash",
      state: { status: "completed", time: { start: 5000, end: 32000 } },
    } as Part
    const state = {
      message: { ses_1: [message("msg_1")] },
      part: { msg_1: [localTool] },
    }

    const result = materializeSessionSnapshots(
      state,
      "ses_1",
      [{ info: message("msg_1"), parts: [snapshotTool] }],
    )

    const merged = result.part.msg_1[0] as { state?: { time?: { start?: number } } }
    expect(merged.state?.time?.start).toBe(5000)
  })

  test("preserves tool part state.time.start for running tool snapshot without end time", () => {
    const localTool = {
      id: "prt_1",
      messageID: "msg_1",
      sessionID: "ses_1",
      type: "tool",
      callID: "call_1",
      tool: "bash",
      state: { status: "running", time: { start: 2000 }, input: {} },
      output: "partial output",
    } as unknown as Part
    const snapshotTool = {
      id: "prt_1",
      messageID: "msg_1",
      sessionID: "ses_1",
      type: "tool",
      callID: "call_1",
      tool: "bash",
      state: { status: "running", input: {} },
    } as unknown as Part
    const state = {
      message: { ses_1: [message("msg_1")] },
      part: { msg_1: [localTool] },
    }

    const result = materializeSessionSnapshots(
      state,
      "ses_1",
      [{ info: message("msg_1"), parts: [snapshotTool] }],
    )

    const merged = result.part.msg_1[0] as { state?: { time?: { start?: number } } }
    expect(merged.state?.time?.start).toBe(2000)
  })
})

describe("getSessionMaterializationStatus", () => {
  test("requires assistant parts for renderable cached state", () => {
    const state = {
      message: { ses_1: [message("msg_1")] },
      part: {},
    }

    expect(getSessionMaterializationStatus(state, "ses_1")).toEqual({
      hasMessages: true,
      renderable: false,
      missingPartMessageIDs: ["msg_1"],
    })
  })

  test("treats user-only cached state as renderable", () => {
    const state = {
      message: { ses_1: [{ ...message("msg_1"), role: "user" } as Message] },
      part: {},
    }

    expect(getSessionMaterializationStatus(state, "ses_1")).toEqual({
      hasMessages: true,
      renderable: true,
      missingPartMessageIDs: [],
    })
  })
})
