import { opencodeClient } from "@/lib/opencode/client"
import { isSameModelRef, toModelRef, type ModelRef, type Session } from "@/lib/opencode/model"
import { markDefiniteTransportFailure } from "@/lib/relay/transport-error"
import { captureRuntimeInstance } from "@/lib/runtime-switch"
import { selectCatalogLoadedForDirectory, selectConfigAgentsForDirectory, useConfigStore } from "@/stores/useConfigStore"
import { getAllSyncSessions, getDirectoryState } from "./sync-refs"

type ResolvedSendSelection = {
  model?: ModelRef
  agent?: string
}

/**
 * The model and agent a send has to switch the session to, checked against a
 * fresh server record: a stale sync copy that already matches the picker must
 * not suppress the switch the user requested, since the turn runs on what the
 * server holds. The model also has to match the sync record read afterwards,
 * so a switch event received during the read still counts.
 *
 * OpenCode records every switch in the transcript, so a send leaves the model
 * and agent unset when the session already runs on them.
 *
 * The read is a check, never a gate for a model-only selection: when it fails,
 * the picked model is stated explicitly and the action goes ahead. With an
 * agent the failed read stops the send, since the agent cannot be compared.
 */
export async function resolveSendSelection(
  sessionId: string,
  directory: string | undefined,
  desired: { providerID: string; modelID: string; variant?: string | null; agent?: string },
): Promise<ResolvedSendSelection> {
  // Compared in wire form: an explicit `Default` (null) switches the session
  // off an effort once, then matches the `"default"` OpenCode records for it.
  const model = toModelRef({ providerID: desired.providerID, id: desired.modelID, variant: desired.variant })
  const isCurrentRuntime = captureRuntimeInstance()
  let serverSession: Session
  try {
    serverSession = await opencodeClient.getSession(sessionId, directory)
  } catch (error) {
    if (desired.agent) {
      // The prompt has not left, so a failed read needs no send confirmation.
      if (error instanceof Error) markDefiniteTransportFailure(error)
      throw error
    }
    if (!isCurrentRuntime()) throw new Error("Message was not sent because the runtime changed.")
    return { model }
  }
  if (!isCurrentRuntime()) throw new Error("Message was not sent because the runtime changed.")
  // A directory store without the record falls through to every store: a
  // project holds its worktrees' sessions too, and a missed record would turn
  // an unchanged model into a switch record in the transcript.
  const syncSession = getDirectoryState(directory)?.session.find((candidate) => candidate.id === sessionId)
    ?? getAllSyncSessions().find((candidate) => candidate.id === sessionId)
  const runsOn = (session: Session | undefined) => Boolean(session?.model && isSameModelRef(session.model, model))
  const modelChanged = !runsOn(serverSession) || !runsOn(syncSession)
  const agentChanged = Boolean(desired.agent) && serverSession.agent !== desired.agent
  return {
    model: modelChanged ? model : undefined,
    agent: agentChanged ? desired.agent : undefined,
  }
}

/**
 * `resolveSendSelection`, plus the agent the client still has to check. The
 * session can already be on an agent its folder lacks: set before the client
 * checked it, or its file was removed since. When the folder's loaded catalog
 * does not list it, the agent stays in the selection, so the client checks it
 * against a fresh list before anything is switched.
 */
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
