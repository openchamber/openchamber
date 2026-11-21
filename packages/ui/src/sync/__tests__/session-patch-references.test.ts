import { afterEach, describe, expect, test } from "bun:test"
import type { SyncEvent } from "@/lib/opencode/events"
import type { Message, Part, Session } from "@/lib/opencode/model"
import { getRuntimeKey } from "@/lib/runtime-switch"
import { ChildStoreManager } from "../child-store"
import { setActionRefs } from "../session-actions"
import { createEventRoutingIndex, handleEvent } from "../sync-context"

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })

let run = 0

const session = (directory: string): Session => ({
  id: "ses_1",
  projectID: "prj_1",
  directory,
  title: "Streaming",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
})
const user: Message = { id: "msg_u", sessionID: "ses_1", role: "user", time: { created: 1 } }
const text: Part = { id: "prt_u", messageID: "msg_u", sessionID: "ses_1", type: "text", text: "hi" }

function setup() {
  run += 1
  const directory = `/patch-references-${run}`
  const childStores = new ChildStoreManager()
  const store = childStores.ensureChild(directory, { bootstrap: false })
  store.setState({
    session: [session(directory)],
    sessionTotal: 1,
    session_status: { ses_1: { type: "busy" } },
    message: { ses_1: [user] },
    part: { msg_u: [text] },
    permission: {},
    form: {},
  })
  setActionRefs(childStores, () => directory)
  cleanups.push(() => childStores.disposeAll())
  const routingIndex = createEventRoutingIndex()
  const receive = (event: SyncEvent) => handleEvent(directory, event, childStores, routingIndex, getRuntimeKey())
  return { store, receive }
}

describe("session.patched", () => {
  test("a usage patch publishes the session list and leaves every other map untouched", () => {
    const { store, receive } = setup()
    const before = store.getState()

    receive({
      type: "session.patched",
      properties: {
        sessionID: "ses_1",
        patch: { cost: 0.5, tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } }, time: { updated: 2 } },
      },
    })

    const after = store.getState()
    expect(after.session).not.toBe(before.session)
    expect(after.session[0]).toMatchObject({ cost: 0.5, time: { updated: 2 } })
    expect(after.message).toBe(before.message)
    expect(after.part).toBe(before.part)
    expect(after.permission).toBe(before.permission)
    expect(after.form).toBe(before.form)
    expect(after.session_status).toBe(before.session_status)
  })

  test("an archive clears the session's caches without editing the published maps", () => {
    const { store, receive } = setup()
    const before = store.getState()

    receive({ type: "session.patched", properties: { sessionID: "ses_1", patch: { time: { archived: 3, updated: 3 } } } })

    const after = store.getState()
    expect(after.session).toHaveLength(0)
    expect(after.message.ses_1).toBe(undefined)
    expect(after.part.msg_u).toBe(undefined)
    expect(after.session_status.ses_1).toBe(undefined)
    expect(before.message.ses_1).toEqual([user])
    expect(before.part.msg_u).toEqual([text])
    expect(before.session_status.ses_1).toEqual({ type: "busy" })
  })
})
