import type { Session } from "@/lib/opencode/model"

/**
 * OpenCode 2.x announces a fork with `session.forked` only: no
 * `session.created` follows, and the event carries ids, not the record. Every
 * client that did not start the fork would otherwise miss it until its session
 * list reloads. This reads the fork's record and hands it back as a
 * `session.created`, so it lands through the same path as any new session.
 *
 * The forking client already inserted the record from the fork response, so a
 * session this client knows is left alone. A fork this client is creating
 * itself (`/btw`, which marks the fork only after it exists) is left to that
 * flow. A failed read applies nothing; the next list read picks the fork up.
 *
 * A patch for the fork can land while its record is being read (the `/btw`
 * marker does), and the global router drops patches for sessions it hasn't
 * seen, so the read record would be stale. Such a fork is read once more.
 */
export type ForkedSessionDeps = {
  isKnown: (sessionID: string) => boolean
  isCreatingLocally: (parentID: string) => boolean
  getSession: (sessionID: string, directory: string | undefined) => Promise<Session>
  isCurrent: () => boolean
  apply: (info: Session) => void
}

const patchedDuringRead = new Map<string, boolean>()

export function noteForkedSessionPatched(sessionID: string): void {
  if (patchedDuringRead.has(sessionID)) patchedDuringRead.set(sessionID, true)
}

export async function applyForkedSession(
  event: { sessionID: string; parentID: string; directory: string | undefined },
  deps: ForkedSessionDeps,
): Promise<void> {
  if (deps.isKnown(event.sessionID) || deps.isCreatingLocally(event.parentID)) return
  let info: Session
  try {
    patchedDuringRead.set(event.sessionID, false)
    info = await deps.getSession(event.sessionID, event.directory)
    if (patchedDuringRead.get(event.sessionID)) {
      info = await deps.getSession(event.sessionID, event.directory)
    }
  } catch {
    return
  } finally {
    patchedDuringRead.delete(event.sessionID)
  }
  if (!deps.isCurrent() || deps.isKnown(event.sessionID)) return
  deps.apply(info)
}
