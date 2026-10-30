import { afterEach, expect, mock, test } from "bun:test"
import type { AssistantMessage, Message, Part, ToolPart } from "@/lib/opencode/model"

type StoreState = { message: Record<string, Message[]>; part: Record<string, Part[]> }

const message: AssistantMessage = {
  id: "msg_result",
  sessionID: "ses_one",
  role: "assistant",
  time: { created: 1, completed: 2 },
  agent: "build",
  providerID: "anthropic",
  modelID: "claude",
}
const part: ToolPart = {
  id: "prt_result",
  sessionID: "ses_one",
  messageID: "msg_result",
  type: "tool",
  callID: "call_1",
  tool: "bash",
  state: { status: "completed", input: {}, output: "the whole output", time: { start: 1, end: 2 } },
}

let state: StoreState = { message: {}, part: {} }
let setStateCalls = 0
let reads = 0

mock.module("@/lib/opencode/client", () => ({
  opencodeClient: {
    getSessionMessage: async () => {
      reads += 1
      return { info: message, parts: [part] }
    },
  },
}))
mock.module("@/lib/runtime-switch", () => ({ getRuntimeKey: () => "runtime-1" }))
mock.module("./sync-refs", () => ({
  getSyncChildStores: () => ({
    ensureChild: () => ({
      getState: () => state,
      setState: (next: StoreState) => {
        setStateCalls += 1
        state = { ...state, ...next }
      },
    }),
  }),
}))

const { completeToolContent } = await import("./tool-content-completion")

afterEach(() => {
  state = { message: {}, part: {} }
  setStateCalls = 0
  reads = 0
})

test("returns the message read by id without writing a store that dropped it", async () => {
  const record = await completeToolContent({ directory: "/plain", sessionID: "ses_one" }, "msg_result")
  expect(reads).toBe(1)
  expect(setStateCalls).toBe(0)
  const read = record?.parts[0]
  expect(read?.type).toBe("tool")
  if (read?.type === "tool") {
    expect(read.state).toMatchObject({ status: "completed", output: "the whole output" })
  }
})

test("merges the message into a store that holds it", async () => {
  state = { message: { ses_one: [message] }, part: {} }
  const record = await completeToolContent({ directory: "/plain", sessionID: "ses_one" }, "msg_result")
  expect(record).toBeNull()
  expect(setStateCalls).toBe(1)
  const merged = state.part.msg_result?.[0]
  expect(merged?.type).toBe("tool")
  if (merged?.type === "tool") {
    expect(merged.state).toMatchObject({ status: "completed", output: "the whole output" })
  }
})

test("shares one read between rows of the same message", async () => {
  await Promise.all([
    completeToolContent({ directory: "/plain", sessionID: "ses_one" }, "msg_result"),
    completeToolContent({ directory: "/plain", sessionID: "ses_one" }, "msg_result"),
  ])
  expect(reads).toBe(1)
})
