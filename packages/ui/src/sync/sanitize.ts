
import type { Session } from "@/lib/opencode/model"

export function stripSessionDiffSnapshots(session: Session): Session {
  const revert = session.revert
  if (!revert || (revert.files === undefined && revert.snapshot === undefined)) return session
  const marker = { ...revert }
  delete marker.files
  delete marker.snapshot
  return { ...session, revert: marker }
}

export function stripSessionListDetails(session: Session): Session {
  const stripped = stripSessionDiffSnapshots(session)
  if (stripped.permissions === undefined) return stripped
  const rest = { ...stripped }
  delete rest.permissions
  return rest
}
