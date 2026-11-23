import { opencodeClient } from "@/lib/opencode/client"
import type { Session } from "@/lib/opencode/model"
import { isAutoModel } from "@/lib/routing/autoModel"
import { markDefiniteTransportFailure } from "@/lib/relay/transport-error"
import { captureRuntimeInstance } from "@/lib/runtime-switch"
import { selectCatalogLoadedForDirectory, selectConfigAgentsForDirectory, useConfigStore } from "@/stores/useConfigStore"
import { whenModelPickWritten } from "./model-gesture"

type ResolvedSendSelection = {
  agent?: string
  providerID?: string
}

export async function resolveSendSelection(
  sessionId: string,
  directory: string | undefined,
  desired: { providerID: string; modelID: string; variant?: string | null; agent?: string },
): Promise<ResolvedSendSelection> {
  await whenModelPickWritten(sessionId)
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
    return {}
  }
  if (!isCurrentRuntime()) throw new Error("Message was not sent because the runtime changed.")
  return {
    agent: desired.agent && serverSession.agent !== desired.agent ? desired.agent : undefined,
    providerID: isAutoModel(desired.providerID, desired.modelID) ? undefined : serverSession.model?.providerID,
  }
}

export async function resolveCheckedSendSelection(
  sessionId: string,
  directory: string | undefined,
  desired: { providerID: string; modelID: string; variant?: string | null; agent?: string },
): Promise<ResolvedSendSelection> {
  const selection = await resolveSendSelection(sessionId, directory, desired)
  if (selection.agent || !desired.agent || !directory) return selection
  const config = useConfigStore.getState()
  const listed = !selectCatalogLoadedForDirectory(config, "agents", directory)
    || selectConfigAgentsForDirectory(config, directory).some((agent) => agent.id === desired.agent)
  return listed ? selection : { ...selection, agent: desired.agent }
}
