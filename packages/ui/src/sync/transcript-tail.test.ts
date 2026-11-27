import { afterEach, expect, test } from "bun:test"
import type { PendingInboxMessage } from "@/lib/opencode/client"
import type { SyncEvent } from "@/lib/opencode/events"
import type { Message, Part } from "@/lib/opencode/model"
import { projectInboxMessage } from "@/lib/opencode/projection"
import { getRuntimeKey } from "@/lib/runtime-switch"
import { ChildStoreManager } from "./child-store"
import { SessionMessageLoader, setImperativeSessionMessageLoader, type SessionMessagePageSource } from "./session-message-loader"
import { createEventRoutingIndex, handleEvent } from "./sync-context"

type Row = { info: Message; parts: Part[] }

const target = { directory: "/transcript-tail-test", sessionID: "ses_tail" }
const sessionID = target.sessionID
const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })

const textParts = (id: string): Part[] => [{ id: `${id}_text`, messageID: id, sessionID, type: "text", text: "hello" }]
const prompt = (id: string, created: number): Row => ({ info: { id, sessionID, role: "user", time: { created } }, parts: textParts(id) })
const reply = (id: string, created: number): Row => ({
  info: {
    id, sessionID, role: "assistant", time: { created, completed: created }, agent: "build", providerID: "p", modelID: "m",
  } as Message,
  parts: textParts(id),
})

// A server with history and an inbox, whose events reach the real reducer and dispatch.
async function openSession() {
  const history: Row[] = []
  const inbox = new Map<string, PendingInboxMessage>()
  let clock = 0
  let inboxFails = false
  let beforePage = () => {}
  let afterPage = () => {}
  const childStores = new ChildStoreManager()
  const sdk: SessionMessagePageSource = {
    async getSessionMessages(_id, options) {
      beforePage()
      const cursor = options?.cursor
      const cut = !cursor ? history.length : Number.isInteger(Number(cursor))
        ? Number(cursor)
        : history.findIndex((row) => row.info.id === JSON.parse(Buffer.from(cursor, "base64url").toString()).id)
      const start = Math.max(0, cut - (options?.limit ?? 100))
      const items = history.slice(start, cut).map((row) => ({ info: { ...row.info }, parts: row.parts })).reverse()
      afterPage()
      return { items, cursor: start > 0 ? { next: String(start) } : {} }
    },
    async getSessionInbox() {
      if (inboxFails) throw new Error("inbox unavailable")
      return [...inbox.values()]
    },
  }
  const loader = new SessionMessageLoader(childStores, { sdk, runtimeKey: getRuntimeKey() })
  setImperativeSessionMessageLoader(loader)
  cleanups.push(() => { setImperativeSessionMessageLoader(null); loader.dispose(); childStores.disposeAll() })
  const store = childStores.ensureChild(target.directory, { bootstrap: false })
  const routing = createEventRoutingIndex()
  const emit = (event: SyncEvent) => handleEvent(target.directory, event, childStores, routing, getRuntimeKey())
  const show = ({ info, parts }: Row) => {
    emit({ type: "message.updated", properties: { info } })
    emit({ type: "message.parts.replaced", properties: { sessionID, messageID: info.id, parts } })
  }
  const server = {
    enqueue(id: string, role: "user" | "synthetic" = "user", live = true) {
      const created = clock += 1
      const item = projectInboxMessage({ type: role, payload: { text: "hello" } }, { sessionID, messageID: id, created })!
      inbox.set(id, item)
      if (live) show({ info: item.info, parts: item.parts ?? [] })
    },
    deliver(id: string, live = true) {
      const created = clock += 1
      inbox.delete(id)
      history.push(prompt(id, created))
      const announce = () => emit({ type: "message.patched", properties: { sessionID, messageID: id, patch: { time: { created } } } })
      if (live) announce()
      return announce
    },
    cancel(id: string, live = true) {
      inbox.delete(id)
      if (live) emit({ type: "message.removed", properties: { sessionID, messageID: id } })
    },
    reply(id: string, live = true) {
      const row = reply(id, clock += 1)
      history.push(row)
      if (live) show(row)
    },
    /** Delivered prompts with long runs of records after each, all while this client is away. */
    runUnseen(turns: number, recordsPerTurn: number, prefix = "away") {
      for (let turn = 0; turn < turns; turn += 1) {
        server.deliver(`${prefix}${turn}`, false)
        for (let record = 1; record < recordsPerTurn; record += 1) server.reply(`${prefix}${turn}_${record}`, false)
      }
    },
  }
  const send = (id: string, admitted = true) => {
    const row = prompt(id, clock += 1)
    loader.optimisticAdd({ ...target, message: row.info, parts: row.parts })
    if (admitted) loader.optimisticAdmit({ ...target, messageID: id })
  }
  const turn = (id: string, local = false) => {
    if (local) send(`u${id}`)
    server.enqueue(`u${id}`)
    server.deliver(`u${id}`)
    server.reply(`a${id}`)
  }
  const ids = () => (store.getState().message[sessionID] ?? []).map((message) => message.id)
  const serverIDs = () => history.map((row) => row.info.id)
  await loader.ensure(target)
  return {
    loader, store, server, send, turn, ids, serverIDs,
    newest: (count: number) => serverIDs().slice(-count),
    failInbox: () => { inboxFails = true },
    whilePageIsRead: (when: "before" | "after", run: () => void) => {
      let ran = false
      const once = () => { if (!ran) { ran = true; run() } }
      if (when === "before") beforePage = once
      else afterPage = once
    },
  }
}

