import type { Session } from "@/lib/opencode/model"
import { normalizePath } from "@/lib/pathNormalization"
import { resolveRecoveryDirectory } from "./form-recovery"

export type SessionReadDirectorySources = {
  knownDirectory: (sessionID: string) => string | null
  readUnscoped: (sessionID: string) => Promise<Pick<Session, "directory"> | null>
  adopt: (sessionID: string, sourceDirectory: string, destinationDirectory: string) => void
}

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
