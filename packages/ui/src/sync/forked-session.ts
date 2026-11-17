import type { Session } from "@/lib/opencode/model"

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
