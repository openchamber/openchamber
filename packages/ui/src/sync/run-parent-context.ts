import type { Session } from "@/lib/opencode/model"
import { opencodeClient } from "@/lib/opencode/client"
import { getMultiRunIdentity } from "@/lib/multirun/identity"
import { buildRunParentContext } from "@/lib/multirun/parentContext"
import { loadLaneLastReply } from "@/lib/multirun/laneData"
import { useGlobalSessionsStore } from "@/stores/useGlobalSessionsStore"
import { useGlobalSessionStatusStore } from "./global-session-status"
import { useGlobalBlockingRequestsStore } from "./global-blocking-requests"
import { getAllSyncSessions } from "./sync-refs"

/** The run's state a message to a multi-run parent session carries; null for any other session. */
export const readRunParentContext = async (ownSession: Session | undefined): Promise<string | null> => {
  if (!ownSession || getMultiRunIdentity(ownSession)?.role !== "parent") return null
  const sessions = new Map(useGlobalSessionsStore.getState().activeSessions.map((session) => [session.id, session]))
  for (const session of getAllSyncSessions()) sessions.set(session.id, session)
  return buildRunParentContext({ parent: ownSession, sessions: sessions.values() }, {
    readSession: (id, directory) => opencodeClient.getSession(id, directory),
    readReply: loadLaneLastReply,
    isBusy: (id) => useGlobalSessionStatusStore.getState().activeSessionIds.has(id),
    blocking: (id) => {
      const requests = useGlobalBlockingRequestsStore.getState().bySession.get(id)
      return requests?.permissions.length ? "permission" : requests?.forms.length || requests?.pages.length ? "question" : null
    },
  })
}
