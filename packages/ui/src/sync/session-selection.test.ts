import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { opencodeClient } from "@/lib/opencode/client"
import { recordProviderError } from "@/lib/opencode/provider-tracker"
import type { Session } from "@/lib/opencode/model"
import { getRuntimeApiBaseUrl, getRuntimeKey, switchRuntimeEndpoint } from "@/lib/runtime-switch"
import { useConfigStore } from "@/stores/useConfigStore"
import { ChildStoreManager } from "./child-store"
import { compactSession, replyToForm, setActionRefs, setOptimisticRefs } from "./session-actions"
import { resolveSendSelection } from "./session-selection"
import * as modelGesture from "./model-gesture"
import { commitModelPick, whenModelPickWritten } from "./model-gesture"
import { routeMessage, useSessionUIStore } from "./session-ui-store"
import { useSelectionStore } from "./selection-store"
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
const requestBodies = new Map<string, string[]>()
let manager: ChildStoreManager
let restoreFetch = () => {}
let serverAgent: string
let serverModel: Session["model"]
let serverOutcome: Session["outcome"]
let respond: (path: string, body?: string) => Response | Promise<Response>
const serverResponse = () => Response.json({ data: { ...session, agent: serverAgent, model: serverModel, outcome: serverOutcome, location: { directory: DIRECTORY } } })
const selectAgent = (agent?: string) => resolveSendSelection(SESSION_ID, DIRECTORY, {
  providerID: MODEL.providerID,
  modelID: MODEL.id,
  agent,
})

