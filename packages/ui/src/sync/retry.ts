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
  "opencode api unavailable",
  "503",
  "502",
]

function isTransientError(error: unknown): boolean {
  if (!error) return false
  const message = String(error instanceof Error ? error.message : error).toLowerCase()
  if (TRANSIENT_MESSAGES.some((m) => message.includes(m))) return true
  // SDK errors from HTTP 502/503 responses (VS Code bridge returns these before OpenCode is ready)
  const status = (error as { status?: number })?.status
  if (status === 502 || status === 503) return true
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
