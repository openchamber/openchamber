import { beforeEach, describe, expect, test } from 'bun:test'
import type { Message, Part } from '@opencode-ai/sdk/v2'

import {
  findLatestUserModelChoice,
  shouldPreserveManualModelOverride,
} from '@/lib/messages/userModelChoice'

/**
 * Regression for openchamber/openchamber#2404:
 * custom agent default model A → manual override to B → delegate subtask →
 * after child completes, synthetic completion nudge must not revert to A.
 */
describe('issue #2404 model override persistence across delegated subtask', () => {
  const sessionId = 'ses_2404'
  const agentName = 'custom-agent'
  const agentDefault = { providerID: 'provider', modelID: 'model-a' }
  const manualOverride = { providerID: 'provider', modelID: 'model-b' }

  let sessionModelSelections: Map<string, { providerId: string; modelId: string }>
  let sessionAgentModelSelections: Map<string, Map<string, { providerId: string; modelId: string }>>
  let selectionSource: 'auto' | 'manual'
  let currentProviderId: string
  let currentModelId: string

  beforeEach(() => {
    sessionModelSelections = new Map()
    sessionAgentModelSelections = new Map()
    selectionSource = 'auto'
    currentProviderId = agentDefault.providerID
    currentModelId = agentDefault.modelID
  })

  const createSessionWithAgentDefault = () => {
    // Session starts on the custom agent's pinned model A.
    currentProviderId = agentDefault.providerID
    currentModelId = agentDefault.modelID
    selectionSource = 'auto'
    sessionModelSelections.set(sessionId, {
      providerId: agentDefault.providerID,
      modelId: agentDefault.modelID,
    })
    sessionAgentModelSelections.set(sessionId, new Map([
      [agentName, { providerId: agentDefault.providerID, modelId: agentDefault.modelID }],
    ]))
  }

  const setManualModelOverride = () => {
    selectionSource = 'manual'
    currentProviderId = manualOverride.providerID
    currentModelId = manualOverride.modelID
    sessionModelSelections.set(sessionId, {
      providerId: manualOverride.providerID,
      modelId: manualOverride.modelID,
    })
    const agentMap = sessionAgentModelSelections.get(sessionId) ?? new Map()
    agentMap.set(agentName, {
      providerId: manualOverride.providerID,
      modelId: manualOverride.modelID,
    })
    sessionAgentModelSelections.set(sessionId, agentMap)
  }

  const completeDelegatedSubtask = () => {
    // Parent already has the real user prompt (sent with override B) plus a
    // synthetic subagent-completion nudge that carries the agent default A.
    const messages: Message[] = [
      {
        id: 'u-real',
        sessionID: sessionId,
        role: 'user',
        time: { created: 1 },
        agent: agentName,
        model: manualOverride,
      } as Message,
      {
        id: 'a1',
        sessionID: sessionId,
        role: 'assistant',
        time: { created: 2 },
        parentID: 'u-real',
        providerID: manualOverride.providerID,
        modelID: manualOverride.modelID,
      } as Message,
      {
        id: 'u-nudge',
        sessionID: sessionId,
        role: 'user',
        time: { created: 3 },
        agent: agentName,
        model: agentDefault,
      } as Message,
    ]
    const partsById: Record<string, Part[]> = {
      'u-real': [{
        id: 'p-real',
        sessionID: sessionId,
        messageID: 'u-real',
        type: 'text',
        text: 'Delegate a subtask',
      } as Part],
      'u-nudge': [{
        id: 'p-nudge',
        sessionID: sessionId,
        messageID: 'u-nudge',
        type: 'text',
        text: 'Subagent finished.',
        synthetic: true,
      } as Part],
    }

    const latestChoice = findLatestUserModelChoice(messages, (id) => partsById[id])
    const saved = sessionModelSelections.get(sessionId) ?? null

    // Composer restore must ignore the synthetic nudge and keep the override.
    expect(latestChoice?.modelID).toBe(manualOverride.modelID)
    expect(shouldPreserveManualModelOverride({
      selectionSource,
      savedSessionModel: saved,
      candidate: {
        providerID: agentDefault.providerID,
        modelID: agentDefault.modelID,
      },
    })).toBe(true)

    // Re-applying the session agent (as ModelControls may after rematerialization)
    // must also prefer the stored override over the agent pin.
    const agentOverride = sessionAgentModelSelections.get(sessionId)?.get(agentName)
    if (agentOverride) {
      currentProviderId = agentOverride.providerId
      currentModelId = agentOverride.modelId
    } else {
      currentProviderId = agentDefault.providerID
      currentModelId = agentDefault.modelID
    }
  }

  test('manual override survives delegated subtask completion', () => {
    createSessionWithAgentDefault()
    setManualModelOverride()
    completeDelegatedSubtask()

    expect(selectionSource).toBe('manual')
    expect(currentProviderId).toBe(manualOverride.providerID)
    expect(currentModelId).toBe(manualOverride.modelID)
    expect(sessionModelSelections.get(sessionId)).toEqual({
      providerId: manualOverride.providerID,
      modelId: manualOverride.modelID,
    })
  })

  test('agent default is used when no manual override was set', () => {
    createSessionWithAgentDefault()
    // No setManualModelOverride — stay on agent default through subtask completion.
    const messages: Message[] = [
      {
        id: 'u-real',
        sessionID: sessionId,
        role: 'user',
        time: { created: 1 },
        agent: agentName,
        model: agentDefault,
      } as Message,
      {
        id: 'u-nudge',
        sessionID: sessionId,
        role: 'user',
        time: { created: 2 },
        agent: agentName,
        model: agentDefault,
      } as Message,
    ]
    const partsById: Record<string, Part[]> = {
      'u-real': [{
        id: 'p-real',
        sessionID: sessionId,
        messageID: 'u-real',
        type: 'text',
        text: 'Delegate a subtask',
      } as Part],
      'u-nudge': [{
        id: 'p-nudge',
        sessionID: sessionId,
        messageID: 'u-nudge',
        type: 'text',
        text: 'Subagent finished.',
        synthetic: true,
      } as Part],
    }

    const latestChoice = findLatestUserModelChoice(messages, (id) => partsById[id])
    expect(latestChoice?.modelID).toBe(agentDefault.modelID)
    expect(shouldPreserveManualModelOverride({
      selectionSource: 'auto',
      savedSessionModel: sessionModelSelections.get(sessionId),
      candidate: latestChoice,
    })).toBe(false)
    expect(currentModelId).toBe(agentDefault.modelID)
  })
})
