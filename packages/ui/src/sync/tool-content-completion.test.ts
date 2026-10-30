import { afterEach, beforeEach, expect, mock, test } from "bun:test"
import type { ChildStoreManager as ChildStores } from "./child-store"
import { toolContentShellChars } from "@/lib/opencode/toolContentShells"

const paths: string[] = []
const responses: Array<() => Response> = []
let runtimeKey = "test-runtime"
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "content-type": "application/json" },
})
const runtime = await import("@/lib/runtime-switch")
const runtimeFetchModule = await import("@/lib/runtime-fetch")
mock.module("@/lib/runtime-url", () => ({ getRuntimeUrlResolver: () => ({ api: () => "http://runtime.test/api" }) }))
mock.module("@/lib/runtime-switch", () => ({
  ...runtime,
  getRuntimeApiBaseUrl: () => "", getRuntimeKey: () => runtimeKey,
  captureRuntimeInstance: () => {
    const captured = runtimeKey
    return () => captured === runtimeKey
  },
}))
mock.module("@/lib/runtime-fetch", () => ({
  ...runtimeFetchModule,
  runtimeFetch: async (input: string | URL | Request) => {
    paths.push(new URL(input instanceof Request ? input.url : input, "http://runtime.test").pathname)
    const response = responses.shift()
    if (!response) throw new Error("Unexpected request")
    return response()
  },
}))

const { opencodeClient } = await import("@/lib/opencode/client")
const { completeToolContent } = await import("./tool-content-completion")
const { ChildStoreManager } = await import("./child-store")
const { setSyncRefs } = await import("./sync-refs")

const directory = "/repo/app"
const sessionID = "ses_child"
const messageID = "msg_parent_owned"
const target = { directory, sessionID }
const wire = (shell: boolean) => ({
  id: messageID, type: "assistant", time: { created: 1000, completed: 1500 },
  agent: "build", model: { id: "test-model", providerID: "test-provider" },
  finish: "stop", cost: 0,
  tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
  content: [{
    type: "tool", id: "call_1", name: "bash", executed: true,
    time: { created: 1003, ran: 1004, completed: 1005 },
    state: {
      status: "completed", input: { command: "ls" },
      content: [{ type: "text", text: shell ? "" : "parent-owned output" }],
      ...(shell ? { metadata: { openchamberContentShell: { chars: 19 } } } : {}),
    },
  }],
})
let stores: ChildStores
beforeEach(async () => {
  paths.length = 0
  responses.length = 0
  runtimeKey = "test-runtime"
  stores = new ChildStoreManager()
  setSyncRefs(opencodeClient.getSdkClient(), stores, directory)
  responses.push(() => json({ data: wire(true) }))
  const record = await opencodeClient.getSessionMessage(sessionID, messageID, directory)
  stores.ensureChild(directory, { bootstrap: false }).setState({
    message: { [sessionID]: [record.info] }, part: { [messageID]: record.parts },
  })
  expect(record.parts.some((part) => toolContentShellChars(part) !== null)).toBe(true)
  paths.length = 0
})
afterEach(() => stores.disposeAll())

const parentResult = (beforeResult = () => {}) => {
  responses.push(
    () => json({ _tag: "MessageNotFoundError", message: "not found" }, 404),
    () => json({ data: {
      id: sessionID, parentID: "ses_parent", projectID: "proj_1", title: "Child",
      cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1, updated: 2 }, location: { directory },
    } }),
    () => { beforeResult(); return json({ data: wire(false) }) },
  )
}

test("completes the child's existing shell through the parent and shares the request", async () => {
  parentResult()
  const first = completeToolContent(target, messageID)
  expect(completeToolContent(target, messageID)).toBe(first)
  await first
  expect(paths).toEqual([
    `/api/session/${sessionID}/message/${messageID}`, `/api/session/${sessionID}`,
    `/api/session/ses_parent/message/${messageID}`,
  ])
  const state = stores.getChild(directory)!.getState()
  expect(state.message[sessionID][0].sessionID).toBe(sessionID)
  expect(state.message.ses_parent).toBeUndefined()
  expect(state.part[messageID].every((part) => part.sessionID === sessionID)).toBe(true)
  expect(state.part[messageID].every((part) => toolContentShellChars(part) === null)).toBe(true)
  expect(JSON.stringify(state.part[messageID])).toContain("parent-owned output")
  paths.length = 0
  await completeToolContent(target, messageID)
  expect(paths).toEqual([])
})

test("does not request a message outside the displayed transcript", async () => {
  stores.getChild(directory)!.setState({ message: {} })
  await completeToolContent(target, messageID)
  expect(paths).toEqual([])
})

test("a removed message is not resurrected by the ancestor result", async () => {
  parentResult(() => stores.getChild(directory)!.setState({ message: {}, part: {} }))
  await completeToolContent(target, messageID)
  expect(stores.getChild(directory)!.getState().message).toEqual({})
  expect(stores.getChild(directory)!.getState().part).toEqual({})
})

test("a runtime switch leaves the child's shell untouched", async () => {
  parentResult(() => { runtimeKey = "other-runtime" })
  expect(await completeToolContent(target, messageID).catch((error: unknown) => error)).toMatchObject({ status: 404 })
  expect(stores.getChild(directory)!.getState().part[messageID].some((part) => toolContentShellChars(part) !== null)).toBe(true)
})

test("strict pin reads neither walk ancestors nor import their text", async () => {
  parentResult()
  expect(await opencodeClient.getSessionMessage(sessionID, messageID, directory).catch((error: unknown) => error))
    .toMatchObject({ status: 404 })
  expect(paths).toEqual([`/api/session/${sessionID}/message/${messageID}`])
  expect(JSON.stringify(stores.getChild(directory)!.getState().part[messageID])).not.toContain("parent-owned output")
})
