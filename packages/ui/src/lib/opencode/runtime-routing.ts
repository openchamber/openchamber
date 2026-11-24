import { ClientError } from "@opencode/client"

class RuntimeRoutingResponseError extends Error {
  constructor(readonly status: number, message: string, readonly undelivered = false) {
    super(message)
    this.name = "RuntimeRoutingResponseError"
  }
}

const OPENCODE_UNREACHABLE = "opencode-unreachable"

export const validateRuntimeResponse = (response: Response): Response => {
  const routingError = response.headers.get("x-openchamber-error")
  const unavailable = routingError === "runtime-unavailable"
  const unreachable = routingError === OPENCODE_UNREACHABLE
  const html = response.ok && (response.headers.get("content-type") ?? "").toLowerCase().includes("text/html")
  if (!unavailable && !unreachable && !html) return response
  void response.body?.cancel().catch(() => undefined)
  if (unreachable) throw new RuntimeRoutingResponseError(response.status, "OpenCode could not be reached", true)
  throw new RuntimeRoutingResponseError(response.status, unavailable
    ? "runtime_unavailable"
    : "the runtime returned a web page instead of an API response")
}

export const runtimeRoutingFailureOf = (error: unknown): RuntimeRoutingResponseError | null =>
  error instanceof RuntimeRoutingResponseError ? error
    : error instanceof ClientError && error.cause instanceof RuntimeRoutingResponseError ? error.cause : null
