import { beforeEach, describe, expect, test } from "bun:test"

import type { SyncEvent } from "@/lib/opencode/events"
import type { FormRequest, ToolPart } from "@/lib/opencode/model"
import {
  applyRecoverableQuestionEvents,
  classifyQuestionToolError,
  deriveRecoveredQuestions,
  noteLocalFormCancelled,
  noteLocalFormReplied,
  noteQuestionFormSnapshot,
  questionToolLink,
  resetRecoverableQuestions,
  submitRecoveredAnswer,
  useRecoverableQuestionsStore,
  type RecoverableQuestionStoreView,
} from "./recoverable-questions"

// The question tool's own form: `metadata.kind === "question"` plus the link
// to the tool call that asked, exactly as OpenCode stamps it.
const questionForm = (id: string, sessionID = "ses_ask"): FormRequest => ({
  id,
  sessionID,
  title: "Questions",
  metadata: { kind: "question", tool: { messageID: "msg_ask", id: "tool_ask" } },
  fields: [
    {
      key: "q0",
      title: "Color",
      description: "Which color do you like?",
      type: "string",
      custom: true,
      options: [{ value: "Red", label: "Red" }, { value: "Blue", label: "Blue" }],
    },
  ],
})

const toolPart = (state: ToolPart["state"]): ToolPart => ({
  id: "tool_ask",
  sessionID: "ses_ask",
  messageID: "msg_ask",
  callID: "call_1",
  tool: "question",
  type: "tool",
  state,
})

const runningTool = (): ToolPart => toolPart({ status: "running", input: {}, time: { start: 1 } })

const failedTool = (error: string, errorType: string | undefined, errorSource?: "local"): ToolPart => toolPart({
  status: "error",
  input: {},
  error,
  errorType,
  errorSource,
  time: { start: 1, end: 2 },
})

const completedTool = (): ToolPart => toolPart({
  status: "completed",
  input: {},
  output: "",
  metadata: { answers: [["Red"]], truncated: false },
  time: { start: 1, end: 2 },
})

const turnDeathPart = (): ToolPart => failedTool("Tool execution interrupted", "aborted")

const emptyView = (): RecoverableQuestionStoreView => ({ form: {}, part: {} })

const viewWith = (
  part: ToolPart | undefined,
  forms: readonly FormRequest[] = [],
): RecoverableQuestionStoreView => ({
  form: forms.length > 0 ? { ses_ask: [...forms] } : {},
  part: part ? { msg_ask: [part] } : {},
})

const formCreated = (form: FormRequest): SyncEvent => ({ type: "form.created", properties: { form } })
const formSettled = (formID: string, disposition?: "replied" | "cancelled"): SyncEvent => ({
  type: "form.settled",
  properties: { sessionID: "ses_ask", formID, disposition },
})
const toolFailed = (
  error: string,
  errorType?: string,
  link: { messageID: string; partID: string } = { messageID: "msg_ask", partID: "tool_ask" },
): SyncEvent => ({
  type: "message.tool.transition",
  properties: {
    sessionID: "ses_ask",
    messageID: link.messageID,
    partID: link.partID,
    transition: { kind: "failed", error, errorType, executed: false, end: 2 },
  },
})
const toolSucceeded = (link: { messageID: string; partID: string } = { messageID: "msg_ask", partID: "tool_ask" }): SyncEvent => ({
  type: "message.tool.transition",
  properties: {
    sessionID: "ses_ask",
    messageID: link.messageID,
    partID: link.partID,
    transition: { kind: "success", output: "", executed: true, end: 2 },
  },
})

const allSessions = new Set(["ses_ask", "ses_parent"])
const recoveryView = () => {
  const state = useRecoverableQuestionsStore.getState()
  return { seen: state.seen, outcomes: state.outcomes, dispositions: state.dispositions }
}

beforeEach(() => {
  resetRecoverableQuestions()
})

