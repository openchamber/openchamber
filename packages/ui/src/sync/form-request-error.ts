import { AgentUnavailableError } from '@/lib/opencode/agent-unavailable-error'

/**
 * The server no longer has this form. The reply or cancel cannot be retried:
 * the request was already settled, or it was never on this directory.
 * Callers must not present that as "submit failed, try again".
 */
export function isFormRequestNotFoundError(error: unknown): boolean {
  if (error && typeof error === "object") {
    const status = (error as { status?: unknown }).status
    if (status === 404) return true
  }

  let message = ""
  if (error instanceof Error) {
    message = error.message
  } else if (typeof error === "string") {
    message = error
  }

  return /Form(?:\.)?NotFoundError|Form request not found/i.test(message)
}

/**
 * The reply failed because the folder lacks the agent: nothing was submitted,
 * and a retry cannot succeed until the user picks an agent the folder has.
 * Returns that agent's name, or null when something else failed.
 */
export function agentUnavailableFrom(error: Error | null): string | null {
  if (error instanceof AgentUnavailableError) return error.agent
  if (error?.cause instanceof AgentUnavailableError) return error.cause.agent
  return null
}
