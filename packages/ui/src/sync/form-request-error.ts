import { AgentUnavailableError } from '@/lib/opencode/agent-unavailable-error'
import type { I18nKey, I18nParams } from '@/lib/i18n'
import { ConnectionLostError } from './connection-lost-error'

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

export const isFormAlreadySettledError = (error: Error): boolean => "tag" in error && error.tag === "FormAlreadySettledError"

export function agentUnavailableFrom(error: Error | null): string | null {
  if (error instanceof AgentUnavailableError) return error.agent
  if (error?.cause instanceof AgentUnavailableError) return error.cause.agent
  return null
}

export function connectionLostMessage(
  error: Error | null,
  t: (key: I18nKey, params?: I18nParams) => string,
): string | null {
  if (!(error instanceof ConnectionLostError)) return null
  if (error.reason) return t('chat.formCard.connectionLostReason', { reason: error.reason })
  return error.everConnected ? t('chat.formCard.connectionLost') : t('chat.formCard.notConnected')
}
