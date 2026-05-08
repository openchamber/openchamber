import { describe, expect, test } from "bun:test"
import type { Event, Part, PermissionRequest, QuestionRequest } from "@opencode-ai/sdk/v2/client"
import { applyDirectoryEvent } from "../event-reducer"
import { INITIAL_STATE, type State } from "../types"

function state(overrides: Partial<State> = {}): State {
  return {
    ...INITIAL_STATE,
    message: {},
    part: {},
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

  test("applies part update without materialization when owning message exists", () => {
    const draft = state({
      message: { ses_1: [{ id: "msg_1", sessionID: "ses_1", role: "assistant", time: { created: 1 } } as never] },
    })
    const result = applyDirectoryEvent(draft, partUpdatedEvent())

    expect(draft.part.msg_1.map((item) => item.id)).toEqual(["prt_1"])
    expect(result).toBe(true)
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
