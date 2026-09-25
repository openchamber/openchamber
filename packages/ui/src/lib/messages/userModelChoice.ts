import type { Message, Part } from '@/lib/opencode/model'

type UserModelChoice = {
  id: string
  agent?: string
  providerID?: string
  modelID?: string
  variant?: string
}

/**
 * The agent/model a turn actually ran on.
 *
 * OpenCode v2 user messages carry no model: the server records the choice on
 * the assistant reply, so the reply is the authority for what the composer
 * should show.
 */
export const extractAssistantModelChoice = (message: Message): UserModelChoice | null => {
  if (message.role !== 'assistant') {
    return null
  }
  return {
    id: message.id,
    agent: message.agent.trim() || undefined,
    providerID: message.providerID.trim() || undefined,
    modelID: message.modelID.trim() || undefined,
    variant: message.variant?.trim() || undefined,
  }
}

/**
 * Find the latest turn's model/agent choice.
 *
 * Messages whose parts have not been loaded yet are skipped so an incomplete
 * snapshot cannot be treated as authoritative.
 */
export const findLatestUserModelChoice = (
  messages: readonly Message[],
  getParts: (messageId: string) => Part[] | undefined,
): UserModelChoice | null => {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message.role !== 'assistant') {
      continue
    }

    const parts = getParts(message.id)
    if (!Array.isArray(parts) || parts.length === 0) {
      continue
    }

    return extractAssistantModelChoice(message)
  }

  return null
}

/**
 * When the user has a manual session model override, historical user-message
 * metadata must not overwrite it. After a real send the selection store is
 * updated to match the message, so a conflict means the picker was changed
 * after the last prompt — keep the override.
 */
export const shouldPreserveManualModelOverride = ({
  selectionSource,
  savedSessionModel,
  candidate,
}: {
  selectionSource: 'auto' | 'manual' | undefined
  savedSessionModel: { providerId: string; modelId: string } | null | undefined
  candidate: Pick<UserModelChoice, 'providerID' | 'modelID'> | null | undefined
}): boolean => {
  if (selectionSource !== 'manual' || !savedSessionModel?.providerId || !savedSessionModel.modelId) {
    return false
  }
  if (!candidate?.providerID || !candidate.modelID) {
    return true
  }
  return savedSessionModel.providerId !== candidate.providerID
    || savedSessionModel.modelId !== candidate.modelID
}
