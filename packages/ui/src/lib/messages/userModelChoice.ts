import type { Message, Part } from '@opencode-ai/sdk/v2'

import { isFullySyntheticMessage } from './synthetic'
import { compareMessagesChronologically } from '@/sync/message-ordering'

export type UserModelChoice = {
  id: string
  time: { created: number }
  agent?: string
  providerID?: string
  modelID?: string
  variant?: string
}

type MessageLike = Message & {
  model?: { providerID?: string; modelID?: string; variant?: string }
  variant?: string
  mode?: string
}

/**
 * Extract agent/model selection metadata from a user message, if present.
 */
export const extractUserModelChoice = (message: MessageLike): UserModelChoice | null => {
  if (message.role !== 'user') {
    return null
  }

  const providerID = typeof message.model?.providerID === 'string' && message.model.providerID.trim().length > 0
    ? message.model.providerID
    : undefined
  const modelID = typeof message.model?.modelID === 'string' && message.model.modelID.trim().length > 0
    ? message.model.modelID
    : undefined
  const agent = typeof message.agent === 'string' && message.agent.trim().length > 0
    ? message.agent
    : (typeof message.mode === 'string' && message.mode.trim().length > 0 ? message.mode : undefined)
  // OpenCode 1.4.0 moved variant from top-level to model.variant.
  const variantCandidate = message.model?.variant ?? message.variant
  const variant = typeof variantCandidate === 'string' && variantCandidate.trim().length > 0
    ? variantCandidate
    : undefined

  return { id: message.id, time: { created: message.time.created }, agent, providerID, modelID, variant }
}

/**
 * Find the latest *real* user prompt's model/agent choice.
 *
 * Synthetic user messages (e.g. subagent-completion nudges injected when a
 * delegated child session goes idle) must not drive the composer model
 * selector — restoring from them clobber a manual session override and reset
 * to the agent default.
 *
 * Messages whose parts have not been loaded yet are skipped so an incomplete
 * snapshot cannot be treated as authoritative.
 */
export const findLatestUserModelChoice = (
  messages: readonly MessageLike[],
  getParts: (messageId: string) => Part[] | undefined,
): UserModelChoice | null => {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message.role !== 'user') {
      continue
    }

    const parts = getParts(message.id)
    if (!Array.isArray(parts) || parts.length === 0) {
      continue
    }
    if (isFullySyntheticMessage(parts)) {
      continue
    }

    return extractUserModelChoice(message)
  }

  return null
}

/**
 * When the user has a manual session model override, initial history and late
 * metadata updates to the same user message must not overwrite it. Chronology
 * distinguishes a new prompt from older history exposed by removal, even when
 * the previously reconciled prompt has paged out of the loaded message bucket.
 */
export const shouldPreserveManualModelOverride = ({
  selectionSource,
  savedSessionModel,
  previousMessage,
  candidate,
}: {
  selectionSource: 'auto' | 'manual' | undefined
  savedSessionModel: { providerId: string; modelId: string } | null | undefined
  previousMessage: Pick<UserModelChoice, 'id' | 'time'> | null | undefined
  candidate: Pick<UserModelChoice, 'id' | 'time' | 'providerID' | 'modelID'> | null | undefined
}): boolean => {
  if (selectionSource !== 'manual' || !savedSessionModel?.providerId || !savedSessionModel.modelId) {
    return false
  }
  if (!candidate?.providerID || !candidate.modelID) {
    return true
  }
  if (previousMessage && candidate.id !== previousMessage.id) {
    return compareMessagesChronologically(candidate, previousMessage) <= 0
  }
  return savedSessionModel.providerId !== candidate.providerID
    || savedSessionModel.modelId !== candidate.modelID
}

export type LoadedUserChoiceRestore = {
  message: Pick<UserModelChoice, 'id' | 'time'>
  restoreKey: string
}

/** Bound component-local history, without moving its chronology backward on rollback. */
export const rememberLoadedUserChoiceRestore = (
  restores: Map<string, LoadedUserChoiceRestore>,
  scope: string,
  restore: LoadedUserChoiceRestore,
) => {
  const previous = restores.get(scope)
  const message = previous && compareMessagesChronologically(previous.message, restore.message) > 0
    ? previous.message
    : restore.message
  restores.delete(scope)
  restores.set(scope, { message, restoreKey: restore.restoreKey })
  if (restores.size <= 150) return
  const oldestScope = restores.keys().next().value
  if (oldestScope !== undefined) restores.delete(oldestScope)
}
