import { afterEach, describe, expect, test } from "bun:test"
import type { SyncEvent } from "@/lib/opencode/events"
import type { Message, Part, Session } from "@/lib/opencode/model"
import { getRuntimeKey } from "@/lib/runtime-switch"
import { ChildStoreManager } from "../child-store"
import { setActionRefs } from "../session-actions"
import { createEventRoutingIndex, handleEvent } from "../sync-context"

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })

// Directory stores persist their session lists, so each test gets its own pair.
let run = 0
let from = ""
let to = ""

const session = (): Session => ({
  id: "ses_1",
  projectID: "prj_old",
  directory: from,
  title: "Moving",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
})
const user: Message = { id: "msg_u", sessionID: "ses_1", role: "user", time: { created: 1 } }
const text: Part = { id: "prt_u", messageID: "msg_u", sessionID: "ses_1", type: "text", text: "hi" }

// What `translateWireEvent` makes of OpenCode's `session.moved`.
const movedEvents = (): SyncEvent[] => [
  {
    type: "session.patched",
    properties: { sessionID: "ses_1", patch: { directory: to, projectID: "prj_new", subpath: null, time: { updated: 5 } } },
  },
  {
    type: "message.updated",
    properties: { info: { id: "msg_moved", sessionID: "ses_1", role: "location-switched", time: { created: 5 }, directory: to } },
  },
]

function setup() {
  run += 1
  from = `/moved-${run}/old`
  to = `/moved-${run}/new`
  const childStores = new ChildStoreManager()
  const source = childStores.ensureChild(from, { bootstrap: false })
  const destination = childStores.ensureChild(to, { bootstrap: false })
  source.setState({
    session: [session()],
    sessionTotal: 1,
    session_status: { ses_1: { type: "idle" } },
    message: { ses_1: [user] },
    part: { msg_u: [text] },
  })
  const routingIndex = createEventRoutingIndex()
  setActionRefs(childStores, () => from)
  cleanups.push(() => childStores.disposeAll())
  const receive = (directory: string, event: SyncEvent) => (
    handleEvent(directory, event, childStores, routingIndex, getRuntimeKey())
  )
  return { source, destination, receive }
}

describe("session.moved", () => {
  test("carries the session and its transcript to the destination store", () => {
    const { source, destination, receive } = setup()

    for (const event of movedEvents()) receive(to, event)

    expect(source.getState().session).toHaveLength(0)
    expect(source.getState().message.ses_1).toBe(undefined)
    expect(source.getState().part.msg_u).toBe(undefined)
    expect(destination.getState().session[0]).toMatchObject({ id: "ses_1", directory: to, projectID: "prj_new" })
    expect(destination.getState().sessionTotal).toBe(1)
    expect(destination.getState().session_status.ses_1?.type).toBe("idle")
    expect(destination.getState().message.ses_1?.map((message) => message.id)).toEqual(["msg_u", "msg_moved"])
    expect(destination.getState().part.msg_u?.[0]?.id).toBe("prt_u")
  })

  test("routes the next turn into the store the chat now reads", () => {
    const { source, destination, receive } = setup()
    for (const event of movedEvents()) receive(to, event)

    const next: Message = { id: "msg_next", sessionID: "ses_1", role: "user", time: { created: 6 } }
    receive(to, { type: "message.updated", properties: { info: next } })

    expect(destination.getState().message.ses_1?.at(-1)?.id).toBe("msg_next")
    expect(source.getState().message.ses_1).toBe(undefined)
  })

  test("a second delivery of the same move changes nothing", () => {
    const { destination, receive } = setup()
    for (const event of movedEvents()) receive(to, event)
    const after = destination.getState()

    receive(from, movedEvents()[0])

    expect(destination.getState().session).toBe(after.session)
    expect(destination.getState().message).toBe(after.message)
  })
})
