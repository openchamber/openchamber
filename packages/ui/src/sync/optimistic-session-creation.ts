import type { Session } from "@/lib/opencode/model"
import { opencodeClient } from "@/lib/opencode/client"
import { getRuntimeKey } from "@/lib/runtime-switch"
import { useGlobalSessionsStore } from "@/stores/useGlobalSessionsStore"
import { getSyncChildStores } from "./sync-refs"
import { getImperativeSessionMessageLoader } from "./session-message-loader"
import { adoptSessionMove } from "./session-actions"
import { dropSessionCaches } from "./session-cache"
import { cleanupPersistedSessionState } from "./session-deletion-cleanup"
import { persistSessions } from "./persist-cache"
import { deferSessionOperation, SessionCreationError, trackPendingSessionCreation } from "./pending-session-creation"

type DraftSessionInput = {
  readonly sessionId: string
  readonly directory: string
  readonly create: (signal: AbortSignal) => Promise<Session | null>
  readonly onCreationFailure?: (session: { sessionId: string; directory: string }) => void
}

/** Tracks the official draft create, without minting an id or inserting a second session record. */
export function createPendingDraftSession(input: DraftSessionInput, submitted: Promise<boolean>) {
  const runtimeKey = getRuntimeKey()
  const sdk = opencodeClient.getSdkClient()
  const stores = getSyncChildStores()
  const loader = getImperativeSessionMessageLoader()
  const isCurrent = () => runtimeKey === getRuntimeKey() && sdk === opencodeClient.getSdkClient()
  const sessionId = input.sessionId
  const completion = deferSessionOperation<Session>()
  const cancellation = new AbortController()
  const release = trackPendingSessionCreation(sessionId, { ready: completion.promise, isCurrent, submitted, cancellation })

  const rollback = (error: SessionCreationError): void => {
    if (isCurrent()) {
      // FORK: recover newer composer text/files before deletion notifies their owners.
      input.onCreationFailure?.({ sessionId, directory: input.directory })
      for (const [directory, child] of stores.children) {
        const current = child.getState()
        if (!current.session.some((item) => item.id === sessionId) && !current.message[sessionId]) continue
        const caches = { message: { ...current.message }, part: { ...current.part },
          session_status: { ...current.session_status }, permission: { ...current.permission }, form: { ...current.form } }
        loader?.invalidateSession({ directory, sessionID: sessionId })
        dropSessionCaches(caches, [sessionId])
        const nextRevision = (current.sessionRevision ?? 0) + 1
        child.setState({ ...caches, session: current.session.filter((item) => item.id !== sessionId),
          sessionRevision: nextRevision,
          sessionDeletedRevision: { ...current.sessionDeletedRevision, [sessionId]: nextRevision } })
      }
      useGlobalSessionsStore.getState().removeSessions([sessionId])
      cleanupPersistedSessionState({ runtimeKey, directory: input.directory, sessionId })
    }
    completion.reject(error)
  }
  // FORK: cancellation rejects local readiness now; a later create response cannot submit the prompt.
  const cancel = () => rollback(new SessionCreationError("cancelled"))
  cancellation.signal.addEventListener("abort", cancel, { once: true })
  void (async () => {
    try {
      const created = await input.create(cancellation.signal)
      if (cancellation.signal.aborted) return
      if (!isCurrent()) throw new SessionCreationError("runtime-changed")
      if (!created || created.id !== sessionId) throw new SessionCreationError("creation-failed")
      const confirmed = { ...created, directory: created.directory || input.directory }
      // FORK: move visible messages and loader shadows together before releasing submissions.
      if (confirmed.directory !== input.directory) adoptSessionMove(sessionId, input.directory, confirmed.directory)
      release()
      persistSessions(confirmed.directory, stores.getChild(confirmed.directory)?.getState().session)
      useGlobalSessionsStore.getState().upsertSession(confirmed)
      completion.resolve(confirmed)
    } catch (cause) {
      // A lost create response may still mean the server created it. Keep its directory intact.
      if (!cancellation.signal.aborted) {
        rollback(cause instanceof SessionCreationError ? cause : new SessionCreationError(isCurrent() ? "creation-failed" : "runtime-changed", { cause }))
      }
    } finally {
      cancellation.signal.removeEventListener("abort", cancel)
      // A cancelled entry keeps rejecting session operations until create's transport settles.
      release()
    }
  })()
  return { ready: completion.promise }
}
