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
// 3. Session list loading — list responses should not populate stores with
//    detail-only revert/diff blobs
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

const getSessionListRevertMarker = (revert: unknown): Pick<SessionRevert, "messageID" | "partID"> | undefined => {
  if (!revert || typeof revert !== "object" || Array.isArray(revert)) {
    return undefined
  }

  const marker: Pick<SessionRevert, "messageID" | "partID"> = {}
  const record = revert as SessionRevert
  if (typeof record.messageID === "string") {
    marker.messageID = record.messageID
  }
  if (typeof record.partID === "string") {
    marker.partID = record.partID
  }

  return Object.keys(marker).length > 0 ? marker : undefined
}

const hasSessionListRevertDetails = (revert: unknown): boolean => {
  if (revert === undefined) {
    return false
  }
  if (!revert || typeof revert !== "object" || Array.isArray(revert)) {
    return true
  }

  return Object.keys(revert).some((key) => key !== "messageID" && key !== "partID")
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

/** Strip detail-only fields from session list records before storing them. */
export function stripSessionListDetails(session: Session): Session {
  const record = session as Session & {
    summary?: SessionSummary
    revert?: unknown
    metadata?: unknown
    permission?: unknown
  }

  const shouldStrip = hasSessionListRevertDetails(record.revert)
    || Array.isArray(record.summary?.diffs)
    || "metadata" in record
    || "permission" in record

  if (!shouldStrip) {
    return session
  }

  const stripped = stripSessionDiffSnapshots(session) as typeof record
  const next: Record<string, unknown> = { ...stripped }
  delete next.metadata
  delete next.permission

  const revertMarker = getSessionListRevertMarker(stripped.revert)
  if (revertMarker) {
    next.revert = revertMarker
  } else {
    delete next.revert
  }

  const summary = stripped.summary
  if (summary && typeof summary === "object" && !Array.isArray(summary)) {
    const summaryCounts: SessionSummary = {}
    if ("additions" in summary) summaryCounts.additions = summary.additions
    if ("deletions" in summary) summaryCounts.deletions = summary.deletions
    if ("files" in summary) summaryCounts.files = summary.files
    if (Object.keys(summaryCounts).length > 0) {
      next.summary = summaryCounts
    } else {
      delete next.summary
    }
  }

  return next as unknown as Session
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
