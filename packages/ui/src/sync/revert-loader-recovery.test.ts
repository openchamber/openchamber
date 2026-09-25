import { afterEach, expect, test } from "bun:test"
import type { MessagePage } from "@/lib/opencode/client"
import type { Message } from "@/lib/opencode/model"
import { getRuntimeKey } from "@/lib/runtime-switch"
import { ChildStoreManager } from "./child-store"
import { SessionMessageLoader, setImperativeSessionMessageLoader } from "./session-message-loader"
import { getSessionPrefetch, setSessionPrefetch } from "./session-prefetch-cache"
import { createEventRoutingIndex, handleEvent } from "./sync-context"

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })

const target = { directory: "/revert-loader-test", sessionID: "ses_revert" }
const message: Message = { id: "msg_deleted", sessionID: target.sessionID, role: "user", time: { created: 1 } }
const emptyPage: MessagePage = { items: [], cursor: {} }
const oldPage: MessagePage = { items: [{ info: message, parts: [] }], cursor: {} }

function setup(getSessionMessages: () => Promise<MessagePage>) {
  const childStores = new ChildStoreManager()
  const loader = new SessionMessageLoader(childStores, { sdk: { getSessionMessages }, runtimeKey: getRuntimeKey() })
  loader.initializeCreatedSession(target)
  const store = childStores.ensureChild(target.directory, { bootstrap: false })
  setImperativeSessionMessageLoader(loader)
  cleanups.push(() => {
    setImperativeSessionMessageLoader(null)
    loader.dispose()
    childStores.disposeAll()
  })
  const commit = (directory = target.directory) => handleEvent(directory, {
    type: "session.revert.committed", properties: { sessionID: target.sessionID, to: message.id },
  }, childStores, createEventRoutingIndex(), getRuntimeKey())
  return { loader, store, commit }
}

test("a committed revert clears optimistic shadows before the next empty snapshot", async () => {
  const { loader, store, commit } = setup(async () => emptyPage)
  loader.optimisticAdd({ ...target, message, parts: [] })
  commit()
  expect(store.getState().message[target.sessionID]).toEqual([])
  await loader.refreshTail(target, 100)
  expect(store.getState().message[target.sessionID]).toEqual([])
})

test("a response started before commit cannot restore its deleted messages", async () => {
  let resolvePage: (page: MessagePage) => void = () => { throw new Error("Request has not started") }
  const pendingPage = new Promise<MessagePage>((resolve) => { resolvePage = resolve })
  const { loader, store, commit } = setup(() => pendingPage)
  store.setState({ message: { [target.sessionID]: [message] } })
  const pending = loader.refreshTail(target, 100)
  commit()
  resolvePage(oldPage)
  await pending
  expect(store.getState().message[target.sessionID]).toEqual([])
})

test("commit preserves optimistic messages before the boundary and resolves an unindexed directory", async () => {
  const { loader, store, commit } = setup(async () => emptyPage)
  const survivor: Message = { ...message, id: "msg_survivor", time: { created: 0 } }
  loader.optimisticAdd({ ...target, message: survivor, parts: [] })
  loader.optimisticAdd({ ...target, message, parts: [] })
  commit("/unindexed-revert-directory")
  expect(store.getState().message[target.sessionID]).toEqual([survivor])
  // Empty visible state makes the remaining shadow observable independently
  // of the materializer's merge of existing messages.
  store.setState({ message: { [target.sessionID]: [] } })
  await loader.refreshTail(target, 100)
  expect(store.getState().message[target.sessionID]).toEqual([survivor])
})

test("an older-page response crossing commit cannot restore the deleted range", async () => {
  let resolvePage: (page: MessagePage) => void = () => { throw new Error("Request has not started") }
  const pendingPage = new Promise<MessagePage>((resolve) => { resolvePage = resolve })
  let reads = 0
  const { loader, store, commit } = setup(async () => ++reads === 1
    ? { ...oldPage, cursor: { next: "older" } }
    : pendingPage)
  store.setState({ message: { [target.sessionID]: [message] } })
  loader.invalidateSession(target)
  await loader.ensure(target)
  const pending = loader.loadOlder(target)
  commit()
  resolvePage(oldPage)
  await pending
  expect(store.getState().message[target.sessionID]).toEqual([])
})

test("commit clears prefetch coverage even when no loader entry exists", () => {
  const childStores = new ChildStoreManager()
  const loader = new SessionMessageLoader(childStores, {
    sdk: { getSessionMessages: async () => emptyPage }, runtimeKey: getRuntimeKey(),
  })
  setImperativeSessionMessageLoader(loader)
  cleanups.push(() => { setImperativeSessionMessageLoader(null); loader.dispose(); childStores.disposeAll() })
  setSessionPrefetch({ ...target, limit: 100, complete: true })
  handleEvent(target.directory, {
    type: "session.revert.committed", properties: { sessionID: target.sessionID, to: message.id },
  }, childStores, createEventRoutingIndex(), getRuntimeKey())
  expect(getSessionPrefetch(target.directory, target.sessionID)).toBeUndefined()
})

test("a no-op commit still clears shadows and cached coverage while preserving another session", async () => {
  const { loader, store, commit } = setup(async () => emptyPage)
  const otherTarget = { ...target, sessionID: "ses_other" }
  loader.initializeCreatedSession(otherTarget)
  const otherMessage: Message = { ...message, id: "msg_other", sessionID: otherTarget.sessionID }
  loader.optimisticAdd({ ...otherTarget, message: otherMessage, parts: [] })
  loader.optimisticAdd({ ...target, message, parts: [] })
  store.setState({ message: { ...store.getState().message, [target.sessionID]: [] } })
  expect(getSessionPrefetch(target.directory, target.sessionID)).toBeDefined()

  commit()

  expect(getSessionPrefetch(target.directory, target.sessionID)).toBeUndefined()
  expect(getSessionPrefetch(otherTarget.directory, otherTarget.sessionID)).toBeDefined()
  await loader.refreshTail(target, 100)
  await loader.refreshTail(otherTarget, 100)
  expect(store.getState().message[target.sessionID]).toEqual([])
  expect(store.getState().message[otherTarget.sessionID]).toEqual([otherMessage])
})
