import { isSameModelRef, toModelRef, type ModelRef } from "@/lib/opencode/model"
import { getAllSyncSessions, getDirectoryState } from "./sync-refs"

type ResolvedSendSelection = {
  model?: ModelRef
  agent?: string
}

/**
 * The model and agent a send has to switch the session to, or nothing when the
 * session already runs on the desired selection. Sending them on every turn
 * would make OpenCode record a switch (and two round trips) each time.
 *
 * OpenCode 2.x keeps the selection on the session: `session.model` and
 * `session.agent` are what the next turn runs on, so only a difference from the
 * session's own record travels. `/compact` resolves its model the same way.
 */
export function resolveSendSelection(
  sessionId: string,
  directory: string | undefined,
  desired: { providerID: string; modelID: string; variant?: string | null; agent?: string },
): ResolvedSendSelection {
  const sessions = getDirectoryState(directory)?.session ?? getAllSyncSessions()
  const session = sessions.find((candidate) => candidate.id === sessionId)
  // Compared in wire form: an explicit `Default` (null) switches the session
  // off an effort once, then matches the `"default"` OpenCode records for it.
  const model = toModelRef({ providerID: desired.providerID, id: desired.modelID, variant: desired.variant })
  const modelChanged = !session?.model || !isSameModelRef(session.model, model)
  const agentChanged = Boolean(desired.agent) && session?.agent !== desired.agent
  return {
    model: modelChanged ? model : undefined,
    agent: agentChanged ? desired.agent : undefined,
  }
}
