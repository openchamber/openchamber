// ---------------------------------------------------------------------------
// Payload sanitization — strip oversized diff snapshot fields client-side.
//
// OpenCode session objects carry summary.diffs[].before/after with full file
// contents. The UI never uses these fields but they waste browser memory and
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
}

type SessionSummary = {
  diffs?: DiffEntry[]
  [key: string]: unknown
}

/** Strip before/after from summary.diffs on a session object */
export function stripSessionDiffSnapshots(session: Session): Session {
  const summary = (session as { summary?: SessionSummary }).summary
  if (!summary?.diffs || !Array.isArray(summary.diffs)) return session

  let changed = false
  const stripped = summary.diffs.map((d) => {
    if (d && (typeof d.before === "string" || typeof d.after === "string")) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { before: _before, after: _after, ...rest } = d
      changed = true
      return rest
    }
    return d
  })

  if (!changed) return session
  return { ...session, summary: { ...summary, diffs: stripped } } as Session
}

/** Strip before/after from summary.diffs on a message object */
export function stripMessageDiffSnapshots(message: Message): Message {
  const summary = (message as { summary?: SessionSummary }).summary
  if (!summary?.diffs || !Array.isArray(summary.diffs)) return message

  let changed = false
  const stripped = summary.diffs.map((d) => {
    if (d && (typeof d.before === "string" || typeof d.after === "string")) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { before: _before, after: _after, ...rest } = d
      changed = true
      return rest
    }
    return d
  })

  if (!changed) return message
  return { ...message, summary: { ...summary, diffs: stripped } } as Message
}
