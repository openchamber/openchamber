import { describe, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2"
import type { Event, Part, PermissionRequest, QuestionRequest, SessionStatus } from "@opencode-ai/sdk/v2/client"
import { applyDirectoryEvent } from "../event-reducer"
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

function buildSession(title: string, time: Session["time"]): Session {
  return {
    id: "ses_1",
    title,
    time,
  } as Session
}

describe("applyDirectoryEvent", () => {
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

  test("preserves optimistic text when server echo is a shorter prefix (slash command)", () => {
    // Optimistic insert for a slash command like "/debug my symptom" carries the
    // full user input. The OpenCode server echo for slash commands can omit the
    // arguments, returning only the command name. To avoid truncating the user
    // message visible in chat, the reducer must keep the optimistic text when
    // the server text is a strict non-empty shorter prefix of the optimistic text.
    // The reducer should also adopt the server part's id so follow-up
    // `message.part.updated` events for that id correctly update the entry.
    const optimisticText = "/debug my symptom: import fails on startup with ModuleNotFoundError"
    const serverText = "/debug"
    const draft = state({
      message: { ses_1: [{ id: "msg_1", sessionID: "ses_1", role: "user", time: { created: 1 } } as never] },
      part: {
        msg_1: [
          {
            id: "prt_optim",
            messageID: "msg_1",
            type: "text",
            text: optimisticText,
          } as Part,
        ],
      },
    })

    const result = applyDirectoryEvent(draft, {
      type: "message.part.updated",
      properties: {
        part: {
          id: "prt_server",
          messageID: "msg_1",
          sessionID: "ses_1",
          type: "text",
          text: serverText,
        },
      },
    } as Event)

    // Result must be a structural change (adopted id) so React re-renders.
    expect(result).toBe(true)
    const parts = draft.part.msg_1 ?? []
    expect(parts.length).toBe(1)
    expect((parts[0] as { text?: string }).text).toBe(optimisticText)
    // Server part id was adopted so follow-up updates for that id will match.
    expect((parts[0] as { id?: string }).id).toBe("prt_server")
    expect((parts[0] as { sessionID?: string }).sessionID).toBe("ses_1")
  })

  test("still replaces optimistic text when server echo is not a prefix", () => {
    // Standard slash command with no truncation: server returns full text, must
    // replace optimistic part to stay in sync with authoritative server state.
    const draft = state({
      message: { ses_1: [{ id: "msg_1", sessionID: "ses_1", role: "user", time: { created: 1 } } as never] },
      part: {
        msg_1: [
          { id: "prt_optim", messageID: "msg_1", type: "text", text: "/help foo bar" } as Part,
        ],
      },
    })

    const result = applyDirectoryEvent(draft, {
      type: "message.part.updated",
      properties: {
        part: {
          id: "prt_server",
          messageID: "msg_1",
          sessionID: "ses_1",
          type: "text",
          text: "/help foo bar normalized",
        },
      },
    } as Event)

    expect(result).toBe(true)
    const parts = draft.part.msg_1 ?? []
    expect(parts.length).toBe(1)
    expect((parts[0] as { text?: string }).text).toBe("/help foo bar normalized")
  })

  test("still replaces optimistic text when server echo is equal-length", () => {
    // Equal length but different content must still replace.
    const draft = state({
      message: { ses_1: [{ id: "msg_1", sessionID: "ses_1", role: "user", time: { created: 1 } } as never] },
      part: {
        msg_1: [
          { id: "prt_optim", messageID: "msg_1", type: "text", text: "/debug A" } as Part,
        ],
      },
    })

    applyDirectoryEvent(draft, {
      type: "message.part.updated",
      properties: {
        part: {
          id: "prt_server",
          messageID: "msg_1",
          sessionID: "ses_1",
          type: "text",
          text: "/debug B",
        },
      },
    } as Event)

    const parts = draft.part.msg_1 ?? []
    expect(parts.length).toBe(1)
    expect((parts[0] as { text?: string }).text).toBe("/debug B")
  })

  test("empty server echo replaces optimistic text (not a real prefix)", () => {
    // Empty string is technically a prefix of any string ("".startsWith is true),
    // but it carries no useful information. Replacement must proceed so the
    // authoritative server state is honored.
    const draft = state({
      message: { ses_1: [{ id: "msg_1", sessionID: "ses_1", role: "user", time: { created: 1 } } as never] },
      part: {
        msg_1: [
          { id: "prt_optim", messageID: "msg_1", type: "text", text: "/debug full body" } as Part,
        ],
      },
    })

    applyDirectoryEvent(draft, {
      type: "message.part.updated",
      properties: {
        part: {
          id: "prt_server",
          messageID: "msg_1",
          sessionID: "ses_1",
          type: "text",
          text: "",
        },
      },
    } as Event)

    const parts = draft.part.msg_1 ?? []
    expect(parts.length).toBe(1)
    expect((parts[0] as { text?: string }).text).toBe("")
  })

  test("follow-up part update with adopted id replaces the optimistic text", () => {
    // After the prefix-echo branch adopts the server part id, any subsequent
    // `message.part.updated` for the same id must locate the entry and update
    // it in-place (no duplicate parts from a fresh optimistic insert).
    const draft = state({
      message: { ses_1: [{ id: "msg_1", sessionID: "ses_1", role: "user", time: { created: 1 } } as never] },
      part: {
        msg_1: [
          { id: "prt_optim", messageID: "msg_1", type: "text", text: "/debug full body" } as Part,
        ],
      },
    })

    // First echo: short prefix → keep optimistic text, adopt server id.
    applyDirectoryEvent(draft, {
      type: "message.part.updated",
      properties: {
        part: {
          id: "prt_server",
          messageID: "msg_1",
          sessionID: "ses_1",
          type: "text",
          text: "/debug",
        },
      },
    } as Event)

    // Second echo for the same server part id: now authoritative full text.
    applyDirectoryEvent(draft, {
      type: "message.part.updated",
      properties: {
        part: {
          id: "prt_server",
          messageID: "msg_1",
          sessionID: "ses_1",
          type: "text",
          text: "/debug normalized full body",
        },
      },
    } as Event)

    const parts = draft.part.msg_1 ?? []
    expect(parts.length).toBe(1)
    expect((parts[0] as { id?: string }).id).toBe("prt_server")
    expect((parts[0] as { text?: string }).text).toBe("/debug normalized full body")
  })
})
