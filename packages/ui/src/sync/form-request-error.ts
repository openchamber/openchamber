import { AgentUnavailableError } from '@/lib/opencode/agent-unavailable-error'
import type { I18nKey, I18nParams } from '@/lib/i18n'
import { ConnectionLostError } from './connection-lost-error'

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
 * OpenCode settled the form before this reply or cancel arrived (another page
 * answered it, its turn ended). Decided by the tag OpenCode names: other 409s,
 * such as a busy session, say nothing about the form.
 */
export const isFormAlreadySettledError = (error: Error): boolean => "tag" in error && error.tag === "FormAlreadySettledError"

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

/**
 * The reply or cancel was refused before it was sent, because the connection
 * to the server was down. Returns the explanation in the user's language, with
 * the disconnect reason when there is one, or null when something else failed.
 * The form keeps the answer, so the same click retries it.
 */
export function connectionLostMessage(
  error: Error | null,
  t: (key: I18nKey, params?: I18nParams) => string,
): string | null {
  if (!(error instanceof ConnectionLostError)) return null
  if (error.reason) return t('chat.formCard.connectionLostReason', { reason: error.reason })
  return error.everConnected ? t('chat.formCard.connectionLost') : t('chat.formCard.notConnected')
}
