import { beforeEach, describe, expect, mock, test } from "bun:test"

/**
 * Proves the send path actually wires the gate. The gate function and the client
 * passthrough are unit-tested separately; without this test both could be
 * correct while nothing connects them.
 */

const sendMessageCalls: Array<Record<string, unknown>> = []
let toolCallCapability: boolean | undefined = false

mock.module("@/lib/opencode/client", () => ({
  opencodeClient: {
    sendMessage: mock(async (params: Record<string, unknown>) => {
      sendMessageCalls.push(params)
      return "msg_1"
    }),
    sendCommand: mock(async () => "msg_cmd"),
    shellSession: mock(async () => undefined),
    setDirectory: mock(() => undefined),
    getDirectory: mock(() => "/tmp/project"),
  },
}))

mock.module("@/stores/useConfigStore", () => ({
  useConfigStore: {
    getState: () => ({
      getModelMetadata: () => ({ tool_call: toolCallCapability }),
    }),
  },
}))

// The optimistic insert needs a mounted useSync(); this test is about the gate,
// so run the send callback directly while leaving the module's other exports
// intact for the rest of the import graph.
const sessionActions = await import("./session-actions")
mock.module("./session-actions", () => ({
  ...sessionActions,
  optimisticSend: mock(async (input: { send: (messageID: string) => Promise<void> }) => {
    await input.send("msg_optimistic")
  }),
}))

const { routeMessage } = await import("./session-ui-store")

const send = (modelID: string) => routeMessage({
  sessionId: "ses_wiring",
  directory: "/tmp/project",
  content: "draw a cow",
  providerID: "google-vertex",
  modelID,
})

describe("routeMessage agent-tool gating", () => {
  beforeEach(() => {
    sendMessageCalls.length = 0
  })

  test("denies every tool when the selected model cannot tool-call", async () => {
    toolCallCapability = false

    await send("gemini-2.5-flash-image")

    expect(sendMessageCalls).toHaveLength(1)
    expect(sendMessageCalls[0]?.tools).toEqual({ "*": false })
  })

  test("allows every tool when the selected model can tool-call", async () => {
    toolCallCapability = true

    await send("gemini-3.6-flash")

    expect(sendMessageCalls).toHaveLength(1)
    expect(sendMessageCalls[0]?.tools).toEqual({ "*": true })
  })

  test("re-enables tools after a deny when the user switches models mid-session", async () => {
    // The reason every send carries the complete map: OpenCode persists it as
    // the session ruleset, so without the second send's explicit `true` the
    // tools would stay denied for the rest of the session.
    toolCallCapability = false
    await send("gemini-2.5-flash-image")

    toolCallCapability = true
    await send("gemini-3.6-flash")

    expect(sendMessageCalls.map((call) => call.tools)).toEqual([
      { "*": false },
      { "*": true },
    ])
  })
})
