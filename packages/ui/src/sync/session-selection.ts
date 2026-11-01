import { opencodeClient } from "@/lib/opencode/client"
import { isSameModelRef, toModelRef, type ModelRef, type Session } from "@/lib/opencode/model"
import { markDefiniteTransportFailure } from "@/lib/relay/transport-error"
import { captureRuntimeInstance } from "@/lib/runtime-switch"
import { getAllSyncSessions, getDirectoryState } from "./sync-refs"

type ResolvedSendSelection = {
  model?: ModelRef
  agent?: string
}

/**
 * The model and agent a send has to switch the session to. Models use the
 * sync record, as `/compact` does. Agents are checked against a fresh server
 * record: a stale sync copy must not suppress the switch the user requested.
 *
 * OpenCode records every switch in the transcript, so a send leaves the agent
 * unset when the server already runs on the desired agent.
 */
export async function resolveSendSelection(
  sessionId: string,
  directory: string | undefined,
  desired: { providerID: string; modelID: string; variant?: string | null; agent?: string },
): Promise<ResolvedSendSelection> {
  let agentChanged = false
  if (desired.agent) {
    const isCurrentRuntime = captureRuntimeInstance()
    let currentSession: Session
    try {
      currentSession = await opencodeClient.getSession(sessionId, directory)
    } catch (error) {
      // The prompt has not left, so a failed read needs no send confirmation.
      if (error instanceof Error) markDefiniteTransportFailure(error)
      throw error
    }
    if (!isCurrentRuntime()) throw new Error("Message was not sent because the runtime changed.")
    agentChanged = currentSession.agent !== desired.agent
  }
  const sessions = getDirectoryState(directory)?.session ?? getAllSyncSessions()
  const session = sessions.find((candidate) => candidate.id === sessionId)
  // Compared in wire form: an explicit `Default` (null) switches the session
  // off an effort once, then matches the `"default"` OpenCode records for it.
  const model = toModelRef({ providerID: desired.providerID, id: desired.modelID, variant: desired.variant })
  const modelChanged = !session?.model || !isSameModelRef(session.model, model)
  return {
    model: modelChanged ? model : undefined,
    agent: agentChanged ? desired.agent : undefined,
  }
}
