import type { Message, Part, Session } from '@/lib/opencode/model'

export type UserModelChoice = {
  id: string
  agent?: string
  providerID?: string
  modelID?: string
  variant?: string
}

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

export const extractSessionRecordModelChoice = (session: Session | undefined): UserModelChoice | null => {
  const model = session?.model
  if (!session || !model?.providerID || !model.id) return null
  return {
    id: `session:${session.id}`,
    agent: undefined,
    providerID: model.providerID,
    modelID: model.id,
    variant: model.variant?.trim() || undefined,
  }
}

export const areModelChoicesEqual = (left: UserModelChoice | null, right: UserModelChoice | null): boolean => {
  if (left === right) return true
  if (!left || !right) return false
  return left.id === right.id
    && left.agent === right.agent
    && left.providerID === right.providerID
    && left.modelID === right.modelID
    && left.variant === right.variant
}

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
