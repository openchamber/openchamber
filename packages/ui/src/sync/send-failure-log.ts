/**
 * Recent prompt-send failures, kept in memory for diagnostics.
 *
 * A rejected send rolls the optimistic message back and, for transport-level
 * failures, the composer stays silent by design. That makes a misrouted or
 * refused prompt indistinguishable from "nothing happened" — the user has
 * nothing to report beyond "it disappeared".
 *
 * This buffer gives the failure somewhere to live until someone asks for it,
 * via the About dialog's diagnostics report or `__opencodeDebug`. It is
 * in-memory only: never persisted, never sent anywhere, and dropped on reload.
 */

const MAX_RECORDED_SEND_FAILURES = 20
const MAX_REASON_LENGTH = 200

export type SendFailureRecord = {
  at: number
  sessionId: string
  messageId: string
  /** Directory the prompt was routed to — the value under suspicion. */
  directory: string | null
  /** HTTP status, or null for a transport failure with no response. */
  status: number | null
  /** Whether the send may still have been accepted server-side. */
  ambiguous: boolean
  /** Whether a confirmation refetch ran and failed to find the message. */
  confirmationChecked: boolean
  reason: string
}

const records: SendFailureRecord[] = []

export function recordSendFailure(record: Omit<SendFailureRecord, 'at' | 'reason'> & { reason: string }): void {
  records.push({
    ...record,
    reason: record.reason.slice(0, MAX_REASON_LENGTH),
    at: Date.now(),
  })
  if (records.length > MAX_RECORDED_SEND_FAILURES) {
    records.splice(0, records.length - MAX_RECORDED_SEND_FAILURES)
  }
}

/** Newest first. */
export function getRecentSendFailures(): SendFailureRecord[] {
  return [...records].reverse()
}

