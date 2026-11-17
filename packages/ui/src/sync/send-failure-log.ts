
const MAX_RECORDED_SEND_FAILURES = 20
const MAX_REASON_LENGTH = 200

export type SendFailureRecord = {
  at: number
  sessionId: string
  messageId: string
  directory: string | null
  status: number | null
  ambiguous: boolean
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

export function getRecentSendFailures(): SendFailureRecord[] {
  return [...records].reverse()
}
