// ---------------------------------------------------------------------------
// Payload sanitization — keep detail-only session fields out of client stores.
//
// A staged revert carries the per-file diffs of everything it would undo. The
// UI derives reverted-state behavior from the lightweight messageID/partID
// marker, so those diffs stay out of the sync stores and the persisted
// session-list cache. Session-level permission rules are likewise detail the
// list never renders.
// ---------------------------------------------------------------------------

import type { Session } from "@/lib/opencode/model"

/** Drop the revert's file diffs and snapshot, keeping only its marker. */
export function stripSessionDiffSnapshots(session: Session): Session {
  const revert = session.revert
  if (!revert || (revert.files === undefined && revert.snapshot === undefined)) return session
  const marker = { ...revert }
  delete marker.files
  delete marker.snapshot
  return { ...session, revert: marker }
}

/** Strip detail-only fields from session list records before storing them. */
export function stripSessionListDetails(session: Session): Session {
  const stripped = stripSessionDiffSnapshots(session)
  if (stripped.permissions === undefined) return stripped
  const rest = { ...stripped }
  delete rest.permissions
  return rest
}
