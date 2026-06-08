import { beforeEach, describe, expect, test } from "bun:test"
import type { Event, Part, PermissionRequest, QuestionRequest, SessionStatus } from "@opencode-ai/sdk/v2/client"
import { applyDirectoryEvent, clearAllChunks, _getChunksByPartFieldForTest } from "../event-reducer"
import { INITIAL_STATE, type State } from "../types"

function state(overrides: Partial<State> = {}): State {
  return {
    ...INITIAL_STATE,
    message: {},
    part: {},
    session_status: {},
    ...overrides,
  }
}

function deltaEvent(): Event {
  return {
    type: "message.part.delta",
    properties: {
      messageID: "msg_1",
      partID: "prt_1",
      field: "text",
      delta: "hello",
    },
  } as Event
}

function partUpdatedEvent(): Event {
  return {
    type: "message.part.updated",
    properties: {
      part: {
        id: "prt_1",
        messageID: "msg_1",
        sessionID: "ses_1",
        type: "text",
        text: "hello",
      },
    },
  } as Event
}

function topLevelSessionOnlyPartUpdatedEvent(): Event {
  return {
    type: "message.part.updated",
    properties: {
      sessionID: "ses_1",
      part: {
        id: "prt_1",
        messageID: "msg_1",
        type: "text",
        text: "hello",
      },
    },
  } as Event
}

