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

import type { EventSessionError } from '@opencode-ai/sdk/v2'

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
 * OpenCode error payloads are `{ name, data: { message, ... } }`; older or
 * foreign shapes carry `message` at the top. Returns nulls for anything
 * else so a caller can tell "no details" from a real message.
 */
export type OpenCodeSessionErrorPayload = EventSessionError['properties']['error']

export function summarizeOpenCodeError(error: OpenCodeSessionErrorPayload | { message?: string } | null | undefined): OpenCodeErrorSummary {
  if (!error || typeof error !== 'object') return { name: null, message: null }
  // SAFETY: the SDK union is `{ name, data: { message } }` per variant; a
  // top-level `message` covers foreign shapes. Every field is checked before use.
  const record = error as { name?: unknown; message?: unknown; data?: { message?: unknown } }
  const name = typeof record.name === 'string' && record.name.trim() ? record.name.trim() : null
  const dataMessage = typeof record.data?.message === 'string' ? record.data.message.trim() : ''
  const topMessage = typeof record.message === 'string' ? record.message.trim() : ''
  const message = dataMessage || topMessage || null
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