const refresh = (session: Awaited<ReturnType<typeof openSession>>) => session.loader.refreshTail(target, 30)

test("a trim cuts a chat where every prompt was sent from here", async () => {
  const session = await openSession()
  for (let i = 0; i < 25; i += 1) session.turn(`${i}`, true)
  expect(session.loader.trimHistory(target)).toBe(true)
  expect(session.ids()).toEqual(session.newest(20))
})

test("answered prompts cut by a trim stay out of the tail when the inbox read fails", async () => {
  const session = await openSession()
  for (let i = 0; i < 8; i += 1) session.turn(`local${i}`, true)
  for (let i = 0; i < 55; i += 1) session.turn(`${i}`)
  expect(session.loader.trimHistory(target)).toBe(true)
  session.failInbox()
  await session.loader.refreshTail(target, 100)
  expect(session.ids().at(-1)).toBe("a54")
  expect(session.ids()).toEqual(session.newest(session.ids().length))
})

test("an answered prompt stays out of a replacing window when the inbox read fails", async () => {
  const session = await openSession()
  session.turn("foreign")
  session.turn("local", true)
  session.loader.markHistoryStale()
  session.server.runUnseen(12, 31)
  session.failInbox()
  await refresh(session)
  expect(session.ids()).toEqual(session.newest(session.ids().length))
})

test("a foreign prompt queued at a gap and delivered 400 records later leaves no hole", async () => {
  const session = await openSession()
  session.turn("first")
  session.server.enqueue("queued")
  session.loader.markHistoryStale()
  for (let i = 0; i < 400; i += 1) session.server.reply(`m${i}`, false)
  session.server.deliver("queued", false)
  session.server.reply("last", false)
  await refresh(session)
  expect(session.ids()).toEqual(session.newest(session.ids().length))
})

test("a failed inbox read keeps a foreign queued prompt below a replacing window", async () => {
  const session = await openSession()
  session.turn("first")
  session.server.enqueue("queued")
  session.loader.markHistoryStale()
  session.server.runUnseen(12, 31)
  session.failInbox()
  await refresh(session)
  expect(session.ids().at(-1)).toBe("queued")
  expect(session.ids().slice(0, -1)).toEqual(session.newest(session.ids().length - 1))
  expect(session.store.getState().part.queued).toHaveLength(1)
})

test("a failed inbox read keeps the second queued prompt when the window delivers the first", async () => {
  const session = await openSession()
  session.turn("first")
  session.server.enqueue("p1")
  session.loader.markHistoryStale()
  for (let i = 0; i < 400; i += 1) session.server.reply(`m${i}`, false)
  session.server.deliver("p1", false)
  session.server.enqueue("p2")
  session.failInbox()
  await refresh(session)
  expect(session.ids().at(-1)).toBe("p2")
  expect(session.ids().slice(0, -1)).toEqual(session.newest(session.ids().length - 1))
})

for (const kind of ["foreign", "local", "synthetic"] as const) {
  test(`a ${kind} prompt cancelled during a gap leaves on refresh`, async () => {
    const session = await openSession()
    session.turn("first")
    if (kind === "local") session.send("gone")
    session.server.enqueue("gone", kind === "synthetic" ? "synthetic" : "user")
    session.server.enqueue("waiting")
    session.loader.markHistoryStale()
    session.server.cancel("gone", false)
    session.server.reply("later", false)
    await refresh(session)
    expect([...session.ids()].sort()).toEqual([...session.serverIDs(), "waiting"].sort())
    expect(session.store.getState().part.gone).toBeUndefined()
    await refresh(session)
    expect(session.ids()).not.toContain("gone")
  })
}