describe("applyDirectoryEvent", () => {
  test("returns typed materialization when delta arrives before parts", () => {
    const result = applyDirectoryEvent(state(), deltaEvent())

    expect(result).toEqual({
      changed: false,
      materialization: { type: "incomplete-session-snapshot", messageID: "msg_1", partID: "prt_1" },
    })
  })

  test("returns typed materialization when delta part is missing", () => {
    const result = applyDirectoryEvent(
      state({ part: { msg_1: [{ id: "prt_2", messageID: "msg_1", type: "text", text: "" } as Part] } }),
      deltaEvent(),
    )

    expect(result).toEqual({
      changed: false,
      materialization: { type: "incomplete-session-snapshot", messageID: "msg_1", partID: "prt_1" },
    })
  })

  test("applies part update and requests materialization when owning message is absent", () => {
    const draft = state()
    const result = applyDirectoryEvent(draft, partUpdatedEvent())

    expect(draft.part.msg_1.map((item) => item.id)).toEqual(["prt_1"])
    expect(result).toEqual({
      changed: true,
      materialization: {
        type: "incomplete-session-snapshot",
        sessionID: "ses_1",
        messageID: "msg_1",
        partID: "prt_1",
      },
    })
  })

  test("uses top-level session id and part message id for part update materialization", () => {
    const draft = state()
    const result = applyDirectoryEvent(draft, topLevelSessionOnlyPartUpdatedEvent())

    expect(draft.part.msg_1.map((item) => item.id)).toEqual(["prt_1"])
    expect(result).toEqual({
      changed: true,
      materialization: {
        type: "incomplete-session-snapshot",
        sessionID: "ses_1",
        messageID: "msg_1",
        partID: "prt_1",
      },
    })
  })

  test("uses top-level session id for delta materialization", () => {
    const result = applyDirectoryEvent(state(), {
      type: "message.part.delta",
      properties: {
        sessionID: "ses_1",
        messageID: "msg_1",
        partID: "prt_1",
        field: "text",
        delta: "hello",
      },
    } as Event)

    expect(result).toEqual({
      changed: false,
      materialization: { type: "incomplete-session-snapshot", sessionID: "ses_1", messageID: "msg_1", partID: "prt_1" },
    })
  })

  test("applies part update without materialization when owning message exists", () => {
    const draft = state({
      message: { ses_1: [{ id: "msg_1", sessionID: "ses_1", role: "assistant", time: { created: 1 } } as never] },
    })
    const result = applyDirectoryEvent(draft, partUpdatedEvent())

    expect(draft.part.msg_1.map((item) => item.id)).toEqual(["prt_1"])
    expect(result).toBe(true)
  })

  test("skips duplicate session status events", () => {
    const draft = state()
    const busyStatus = { type: "busy" } as SessionStatus
    const event = {
      type: "session.status",
      properties: { sessionID: "ses_1", status: busyStatus },
    } as Event

    expect(applyDirectoryEvent(draft, event)).toBe(true)
    const statusRef = draft.session_status.ses_1

    expect(applyDirectoryEvent(draft, event)).toBe(false)
    expect(draft.session_status.ses_1).toBe(statusRef)
  })

  test("skips duplicate session idle events", () => {
    const draft = state()
    const event = {
      type: "session.idle",
      properties: { sessionID: "ses_1" },
    } as Event

    expect(applyDirectoryEvent(draft, event)).toBe(true)
    const statusRef = draft.session_status.ses_1

    expect(applyDirectoryEvent(draft, event)).toBe(false)
    expect(draft.session_status.ses_1).toBe(statusRef)
  })

  test("skips duplicate session error idle-state events", () => {
    const draft = state()
    const event = {
      type: "session.error",
      properties: { sessionID: "ses_1" },
    } as Event

    expect(applyDirectoryEvent(draft, event)).toBe(true)
    const statusRef = draft.session_status.ses_1

    expect(applyDirectoryEvent(draft, event)).toBe(false)
    expect(draft.session_status.ses_1).toBe(statusRef)
  })

  test("detects retry status metadata changes", () => {
    const draft = state({
      session_status: {
        ses_1: { type: "retry", attempt: 1, message: "rate limited", next: 10 } as SessionStatus,
      },
    })

    const event = {
      type: "session.status",
      properties: {
        sessionID: "ses_1",
        status: { type: "retry", attempt: 2, message: "rate limited", next: 20 } as SessionStatus,
      },
    } as Event

    expect(applyDirectoryEvent(draft, event)).toBe(true)
    expect((draft.session_status.ses_1 as Extract<SessionStatus, { type: "retry" }>).attempt).toBe(2)
  })

  test("updates permission request arrays immutably", () => {
    const initialPermissions = [
      { id: "perm_1", sessionID: "ses_1" } as PermissionRequest,
    ]
    const draft = state({ permission: { ses_1: initialPermissions } })

    applyDirectoryEvent(draft, {
      type: "permission.asked",
      properties: { id: "perm_2", sessionID: "ses_1" } as PermissionRequest,
    } as Event)

    expect(draft.permission.ses_1).not.toBe(initialPermissions)
    expect(draft.permission.ses_1.map((item) => item.id)).toEqual(["perm_1", "perm_2"])

    const afterAsk = draft.permission.ses_1
    applyDirectoryEvent(draft, {
      type: "permission.replied",
      properties: { sessionID: "ses_1", requestID: "perm_1" },
    } as Event)

    expect(draft.permission.ses_1).not.toBe(afterAsk)
    expect(draft.permission.ses_1.map((item) => item.id)).toEqual(["perm_2"])
  })

  test("updates question request arrays immutably", () => {
    const initialQuestions = [
      { id: "ques_1", sessionID: "ses_1" } as QuestionRequest,
    ]
    const draft = state({ question: { ses_1: initialQuestions } })

    applyDirectoryEvent(draft, {
      type: "question.asked",
      properties: { id: "ques_2", sessionID: "ses_1" } as QuestionRequest,
    } as Event)

    expect(draft.question.ses_1).not.toBe(initialQuestions)
    expect(draft.question.ses_1.map((item) => item.id)).toEqual(["ques_1", "ques_2"])

    const afterAsk = draft.question.ses_1
    applyDirectoryEvent(draft, {
      type: "question.replied",
      properties: { sessionID: "ses_1", requestID: "ques_1" },
    } as Event)

    expect(draft.question.ses_1).not.toBe(afterAsk)
    expect(draft.question.ses_1.map((item) => item.id)).toEqual(["ques_2"])

    const afterReply = draft.question.ses_1
    applyDirectoryEvent(draft, {
      type: "question.rejected",
      properties: { sessionID: "ses_1", requestID: "ques_2" },
    } as Event)

    expect(draft.question.ses_1).not.toBe(afterReply)
    expect(draft.question.ses_1).toEqual([])
  })
})

