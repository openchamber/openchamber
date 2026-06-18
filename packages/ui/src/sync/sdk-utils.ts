/**
 * Shared SDK utility types and helpers for the sync layer.
 * Extracted from session-actions.ts, sync-context.tsx, and use-sync.ts
 * to break import cycles and eliminate code triplication.
 */

export interface SdkResult<T> {
  data?: T
  error?: unknown
  response?: {
    status?: number
    headers?: { get?: (name: string) => string | null }
  }
}

export function formatSdkError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message
    if (typeof message === "string" && message.length > 0) return message

    const data = (error as { data?: unknown }).data
    if (data && typeof data === "object") {
      const dataMessage = (data as { message?: unknown }).message
      if (typeof dataMessage === "string" && dataMessage.length > 0) return dataMessage
    }
  }
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

export function assertSdkSuccess<T>(result: SdkResult<T>, operation: string): T | undefined {
  if (!result.error) return result.data
  const status = result.response?.status
  throw new Error(`${operation} failed${status ? ` (${status})` : ""}: ${formatSdkError(result.error)}`)
}

export function assertSdkData<T>(result: SdkResult<T>, operation: string): T {
  const data = assertSdkSuccess(result, operation)
  if (data === undefined || data === null) {
    throw new Error(`${operation} failed: empty response`)
  }
  return data
}