describe("question eligibility", () => {
  test("links only ordinary session-owned question forms", () => {
    expect(questionToolLink(questionForm("frm_1"))).toEqual({ messageID: "msg_ask", toolID: "tool_ask" })
  })

  test("refuses web-search consent forms", () => {
    const consent: FormRequest = {
      id: "frm_consent",
      sessionID: "ses_ask",
      title: "Allow web search?",
      metadata: { kind: "websearch.provider" },
      fields: [{ key: "choice", type: "string", options: [{ value: "allow", label: "Allow" }] }],
    }
    expect(questionToolLink(consent)).toBeNull()
  })

  test("refuses MCP elicitation and forms with no tool call behind them", () => {
    const elicitation: FormRequest = {
      id: "frm_eli",
      sessionID: "global",
      title: "MCP server asks",
      fields: [{ key: "token", type: "string" }],
    }
    const clientCreated: FormRequest = {
      id: "frm_plain",
      sessionID: "ses_ask",
      title: "API form",
      fields: [{ key: "token", type: "string" }],
    }
    const questionWithoutTool: FormRequest = {
      id: "frm_q",
      sessionID: "ses_ask",
      title: "Questions",
      metadata: { kind: "question" },
      fields: [{ key: "q0", type: "string" }],
    }
    expect(questionToolLink(elicitation)).toBeNull()
    expect(questionToolLink(clientCreated)).toBeNull()
    expect(questionToolLink(questionWithoutTool)).toBeNull()
  })

  test("permission events never enter the recovery store", () => {
    applyRecoverableQuestionEvents("/repo", [
      { type: "permission.asked", properties: { id: "per_1", sessionID: "ses_ask", action: "bash", resources: ["*"], save: ["deny"] } },
      { type: "permission.replied", properties: { sessionID: "ses_ask", requestID: "per_1" } },
    ])
    expect(recoveryView().seen.size).toBe(0)
    expect(recoveryView().outcomes.size).toBe(0)
  })
})

describe("ask outcome classification", () => {
  test("reads turn death, shutdown and dismissal apart", () => {
    expect(classifyQuestionToolError("Tool execution interrupted", "aborted", false)).toBe("turn-death")
    expect(classifyQuestionToolError("Interaction cancelled because the location shut down", "aborted", false)).toBe("shutdown")
    expect(classifyQuestionToolError("Step interrupted", "aborted", false)).toBe("unresolved")
    expect(classifyQuestionToolError("form cancelled", "tool.execution", false)).toBe("dismissed")
    expect(classifyQuestionToolError("not needed", "tool.execution", false)).toBe("dismissed")
    expect(classifyQuestionToolError("Interrupted", undefined, true)).toBe("turn-death")
  })

  test("fails closed on evidence it does not recognize", () => {
    expect(classifyQuestionToolError("something else", "aborted", false)).toBe("unresolved")
    expect(classifyQuestionToolError("something else", undefined, false)).toBe("unresolved")
    expect(classifyQuestionToolError("Interrupted", undefined, false)).toBe("unresolved")
  })
})

describe("recovery of a question whose ask died", () => {
  test("keeps the question when the request vanished without a settled event", () => {
    applyRecoverableQuestionEvents("/repo", [formCreated(questionForm("frm_1"))])
    // The turn dies; no `form.settled` ever arrives (the events were lost).
    const recovered = deriveRecoveredQuestions(viewWith(turnDeathPart()), recoveryView(), allSessions)
    expect(recovered.map((entry) => entry.form.id)).toEqual(["frm_1"])
    expect(recovered[0]?.toolMessageID).toBe("msg_ask")
    expect(recovered[0]?.evidence).toBe("tool-interrupted")
  })

  test("keeps the question the local interrupted-turn mark closed", () => {
    noteQuestionFormSnapshot("/repo", [questionForm("frm_1")])
    const recovered = deriveRecoveredQuestions(
      viewWith(failedTool("Interrupted", undefined, "local")),
      recoveryView(),
      allSessions,
    )
    expect(recovered).toHaveLength(1)
    expect(recovered[0]?.evidence).toBe("local-interrupt-mark")
  })

  test("recovers when the settle came with the turn's death in one batch", () => {
    // OpenCode cancels the ask as its tool call is aborted: `form.cancelled`
    // settles the request first, then the tool dies. The capture happens on
    // the creation event, so nothing is lost between the two publications.
    applyRecoverableQuestionEvents("/repo", [
      formCreated(questionForm("frm_1")),
      formSettled("frm_1", "cancelled"),
      toolFailed("Tool execution interrupted", "aborted"),
    ])
    const recovered = deriveRecoveredQuestions(viewWith(turnDeathPart()), recoveryView(), allSessions)
    expect(recovered.map((entry) => entry.form.id)).toEqual(["frm_1"])
  })

  test("never shows a question whose request is still pending", () => {
    applyRecoverableQuestionEvents("/repo", [formCreated(questionForm("frm_1"))])
    const recovered = deriveRecoveredQuestions(
      viewWith(turnDeathPart(), [questionForm("frm_1")]),
      recoveryView(),
      allSessions,
    )
    expect(recovered).toEqual([])
  })

  test("keeps only questions inside the session scope", () => {
    applyRecoverableQuestionEvents("/repo", [formCreated(questionForm("frm_1", "ses_child"))])
    const parentScope = new Set(["ses_parent", "ses_child"])
    const ownScope = new Set(["ses_parent"])
    expect(deriveRecoveredQuestions(viewWith(turnDeathPart()), recoveryView(), parentScope)).toHaveLength(1)
    expect(deriveRecoveredQuestions(viewWith(turnDeathPart()), recoveryView(), ownScope)).toEqual([])
  })
})

