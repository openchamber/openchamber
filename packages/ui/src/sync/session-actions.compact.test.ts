import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"

import { createRuntimeOpencodeClient, opencodeClient } from "@/lib/opencode/client"
import type { ModelRef, ModelSelection, Session } from "@/lib/opencode/model"
import { getRuntimeApiBaseUrl, getRuntimeKey, switchRuntimeEndpoint } from "@/lib/runtime-switch"
import { compactSession } from "./session-actions"
import { ChildStoreManager } from "./child-store"
import { getAllSyncSessions, setSyncRefs } from "./sync-refs"
import { useSelectionStore } from "./selection-store"

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
  useSelectionStore.setState({ sessionPickedModels: new Map() })
  spyOn(opencodeClient, "switchSessionModel").mockImplementation(async (_id, model, directory) => {
    calls.push({ method: "switchModel", model, directory })
    if (switchError) throw switchError
  })
  spyOn(opencodeClient, "compactSession").mockImplementation(async (_id, directory) => {
    calls.push({ method: "compact", directory })
  })
  // The server holds what the sync store holds.
  spyOn(opencodeClient, "getSession").mockImplementation(async (id) => {
    const session = getAllSyncSessions().find((candidate) => candidate.id === id)
    if (!session) throw new Error(`no session ${id}`)
    return session
  })
})

afterEach(() => {
  switchRuntimeEndpoint({ apiBaseUrl: originalBase, runtimeKey: originalRuntime })
  mock.restore()
  manager.disposeAll()
})

describe("compactSession", () => {
  test("settles the applied pick only after successful compaction", async () => {
    const store = useSelectionStore.getState()
    store.pickSessionModel(SESSION_ID, "provider", "model-b")
    spyOn(opencodeClient, "compactSession").mockRejectedValueOnce(new Error("compact refused"))
      .mockResolvedValue(undefined)
    const selection = { providerID: "provider", modelID: "model-b" }
    await expect(compactSession(SESSION_ID, selection, DIRECTORY)).rejects.toThrow("compact refused")
    expect(store.getSessionModelPick(SESSION_ID)).toEqual({ providerId: "provider", modelId: "model-b" })
    await compactSession(SESSION_ID, selection, DIRECTORY)
    expect(store.getSessionModelPick(SESSION_ID)).toBeNull()
  })

  test("a successful compaction settles its runtime after a switch and preserves a newer pick", async () => {
    const store = useSelectionStore.getState()
    store.pickSessionModel(SESSION_ID, "provider", "model-b")
    spyOn(opencodeClient, "compactSession").mockImplementation(async () => {
      switchRuntimeEndpoint({ apiBaseUrl: "https://compact-other.test", runtimeKey: "compact-other" })
      store.pickSessionModel(SESSION_ID, "provider", "model-b")
    })
    await compactSession(SESSION_ID, { providerID: "provider", modelID: "model-b" }, DIRECTORY)
    expect(store.getSessionModelPick(SESSION_ID)).toEqual({ providerId: "provider", modelId: "model-b" })
    switchRuntimeEndpoint({ apiBaseUrl: originalBase, runtimeKey: originalRuntime })
    expect(store.getSessionModelPick(SESSION_ID)).toBeNull()
  })

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
      let switchStarted = () => {}
      const reachedSwitch = new Promise<void>((resolve) => { switchStarted = resolve })
      const pendingSwitch = new Promise<void>((resolve) => { finishSwitch = resolve })
      spyOn(opencodeClient, "switchSessionModel").mockImplementation(() => {
        switchStarted()
        return pendingSwitch
      })

      const result = compactSession(SESSION_ID, { providerID: "provider", modelID: "model-b", variant: "high" }, DIRECTORY)
      await reachedSwitch
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

  test("a failed session read still compacts, with the picked model stated explicitly", async () => {
    const store = useSelectionStore.getState()
    store.pickSessionModel(SESSION_ID, "provider", "model-a")
    spyOn(opencodeClient, "getSession").mockRejectedValue(new Error("session read failed"))

    // The cache already matches the pick, so only the failed read makes it switch.
    await compactSession(SESSION_ID, { providerID: "provider", modelID: "model-a", variant: "high" }, DIRECTORY)

    expect(calls).toEqual([
      { method: "switchModel", model: { providerID: "provider", id: "model-a", variant: "high" }, directory: DIRECTORY },
      { method: "compact", directory: DIRECTORY },
    ])
    expect(store.getSessionModelPick(SESSION_ID)).toBeNull()
  })

  test("a runtime switch during a failed session read cancels compaction", async () => {
    spyOn(opencodeClient, "getSession").mockImplementation(async () => {
      switchRuntimeEndpoint({ apiBaseUrl: "https://compact-other.test", runtimeKey: "compact-other" })
      throw new Error("session read failed")
    })

    await expect(
      compactSession(SESSION_ID, { providerID: "provider", modelID: "model-b" }, DIRECTORY),
    ).rejects.toThrow("runtime changed")

    expect(calls).toEqual([])
  })

  test("compacts directly when the composer has no selection", async () => {
    await compactSession(SESSION_ID, null, DIRECTORY)

    expect(calls).toEqual([{ method: "compact", directory: DIRECTORY }])
  })
})
