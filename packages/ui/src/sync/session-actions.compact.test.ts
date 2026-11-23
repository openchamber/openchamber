import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"

import { createRuntimeOpencodeClient, opencodeClient } from "@/lib/opencode/client"
import type { ModelRef, ModelSelection, Session } from "@/lib/opencode/model"
import { getRuntimeApiBaseUrl, getRuntimeKey, switchRuntimeEndpoint } from "@/lib/runtime-switch"
import { compactSession } from "./session-actions"
import { ChildStoreManager } from "./child-store"
import { setSyncRefs } from "./sync-refs"
import { useSelectionStore } from "./selection-store"
import { commitModelPick, whenModelPickWritten } from "./model-gesture"

const DIRECTORY = "/repo"
const SESSION_ID = "ses_compact"

type ClientCall = {
  method: "switchModel" | "compact"
  directory?: string | null
  model?: ModelSelection
}

const sessionOn = (model: ModelRef): Session => ({
  id: SESSION_ID,
  projectID: "project",
  directory: DIRECTORY,
  title: "Compact me",
  model,
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
})

let manager: ChildStoreManager
let calls: ClientCall[]
let releaseSwitch: Promise<void> | null
const originalBase = getRuntimeApiBaseUrl()
const originalRuntime = getRuntimeKey()

beforeEach(() => {
  manager = new ChildStoreManager()
  setSyncRefs(createRuntimeOpencodeClient({ baseUrl: "http://localhost" }), manager, DIRECTORY)
  manager.ensureChild(DIRECTORY, { bootstrap: false }).setState({
    session: [sessionOn({ providerID: "provider", id: "model-a", variant: "high" })],
  })
  calls = []
  releaseSwitch = null
  useSelectionStore.setState({ sessionPickedModels: new Map() })
  spyOn(opencodeClient, "switchSessionModel").mockImplementation(async (_id, model, directory) => {
    await releaseSwitch
    calls.push({ method: "switchModel", model, directory })
  })
  spyOn(opencodeClient, "compactSession").mockImplementation(async (_id, directory) => {
    calls.push({ method: "compact", directory })
  })
})

afterEach(() => {
  switchRuntimeEndpoint({ apiBaseUrl: originalBase, runtimeKey: originalRuntime })
  mock.restore()
  manager.disposeAll()
})

describe("compactSession", () => {
  test("compacts on the model the session has and writes no model, whatever the composer or a pending pick shows", async () => {
    useSelectionStore.getState().pickSessionModel(SESSION_ID, "provider", "model-b")

    await compactSession(SESSION_ID, DIRECTORY)

    expect(calls).toEqual([{ method: "compact", directory: DIRECTORY }])
  })

  test("a failed compaction is not retried with a model", async () => {
    spyOn(opencodeClient, "compactSession").mockRejectedValueOnce(new Error("compact refused")).mockResolvedValue(undefined)

    await expect(compactSession(SESSION_ID, DIRECTORY)).rejects.toThrow("compact refused")
    await compactSession(SESSION_ID, DIRECTORY)

    expect(calls).toEqual([])
  })

  test("waits for this client's own pick still being written, then compacts", async () => {
    let release = () => {}
    releaseSwitch = new Promise<void>((resolve) => { release = resolve })
    commitModelPick(SESSION_ID, { providerID: "provider", modelID: "model-b", variant: "low" }, DIRECTORY)

    // Without the wait the compaction would be recorded here, before the held switch is released.
    const compacting = compactSession(SESSION_ID, DIRECTORY)
    release()
    await compacting
    await whenModelPickWritten(SESSION_ID)
    expect(calls).toEqual([
      { method: "switchModel", model: { providerID: "provider", id: "model-b", variant: "low" }, directory: DIRECTORY },
      { method: "compact", directory: DIRECTORY },
    ])
  })

  for (const returnToOriginal of [false, true]) {
    test(`a runtime switch while a pick is being written cancels compaction, return to original: ${returnToOriginal}`, async () => {
      let release = () => {}
      releaseSwitch = new Promise<void>((resolve) => { release = resolve })
      commitModelPick(SESSION_ID, { providerID: "provider", modelID: "model-b" }, DIRECTORY)

      const result = compactSession(SESSION_ID, DIRECTORY)
      switchRuntimeEndpoint({ apiBaseUrl: "https://compact-other.test", runtimeKey: "compact-other" })
      if (returnToOriginal) switchRuntimeEndpoint({ apiBaseUrl: originalBase, runtimeKey: originalRuntime })
      release()

      await expect(result).rejects.toThrow("runtime changed")
      expect(calls.filter((call) => call.method === "compact")).toEqual([])
    })
  }
})
