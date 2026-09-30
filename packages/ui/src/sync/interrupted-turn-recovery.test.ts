import { afterEach, describe, expect, test } from "bun:test"
import type { MessagePage } from "@/lib/opencode/client"
import type { SyncEvent } from "@/lib/opencode/events"
import type { Message, Part } from "@/lib/opencode/model"
import { getRuntimeKey } from "@/lib/runtime-switch"
import { ChildStoreManager } from "./child-store"
import { UNWATCHED_TURN_SILENCE_MS, isSilentUnwatchedTurn } from "./observed-turns"
import { SessionMessageLoader, setImperativeSessionMessageLoader } from "./session-message-loader"
import { createEventRoutingIndex, handleEvent, recoverInterruptedTurnAfterMessageLoad } from "./sync-context"

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })

// The turn's records are fresh: a process may still be running it.
const now = Date.now()
const user: Message = { id: "msg_u", sessionID: "ses_1", role: "user", time: { created: now - 2000 } }
const openAssistant: Message = {
  id: "msg_a", sessionID: "ses_1", role: "assistant", time: { created: now - 1000 },
  modelID: "m", providerID: "p", agent: "build",
}
const text: Part = { id: "prt_a", messageID: "msg_a", sessionID: "ses_1", type: "text", text: "4" }

function setup(serverRecords: () => Array<{ info: Message; parts: Part[] }>) {
  const childStores = new ChildStoreManager()
  const store = childStores.ensureChild("/repo", { bootstrap: false })
  const routingIndex = createEventRoutingIndex()
  // The live stream of the server this page is connected to.
  const receive = (event: SyncEvent) => handleEvent("/repo", event, childStores, routingIndex, getRuntimeKey())
  store.setState({
    session: [],
    message: { ses_1: [user, openAssistant] },
    part: { msg_a: [text] },
    session_status: { ses_1: { type: "idle" } },
  })
  let reads = 0
  const sdk = {
    getSessionMessages: async (): Promise<MessagePage> => {
      reads += 1
      return { items: serverRecords(), cursor: {} }
    },
  }
  const loader = new SessionMessageLoader(childStores, { sdk, runtimeKey: "recovery-test" })
  setImperativeSessionMessageLoader(loader)
  cleanups.push(() => { setImperativeSessionMessageLoader(null); childStores.disposeAll() })
  return { store, receive, reads: () => reads }
}

const busy: SyncEvent = { type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } }

