import { describe, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2"
import type {
  Event,
  Message,
  Part,
  PermissionRequest,
  QuestionRequest,
  SessionStatus,
} from "@opencode-ai/sdk/v2/client"
import { applyDirectoryEvent } from "../event-reducer"
import { INITIAL_STATE, type State } from "../types"

// Fully-typed minimal V2 question fixtures: the reducer reads only
// id/sessionID/requestID, and the SDK payload types require questions/answers
// arrays and the envelope `id`, so no type assertions are needed.
const questionRequest = (id: string, sessionID = "ses_1"): QuestionRequest => ({
  id,
  sessionID,
  questions: [],
})

const questionAskedEvent = (
  type: "question.asked" | "question.v2.asked",
  id: string,
): Event => ({
  type,
  id,
  properties: questionRequest(id),
})

const questionRepliedEvent = (requestID: string): Event => ({
  type: "question.v2.replied",
  id: `evt_${requestID}`,
  properties: { sessionID: "ses_1", requestID, answers: [] },
})

const questionRejectedEvent = (requestID: string): Event => ({
  type: "question.v2.rejected",
  id: `evt_${requestID}`,
  properties: { sessionID: "ses_1", requestID },
})

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

function buildSession(title: string, time: Session["time"]): Session {
  return {
    id: "ses_1",
    title,
    time,
  } as Session
}

describe("applyDirectoryEvent", () => {
  test("inserts post-rollover message events by creation time rather than ID", () => {
    const legacy = {
      id: "msg_ffffffffffffLegacy",
      sessionID: "ses_1",
      role: "user",
      time: { created: 100 },
    } as Message
    const current = {
      id: "msg_000000000000Current",
      sessionID: "ses_1",
      role: "assistant",
      time: { created: 200 },
    } as Message
    const draft = state({ message: { ses_1: [legacy] } })

    expect(applyDirectoryEvent(draft, {
      type: "message.updated",
      properties: { info: current },
    } as Event)).toBe(true)
    expect(draft.message.ses_1).toEqual([legacy, current])
  })

  test("preserves part event order across the part ID rollover", () => {
    const legacyPart = {
      id: "prt_ffffffffffffLegacy",
      messageID: "msg_1",
      sessionID: "ses_1",
      type: "text",
      text: "legacy",
    } as Part
    const currentPart = {
      id: "prt_000000000000Current",
      messageID: "msg_1",
      sessionID: "ses_1",
      type: "text",
      text: "current",
    } as Part
    const draft = state({
      message: { ses_1: [{ id: "msg_1", sessionID: "ses_1", role: "assistant", time: { created: 1 } } as Message] },
      part: { msg_1: [legacyPart] },
    })

    expect(applyDirectoryEvent(draft, {
      type: "message.part.updated",
      properties: { part: currentPart },
    } as Event)).toBe(true)
    expect(draft.part.msg_1).toEqual([legacyPart, currentPart])
  })

  test("replaces an optimistic user part in place instead of appending it", () => {
    const optimisticText = { id: "prt_optimistic_text", messageID: "msg_1", type: "text", text: "hi" } as Part
    const optimisticFile = { id: "prt_optimistic_file", messageID: "msg_1", type: "file", filename: "a.png" } as Part
    const serverText = { id: "prt_server_text", messageID: "msg_1", sessionID: "ses_1", type: "text", text: "hi" } as Part
    const draft = state({
      message: { ses_1: [{ id: "msg_1", sessionID: "ses_1", role: "user", time: { created: 1 } } as Message] },
      part: { msg_1: [optimisticText, optimisticFile] },
    })

    expect(applyDirectoryEvent(draft, {
      type: "message.part.updated",
      properties: { part: serverText },
    } as Event)).toBe(true)
    expect(draft.part.msg_1).toEqual([serverText, optimisticFile])
  })

  test("returns typed materialization when delta arrives before parts", () => {
    const result = applyDirectoryEvent(state(), deltaEvent())

    expect(result).toEqual({
      changed: false,
      materialization: { type: "incomplete-session-snapshot", reason: "orphan-delta", messageID: "msg_1", partID: "prt_1" },
    })
  })

  test("returns typed materialization when delta part is missing", () => {
    const result = applyDirectoryEvent(
      state({ part: { msg_1: [{ id: "prt_2", messageID: "msg_1", type: "text", text: "" } as Part] } }),
      deltaEvent(),
    )

    expect(result).toEqual({
      changed: false,
      materialization: { type: "incomplete-session-snapshot", reason: "missing-delta-part", messageID: "msg_1", partID: "prt_1" },
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
        reason: "missing-owning-message",
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
        reason: "missing-owning-message",
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
      materialization: { type: "incomplete-session-snapshot", reason: "orphan-delta", sessionID: "ses_1", messageID: "msg_1", partID: "prt_1" },
    })
  })

  test("skips stale session.updated events so a newer title survives", () => {
    const draft = state({ session: [buildSession("New Title", { created: 1, updated: 20 })] })

    const result = applyDirectoryEvent(draft, {
      type: "session.updated",
      properties: {
        info: buildSession("Old Title", { created: 1, updated: 10 }),
      },
    } as Event)

    expect(result).toBe(false)
    expect(draft.session[0]?.title).toBe("New Title")
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

  test("upserts question.v2.asked requests like the V1 asked event", () => {
    const draft = state({ question: { ses_1: [questionRequest("ques_1")] } })

    expect(applyDirectoryEvent(draft, questionAskedEvent("question.v2.asked", "ques_2"))).toBe(true)

    expect(draft.question.ses_1.map((item) => item.id)).toEqual(["ques_1", "ques_2"])
  })

  test("question.v2.asked is idempotent — replaying the event does not duplicate", () => {
    const draft = state()

    expect(applyDirectoryEvent(draft, questionAskedEvent("question.v2.asked", "ques_1"))).toBe(true)
    expect(applyDirectoryEvent(draft, questionAskedEvent("question.v2.asked", "ques_1"))).toBe(true)
    expect(draft.question.ses_1.map((item) => item.id)).toEqual(["ques_1"])
  })

  test("dual-fire v1 + v2 asked for the same id stays a single pending entry", () => {
    const draft = state()

    expect(applyDirectoryEvent(draft, questionAskedEvent("question.asked", "ques_1"))).toBe(true)
    expect(applyDirectoryEvent(draft, questionAskedEvent("question.v2.asked", "ques_1"))).toBe(true)

    expect(draft.question.ses_1).toHaveLength(1)
    // The V2 arrival replaces the stored record rather than appending a twin.
    expect(draft.question.ses_1[0]?.id).toBe("ques_1")
  })

  test("removes pending requests on question.v2.replied and question.v2.rejected", () => {
    const draft = state({ question: { ses_1: [questionRequest("ques_1"), questionRequest("ques_2")] } })

    expect(applyDirectoryEvent(draft, questionRepliedEvent("ques_1"))).toBe(true)
    expect(draft.question.ses_1.map((item) => item.id)).toEqual(["ques_2"])

    expect(applyDirectoryEvent(draft, questionRejectedEvent("ques_2"))).toBe(true)
    expect(draft.question.ses_1).toEqual([])
  })

  test("v2 removal events are no-ops for unknown requests and clear v1-asked entries too", () => {
    const draft = state({ question: { ses_1: [questionRequest("ques_1")] } })

    // Unknown request: no change, no array replacement.
    expect(applyDirectoryEvent(draft, questionRepliedEvent("ques_missing"))).toBe(false)

    // Dual-emission safety: the V2 terminal event resolves a request that was
    // created by the V1 asked event.
    expect(applyDirectoryEvent(draft, questionRepliedEvent("ques_1"))).toBe(true)
    expect(draft.question.ses_1).toEqual([])
  })

  test("a late question.v2.asked after a terminal event re-registers the request", () => {
    const draft = state()

    expect(applyDirectoryEvent(draft, questionAskedEvent("question.v2.asked", "ques_1"))).toBe(true)
    expect(applyDirectoryEvent(draft, questionRepliedEvent("ques_1"))).toBe(true)
    expect(draft.question.ses_1).toEqual([])

    // The reducer keeps no tombstone or last-status bookkeeping: asked is an
    // unconditional upsert, so a replayed or late asked re-inserts after a
    // terminal removal. This is intentional for the ordered SSE stream — it is
    // what makes replayed asks self-harmless — never a stale-request guard.
    expect(applyDirectoryEvent(draft, questionAskedEvent("question.v2.asked", "ques_1"))).toBe(true)
    expect(draft.question.ses_1.map((item) => item.id)).toEqual(["ques_1"])
  })
})
