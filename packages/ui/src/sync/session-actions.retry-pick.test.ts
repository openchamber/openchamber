import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"

import { createRuntimeOpencodeClient, opencodeClient } from "@/lib/opencode/client"
import type { ModelSelection, Session } from "@/lib/opencode/model"
import { useConfigStore } from "@/stores/useConfigStore"
import { applyModelPickToRetry } from "./session-actions"
import { ChildStoreManager } from "./child-store"
import { setSyncRefs } from "./sync-refs"
import { useSelectionStore } from "./selection-store"
import { useSessionUIStore } from "./session-ui-store"

const DIRECTORY = "/repo"
const SESSION_ID = "ses_retrying"

const session: Session = {
  id: SESSION_ID,
  projectID: "project",
  directory: DIRECTORY,
  title: "Retrying",
  model: { providerID: "provider", id: "model-a", variant: "default" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
}

let manager: ChildStoreManager
let switches: ModelSelection[]
let switchError: Error | null

/** The main chat's composer shows `modelId` with `variant`, as after a pick in its model picker. */
const composerOn = (modelId: string, variant?: string) => {
  useConfigStore.setState({
    currentProviderId: "provider",
    currentModelId: modelId,
    currentVariant: variant,
    currentVariantSelection: { override: variant, inherited: undefined },
  })
}

beforeEach(() => {
  manager = new ChildStoreManager()
  setSyncRefs(createRuntimeOpencodeClient({ baseUrl: "http://localhost" }), manager, DIRECTORY)
  manager.ensureChild(DIRECTORY, { bootstrap: false }).setState({ session: [session] })
  useSessionUIStore.setState({ currentSessionId: SESSION_ID })
  useSelectionStore.setState({ sessionPickedModels: new Map() })
  composerOn("model-a")
  switches = []
  switchError = null
  spyOn(opencodeClient, "switchSessionModel").mockImplementation(async (_id, model) => {
    switches.push(model)
    if (switchError) throw switchError
  })
})

afterEach(() => {
  mock.restore()
  manager.disposeAll()
})

describe("applyModelPickToRetry", () => {
  test("switches the session to the composer's pick and settles it", async () => {
    composerOn("model-b", "high")
    useSelectionStore.getState().pickSessionModel(SESSION_ID, "provider", "model-b")

    await applyModelPickToRetry(SESSION_ID, DIRECTORY)

    expect(switches).toEqual([{ providerID: "provider", id: "model-b", variant: "high" }])
    expect(useSelectionStore.getState().getSessionModelPick(SESSION_ID)).toBeNull()
  })

  test("a pick reverted before the record follows the first switch is still sent", async () => {
    composerOn("model-b")
    useSelectionStore.getState().pickSessionModel(SESSION_ID, "provider", "model-b")
    await applyModelPickToRetry(SESSION_ID, DIRECTORY)
    composerOn("model-a")
    useSelectionStore.getState().pickSessionModel(SESSION_ID, "provider", "model-a")

    await applyModelPickToRetry(SESSION_ID, DIRECTORY)

    expect(switches.map((model) => model.id)).toEqual(["model-b", "model-a"])
  })

  test("switches nothing without an unsent pick", async () => {
    composerOn("model-b")

    await applyModelPickToRetry(SESSION_ID, DIRECTORY)

    expect(switches).toEqual([])
  })

  test("leaves an Auto pick for the next send", async () => {
    useConfigStore.setState({ currentProviderId: "openchamber", currentModelId: "auto" })
    useSelectionStore.getState().pickSessionModel(SESSION_ID, "openchamber", "auto")

    await applyModelPickToRetry(SESSION_ID, DIRECTORY)

    expect(switches).toEqual([])
    expect(useSelectionStore.getState().getSessionModelPick(SESSION_ID)).toEqual({ providerId: "openchamber", modelId: "auto" })
  })

  test("a failed switch keeps the pick for the next attempt", async () => {
    composerOn("model-b")
    useSelectionStore.getState().pickSessionModel(SESSION_ID, "provider", "model-b")
    switchError = new Error("switch refused")

    await expect(applyModelPickToRetry(SESSION_ID, DIRECTORY)).rejects.toThrow("switch refused")

    expect(useSelectionStore.getState().getSessionModelPick(SESSION_ID)).toEqual({ providerId: "provider", modelId: "model-b" })
  })
})