test("a failed inbox read removes no queued prompt", async () => {
  const session = await openSession()
  session.turn("first")
  session.server.enqueue("queued")
  session.loader.markHistoryStale()
  session.server.cancel("queued", false)
  session.failInbox()
  await refresh(session)
  expect(session.ids()).toContain("queued")
})

test("a refresh keeps a prompt enqueued while it reads and a send the server has not answered", async () => {
  const session = await openSession()
  session.turn("first")
  session.send("sending", false)
  session.server.enqueue("sending")
  session.server.cancel("sending", false)
  session.loader.markHistoryStale()
  session.whilePageIsRead("before", () => session.server.enqueue("during"))
  await refresh(session)
  expect(session.ids()).toContain("during")
  expect(session.ids()).toContain("sending")
})

test("a prompt delivered after the page was read stays while its delivery event is late", async () => {
  const session = await openSession()
  session.turn("first")
  session.server.enqueue("queued")
  let announce = () => {}
  session.whilePageIsRead("after", () => { announce = session.server.deliver("queued", false) })
  await refresh(session)
  expect(session.ids()).toContain("queued")
  announce()
  expect(session.ids()).toEqual(session.serverIDs())
})

test("a trim keeps a foreign queued prompt above the cut, and older history still loads", async () => {
  const session = await openSession()
  session.turn("first")
  session.server.enqueue("queued")
  for (let i = 0; i < 14; i += 1) session.turn(`${i}`)
  expect(session.loader.trimHistory(target)).toBe(true)
  expect(session.ids()).toEqual(["queued", ...session.newest(20)])
  expect(session.store.getState().part.queued).toHaveLength(1)
  expect(session.loader.trimHistory(target)).toBe(false)
  await session.loader.loadOlder(target)
  expect(session.loader.getSnapshot(target).status).toBe("ready")
  expect(session.ids().filter((id) => id !== "queued")).toEqual(session.serverIDs())
  session.server.deliver("queued")
  expect(session.ids()).toEqual(session.serverIDs())
})

test("a trim starts its window at a delivered prompt when a queued one is the tenth from the end", async () => {
  const session = await openSession()
  for (let i = 0; i < 6; i += 1) session.turn(`old${i}`)
  session.server.enqueue("queued")
  for (let i = 0; i < 9; i += 1) session.turn(`${i}`)
  expect(session.loader.trimHistory(target)).toBe(true)
  expect(session.ids().filter((id) => id !== "queued")).toEqual(session.newest(20))
  await session.loader.loadOlder(target)
  expect(session.ids().filter((id) => id !== "queued")).toEqual(session.serverIDs())
})

test("a queued prompt cancelled live does not return when the inbox read fails", async () => {
  const session = await openSession()
  session.turn("first")
  session.send("cancelled")
  session.server.enqueue("cancelled")
  session.server.cancel("cancelled")
  session.failInbox()
  await refresh(session)
  expect(session.ids()).toEqual(session.serverIDs())
})

test("a refresh keeps a delivered prompt whose echo was lost when its page does not reach it", async () => {
  const session = await openSession()
  session.turn("first")
  session.send("sent")
  session.server.enqueue("sent", "user", false)
  session.server.deliver("sent", false)
  for (let i = 0; i < 40; i += 1) session.server.reply(`m${i}`)
  await refresh(session)
  expect(session.ids()).toEqual(session.serverIDs())
})

for (const trimmed of [true, false]) {
  test(`a queued prompt ${trimmed ? "kept above a trim" : "above later turns"} and delivered during a gap joins the tail in order`, async () => {
    const session = await openSession()
    session.turn("first")
    session.server.enqueue("queued")
    for (let i = 0; i < (trimmed ? 14 : 5); i += 1) session.turn(`${i}`)
    expect(session.loader.trimHistory(target)).toBe(trimmed)
    session.loader.markHistoryStale()
    session.server.deliver("queued", false)
    await session.loader.refreshTail(target, 2)
    expect(session.ids()).toEqual(session.newest(session.ids().length))
    expect(session.ids().at(-1)).toBe("queued")
  })
}
