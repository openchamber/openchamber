import { useProjectsStore } from "@/stores/useProjectsStore"
import type { ChildStoreManager } from "./child-store"
import { useGlobalBlockingRequestsStore } from "./global-blocking-requests"
import { useGlobalSessionsStore } from "@/stores/useGlobalSessionsStore"
import { isSessionAdmitted } from "./session-admission"
import { useSessionUIStore } from "./session-ui-store"

export function subscribePendingDescendantRequests(childStores: ChildStoreManager, sessionID: string): () => void {
  const load = () => {
    const sessions = useGlobalSessionsStore.getState().entityById
    for (const [pendingSessionID, pending] of useGlobalBlockingRequestsStore.getState().bySession) {
      if (pending.permissions.length === 0 && pending.forms.length === 0) continue
      const visited = new Set<string>()
      let ancestorID: string | undefined = pendingSessionID
      while (ancestorID && !visited.has(ancestorID)) {
        if (ancestorID === sessionID) {
          if (isSessionAdmitted(pending.directory) && childStores.getChild(pending.directory)?.getState().status !== 'complete') {
            childStores.requestBootstrap({ directory: pending.directory, priority: 'selected', reason: 'action-demand' })
          }
          break
        }
        visited.add(ancestorID)
        ancestorID = sessions.get(ancestorID)?.parentID
      }
    }
  }
  const unsubscribeRequests = useGlobalBlockingRequestsStore.subscribe(load)
  const unsubscribeSessions = useGlobalSessionsStore.subscribe((state, previous) => {
    if (state.entityById !== previous.entityById) load()
  })
  const unsubscribeProjects = useProjectsStore.subscribe((state, previous) => {
    if (state.projects !== previous.projects) load()
  })
  const unsubscribeWorktrees = useSessionUIStore.subscribe((state, previous) => {
    if (state.availableWorktreesByProject !== previous.availableWorktreesByProject) load()
  })
  load()
  return () => {
    unsubscribeRequests()
    unsubscribeSessions()
    unsubscribeProjects()
    unsubscribeWorktrees()
  }
}
