import { afterEach, expect, spyOn, test } from "bun:test"
import { opencodeClient } from "@/lib/opencode/client"
import { getRuntimeKey } from "@/lib/runtime-switch"
import { useConfigStore } from "@/stores/useConfigStore"
import { useSessionGoalArmStore } from "@/stores/useSessionGoalArmStore"
import { ChildStoreManager } from "./child-store"
import { setActionRefs, setOptimisticRefs } from "./session-actions"
import { useSessionUIStore } from "./session-ui-store"
import { setSyncRefs } from "./sync-refs"
import { deferSessionOperation } from "./pending-session-creation"

const stores = new ChildStoreManager()
const directory = "/response-style-qa"

afterEach(() => {
  stores.disposeAll()
})

test("shows the prompt while response settings load and writes them before sending", async () => {
  // Given a session whose first-send settings are still on the network.
  stores.ensureChild(directory, { bootstrap: false })
  setActionRefs(stores, () => directory)
  setSyncRefs(opencodeClient.getSdkClient(), stores, directory)
  useConfigStore.setState({ isConnected: true, hasEverConnected: true })
  useSessionGoalArmStore.getState().setArmed(false, null)
  const inserted = deferSessionOperation<void>()
  setOptimisticRefs((input) => {
    if (input.message.role === "user") inserted.resolve()
  }, () => undefined)
  const settings = deferSessionOperation<string | null>()
  const knowledgeRequest = deferSessionOperation<Request>()
  const knowledgeWritten = deferSessionOperation<Response>()
  const send = spyOn(opencodeClient, "sendMessage").mockResolvedValue("msg_style_qa")
  const fetch = spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input instanceof Request ? input : new URL(input.toString(), "http://localhost/"), init)
    if (new URL(request.url).pathname === "/api/session-knowledge/sync") {
      knowledgeRequest.resolve(request)
      return knowledgeWritten.promise
    }
    return Response.json({})
  })
  const options = {
    target: { runtimeKey: getRuntimeKey(), sessionId: "ses_style_qa", directory },
    responseStyle: settings.promise,
  }

  try {
    // When the message is submitted without waiting for those settings.
    const sending = useSessionUIStore.getState().sendMessage(
      "qa-input", "qa-provider", "qa-model", undefined, undefined,
      undefined, undefined, undefined, "normal", options,
    )
    await inserted.promise
    await new Promise<void>((resolve) => setImmediate(resolve))

    // Then the bubble is present, but delivery waits for its instruction write.
    expect(send.mock.calls).toHaveLength(0)
    const style = "qa-response-setting"
    settings.resolve(style)
    const request = await knowledgeRequest.promise
    expect(request.method).toBe("POST")
    expect(await request.json()).toEqual({ directory, sessionId: "ses_style_qa", responseStyleInstruction: style })
    expect(send.mock.calls).toHaveLength(0)
    knowledgeWritten.resolve(Response.json({}))
    await sending
    expect(send.mock.calls).toHaveLength(1)
    expect(send.mock.calls[0]?.[0].context).toBeUndefined()
  } finally {
    settings.resolve(null)
    knowledgeWritten.resolve(Response.json({}))
    send.mockRestore()
    fetch.mockRestore()
  }
})
