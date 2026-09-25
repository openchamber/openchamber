/**
 * Recent OpenCode session errors, kept in memory for diagnostics.
 *
 * OpenCode reports a failed turn as a `session.error` event. The message it
 * carries is the only account of what went wrong, and it may arrive without
 * an assistant message to attach itself to, so a turn can end with nothing
 * on screen. This buffer keeps the last errors until someone asks for them,
 * via the status report (Ctrl/Cmd+Shift+L) or `__opencodeDebug`. In-memory
 * only: never persisted, never sent anywhere, dropped on reload.
 */

import type { StructuredError } from '@/lib/opencode/model'

const MAX_RECORDED_SESSION_ERRORS = 20
const MAX_MESSAGE_LENGTH = 400

export type OpenCodeErrorSummary = {
  name: string | null
  message: string | null
}

export type SessionErrorRecord = OpenCodeErrorSummary & {
  at: number
  sessionId: string
  directory: string | null
}

/**
 * OpenCode v2 reports a failed turn as `{ type, message }`. The record keeps
 * both: `type` names the failure class the server recognised, `message` is the
 * text worth showing. Returns nulls when neither is usable, so a caller can
 * tell "no details" from a real message.
 */
export function summarizeOpenCodeError(error: StructuredError | null | undefined): OpenCodeErrorSummary {
  if (!error) return { name: null, message: null }
  const name = error.type.trim() ? error.type.trim() : null
  const message = error.message.trim()
  return { name, message: message ? message.slice(0, MAX_MESSAGE_LENGTH) : null }
}

const records: SessionErrorRecord[] = []

export function recordSessionError(record: Omit<SessionErrorRecord, 'at'>): void {
  records.push({ ...record, at: Date.now() })
  if (records.length > MAX_RECORDED_SESSION_ERRORS) {
    records.splice(0, records.length - MAX_RECORDED_SESSION_ERRORS)
  }
}

/** Newest first. */
export function getRecentSessionErrors(): SessionErrorRecord[] {
  return [...records].reverse()
}
