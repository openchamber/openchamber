
import type { StructuredError } from '@/lib/opencode/model'

const MAX_RECORDED_SESSION_ERRORS = 20
const MAX_MESSAGE_LENGTH = 400
const MAX_RESPONSE_BODY_LENGTH = 16_000

export type OpenCodeErrorSummary = {
  name: string | null
  message: string | null
}

export type SessionErrorRecord = OpenCodeErrorSummary & {
  at: number
  sessionId: string
  directory: string | null
}

export function summarizeOpenCodeError(error: StructuredError | null | undefined): OpenCodeErrorSummary {
  if (!error) return { name: null, message: null }
  const name = error.type.trim() ? error.type.trim() : null
  const message = error.message.trim()
  return { name, message: message ? message.slice(0, MAX_MESSAGE_LENGTH) : null }
}

export function responseBodyOf(error: StructuredError | null | undefined): string | null {
  const body = error?.response?.body.trim()
  return body ? body.slice(0, MAX_RESPONSE_BODY_LENGTH) : null
}

const records: SessionErrorRecord[] = []

export function recordSessionError(record: Omit<SessionErrorRecord, 'at'>): void {
  records.push({ ...record, at: Date.now() })
  if (records.length > MAX_RECORDED_SESSION_ERRORS) {
    records.splice(0, records.length - MAX_RECORDED_SESSION_ERRORS)
  }
}

export function getRecentSessionErrors(): SessionErrorRecord[] {
  return [...records].reverse()
}
