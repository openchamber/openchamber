// ---------------------------------------------------------------------------
// Payload sanitization — strip oversized diff snapshot fields client-side.
//
// OpenCode session/message snapshots may carry large full-content diff fields
// (legacy before/after or from/to). The UI never uses these fields but they
// waste browser memory and
// can crash tabs for large sessions.
//
// Applied at two points:
// 1. Event reducer — session.created/session.updated events
// 2. Message loading — fetchMessages response
// ---------------------------------------------------------------------------

import type { Session, Message } from "@opencode-ai/sdk/v2/client"

type DiffEntry = {
  file?: string
  status?: string
  additions?: number
  deletions?: number
  before?: string
  after?: string
  from?: string
  to?: string
}

type SessionSummary = {
  diffs?: DiffEntry[]
  [key: string]: unknown
}

type SessionRevert = {
  messageID?: string
  partID?: string
  snapshot?: string
  diff?: string
  [key: string]: unknown
}

const stripDiffSnapshotFields = <T extends DiffEntry>(diff: T, includePatch: boolean): T => {
  if (!diff || typeof diff !== "object") {
    return diff
  }

  const shouldStrip =
    typeof diff.before === "string"
    || typeof diff.after === "string"
    || typeof diff.from === "string"
    || typeof diff.to === "string"
    || (includePatch && "patch" in (diff as T & { patch?: unknown }) && typeof (diff as T & { patch?: unknown }).patch === "string")

  if (!shouldStrip) {
    return diff
  }

  const rest = { ...diff } as T & { patch?: string }
  delete rest.before
  delete rest.after
  delete rest.from
  delete rest.to
  if (includePatch) {
    delete rest.patch
  }
  return rest
}

/** Strip oversized snapshot fields from summary.diffs on a session object */
export function stripSessionDiffSnapshots(session: Session): Session {
  const summary = (session as { summary?: SessionSummary }).summary
  const revert = (session as { revert?: SessionRevert }).revert

  let nextSession: Session = session
  let changed = false

  if (revert && (typeof revert.snapshot === "string" || typeof revert.diff === "string")) {
    const nextRevert = { ...revert }
    delete nextRevert.snapshot
    delete nextRevert.diff
    nextSession = { ...nextSession, revert: nextRevert } as Session
    changed = true
  }

  if (!summary?.diffs || !Array.isArray(summary.diffs)) return nextSession

  const stripped = summary.diffs.map((d) => {
    const nextDiff = stripDiffSnapshotFields(d, true)
    if (nextDiff !== d) {
      changed = true
    }
    return nextDiff
  })

  if (!changed) return nextSession
  return { ...nextSession, summary: { ...summary, diffs: stripped } } as Session
}

/** Strip oversized snapshot fields from summary.diffs on a message object */
export function stripMessageDiffSnapshots(message: Message): Message {
  const summary = (message as { summary?: SessionSummary }).summary
  if (!summary?.diffs || !Array.isArray(summary.diffs)) return message

  let changed = false
  const stripped = summary.diffs.map((d) => {
    const nextDiff = stripDiffSnapshotFields(d, false)
    if (nextDiff !== d) {
      changed = true
    }
    return nextDiff
  })

  if (!changed) return message
  return { ...message, summary: { ...summary, diffs: stripped } } as Message
}
