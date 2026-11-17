import { useGlobalSessionsStore } from "@/stores/useGlobalSessionsStore"
import { toast } from "@/components/ui"
import { setSessionParentResolver } from "./global-session-status"
import { settledPageKeys, useGlobalBlockingRequestsStore } from "./global-blocking-requests"
import { requestHostTurnStarts } from "./host-session-status-seed"
import { setHostTurnStartRequester } from "./session-activity-timing"
import { useWorkflowRunsStore } from "@/lib/workflows/store"
import { setWorkflowRunningSessions } from "./workflow-activity"

useWorkflowRunsStore.subscribe((state) => {
  setWorkflowRunningSessions(Object.entries(state.bySession).flatMap(([sessionId, entry]) => (
    entry.runs.some((run) => run.state === "running") ? [sessionId] : []
  )))
})

useGlobalBlockingRequestsStore.subscribe((state, previous) => {
  if (state.bySession === previous.bySession) return
  const settled = settledPageKeys(previous.bySession, state.bySession)
  if (settled.length === 0) return
  const shown = new Set(toast.getToasts().map((entry) => entry.id))
  for (const key of settled) {
    if (shown.has(`page-${key}`)) toast.dismiss(`page-${key}`)
  }
})

setSessionParentResolver((sessionId) => useGlobalSessionsStore.getState().entityById.get(sessionId)?.parentID)

setHostTurnStartRequester(requestHostTurnStarts)
