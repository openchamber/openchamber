import { type SyncEvent } from "@/lib/opencode/events"
import type { ControlStreamSyncEvent } from "@/lib/openchamberEvents"
import { applyWaitingPageEvent } from "./global-blocking-requests"
import { applySessionAssistEvent } from "./pending-session-assists"
import { useWorkflowRunsStore } from "@/lib/workflows/store"
import { resolveCachedSessionDirectory } from "./event-routing-index"
import { notifyWaitingPage } from "./sync-request-notifications"

type ControlStreamOnlyEvent = Exclude<ControlStreamSyncEvent, { type: "session.patched" }>

export const isControlStreamOnlyEvent = (payload: SyncEvent): payload is ControlStreamOnlyEvent => (
  payload.type === "openchamber.page-waiting"
  || payload.type === "openchamber.page-settled"
  || payload.type === "openchamber.session-assist"
  || payload.type === "openchamber.workflow-run"
  || payload.type === "openchamber.workflow-run-removed"
)

export const applyControlStreamOnlyEvent = (payload: ControlStreamOnlyEvent): void => {
  switch (payload.type) {
    case "openchamber.page-waiting":
    case "openchamber.page-settled":
      applyWaitingPageEvent(payload, resolveCachedSessionDirectory)
      if (payload.type === "openchamber.page-waiting") notifyWaitingPage(payload)
      return
    case "openchamber.session-assist":
      applySessionAssistEvent(payload.properties, resolveCachedSessionDirectory)
      return
    case "openchamber.workflow-run":
      useWorkflowRunsStore.getState().apply(payload.properties.run)
      return
    case "openchamber.workflow-run-removed":
      useWorkflowRunsStore.getState().remove(payload.properties.parentSessionId, payload.properties.runId)
      return
  }
}