describe("chunked text accumulator", () => {
  beforeEach(() => {
    _getChunksByPartFieldForTest().clear()
  })

  test("long stream accumulation is correct", () => {
    const draft = state({ part: { msg_1: [{ id: "prt_1", messageID: "msg_1", type: "text", text: "" } as Part] } })
    const evt = deltaEvent()
    evt.properties.delta = "a"
    for (let i = 0; i < 500; i++) {
      applyDirectoryEvent(draft, evt)
    }
    expect(draft.part.msg_1[0].text).toBe("a".repeat(500))
  })

  test("dedup against last chunk tail works", () => {
    const draft = state({ part: { msg_1: [{ id: "prt_1", messageID: "msg_1", type: "text", text: "" } as Part] } })
    // First: part.updated to set text "hello" with dedup metadata
    const initial: Event = {
      type: "message.part.updated",
      properties: {
        part: { id: "prt_1", messageID: "msg_1", sessionID: "ses_1", type: "text", text: "hello", __dedupeNextDeltaFields: ["text"] },
      },
    } as unknown as Event
    applyDirectoryEvent(draft, initial)

    // Now delta "lo world" — "lo" overlaps with "hello" tail
    const evt = deltaEvent()
    evt.properties.delta = "lo world"
    applyDirectoryEvent(draft, evt)

    expect(draft.part.msg_1[0].text).toBe("hello world")
  })

  test("no-overlap dedup falls through to full append", () => {
    const draft = state({ part: { msg_1: [{ id: "prt_1", messageID: "msg_1", type: "text", text: "" } as Part] } })
    const initial: Event = {
      type: "message.part.updated",
      properties: {
        part: { id: "prt_1", messageID: "msg_1", sessionID: "ses_1", type: "text", text: "foo", __dedupeNextDeltaFields: ["text"] },
      },
    } as unknown as Event
    applyDirectoryEvent(draft, initial)

    const evt = deltaEvent()
    evt.properties.delta = "bar"
    applyDirectoryEvent(draft, evt)

    expect(draft.part.msg_1[0].text).toBe("foobar")
  })

  test("non-dedup append works", () => {
    const draft = state({ part: { msg_1: [{ id: "prt_1", messageID: "msg_1", type: "text", text: "" } as Part] } })
    const evt = deltaEvent()
    evt.properties.delta = "foo"
    applyDirectoryEvent(draft, evt)
    evt.properties.delta = "bar"
    applyDirectoryEvent(draft, evt)

    expect(draft.part.msg_1[0].text).toBe("foobar")
  })

  test("message.part.updated resets chunks", () => {
    const draft = state({ part: { msg_1: [{ id: "prt_1", messageID: "msg_1", type: "text", text: "" } as Part] } })
    // Accumulate some deltas
    const evt = deltaEvent()
    evt.properties.delta = "hello "
    applyDirectoryEvent(draft, evt)
    evt.properties.delta = "world"
    applyDirectoryEvent(draft, evt)
    expect(draft.part.msg_1[0].text).toBe("hello world")

    // part.updated replaces full text
    const updated: Event = {
      type: "message.part.updated",
      properties: {
        part: { id: "prt_1", messageID: "msg_1", sessionID: "ses_1", type: "text", text: "fresh" },
      },
    } as Event
    applyDirectoryEvent(draft, updated)

    // Subsequent delta should append to "fresh" not old chunks
    evt.properties.delta = "ly"
    applyDirectoryEvent(draft, evt)
    expect(draft.part.msg_1[0].text).toBe("freshly")
  })

  test("message.part.removed clears chunks for that part", () => {
    const draft = state({ part: { msg_1: [{ id: "prt_1", messageID: "msg_1", type: "text", text: "" } as Part] } })
    // Accumulate deltas to create chunk entries
    const evt = deltaEvent()
    evt.properties.delta = "a"
    applyDirectoryEvent(draft, evt)
    evt.properties.delta = "b"
    applyDirectoryEvent(draft, evt)

    expect(_getChunksByPartFieldForTest().size).toBeGreaterThan(0)

    // Remove the part
    const removeEvt: Event = {
      type: "message.part.removed",
      properties: { messageID: "msg_1", partID: "prt_1" },
    } as Event
    applyDirectoryEvent(draft, removeEvt)

    // Assert no chunks remain for that part
    const remaining = [..._getChunksByPartFieldForTest().keys()].filter((k) => k.startsWith("msg_1:prt_1:"))
    expect(remaining).toEqual([])
  })

  test("message.removed clears all chunks for that message", () => {
    const draft = state({ part: { msg_1: [{ id: "prt_1", messageID: "msg_1", type: "text", text: "" } as Part] } })
    // Accumulate deltas to create chunk entries
    const evt = deltaEvent()
    evt.properties.delta = "a"
    applyDirectoryEvent(draft, evt)

    expect(_getChunksByPartFieldForTest().size).toBeGreaterThan(0)

    // Remove the message
    const removeMsg: Event = {
      type: "message.removed",
      properties: { sessionID: "ses_1", messageID: "msg_1" },
    } as Event
    applyDirectoryEvent(draft, removeMsg)

    // Assert no chunks remain for that messageID
    const remaining = [..._getChunksByPartFieldForTest().keys()].filter((k) => k.startsWith("msg_1:"))
    expect(remaining).toEqual([])
  })

  test("clearAllChunks is callable and empties the map", () => {
    const draft = state({ part: { msg_1: [{ id: "prt_1", messageID: "msg_1", type: "text", text: "" } as Part] } })
    const evt = deltaEvent()
    evt.properties.delta = "a"
    applyDirectoryEvent(draft, evt)

    expect(_getChunksByPartFieldForTest().size).toBeGreaterThan(0)

    clearAllChunks()

    expect(_getChunksByPartFieldForTest().size).toBe(0)
  })
})