describe("settlement beats recovery", () => {
  test("a replayed interruption cannot replace a confirmed answer", () => {
    applyRecoverableQuestionEvents("/repo", [
      formCreated(questionForm("frm_1")),
      toolSucceeded(),
      toolFailed("Tool execution interrupted", "aborted"),
    ])
    expect(deriveRecoveredQuestions(viewWith(turnDeathPart()), recoveryView(), allSessions)).toEqual([])
  })

  test("an explicit reply this client sent is final", () => {
    applyRecoverableQuestionEvents("/repo", [formCreated(questionForm("frm_1"))])
    noteLocalFormReplied("frm_1")
    expect(deriveRecoveredQuestions(viewWith(turnDeathPart()), recoveryView(), allSessions)).toEqual([])
  })

  test("a reply event settles it even without the tool disposition", () => {
    applyRecoverableQuestionEvents("/repo", [
      formCreated(questionForm("frm_1")),
      formSettled("frm_1", "replied"),
    ])
    expect(deriveRecoveredQuestions(viewWith(turnDeathPart()), recoveryView(), allSessions)).toEqual([])
  })

  test("a question answered elsewhere during a disconnect is not recovered", () => {
    // The settle collapsed into `form.settled` with no disposition and the
    // events around it were lost; the transcript still shows the answer.
    applyRecoverableQuestionEvents("/repo", [formCreated(questionForm("frm_1"))])
    const recovered = deriveRecoveredQuestions(viewWith(completedTool()), recoveryView(), allSessions)
    expect(recovered).toEqual([])
  })

  test("a deliberate dismissal is not recovered", () => {
    applyRecoverableQuestionEvents("/repo", [
      formCreated(questionForm("frm_1")),
      formSettled("frm_1", "cancelled"),
      toolFailed("form cancelled", "tool.execution"),
    ])
    expect(deriveRecoveredQuestions(
      viewWith(failedTool("form cancelled", "tool.execution")),
      recoveryView(),
      allSessions,
    )).toEqual([])
  })

  test("a local dismissal closes the card for good", () => {
    applyRecoverableQuestionEvents("/repo", [formCreated(questionForm("frm_1"))])
    noteLocalFormCancelled("frm_1")
    expect(deriveRecoveredQuestions(viewWith(turnDeathPart()), recoveryView(), allSessions)).toEqual([])
  })

  test("an authoritative answer revokes an already promoted card", () => {
    applyRecoverableQuestionEvents("/repo", [formCreated(questionForm("frm_1"))])
    // The death was recorded (local mark on the part, disposition recorded
    // from the turn's failure): the card shows.
    useRecoverableQuestionsStore.setState((state) => ({
      dispositions: new Map(state.dispositions).set("msg_ask\u0000tool_ask", { sessionID: "ses_ask", outcome: "turn-death" }),
    }))
    expect(deriveRecoveredQuestions(
      viewWith(failedTool("Interrupted", undefined, "local")),
      recoveryView(),
      allSessions,
    )).toHaveLength(1)

    applyRecoverableQuestionEvents("/repo", [toolSucceeded()])
    expect(deriveRecoveredQuestions(
      viewWith(failedTool("Interrupted", undefined, "local")),
      recoveryView(),
      allSessions,
    )).toEqual([])
  })
})

