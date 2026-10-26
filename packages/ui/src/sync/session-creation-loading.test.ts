import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { Session, UserMessage } from "@/lib/opencode/model"
import { opencodeClient } from "@/lib/opencode/client"
import type { MessagePage } from "@/lib/opencode/client"
import type { SessionMessagePageSource } from "./session-message-loader"
import { getRuntimeKey } from "@/lib/runtime-switch"
import { ChildStoreManager } from "./child-store"
import { createSession, setActionRefs } from "./session-actions"
import { SessionMessageLoader, setImperativeSessionMessageLoader } from "./session-message-loader"
import { useSessionUIStore } from "./session-ui-store"

const originalCreateSession = opencodeClient.createSession
const originalDirectory = opencodeClient.getDirectory()
const originalSelection = useSessionUIStore.getState()
let childStores: ChildStoreManager
let loader: SessionMessageLoader
let requests = 0
// Any history read is a failure for these tests, so the page source counts
// calls and rejects.
const sdk: SessionMessagePageSource = {
  getSessionMessages: async (): Promise<MessagePage> => {
    requests += 1
    throw new Error("history read should not happen")
  },
}
const session: Session = {
  id: "session-created",
  projectID: "project-created",
  directory: "C:/canonical/worktree",
  title: "New session",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
}

beforeEach(() => {
  requests = 0
  childStores = new ChildStoreManager()
  loader = new SessionMessageLoader(childStores, { sdk, runtimeKey: getRuntimeKey() })
  setActionRefs(childStores, () => "/requested")
  setImperativeSessionMessageLoader(loader)
})

afterEach(() => {
  opencodeClient.createSession = originalCreateSession
  opencodeClient.setDirectory(originalDirectory)
  useSessionUIStore.setState(originalSelection)
  setImperativeSessionMessageLoader(null)
  loader.dispose()
  childStores.disposeAll()
})

describe("confirmed session creation", () => {
  test("publishes the new transcript before navigation can issue a failing history read", async () => {
    opencodeClient.createSession = async () => session

    expect(await createSession(undefined, "/requested")).toBe(session)
    const target = { directory: session.directory, sessionID: session.id }
    await loader.ensure(target, { reason: "reactive" })

    expect(requests).toBe(0)
    expect(useSessionUIStore.getState().currentSessionDirectory).toBe(session.directory)
    expect(childStores.getChild(session.directory)?.getState().session).toEqual([session])
    expect(childStores.getChild(session.directory)?.getState().message[session.id]).toEqual([])
    expect(loader.getSnapshot(target).status).toBe("ready")
    expect(childStores.getChild("/requested")?.getState().message[session.id]).toBeUndefined()
  })

  test("retains newer metadata and the first prompt delivered before the create response", async () => {
    const store = childStores.ensureChild(session.directory, { bootstrap: false })
    const newerSession = { ...session, title: "Already renamed", time: { created: 1, updated: 2 } }
    const record = {
      id: "msg_first",
      sessionID: session.id,
      role: "user",
      time: { created: 2 },
    } satisfies UserMessage
    opencodeClient.createSession = async () => {
      store.setState({ session: [newerSession], message: { [session.id]: [record] } })
      return session
    }

    await createSession(undefined, "/requested")

    expect(requests).toBe(0)
    expect(store.getState().session).toEqual([newerSession])
    expect(store.getState().message[session.id]).toEqual([record])
  })

  test("a rejected create does not seed an empty successful transcript", async () => {
    opencodeClient.createSession = async () => { throw new Error("offline") }
    const previousSelection = useSessionUIStore.getState().currentSessionId

    expect(await createSession(undefined, "/requested")).toBeNull()

    expect(useSessionUIStore.getState().currentSessionId).toBe(previousSelection)
    expect(childStores.getChild(session.directory)).toBeUndefined()
    expect(requests).toBe(0)
  })
})
