import type { Metadata } from "@/lib/opencode/model"
import { newLeadMarker } from "@/lib/sessionLead"
import type { NewSessionDraftState } from "./session-ui-store"

export const draftSessionMetadata = (draft: Pick<NewSessionDraftState, "projectContextPins" | "lead">): Metadata | undefined => {
  const draftPins = draft.projectContextPins ?? { notes: [], plans: [] }
  const pins = draftPins.notes.length > 0 || draftPins.plans.length > 0 ? { project_context_pins: draftPins } : null
  const lead = draft.lead ? { lead: newLeadMarker(Date.now()) } : null
  return pins || lead ? { openchamber: { ...pins, ...lead } } : undefined
}