describe("restarts and unknown states do not orphan", () => {
  test("a shutdown cancellation is never recovered", () => {
    applyRecoverableQuestionEvents("/repo", [formCreated(questionForm("frm_1"))])
    const recovered = deriveRecoveredQuestions(
      viewWith(failedTool("Interaction cancelled because the location shut down", "aborted")),
      recoveryView(),
      allSessions,
    )
    expect(recovered).toEqual([])
  })

  test("a question whose tool call still waits stays unrecovered", () => {
    // A hard kill leaves the ask gone and the tool part running with no death
    // record: indistinguishable from a turn another process owns (openchamber
    // #4156), so it is neither shown nor tombstoned — a recorded death may
    // still settle it later.
    applyRecoverableQuestionEvents("/repo", [formCreated(questionForm("frm_1"))])
    const state = recoveryView()
    expect(deriveRecoveredQuestions(viewWith(runningTool()), state, allSessions)).toEqual([])
    // Later, the turn's death is recorded and the local mark lands.
    expect(deriveRecoveredQuestions(
      viewWith(failedTool("Interrupted", undefined, "local")),
      state,
      allSessions,
    )).toHaveLength(1)
  })

  test("unrecognized evidence fails closed", () => {
    applyRecoverableQuestionEvents("/repo", [formCreated(questionForm("frm_1"))])
    expect(deriveRecoveredQuestions(viewWith(failedTool("weird", "weird")), recoveryView(), allSessions)).toEqual([])
    expect(deriveRecoveredQuestions(emptyView(), recoveryView(), allSessions)).toEqual([])
  })
})

describe("lifecycle", () => {
  test("bounds dispositions and outcomes to the last 100 captured questions", () => {
    for (let index = 0; index < 160; index += 1) {
      const form = questionForm(`frm_${index}`)
      const link = { messageID: `msg_${index}`, partID: `tool_${index}` }
      form.metadata = { kind: "question", tool: { messageID: link.messageID, id: link.partID } }
      applyRecoverableQuestionEvents("/repo", [formCreated(form), toolSucceeded(link)])
      noteLocalFormReplied(form.id)
    }
    const state = recoveryView()
    expect(state.seen.size).toBe(100)
    expect(state.outcomes.size).toBe(100)
    expect(state.dispositions.size).toBe(100)
    expect(state.seen.has("frm_0")).toBe(false)
    expect(state.outcomes.has("frm_0")).toBe(false)
    expect(state.dispositions.has("msg_0\u0000tool_0")).toBe(false)

    applyRecoverableQuestionEvents("/repo", [{ type: "session.deleted", properties: { sessionID: "ses_ask" } }])
    expect(recoveryView().seen.size).toBe(0)
    expect(recoveryView().outcomes.size).toBe(0)
    expect(recoveryView().dispositions.size).toBe(0)
  })

  test("unobserved and evicted replies do not accumulate outcomes", () => {
    for (let index = 0; index < 160; index += 1) {
      noteLocalFormReplied(`frm_${index}`)
      noteLocalFormCancelled(`cancel_${index}`)
      applyRecoverableQuestionEvents("/repo", [formSettled(`remote_${index}`, "replied")])
    }
    expect(recoveryView().outcomes.size).toBe(0)
  })

  test("a repeated snapshot cannot reopen a dismissed captured question", () => {
    const form = questionForm("frm_1")
    noteQuestionFormSnapshot("/repo", [form])
    noteLocalFormCancelled(form.id)
    noteQuestionFormSnapshot("/repo", [form])
    expect(deriveRecoveredQuestions(viewWith(turnDeathPart()), recoveryView(), allSessions)).toEqual([])
  })

  test("dismissing a recovered card leaves a tombstone", () => {
    applyRecoverableQuestionEvents("/repo", [formCreated(questionForm("frm_1"))])
    expect(deriveRecoveredQuestions(viewWith(turnDeathPart()), recoveryView(), allSessions)).toHaveLength(1)
    noteLocalFormCancelled("frm_1")
    expect(deriveRecoveredQuestions(viewWith(turnDeathPart()), recoveryView(), allSessions)).toEqual([])
    expect(useRecoverableQuestionsStore.getState().outcomes.get("frm_1")).toBe("dismissed")
  })

  test("a session deletion drops its questions", () => {
    applyRecoverableQuestionEvents("/repo", [formCreated(questionForm("frm_1"))])
    applyRecoverableQuestionEvents("/repo", [{ type: "session.deleted", properties: { sessionID: "ses_ask" } }])
    expect(deriveRecoveredQuestions(viewWith(turnDeathPart()), recoveryView(), allSessions)).toEqual([])
  })

  test("a runtime switch starts from nothing", () => {
    applyRecoverableQuestionEvents("/repo", [formCreated(questionForm("frm_1"))])
    resetRecoverableQuestions()
    expect(deriveRecoveredQuestions(viewWith(turnDeathPart()), recoveryView(), allSessions)).toEqual([])
  })

  test("a list read captures questions a later death can recover", () => {
    // A question opened while this client looked at another session comes in
    // through a pending-forms read; its death is recoverable like any other.
    noteQuestionFormSnapshot("/repo", [questionForm("frm_1")])
    expect(deriveRecoveredQuestions(viewWith(turnDeathPart()), recoveryView(), allSessions)).toHaveLength(1)
    // Absence from a later read carries no meaning of its own: the pending
    // form list in the store decides whether the ask is still alive.
    noteQuestionFormSnapshot("/repo", [])
    expect(deriveRecoveredQuestions(viewWith(turnDeathPart()), recoveryView(), allSessions)).toHaveLength(1)
    expect(deriveRecoveredQuestions(viewWith(turnDeathPart(), [questionForm("frm_1")]), recoveryView(), allSessions)).toEqual([])
  })

  test("records a disposition only for a captured question's own tool call", () => {
    applyRecoverableQuestionEvents("/repo", [formCreated(questionForm("frm_1"))])
    const other = { messageID: "msg_other", partID: "tool_other" }
    applyRecoverableQuestionEvents("/repo", [toolSucceeded(other), toolFailed("Tool execution interrupted", "aborted", other)])
    expect(recoveryView().dispositions.size).toBe(0)
    // The captured question's own call still records its outcome.
    applyRecoverableQuestionEvents("/repo", [toolFailed("Tool execution interrupted", "aborted")])
    expect(recoveryView().dispositions.get("msg_ask\u0000tool_ask")?.outcome).toBe("turn-death")
  })
})

