
import { isAmbiguousTransportFailure, isDefiniteTransportFailure } from "@/lib/relay/transport-error"

export function getErrorStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null
  // SAFETY: `error` is a non-null object here; both probes read optional
  // properties an SDK/fetch rejection may carry and validate them below.
  const direct = (error as { status?: unknown }).status
  if (typeof direct === "number") return direct
  // SAFETY: same non-null object, optional property probe validated below.
  const response = (error as { response?: { status?: unknown } }).response
  return typeof response?.status === "number" ? response.status : null
}

export function isAmbiguousSendFailure(error: unknown): boolean {
  if (error instanceof Error && isDefiniteTransportFailure(error)) return false
  if (isAmbiguousTransportFailure(error)) return true

  const status = getErrorStatus(error)
  if (status === 503 || status === 504 || status === 408) return true
  if (error instanceof TypeError) return true
  if (error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")) return true

  const message = error instanceof Error
    ? error.message.toLowerCase()
    : typeof error === "string"
      ? error.toLowerCase()
      : ""

  return message.includes("timeout")
    || message.includes("timed out")
    || message.includes("failed to fetch")
    || message.includes("networkerror")
    || message.includes("network error")
    || message.includes("gateway timeout")
    || message.includes("econnreset")
    || message.includes("socket hang up")
}
