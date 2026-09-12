import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createOpencodeClient, type Session } from "@opencode-ai/sdk/v2/client"
import { opencodeClient } from "@/lib/opencode/client"
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
const sdk = createOpencodeClient({
  baseUrl: "http://session-creation.test",
  fetch: async () => {
    requests += 1
    return Response.json({ message: "not found" }, { status: 404 })
  },
})
const session: Session = {
  id: "session-created",
  slug: "created",
  projectID: "project-created",
  directory: "C:/canonical/worktree",
  title: "New session",
  version: "1",
  time: { created: 1, updated: 1 },
}

beforeEach(() => {
  requests = 0
  childStores = new ChildStoreManager()
  loader = new SessionMessageLoader(childStores, { sdk, runtimeKey: getRuntimeKey() })
  setActionRefs(sdk, childStores, () => "/requested")
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
      agent: "build",
      model: { providerID: "test", modelID: "test" },
    } satisfies import("@opencode-ai/sdk/v2/client").UserMessage
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