beforeEach(() => {
  requests.length = 0
  requestBodies.clear()
  serverAgent = "plan"
  serverModel = MODEL
  serverOutcome = undefined
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
    const body = String(init?.body ?? (input instanceof Request ? await input.clone().text() : ""))
    requestBodies.set(url.pathname, [...(requestBodies.get(url.pathname) ?? []), body])
    return respond(url.pathname, body)
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

  test("a send without an agent skips the switch when the server and the cache both match", async () => {
    expect(await selectAgent()).toEqual({ agent: undefined, providerID: MODEL.providerID })
    expect(requests).toHaveLength(1)
  })

  test("a failed server read rejects instead of granting the cached agent authority", async () => {
    respond = () => new Response(null, { status: 503 })

    await expect(selectAgent("build")).rejects.toThrow()
    expect(requests).toHaveLength(1)
  })

  test("a failed server read without an agent still sends, and judges no provider it cannot know", async () => {
    manager.getChild(DIRECTORY)?.setState({ session: [{ ...session, model: { providerID: "stale-provider", id: "old" } }] })
    respond = () => new Response(null, { status: 503 })

    expect(await selectAgent()).toEqual({})
    expect(requests).toHaveLength(1)
  })

  test("an Auto composer judges no provider: the server routes the prompt", async () => {
    expect(await resolveSendSelection(SESSION_ID, DIRECTORY, { providerID: "openchamber", modelID: "auto" })).toEqual({ agent: undefined, providerID: undefined })
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

  test("a send goes to the session's own directory when another store also holds it (#6262)", async () => {
    const wasConnected = useConfigStore.getState().isConnected
    useConfigStore.setState({ isConnected: true })
    setActionRefs(manager, () => DIRECTORY)
    setOptimisticRefs(() => {}, () => {})
    manager.ensureChild("/chats/other", { bootstrap: false }).setState({ session: [session] })
    respond = () => new Response(null, { status: 503 })
    try {
      await expect(routeMessage({
        runtimeKey: getRuntimeKey(),
        sessionId: SESSION_ID,
        directory: DIRECTORY,
        content: "Follow up",
        providerID: MODEL.providerID,
        modelID: MODEL.id,
        agent: "build",
      })).rejects.toThrow()

      expect(requests[0]?.directory).toBe(encodeURIComponent(DIRECTORY))
    } finally {
      useConfigStore.setState({ isConnected: wasConnected })
    }
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

describe("only a fresh choice in this client changes the model of an existing session", () => {
  const OPUS = { providerID: "anthropic", id: "opus", variant: "high" }
  const FABLE = { providerID: "anthropic", id: "fable", variant: "medium" }
  const OPUS_XHIGH = { providerID: "anthropic", id: "opus", variant: "xhigh" }
  const composer = { providerID: FABLE.providerID, modelID: FABLE.id, variant: FABLE.variant, agent: "build" }
  const modelPath = `/api/session/${SESSION_ID}/model`
  const promptPath = `/api/session/${SESSION_ID}/prompt`
  const modelPosts = () => (requestBodies.get(modelPath) ?? []).map((body) => JSON.parse(body).model)
  const promptsAcceptedOn: Array<Session["model"]> = []
  const serverEvents: string[] = []
  let heldModelPost: Promise<void> | null = null
  let modelPostStarted = () => {}
  const liveServer = async (path: string, body?: string) => {
    if (path === `/api/session/${SESSION_ID}`) return serverResponse()
    if (path === modelPath) {
      modelPostStarted()
      await heldModelPost
      serverModel = JSON.parse(body ?? "{}").model
      serverEvents.push("model written")
      return new Response(null, { status: 204 })
    }
    if (path.endsWith("/form/q-1/reply")) serverEvents.push("form answered")
    if (path === promptPath) {
      promptsAcceptedOn.push(serverModel)
      return Response.json({ data: { id: "msg_1", sessionID: SESSION_ID, time: { created: 1 }, type: "user", payload: { text: "Next" }, delivery: "queue" } })
    }
    if (path.endsWith("/compact")) return Response.json({ data: { id: "msg_2", sessionID: SESSION_ID, time: { created: 1 }, type: "compaction", payload: {}, delivery: "queue" } })
    return new Response(null, { status: 204 })
  }
  const runningOn = (model: Session["model"], record: Partial<Session> | null = { outcome: "succeeded" }) => {
    serverAgent = "build"
    serverModel = model
    serverOutcome = record?.outcome
    manager.getChild(DIRECTORY)?.setState({ session: record ? [{ ...session, agent: "build", model, ...record }] : [] })
  }
  const connected = async <T,>(act: () => Promise<T>): Promise<T> => {
    const wasConnected = useConfigStore.getState().isConnected
    const config = useConfigStore.getState()
    const wasComposer = { currentProviderId: config.currentProviderId, currentModelId: config.currentModelId, currentVariant: config.currentVariant, currentAgentName: config.currentAgentName }
    const wasSession = useSessionUIStore.getState().currentSessionId
    useConfigStore.setState({ isConnected: true, currentProviderId: FABLE.providerID, currentModelId: FABLE.id, currentVariant: FABLE.variant, currentAgentName: "build" })
    useSessionUIStore.setState({ currentSessionId: SESSION_ID })
    setActionRefs(manager, () => DIRECTORY)
    setOptimisticRefs(() => {}, () => {})
    try {
      return await act()
    } finally {
      useSessionUIStore.setState({ currentSessionId: wasSession })
      useConfigStore.setState({ isConnected: wasConnected, ...wasComposer })
    }
  }
  const sendMessage = () => connected(() => routeMessage({ runtimeKey: getRuntimeKey(), sessionId: SESSION_ID, directory: DIRECTORY, content: "Next", ...composer }))
  const answerForm = () => connected(() => replyToForm(SESSION_ID, "q-1", { choice: true }))
  const compact = () => connected(() => compactSession(SESSION_ID, DIRECTORY))

  beforeEach(() => {
    useSelectionStore.getState().clearSessionSelections(SESSION_ID)
    promptsAcceptedOn.length = 0
    serverEvents.length = 0
    heldModelPost = null
    modelPostStarted = () => {}
    respond = liveServer
  })

  for (const [label, record] of [
    ["has run and is cached", { outcome: "succeeded" } as const],
    ["has no outcome yet and is cached", {}],
    ["is not cached at all", null],
  ] as const) {
    describe(`a session that ${label}`, () => {
      beforeEach(() => runningOn(OPUS, record))

      test("a send is accepted on the model another client chose, with no model request", async () => {
        expect(await sendMessage()).toBe("prompt")

        expect(modelPosts()).toEqual([])
        expect(promptsAcceptedOn).toEqual([OPUS])
      })

      test("a form answer is accepted on the model another client chose, with no model request", async () => {
        await answerForm()

        expect(requests.map((request) => request.path)).toContain(`/api/session/${SESSION_ID}/form/q-1/reply`)
        expect(modelPosts()).toEqual([])
        expect(serverModel).toEqual(OPUS)
      })

      test("a compaction leaves the model alone, also when the server read fails", async () => {
        await compact()
        respond = (path, body) => path === `/api/session/${SESSION_ID}` ? new Response(null, { status: 503 }) : liveServer(path, body)
        await compact()

        expect(modelPosts()).toEqual([])
        expect(requests.filter((request) => request.path.endsWith("/compact"))).toHaveLength(2)
      })
    })
  }

  test("a send whose server read fails is still accepted, on the model the session has", async () => {
    runningOn(OPUS, null)
    respond = (path, body) => path === `/api/session/${SESSION_ID}` ? new Response(null, { status: 503 }) : liveServer(path, body)

    const sent = await connected(() => routeMessage({ runtimeKey: getRuntimeKey(), sessionId: SESSION_ID, directory: DIRECTORY, content: "Next", ...composer, agent: undefined }))

    expect(sent).toBe("prompt")
    expect(modelPosts()).toEqual([])
    expect(promptsAcceptedOn).toEqual([OPUS])
  })

  test("a fresh pick switches the session to exactly that model and effort, once; sends and answers after it never replay it", async () => {
    runningOn(OPUS)
    commitModelPick(SESSION_ID, { providerID: FABLE.providerID, modelID: FABLE.id, variant: FABLE.variant })
    await whenModelPickWritten(SESSION_ID)

    expect(modelPosts()).toEqual([FABLE])
    expect(serverModel).toEqual(FABLE)

    expect(await sendMessage()).toBe("prompt")
    await answerForm()
    await compact()
    expect(await sendMessage()).toBe("prompt")
    expect(modelPosts()).toEqual([FABLE])
    expect(promptsAcceptedOn).toEqual([FABLE, FABLE])
  })

  test("after another client's later choice, this client's next sends and answers keep it, pick or no pick", async () => {
    runningOn(OPUS)
    commitModelPick(SESSION_ID, { providerID: FABLE.providerID, modelID: FABLE.id, variant: FABLE.variant })
    await whenModelPickWritten(SESSION_ID)

    runningOn(OPUS)
    expect(await sendMessage()).toBe("prompt")
    await answerForm()
    runningOn(OPUS_XHIGH)
    expect(await sendMessage()).toBe("prompt")
    runningOn(OPUS)
    expect(await sendMessage()).toBe("prompt")

    expect(modelPosts()).toEqual([FABLE])
    expect(promptsAcceptedOn).toEqual([OPUS, OPUS_XHIGH, OPUS])
  })

  test("a fresh pick is written even when the local record already shows that model", async () => {
    runningOn(OPUS)
    manager.getChild(DIRECTORY)?.setState({ session: [{ ...session, agent: "build", model: FABLE, outcome: "succeeded" }] })

    commitModelPick(SESSION_ID, { providerID: FABLE.providerID, modelID: FABLE.id, variant: FABLE.variant })
    await whenModelPickWritten(SESSION_ID)

    expect(modelPosts()).toEqual([FABLE])
    expect(serverModel).toEqual(FABLE)
  })

  test("an effort-only pick writes the model with that effort", async () => {
    runningOn(OPUS)

    commitModelPick(SESSION_ID, { providerID: OPUS.providerID, modelID: OPUS.id, variant: OPUS_XHIGH.variant })
    await whenModelPickWritten(SESSION_ID)

    expect(modelPosts()).toEqual([OPUS_XHIGH])
    expect(serverModel).toEqual(OPUS_XHIGH)
  })

  test("picks made in quick succession end on the last one, and a pick made during a write follows it in order", async () => {
    runningOn(OPUS)
    commitModelPick(SESSION_ID, { providerID: FABLE.providerID, modelID: FABLE.id, variant: FABLE.variant })
    commitModelPick(SESSION_ID, { providerID: OPUS.providerID, modelID: OPUS.id, variant: OPUS_XHIGH.variant })
    await whenModelPickWritten(SESSION_ID)
    expect(modelPosts()).toEqual([OPUS_XHIGH])

    let release = () => {}
    heldModelPost = new Promise<void>((resolve) => { release = resolve })
    const writing = new Promise<void>((resolve) => { modelPostStarted = resolve })
    commitModelPick(SESSION_ID, { providerID: FABLE.providerID, modelID: FABLE.id, variant: FABLE.variant })
    await writing
    commitModelPick(SESSION_ID, { providerID: OPUS.providerID, modelID: OPUS.id, variant: OPUS.variant })
    heldModelPost = null
    release()
    await whenModelPickWritten(SESSION_ID)

    expect(modelPosts()).toEqual([OPUS_XHIGH, FABLE, OPUS])
    expect(serverModel).toEqual(OPUS)
  })

  test("a send made right after a pick waits for the pick's write", async () => {
    runningOn(OPUS)
    let release = () => {}
    heldModelPost = new Promise<void>((resolve) => { release = resolve })
    commitModelPick(SESSION_ID, { providerID: FABLE.providerID, modelID: FABLE.id, variant: FABLE.variant })
    const writing = new Promise<void>((resolve) => { modelPostStarted = resolve })
    const sent = sendMessage()
    await writing

    release()
    await sent

    expect(promptsAcceptedOn).toEqual([FABLE])
    expect(requests.map((request) => request.path).filter((path) => path === modelPath || path === promptPath)).toEqual([modelPath, promptPath])
  })

  test("a pick whose write fails is dropped, and no later send writes it for it", async () => {
    runningOn(OPUS)
    respond = (path, body) => path === modelPath ? new Response(null, { status: 503 }) : liveServer(path, body)

    commitModelPick(SESSION_ID, { providerID: FABLE.providerID, modelID: FABLE.id, variant: FABLE.variant })
    await whenModelPickWritten(SESSION_ID)
    expect(useSelectionStore.getState().getSessionModelPick(SESSION_ID)).toBeNull()

    expect(await sendMessage()).toBe("prompt")
    expect(modelPosts()).toHaveLength(1)
    expect(promptsAcceptedOn).toEqual([OPUS])
  })

  test("a pick on something that is not a session, such as a pending BTW composer, writes nothing", async () => {
    commitModelPick("btw-pending:ses_agent_selection", { providerID: FABLE.providerID, modelID: FABLE.id, variant: FABLE.variant })
    await whenModelPickWritten("btw-pending:ses_agent_selection")

    expect(requests).toEqual([])
  })

  test("an explicit Auto pick marks the session through the same switch", async () => {
    runningOn(OPUS)
    commitModelPick(SESSION_ID, { providerID: "openchamber", modelID: "auto" })
    await whenModelPickWritten(SESSION_ID)

    expect(modelPosts()).toEqual([{ providerID: "openchamber", id: "auto" }])
  })

  describe("the provider circuit", () => {
    const openCircuit = (providerID: string) => { for (let attempt = 0; attempt < 3; attempt += 1) recordProviderError(providerID, 503) }

    test("a stale composer's open provider cannot block a send that goes to the healthy provider the session runs on", async () => {
      runningOn(OPUS)
      openCircuit("stale-provider")

      const stale = { ...composer, providerID: "stale-provider" }
      const sent = await connected(() => routeMessage({ runtimeKey: getRuntimeKey(), sessionId: SESSION_ID, directory: DIRECTORY, content: "Next", ...stale }))

      expect(sent).toBe("prompt")
      expect(promptsAcceptedOn).toEqual([OPUS])
    })

    test("an open circuit on the provider the session runs on still stops the send", async () => {
      runningOn({ providerID: "tripped-provider", id: "model" })
      openCircuit("tripped-provider")

      await expect(sendMessage()).rejects.toThrow("temporarily unavailable")
      expect(promptsAcceptedOn).toEqual([])
    })

    test("an Auto prompt reaches the server's router even while the last real model's provider is tripped", async () => {
      const previous = { providerID: "auto-previous", id: "last" }
      const routed = { providerID: "auto-healthy", id: "next", variant: "high" }
      runningOn(previous)
      openCircuit(previous.providerID)
      // The server's live Auto middleware routes each accepted prompt to a healthy model.
      respond = async (path, body) => {
        if (path === promptPath) serverModel = routed
        return liveServer(path, body)
      }

      const sent = await connected(() => routeMessage({ runtimeKey: getRuntimeKey(), sessionId: SESSION_ID, directory: DIRECTORY, content: "Next", providerID: "openchamber", modelID: "auto", agent: "build" }))

      expect(sent).toBe("prompt")
      expect(promptsAcceptedOn).toEqual([routed])
      expect(serverModel).toEqual(routed)
      expect(modelPosts()).toEqual([])
    })

    test("a failed session read judges neither the cached nor the composer's provider, and the send reaches the prompt", async () => {
      const healthy = { providerID: "offline-healthy-provider", id: "current" }
      runningOn(healthy, { outcome: "succeeded", model: { providerID: "offline-stale-provider", id: "old" } })
      serverModel = healthy
      openCircuit("offline-stale-provider")
      respond = (path, body) => path === `/api/session/${SESSION_ID}` ? new Response(null, { status: 503 }) : liveServer(path, body)

      const sent = await connected(() => routeMessage({ runtimeKey: getRuntimeKey(), sessionId: SESSION_ID, directory: DIRECTORY, content: "Next", ...composer, providerID: "offline-stale-provider", agent: undefined }))

      expect(sent).toBe("prompt")
      expect(promptsAcceptedOn).toEqual([healthy])
      expect(modelPosts()).toEqual([])
    })
  })

  describe("a form answer", () => {
    for (const child of [true, false]) {
      test(`waits for this client's own model pick still being written, whether or not an agent is picked (child session: ${child})`, async () => {
        runningOn(OPUS, child ? { outcome: "succeeded", parentID: "ses_parent" } : { outcome: "succeeded" })
        let release = () => {}
        heldModelPost = new Promise<void>((resolve) => { release = resolve })
        const writing = new Promise<void>((resolve) => { modelPostStarted = resolve })
        commitModelPick(SESSION_ID, { providerID: FABLE.providerID, modelID: FABLE.id, variant: FABLE.variant })
        await writing

        // The answer asks for the pick's write; released only after that, it must come after the write.
        let asked = () => {}
        const reachedTheWait = new Promise<void>((resolve) => { asked = resolve })
        const realWait = modelGesture.whenModelPickWritten
        const spy = spyOn(modelGesture, "whenModelPickWritten").mockImplementation((sessionId) => { asked(); return realWait(sessionId) })
        try {
          const answered = answerForm()
          await reachedTheWait
          release()
          await answered
        } finally {
          spy.mockRestore()
        }

        expect(serverEvents).toEqual(["model written", "form answered"])
        expect(serverModel).toEqual(FABLE)
        expect(modelPosts()).toEqual([FABLE])
      })
    }
  })
})

describe("a session this client creates or forks starts on the chosen model; no send writes one", () => {
  const FABLE = { providerID: "anthropic", id: "fable", variant: "medium" }
  const OPUS = { providerID: "anthropic", id: "opus", variant: "high" }
  const accepted: Array<Session["model"]> = []
  const modelPath = `/api/session/${SESSION_ID}/model`
  const promptPath = `/api/session/${SESSION_ID}/prompt`
  const modelPosts = () => (requestBodies.get(modelPath) ?? []).map((body) => JSON.parse(body).model)
  const createBodies = () => (requestBodies.get("/api/session") ?? []).map((body) => JSON.parse(body))
  let failFirstPrompt = false
  let holdRead: Promise<void> | undefined
  let readStarted: (() => void) | undefined
  const wasConfig = useConfigStore.getState()

  beforeEach(() => {
    useSelectionStore.getState().clearSessionSelections(SESSION_ID)
    accepted.length = 0
    failFirstPrompt = false
    holdRead = undefined
    readStarted = undefined
    serverAgent = "build"
    serverModel = FABLE
    serverOutcome = undefined
    useConfigStore.setState({ isConnected: true, currentAgentName: "build" })
    useSessionUIStore.setState({ currentSessionId: SESSION_ID })
    setActionRefs(manager, () => DIRECTORY)
    setOptimisticRefs(() => {}, () => {})
    manager.getChild(DIRECTORY)?.setState({ session: [{ ...session, model: FABLE, agent: "build" }] })
    respond = async (path, body) => {
      if (path === "/api/session") {
        const model = JSON.parse(body ?? "{}").model
        if (model) serverModel = model
        return serverResponse()
      }
      if (path.endsWith("/fork")) return serverResponse()
      if (path === `/api/session/${SESSION_ID}`) {
        readStarted?.()
        await holdRead
        return serverResponse()
      }
      if (path === modelPath) {
        serverModel = JSON.parse(body ?? "{}").model
        return new Response(null, { status: 204 })
      }
      if (path.endsWith("/agent")) {
        serverAgent = JSON.parse(body ?? "{}").agent
        return new Response(null, { status: 204 })
      }
      if (path === promptPath) {
        accepted.push(serverModel)
        if (failFirstPrompt) { failFirstPrompt = false; return new Response(null, { status: 503 }) }
        return Response.json({ data: { id: "msg_1", sessionID: SESSION_ID, time: { created: 1 }, type: "user", payload: { text: "Next" }, delivery: "queue" } })
      }
      if (path.endsWith("/message")) return new Response(null, { status: 503 })
      return new Response(null, { status: 204 })
    }
  })

  afterEach(() => {
    useConfigStore.setState({ isConnected: wasConfig.isConnected, currentAgentName: wasConfig.currentAgentName })
  })

  const send = () => routeMessage({ runtimeKey: getRuntimeKey(), sessionId: SESSION_ID, directory: DIRECTORY, content: "Next", providerID: FABLE.providerID, modelID: FABLE.id, variant: FABLE.variant, agent: "build" })
  const otherClientPicks = async (model: Session["model"]) => {
    const response = await fetch(`http://agent-selection.test${modelPath}`, { method: "POST", body: JSON.stringify({ model }), headers: { "content-type": "application/json" } })
    expect(response.status).toBe(204)
    expect(serverModel).toEqual(model)
  }
  const create = () => opencodeClient.createSession({ model: FABLE, agent: "build" }, DIRECTORY)
  const fork = () => opencodeClient.forkSession("ses_parent", { directory: DIRECTORY })

  test("a created session starts on the composer's model and effort through the create body, and its first send writes none", async () => {
    await create()
    expect(createBodies().map((body) => body.model)).toEqual([FABLE])
    expect(await send()).toBe("prompt")
    expect(accepted).toEqual([FABLE])
    expect(modelPosts()).toEqual([])
  })

  test("an Auto composer marks the new session at its creating gesture, once, and the first send writes none", async () => {
    await opencodeClient.createSession({ model: { providerID: "openchamber", id: "auto" }, agent: "build" }, DIRECTORY)
    expect(createBodies().map((body) => body.model)).toEqual([undefined])
    expect(modelPosts()).toEqual([{ providerID: "openchamber", id: "auto" }])

    await routeMessage({ runtimeKey: getRuntimeKey(), sessionId: SESSION_ID, directory: DIRECTORY, content: "Next", providerID: "openchamber", modelID: "auto", agent: "build" })
    expect(modelPosts()).toEqual([{ providerID: "openchamber", id: "auto" }])
  })

  for (const [kind, make] of [["create", create], ["fork", fork]] as const) {
    for (const outcome of [undefined, "succeeded"] as const) {
      test(`${kind}, then another client chooses Opus, outcome=${outcome}: this client's ordinary send leaves Opus`, async () => {
        expect((await make()).id).toBe(SESSION_ID)
        serverOutcome = outcome
        await otherClientPicks(OPUS)
        expect(await send()).toBe("prompt")
        expect(accepted).toEqual([OPUS])
        expect(serverModel).toEqual(OPUS)
        expect(modelPosts()).toEqual([OPUS])
      })
    }
  }

  test("a first prompt that was accepted but not confirmed does not let a retry replay the composer after another client's pick", async () => {
    await create()
    failFirstPrompt = true
    await expect(send()).rejects.toThrow()
    expect(accepted).toEqual([FABLE])
    await otherClientPicks(OPUS)
    expect(await send()).toBe("prompt")
    expect(accepted).toEqual([FABLE, OPUS])
    expect(serverModel).toEqual(OPUS)
  })

  test("a first prompt whose response was lost but whose message exists does not let a later send replay the composer", async () => {
    await create()
    failFirstPrompt = true
    let acceptedId = ""
    const saved = respond
    respond = (path, body) => {
      if (path === promptPath) acceptedId = JSON.parse(body ?? "{}").id
      return saved(path, body)
    }
    const confirmation = spyOn(opencodeClient, "getSessionMessages").mockImplementation(async () => ({
      items: [{ info: { id: acceptedId, sessionID: SESSION_ID, role: "user", time: { created: 1 } }, parts: [] }], cursor: {},
    }))
    try {
      expect(await send()).toBe("prompt")
      expect(confirmation).toHaveBeenCalled()
      expect(accepted).toEqual([FABLE])
      await otherClientPicks(OPUS)
      expect(await send()).toBe("prompt")
      expect(accepted).toEqual([FABLE, OPUS])
      expect(serverModel).toEqual(OPUS)
    } finally {
      confirmation.mockRestore()
    }
  })

  test("a direct send, as multi-run fusion makes it, leaves nothing for a later ordinary send to replay", async () => {
    await create()
    await opencodeClient.sendMessage({ runtimeKey: getRuntimeKey(), id: SESSION_ID, providerID: FABLE.providerID, text: "Fusion", directory: DIRECTORY })
    expect(accepted).toEqual([FABLE])
    await otherClientPicks(OPUS)
    expect(await send()).toBe("prompt")
    expect(accepted).toEqual([FABLE, OPUS])
    expect(serverModel).toEqual(OPUS)
    expect(modelPosts()).toEqual([OPUS])
  })

  test("a pick this client makes while the first send reads the session stays, after its own acknowledgment", async () => {
    await create()
    let release = () => {}
    holdRead = new Promise<void>((resolve) => { release = resolve })
    const reading = new Promise<void>((resolve) => { readStarted = resolve })
    const sent = send()
    await reading
    commitModelPick(SESSION_ID, { providerID: OPUS.providerID, modelID: OPUS.id, variant: OPUS.variant }, DIRECTORY)
    await whenModelPickWritten(SESSION_ID)
    expect(serverModel).toEqual(OPUS)
    release()
    expect(await sent).toBe("prompt")
    expect(serverModel).toEqual(OPUS)
    expect(accepted).toEqual([OPUS])
  })

  test("a send naming an agent that pins another model switches the agent and writes no model", async () => {
    const agentList = spyOn(opencodeClient, "listAgents").mockResolvedValue([{
      id: "plan", name: "plan", displayName: "Plan", mode: "primary", hidden: false, model: OPUS,
      request: { settings: {}, headers: {}, body: {} }, permissions: [],
    }])
    try {
      expect(await routeMessage({ runtimeKey: getRuntimeKey(), sessionId: SESSION_ID, directory: DIRECTORY, content: "Next", providerID: OPUS.providerID, modelID: OPUS.id, variant: OPUS.variant, agent: "plan" })).toBe("prompt")
      expect(serverAgent).toBe("plan")
      expect(serverModel).toEqual(FABLE)
      expect(accepted).toEqual([FABLE])
      expect(modelPosts()).toEqual([])
    } finally {
      agentList.mockRestore()
    }
  })
})
