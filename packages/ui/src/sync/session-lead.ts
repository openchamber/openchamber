import { z } from "zod"

import { opencodeClient } from "@/lib/opencode/client"
import { ascendingId } from "@/lib/opencode/ids"
import { getRuntimeKey } from "@/lib/runtime-switch"
import { runtimeFetch } from "@/lib/runtime-fetch"
import type { Session } from "@/lib/opencode/model"
import { LEAD_ANSWER_METADATA_KEY, withDismissedSuggestion, withSessionLead } from "@/lib/sessionLead"
import { syncSessionKnowledge } from "@/lib/sessionKnowledgeApi"
import { commitStagedRevert, patchSessionMetadata } from "./session-actions"
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

export async function answerLeadQuestion(sessionId: string, directory: string, question: string, answer: string): Promise<void> {
  const runtimeKey = getRuntimeKey()
  await commitStagedRevert(sessionId, directory)
  await opencodeClient.resumeWithSyntheticInput({
    runtimeKey,
    id: ascendingId("msg"),
    sessionId,
    directory,
    text: `The user answered a question from your digest.\n\nQuestion: ${question}\nAnswer: ${answer}`,
    metadata: { [LEAD_ANSWER_METADATA_KEY]: { question, answer } },
  })
}

const dismissals = new Map<string, Promise<unknown>>()

export function dismissLeadSuggestion(sessionId: string, directory: string, item: string): Promise<void> {
  const runtimeKey = getRuntimeKey()
  const run = (dismissals.get(sessionId) ?? Promise.resolve())
    .then(() => patchSessionMetadata(sessionId, directory, (metadata) => withDismissedSuggestion(metadata, item), runtimeKey))
    .then(() => undefined)
  const settled = run.catch(() => undefined)
  dismissals.set(sessionId, settled)
  void settled.then(() => {
    if (dismissals.get(sessionId) === settled) dismissals.delete(sessionId)
  })
  return run
}

const controlErrorSchema = z.object({ error: z.string() })

export async function handSessionToLead(sessionId: string, leadId: string): Promise<void> {
  const response = await runtimeFetch("/api/openchamber/control", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "lead.handover", input: { sessionId, leadId } }),
  })
  if (response.ok) return
  const body = controlErrorSchema.safeParse(await response.json().catch(() => null))
  throw new Error(body.data?.error ?? `hand-over failed with ${response.status}`)
}
