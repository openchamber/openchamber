export interface RetryOptions {
  attempts?: number
  delay?: number
  factor?: number
  maxDelay?: number
  retryIf?: (error: unknown) => boolean
}

const TRANSIENT_MESSAGES = [
  "load failed",
  "network connection was lost",
  "network request failed",
  "failed to fetch",
  "econnreset",
  "econnrefused",
  "etimedout",
  "socket hang up",
  // AbortSignal.timeout() (used by bounded session-list requests) surfaces
  // this exact message in Bun/Electron. Treat it like ETIMEDOUT so a cold
  // OpenCode index warm-up gets the same bounded retry budget as other
  // transient transport failures.
  "signal timed out",
  "opencode api unavailable",
  "503",
  "502",
]

function isTransientError(error: unknown): boolean {
  if (!error) return false
  const message = String(error instanceof Error ? error.message : error).toLowerCase()
  if (TRANSIENT_MESSAGES.some((m) => message.includes(m))) return true
  // Any HTTP 5xx is considered transient — server-side issues during warmup
  // (OpenCode reading sessions from disk, bridge not ready, etc.) are retryable.
  const status = (error as { status?: number })?.status
  if (typeof status === "number" && status >= 500 && status < 600) return true
  return false
}

export async function retry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const {
    attempts = 3,
    delay = 500,
    factor = 2,
    maxDelay = 10000,
    retryIf = isTransientError,
  } = options

  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      if (attempt === attempts - 1 || !retryIf(error)) throw error
      const wait = Math.min(delay * Math.pow(factor, attempt), maxDelay)
      await new Promise((resolve) => setTimeout(resolve, wait))
    }
  }
  throw lastError
}