describe("recoverInterruptedTurnAfterMessageLoad", () => {
  test("re-reads the tail under an idle status before calling the turn interrupted", async () => {
    // The messages were read while the turn was still running; the status was
    // read after it finished. The server now has the completed message.
    const completed: Message = { ...openAssistant, time: { created: now - 1000, completed: now }, finish: "stop" }
    const { store, receive, reads } = setup(() => [{ info: user, parts: [] }, { info: completed, parts: [text] }])
    receive(busy)
    store.setState({ session_status: { ses_1: { type: "idle" } } })

    await recoverInterruptedTurnAfterMessageLoad("/repo", store, "ses_1")

    expect(reads()).toBe(1)
    const assistant = store.getState().message.ses_1.find((message) => message.id === "msg_a")
    expect(assistant).toMatchObject({ time: { completed: now }, finish: "stop" })
    expect(assistant !== undefined && "error" in assistant).toBe(false)
  })

  test("marks the turn interrupted when the settled server still has it open", async () => {
    const { store, receive, reads } = setup(() => [{ info: user, parts: [] }, { info: openAssistant, parts: [text] }])
    receive(busy)
    store.setState({ session_status: { ses_1: { type: "idle" } } })

    await recoverInterruptedTurnAfterMessageLoad("/repo", store, "ses_1")

    expect(reads()).toBe(1)
    const assistant = store.getState().message.ses_1.find((message) => message.id === "msg_a")
    expect(assistant).toMatchObject({ error: { type: "aborted" } })
    expect(assistant?.role === "assistant" && assistant.time.completed !== undefined).toBe(true)
  })

  test("leaves open a turn this page never saw running (#4156)", async () => {
    // Another OpenCode process on the same database (the TUI) is running the
    // turn. The connected server reports the session idle because it knows
    // nothing about that process.
    const { store, reads } = setup(() => [{ info: user, parts: [] }, { info: openAssistant, parts: [text] }])

    await recoverInterruptedTurnAfterMessageLoad("/repo", store, "ses_1")

    expect(reads()).toBe(0)
    const assistant = store.getState().message.ses_1.find((message) => message.id === "msg_a")
    expect(assistant).toBe(openAssistant)
  })

  test("a watched run that finished does not vouch for a later turn from another process", async () => {
    const completed: Message = { ...openAssistant, time: { created: now - 1000, completed: now }, finish: "stop" }
    const { store, receive, reads } = setup(() => [])
    store.setState({ message: { ses_1: [user, completed] } })
    receive(busy)
    receive({ type: "session.idle", properties: { sessionID: "ses_1" } })

    // Later the TUI starts a turn in the same session; a reload brings it in.
    const tuiUser: Message = { ...user, id: "msg_u2", time: { created: now } }
    const tuiAssistant: Message = { ...openAssistant, id: "msg_a2", time: { created: now } }
    store.setState({ message: { ses_1: [user, completed, tuiUser, tuiAssistant] } })

    await recoverInterruptedTurnAfterMessageLoad("/repo", store, "ses_1")

    expect(reads()).toBe(0)
    expect(store.getState().message.ses_1.at(-1)).toBe(tuiAssistant)
  })

  test("a run settled while this page had none of its messages does not vouch for a later turn", async () => {
    // Another client ran and finished a turn here; this page never opened it.
    const { store, receive, reads } = setup(() => [])
    store.setState({ message: {}, part: {} })
    receive(busy)
    receive({ type: "session.idle", properties: { sessionID: "ses_1" } })

    // Later a TUI turn is running in it, and the user opens the session.
    store.setState({ message: { ses_1: [user, openAssistant] }, part: { msg_a: [text] } })
    await recoverInterruptedTurnAfterMessageLoad("/repo", store, "ses_1")

    expect(reads()).toBe(0)
    expect(store.getState().message.ses_1.at(-1)).toBe(openAssistant)
  })

  test("marks a turn nobody watched once it has been silent long enough", async () => {
    // The app crashed mid-turn: OpenCode never finalized the answer, and no
    // process has touched it since. Fresh records would mean a live run.
    const old = now - UNWATCHED_TURN_SILENCE_MS - 1000
    const stale: Message = { ...openAssistant, time: { created: old } }
    const staleText: Part = { ...text, time: { start: old } }
    const { store, reads } = setup(() => [{ info: user, parts: [] }, { info: stale, parts: [staleText] }])
    store.setState({ message: { ses_1: [user, stale] }, part: { msg_a: [staleText] } })

    await recoverInterruptedTurnAfterMessageLoad("/repo", store, "ses_1")

    expect(reads()).toBe(1)
    const assistant = store.getState().message.ses_1.find((message) => message.id === "msg_a")
    expect(assistant).toMatchObject({ error: { type: "aborted" } })
    expect(assistant?.role === "assistant" && assistant.time.completed !== undefined).toBe(true)
  })
})

describe("isSilentUnwatchedTurn", () => {
  const old = 1_000_000
  const stale: Message = { ...openAssistant, time: { created: old } }
  const at = old + UNWATCHED_TURN_SILENCE_MS

  test("an old answer with a recently started tool is still live", () => {
    const tool: Part = {
      id: "prt_t", messageID: "msg_a", sessionID: "ses_1", type: "tool", tool: "bash", callID: "c",
      state: { status: "running", input: {}, time: { start: at - 1000 } },
    }
    expect(isSilentUnwatchedTurn({ message: { ses_1: [user, stale] }, part: { msg_a: [tool] } }, "ses_1", at)).toBe(false)
  })

  test("an answer whose last record ended a window ago is silent", () => {
    const done: Part = { ...text, time: { start: old, end: old + 10 } }
    expect(isSilentUnwatchedTurn({ message: { ses_1: [user, stale] }, part: { msg_a: [done] } }, "ses_1", at)).toBe(false)
    expect(isSilentUnwatchedTurn({ message: { ses_1: [user, stale] }, part: { msg_a: [done] } }, "ses_1", at + 10)).toBe(true)
  })

  test("a finished answer or a trailing user message is never silent", () => {
    const completed: Message = { ...stale, time: { created: old, completed: old + 1 } }
    expect(isSilentUnwatchedTurn({ message: { ses_1: [user, completed] }, part: {} }, "ses_1", at)).toBe(false)
    expect(isSilentUnwatchedTurn({ message: { ses_1: [stale, user] }, part: {} }, "ses_1", at)).toBe(false)
  })
})
