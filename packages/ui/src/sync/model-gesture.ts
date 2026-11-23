import { toast } from "@/components/ui"
import { opencodeClient } from "@/lib/opencode/client"
import { captureRuntimeInstance, getRuntimeKey } from "@/lib/runtime-switch"
import { useConfigStore } from "@/stores/useConfigStore"
import { useSelectionStore } from "./selection-store"
import { getSyncSessionDirectory } from "./sync-refs"

type ModelGesture = { providerID: string; modelID: string; variant?: string | null }

const SESSION_ID_FORMAT = /^[A-Za-z0-9_-]{4,128}$/
const writes = new Map<string, { latest: symbol; done: Promise<void> }>()
const writeKey = (sessionId: string) => JSON.stringify([getRuntimeKey(), sessionId])

export const toastModelSwitchFailed = (): void => { toast.error("Could not switch the model") }

export function whenModelPickWritten(sessionId: string): Promise<void> {
  return writes.get(writeKey(sessionId))?.done ?? Promise.resolve()
}

export function commitModelPick(sessionId: string | null | undefined, gesture: ModelGesture, directory?: string | null): void {
  if (!sessionId) return
  useSelectionStore.getState().pickSessionModel(sessionId, gesture.providerID, gesture.modelID)
  if (!SESSION_ID_FORMAT.test(sessionId)) return
  const key = writeKey(sessionId)
  const ticket = Symbol(key)
  const isCurrentRuntime = captureRuntimeInstance()
  const previous = writes.get(key)?.done ?? Promise.resolve()
  const done = previous
    .then(async () => {
      if (writes.get(key)?.latest !== ticket || !isCurrentRuntime()) return
      const model = { providerID: gesture.providerID, id: gesture.modelID, variant: gesture.variant }
      await opencodeClient.switchSessionModel(sessionId, model, directory ?? getSyncSessionDirectory(sessionId))
    })
    .catch((error) => {
      console.warn("[model-gesture] the model switch was not applied:", error)
      useSelectionStore.getState().captureSessionModelPickSettlement(sessionId, gesture.providerID, gesture.modelID)()
      toastModelSwitchFailed()
    })
    .finally(() => {
      if (writes.get(key)?.done === done) writes.delete(key)
    })
  writes.set(key, { latest: ticket, done })
}

export function commitComposerPick(sessionId: string | null | undefined, directory?: string | null): void {
  const config = useConfigStore.getState()
  if (!sessionId || !config.currentProviderId || !config.currentModelId) return
  const variant = config.currentVariantSelection.override === null ? null : config.currentVariant
  commitModelPick(sessionId, { providerID: config.currentProviderId, modelID: config.currentModelId, variant }, directory)
}

export function commitAgentPinnedModel(sessionId: string | null | undefined, agentName: string, directory?: string | null): void {
  const config = useConfigStore.getState()
  const pinned = config.agents.find((agent) => agent.name === agentName)?.model
  if (!pinned || pinned.providerID !== config.currentProviderId || pinned.id !== config.currentModelId) return
  commitComposerPick(sessionId, directory)
}
