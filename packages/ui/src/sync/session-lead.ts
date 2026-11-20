import { getRuntimeKey } from "@/lib/runtime-switch"
import type { Session } from "@/lib/opencode/model"
import { withSessionLead } from "@/lib/sessionLead"
import { syncSessionKnowledge } from "@/lib/sessionKnowledgeApi"
import { patchSessionMetadata } from "./session-actions"
import { useSessionUIStore } from "./session-ui-store"

export async function setSessionLead(
  sessionId: string,
  directory: string | null | undefined,
  lead: boolean,
): Promise<Session | null> {
  const runtimeKeyAtClick = getRuntimeKey()
  try {
    const updated = await patchSessionMetadata(sessionId, directory, (metadata) => withSessionLead(metadata, lead, Date.now()), runtimeKeyAtClick)
    await syncSessionKnowledge(updated.directory || directory, sessionId, undefined, runtimeKeyAtClick)
    return updated
  } catch (error) {
    if (getRuntimeKey() !== runtimeKeyAtClick) return null
    throw error
  }
}

export function openOrToggleLeadDraft(options?: { directoryOverride?: string | null }): void {
  const { currentSessionId, newSessionDraft, openNewSessionDraft } = useSessionUIStore.getState()
  if (!currentSessionId && newSessionDraft.open) {
    useSessionUIStore.setState({ newSessionDraft: { ...newSessionDraft, lead: newSessionDraft.lead ? undefined : true } })
    return
  }
  openNewSessionDraft({ ...options, lead: true })
}
