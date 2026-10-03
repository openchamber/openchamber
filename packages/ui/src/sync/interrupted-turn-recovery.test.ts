import { afterEach, describe, expect, test } from "bun:test"
import type { SyncEvent } from "@/lib/opencode/events"
import type { Message, Part, SessionOutcome } from "@/lib/opencode/model"
import { getRuntimeKey } from "@/lib/runtime-switch"
import { ChildStoreManager } from "./child-store"
import { createEventRoutingIndex, handleEvent, markRecordedInterruptedTurn } from "./sync-context"

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })

const user: Message = { id: "msg_u", sessionID: "ses_1", role: "user", time: { created: 1 } }
const openAssistant: Message = {
  id: "msg_a", sessionID: "ses_1", role: "assistant", time: { created: 2 },
  modelID: "m", providerID: "p", agent: "build",
}
const runningTool: Part = {
  id: "prt_t", messageID: "msg_a", sessionID: "ses_1", type: "tool", tool: "bash", callID: "c",
  state: { status: "running", input: {}, time: { start: 2 } },
}
const idle = (outcome: SessionOutcome, id = "msg_i"): Message => (
  { id, sessionID: "ses_1", role: "idle", time: { created: 3 }, outcome }
)

function setup(messages: Message[]) {
  const childStores = new ChildStoreManager()
  const store = childStores.ensureChild("/repo", { bootstrap: false })
  const routingIndex = createEventRoutingIndex()
  const receive = (event: SyncEvent) => handleEvent("/repo", event, childStores, routingIndex, getRuntimeKey())
  store.setState({ session: [], message: { ses_1: messages }, part: { msg_a: [runningTool] } })
  cleanups.push(() => childStores.disposeAll())
  return { store, receive }
}

const isStopped = (message: Message | undefined) => (
  message?.role === "assistant" && message.time.completed !== undefined && message.error?.type === "aborted"
)

describe("markRecordedInterruptedTurn", () => {
  for (const outcome of ["interrupted", "failed"] as const) {
    test(`marks the turn OpenCode recorded as ${outcome}`, () => {
      const { store } = setup([user, openAssistant, idle(outcome)])

      markRecordedInterruptedTurn(store, "ses_1")

      expect(isStopped(store.getState().message.ses_1[1])).toBe(true)
      const tool = store.getState().part.msg_a[0]
      expect(tool?.type === "tool" && tool.state.status).toBe("error")
    })
  }

  test("leaves an unfinished turn with no record open (#4156)", () => {
    // Another OpenCode process on the same database (the TUI) is running it.
    const { store } = setup([user, openAssistant])

    markRecordedInterruptedTurn(store, "ses_1")

    expect(store.getState().message.ses_1[1]).toBe(openAssistant)
    expect(store.getState().part.msg_a[0]).toBe(runningTool)
  })

  test("a succeeded record is not a stop", () => {
    const { store } = setup([user, openAssistant, idle("succeeded")])

    markRecordedInterruptedTurn(store, "ses_1")

    expect(store.getState().message.ses_1[1]).toBe(openAssistant)
  })

  test("a record from an earlier turn does not stop a later one", () => {
    const earlier: Message = { ...openAssistant, id: "msg_0", time: { created: 0, completed: 1 } }
    const { store } = setup([earlier, idle("interrupted", "msg_i0"), user, openAssistant])

    markRecordedInterruptedTurn(store, "ses_1")

    expect(store.getState().message.ses_1.at(-1)).toBe(openAssistant)
  })

  test("the newest record decides", () => {
    const { store } = setup([user, openAssistant, idle("interrupted", "msg_i0"), idle("succeeded")])

    markRecordedInterruptedTurn(store, "ses_1")

    expect(store.getState().message.ses_1[1]).toBe(openAssistant)
  })
})

describe("settle events", () => {
  test("an interrupted outcome marks the open turn", () => {
    const { store, receive } = setup([user, openAssistant])

    receive({ type: "session.idle", properties: { sessionID: "ses_1", outcome: "interrupted" } })

    expect(isStopped(store.getState().message.ses_1[1])).toBe(true)
  })

  test("a failed turn marks the open turn", () => {
    const { store, receive } = setup([user, openAssistant])

    receive({ type: "session.error", properties: { sessionID: "ses_1", error: { type: "unknown", message: "boom" } } })

    expect(isStopped(store.getState().message.ses_1[1])).toBe(true)
  })

  for (const outcome of [undefined, "succeeded"] as const) {
    test(`an idle event with ${outcome ?? "no"} outcome leaves the turn as stored`, () => {
      const { store, receive } = setup([user, openAssistant])

      receive({ type: "session.idle", properties: { sessionID: "ses_1", outcome } })

      expect(store.getState().message.ses_1[1]).toBe(openAssistant)
    })
  }
})
