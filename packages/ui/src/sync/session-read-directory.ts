import type { Session } from "@/lib/opencode/model"
import { normalizePath } from "@/lib/pathNormalization"
import { resolveRecoveryDirectory } from "./form-recovery"

export type SessionReadDirectorySources = {
  /** The directory the global session record names, or null when it has none. */
  knownDirectory: (sessionID: string) => string | null
  /** The session read by ID without a directory scope; null when the read fails. */
  readUnscoped: (sessionID: string) => Promise<Pick<Session, "directory"> | null>
  /** Follows a move the server already made (`adoptSessionMove`). */
  adopt: (sessionID: string, sourceDirectory: string, destinationDirectory: string) => void
}

/**
 * The directory a session should be read from. The global record follows a
 * move and is the normal answer; a session it has not listed yet is read by
 * ID unscoped. A different answer from the directory the caller selected (a
 * stale copy left by a move) is adopted before any read starts, so the old
 * directory is never repopulated and the chat follows the session.
 *
 * `isCurrent` is the caller's runtime instance, captured before it called.
 * Null means that instance retired while the unscoped read was in flight: the
 * caller stops, and nothing was adopted into the replacement instance.
 */
export async function resolveSessionReadDirectory(
  sessionID: string,
  fallback: string,
  isCurrent: () => boolean,
  sources: SessionReadDirectorySources,
): Promise<string | null> {
  if (!isCurrent()) return null
  const selected = normalizePath(fallback) ?? fallback
  const known = normalizePath(sources.knownDirectory(sessionID))
  if (known) {
    if (known !== selected) sources.adopt(sessionID, selected, known)
    return known
  }
  const authoritative = await sources.readUnscoped(sessionID).catch(() => null)
  if (!isCurrent()) return null
  const directory = resolveRecoveryDirectory(authoritative, selected) ?? selected
  if (directory !== selected) sources.adopt(sessionID, selected, directory)
  return directory
}
