import { opencodeClient } from "@/lib/opencode/client"
import { isSameModelRef, toModelRef, type ModelRef, type Session } from "@/lib/opencode/model"
import { markDefiniteTransportFailure } from "@/lib/relay/transport-error"
import { isAutoModel } from "@/lib/routing/autoModel"
import { captureRuntimeInstance } from "@/lib/runtime-switch"
import { useSelectionStore } from "./selection-store"
import { selectCatalogLoadedForDirectory, selectConfigAgentsForDirectory, useConfigStore } from "@/stores/useConfigStore"
import { getAllSyncSessions, getDirectoryState } from "./sync-refs"

export function isSessionModelChosen(sessionId: string, providerID: string, modelID: string): boolean {
  if (isAutoModel(providerID, modelID)) return true
  const pick = useSelectionStore.getState().getSessionModelPick(sessionId)
  return pick?.providerId === providerID && pick.modelId === modelID
}

type ResolvedSendSelection = {
  model?: ModelRef
  agent?: string
}

export type SendSelectionRequest = {
  providerID: string
  modelID: string
  variant?: string | null
  agent?: string
  keepSessionModel?: boolean
  keepSessionAgent?: boolean
}

export async function resolveSendSelection(
  sessionId: string,
  directory: string | undefined,
  desired: SendSelectionRequest,
): Promise<ResolvedSendSelection> {
  const model = toModelRef({ providerID: desired.providerID, id: desired.modelID, variant: desired.variant })
  const isCurrentRuntime = captureRuntimeInstance()
  let serverSession: Session
  try {
    serverSession = await opencodeClient.getSession(sessionId, directory)
  } catch (error) {
    if (desired.agent) {
      if (error instanceof Error) markDefiniteTransportFailure(error)
      throw error
    }
    if (!isCurrentRuntime()) throw new Error("Message was not sent because the runtime changed.")
    return desired.keepSessionModel ? {} : { model }
  }
  if (!isCurrentRuntime()) throw new Error("Message was not sent because the runtime changed.")
  const syncSession = getDirectoryState(directory)?.session.find((candidate) => candidate.id === sessionId)
    ?? getAllSyncSessions().find((candidate) => candidate.id === sessionId)
  const runsOn = (session: Session | undefined) => Boolean(session?.model && isSameModelRef(session.model, model))
  const modelChanged = desired.keepSessionModel
    ? !serverSession.model
    : !runsOn(serverSession) || !runsOn(syncSession)
  const agentChanged = Boolean(desired.agent) && serverSession.agent !== desired.agent && !(desired.keepSessionAgent && serverSession.agent)
  return {
    model: modelChanged ? model : undefined,
    agent: agentChanged ? desired.agent : undefined,
  }
}

export async function resolveCheckedSendSelection(
  sessionId: string,
  directory: string | undefined,
  desired: SendSelectionRequest,
): Promise<ResolvedSendSelection> {
  const selection = await resolveSendSelection(sessionId, directory, desired)
  if (selection.agent || !desired.agent || !directory || desired.keepSessionAgent) return selection
  const config = useConfigStore.getState()
  const listed = !selectCatalogLoadedForDirectory(config, "agents", directory)
    || selectConfigAgentsForDirectory(config, directory).some((agent) => agent.id === desired.agent)
  return listed ? selection : { ...selection, agent: desired.agent }
}
