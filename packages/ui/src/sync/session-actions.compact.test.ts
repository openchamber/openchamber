import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"

import { createRuntimeOpencodeClient, opencodeClient } from "@/lib/opencode/client"
import type { ModelRef, ModelSelection, Session } from "@/lib/opencode/model"
import { getRuntimeApiBaseUrl, getRuntimeKey, switchRuntimeEndpoint } from "@/lib/runtime-switch"
import { compactSession } from "./session-actions"
import { ChildStoreManager } from "./child-store"
import { setSyncRefs } from "./sync-refs"

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
let switchError: Error | null
const originalBase = getRuntimeApiBaseUrl()
const originalRuntime = getRuntimeKey()

beforeEach(() => {
  manager = new ChildStoreManager()
  setSyncRefs(createRuntimeOpencodeClient({ baseUrl: "http://localhost" }), manager, DIRECTORY)
  manager.ensureChild(DIRECTORY, { bootstrap: false }).setState({
    session: [sessionOn({ providerID: "provider", id: "model-a", variant: "high" })],
  })
  calls = []
  switchError = null
  spyOn(opencodeClient, "switchSessionModel").mockImplementation(async (_id, model, directory) => {
    calls.push({ method: "switchModel", model, directory })
    if (switchError) throw switchError
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
  test("switches a changed model before compacting, both in the session directory", async () => {
    await compactSession(SESSION_ID, { providerID: "provider", modelID: "model-b", variant: "high" }, DIRECTORY)

    expect(calls).toEqual([
      { method: "switchModel", model: { providerID: "provider", id: "model-b", variant: "high" }, directory: DIRECTORY },
      { method: "compact", directory: DIRECTORY },
    ])
  })

  test("switches when only the reasoning variant changes", async () => {
    await compactSession(SESSION_ID, { providerID: "provider", modelID: "model-a", variant: "low" }, DIRECTORY)

    expect(calls).toEqual([
      { method: "switchModel", model: { providerID: "provider", id: "model-a", variant: "low" }, directory: DIRECTORY },
      { method: "compact", directory: DIRECTORY },
    ])
  })

  test("sends no switch when the model and variant already match the session", async () => {
    await compactSession(SESSION_ID, { providerID: "provider", modelID: "model-a", variant: "high" }, DIRECTORY)

    expect(calls).toEqual([{ method: "compact", directory: DIRECTORY }])
  })

  test("treats an explicit Default as the effort the session already records", async () => {
    manager.getChild(DIRECTORY)?.setState({
      session: [sessionOn({ providerID: "provider", id: "model-a", variant: "default" })],
    })

    await compactSession(SESSION_ID, { providerID: "provider", modelID: "model-a", variant: null }, DIRECTORY)

    expect(calls).toEqual([{ method: "compact", directory: DIRECTORY }])
  })

  test("a failed switch leaves the transcript uncompacted", async () => {
    switchError = new Error("switch refused")

    await expect(
      compactSession(SESSION_ID, { providerID: "provider", modelID: "model-b", variant: "high" }, DIRECTORY),
    ).rejects.toThrow("switch refused")

    expect(calls).toEqual([
      { method: "switchModel", model: { providerID: "provider", id: "model-b", variant: "high" }, directory: DIRECTORY },
    ])
  })

  for (const returnToOriginal of [false, true]) {
    test(`a runtime switch during model reconciliation cancels compaction, return to original: ${returnToOriginal}`, async () => {
      let finishSwitch = () => {}
      const pendingSwitch = new Promise<void>((resolve) => { finishSwitch = resolve })
      spyOn(opencodeClient, "switchSessionModel").mockImplementation(() => pendingSwitch)

      const result = compactSession(SESSION_ID, { providerID: "provider", modelID: "model-b", variant: "high" }, DIRECTORY)
      switchRuntimeEndpoint({ apiBaseUrl: "https://compact-other.test", runtimeKey: "compact-other" })
      if (returnToOriginal) {
        switchRuntimeEndpoint({ apiBaseUrl: originalBase, runtimeKey: originalRuntime })
      }
      finishSwitch()

      await expect(result).rejects.toThrow("runtime changed")
      expect(calls).toEqual([])
    })
  }

  test("an Auto pick compacts on the session's own model without a switch", async () => {
    await compactSession(SESSION_ID, { providerID: "openchamber", modelID: "auto" }, DIRECTORY)

    expect(calls).toEqual([{ method: "compact", directory: DIRECTORY }])
  })

  test("compacts directly when the composer has no selection", async () => {
    await compactSession(SESSION_ID, null, DIRECTORY)

    expect(calls).toEqual([{ method: "compact", directory: DIRECTORY }])
  })
})