describe("answer submissions", () => {
  test("a stale mounted card cannot resubmit an accepted answer", async () => {
    noteQuestionFormSnapshot("/repo", [questionForm("frm_1")])
    let sends = 0
    const send = async () => {
      sends += 1
      noteLocalFormReplied("frm_1")
    }
    await submitRecoveredAnswer("frm_1", send)
    await submitRecoveredAnswer("frm_1", send)
    expect(sends).toBe(1)
  })

  test("an old runtime's completion cannot release a new runtime's lock", async () => {
    let releaseOld = () => {}
    let releaseNew = () => {}
    const old = submitRecoveredAnswer("frm_1", () => new Promise<void>((resolve) => { releaseOld = resolve }))
    resetRecoverableQuestions()
    const current = submitRecoveredAnswer("frm_1", () => new Promise<void>((resolve) => { releaseNew = resolve }))
    releaseOld()
    await old
    expect(useRecoverableQuestionsStore.getState().submissions.get("frm_1")).toBe(current)
    releaseNew()
    await current
    expect(useRecoverableQuestionsStore.getState().submissions.size).toBe(0)
  })

  test("a duplicate submit reuses the first send", async () => {
    let sends = 0
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const send = async () => {
      sends += 1
      await gate
    }
    const first = submitRecoveredAnswer("frm_1", send)
    const second = submitRecoveredAnswer("frm_1", send)
    expect(sends).toBe(1)
    release()
    await Promise.all([first, second])
    expect(sends).toBe(1)
    // The lock is released afterwards: a later retry can send again.
    await submitRecoveredAnswer("frm_1", async () => {
      sends += 1
    })
    expect(sends).toBe(2)
  })

  test("a rejected send keeps the question recoverable", async () => {
    applyRecoverableQuestionEvents("/repo", [formCreated(questionForm("frm_1"))])
    await expect(submitRecoveredAnswer("frm_1", async () => {
      throw new Error("send failed")
    })).rejects.toThrow("send failed")
    // No tombstone: the card and its draft stay for a retry.
    expect(useRecoverableQuestionsStore.getState().outcomes.has("frm_1")).toBe(false)
    expect(deriveRecoveredQuestions(viewWith(turnDeathPart()), recoveryView(), allSessions)).toHaveLength(1)
  })
})
