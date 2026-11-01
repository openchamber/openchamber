import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { opencodeClient } from "@/lib/opencode/client"
import type { Session } from "@/lib/opencode/model"
import { getRuntimeApiBaseUrl, getRuntimeKey, switchRuntimeEndpoint } from "@/lib/runtime-switch"
import { useConfigStore } from "@/stores/useConfigStore"
import { ChildStoreManager } from "./child-store"
import { setActionRefs, setOptimisticRefs } from "./session-actions"
import { resolveSendSelection } from "./session-selection"
import { routeMessage } from "./session-ui-store"
import { setSyncRefs } from "./sync-refs"

const DIRECTORY = "/repo/agent selection"
const SESSION_ID = "ses_agent_selection"
const MODEL = { providerID: "provider", id: "model" }
const session: Session = {
  id: SESSION_ID,
  projectID: "project",
  directory: DIRECTORY,
  title: "Agent selection",
  agent: "build",
  model: MODEL,
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
}
const originalRuntime = { apiBaseUrl: getRuntimeApiBaseUrl(), runtimeKey: getRuntimeKey() }
const requests: Array<{ path: string; directory: string | null }> = []
let manager: ChildStoreManager
let restoreFetch = () => {}
let serverAgent: string
let respond: () => Response | Promise<Response>
const serverResponse = () => Response.json({ data: { ...session, agent: serverAgent, location: { directory: DIRECTORY } } })
const selectAgent = (agent?: string) => resolveSendSelection(SESSION_ID, DIRECTORY, {
  providerID: MODEL.providerID,
  modelID: MODEL.id,
  agent,
})

beforeEach(() => {
  requests.length = 0
  serverAgent = "plan"
  respond = serverResponse
  switchRuntimeEndpoint({ apiBaseUrl: "http://agent-selection.test", runtimeKey: "agent-selection" })
  opencodeClient.reconnectToRuntimeBaseUrl()
  manager = new ChildStoreManager()
  manager.ensureChild(DIRECTORY, { bootstrap: false }).setState({ session: [session] })
  setSyncRefs(opencodeClient.getScopedSdkClient(DIRECTORY), manager, DIRECTORY)
  const transport = spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.pathname === "/auth/url-token") return new Response(null, { status: 404 })
    requests.push({ path: url.pathname, directory: new Headers(init?.headers).get("x-opencode-directory") })
    return respond()
  })
  restoreFetch = () => transport.mockRestore()
})

afterEach(() => {
  restoreFetch()
  manager.disposeAll()
  setSyncRefs(opencodeClient.getSdkClient(), new ChildStoreManager(), "")
  switchRuntimeEndpoint(originalRuntime)
  opencodeClient.reconnectToRuntimeBaseUrl()
})

describe("send agent selection", () => {
  test("a stale Build cache cannot suppress a switch from the server's Plan agent (#6035)", async () => {
    const selection = await selectAgent("build")

    expect(selection.agent).toBe("build")
    expect(selection.model).toBeUndefined()
    expect(requests).toEqual([{ path: `/api/session/${SESSION_ID}`, directory: encodeURIComponent(DIRECTORY) }])
  })

  test("the server's matching agent skips a switch even when the cache disagrees", async () => {
    serverAgent = "build"
    manager.getChild(DIRECTORY)?.setState({ session: [{ ...session, agent: "plan" }] })

    expect((await selectAgent("build")).agent).toBeUndefined()
    expect(requests).toHaveLength(1)
  })

  test("a session absent from the cache still compares the server's agent", async () => {
    manager.getChild(DIRECTORY)?.setState({ session: [] })
    serverAgent = "build"

    expect((await selectAgent("build")).agent).toBeUndefined()
    expect(requests).toHaveLength(1)
  })

  test("a send without an agent keeps the model comparison and makes no server read", async () => {
    expect(await selectAgent()).toEqual({ model: undefined, agent: undefined })
    expect(requests).toHaveLength(0)
  })

  test("a failed server read rejects instead of granting the cached agent authority", async () => {
    respond = () => new Response(null, { status: 503 })

    await expect(selectAgent("build")).rejects.toThrow()
    expect(requests).toHaveLength(1)
  })

  test("a failed agent read rolls the send back without prompt-confirmation reads", async () => {
    const wasConnected = useConfigStore.getState().isConnected
    useConfigStore.setState({ isConnected: true })
    setActionRefs(manager, () => DIRECTORY)
    const removed: string[] = []
    setOptimisticRefs(() => {}, ({ messageID }) => { removed.push(messageID) })
    respond = () => new Response(null, { status: 503 })
    try {
      await expect(routeMessage({
        runtimeKey: getRuntimeKey(),
        sessionId: SESSION_ID,
        directory: DIRECTORY,
        content: "Switch to Build",
        providerID: MODEL.providerID,
        modelID: MODEL.id,
        agent: "build",
      })).rejects.toThrow()

      expect(requests).toHaveLength(1)
      expect(removed).toHaveLength(1)
      expect(manager.getChild(DIRECTORY)?.getState().session_status[SESSION_ID]?.type).toBe("idle")
    } finally {
      useConfigStore.setState({ isConnected: wasConnected })
    }
  })

  test("model and effort changes received during the agent read remain visible to the send", async () => {
    manager.getChild(DIRECTORY)?.setState({ session: [{ ...session, model: { ...MODEL, variant: "high" } }] })
    let started = () => {}
    const requested = new Promise<void>((resolve) => { started = resolve })
    let finish = (_response: Response) => {}
    const held = new Promise<Response>((resolve) => { finish = resolve })
    respond = () => { started(); return held }
    const selection = resolveSendSelection(SESSION_ID, DIRECTORY, {
      providerID: MODEL.providerID,
      modelID: MODEL.id,
      variant: "high",
      agent: "build",
    })
    await requested
    manager.getChild(DIRECTORY)?.setState({ session: [{ ...session, model: { ...MODEL, variant: "low" } }] })
    finish(serverResponse())

    expect((await selection).model).toEqual({ ...MODEL, variant: "high" })
  })

  for (const roundTrip of [false, true]) {
    test(`a runtime change discards the server read, return to original: ${roundTrip}`, async () => {
      let started = () => {}
      const requested = new Promise<void>((resolve) => { started = resolve })
      let finish = (_response: Response) => {}
      const held = new Promise<Response>((resolve) => { finish = resolve })
      respond = () => { started(); return held }
      const selection = selectAgent("build")
      await requested

      switchRuntimeEndpoint({ apiBaseUrl: "http://agent-other.test", runtimeKey: "agent-other" })
      if (roundTrip) switchRuntimeEndpoint({ apiBaseUrl: "http://agent-selection.test", runtimeKey: "agent-selection" })
      finish(serverResponse())

      await expect(selection).rejects.toThrow("runtime changed")
      expect(requests).toHaveLength(1)
    })
  }
})
