import { describe, expect, test } from 'bun:test'
import type { Message, Part } from '@/lib/opencode/model'

import {
  extractAssistantModelChoice,
  findLatestUserModelChoice,
  shouldPreserveManualModelOverride,
} from './userModelChoice'

const userMessage = (id: string): Message => ({
  id,
  sessionID: 'ses_1',
  role: 'user',
  time: { created: 1 },
})

const assistantMessage = (id: string, modelID: string, options: { agent?: string; variant?: string } = {}): Message => ({
  id,
  sessionID: 'ses_1',
  role: 'assistant',
  time: { created: 2, completed: 3 },
  agent: options.agent ?? 'custom-agent',
  providerID: 'provider',
  modelID,
  ...(options.variant ? { variant: options.variant } : {}),
})

const textPart = (id: string, messageID: string, text: string): Part => ({
  id,
  sessionID: 'ses_1',
  messageID,
  type: 'text',
  text,
})

describe('findLatestUserModelChoice', () => {
  test('returns the model the latest answered turn ran on', () => {
    const messages = [
      userMessage('u1'),
      assistantMessage('a1', 'model-a'),
      userMessage('u2'),
      assistantMessage('a2', 'model-b'),
    ]
    const partsById: Record<string, Part[]> = {
      a1: [textPart('p1', 'a1', 'first')],
      a2: [textPart('p2', 'a2', 'second')],
    }

    const choice = findLatestUserModelChoice(messages, (id) => partsById[id])
    expect(choice?.id).toBe('a2')
    expect(choice?.modelID).toBe('model-b')
    expect(choice?.providerID).toBe('provider')
    expect(choice?.agent).toBe('custom-agent')
  })

  test('skips messages whose parts have not loaded yet', () => {
    const messages = [assistantMessage('a1', 'model-a'), assistantMessage('a2', 'model-b')]
    const partsById: Record<string, Part[]> = {
      a1: [textPart('p1', 'a1', 'first')],
      // a2 parts missing
    }

    const choice = findLatestUserModelChoice(messages, (id) => partsById[id])
    expect(choice?.id).toBe('a1')
    expect(choice?.modelID).toBe('model-a')
  })

  test('returns null when the session has no answered turn', () => {
    expect(findLatestUserModelChoice([userMessage('u1')], () => undefined)).toBeNull()
  })
})

describe('shouldPreserveManualModelOverride', () => {
  test('preserves manual override when it differs from the candidate message model', () => {
    expect(shouldPreserveManualModelOverride({
      selectionSource: 'manual',
      savedSessionModel: { providerId: 'provider', modelId: 'model-b' },
      candidate: { providerID: 'provider', modelID: 'model-a' },
    })).toBe(true)
  })

  test('does not preserve when selection matches the candidate', () => {
    expect(shouldPreserveManualModelOverride({
      selectionSource: 'manual',
      savedSessionModel: { providerId: 'provider', modelId: 'model-b' },
      candidate: { providerID: 'provider', modelID: 'model-b' },
    })).toBe(false)
  })

  test('does not preserve auto selections', () => {
    expect(shouldPreserveManualModelOverride({
      selectionSource: 'auto',
      savedSessionModel: { providerId: 'provider', modelId: 'model-b' },
      candidate: { providerID: 'provider', modelID: 'model-a' },
    })).toBe(false)
  })

  test('preserves manual override when candidate has no model', () => {
    expect(shouldPreserveManualModelOverride({
      selectionSource: 'manual',
      savedSessionModel: { providerId: 'provider', modelId: 'model-b' },
      candidate: { providerID: undefined, modelID: undefined },
    })).toBe(true)
  })
})

describe('extractAssistantModelChoice', () => {
  test('reads the variant off the assistant message', () => {
    expect(extractAssistantModelChoice(assistantMessage('a1', 'model-b', { variant: 'high' }))?.variant).toBe('high')
  })

  test('ignores non-assistant messages', () => {
    expect(extractAssistantModelChoice(userMessage('u1'))).toBeNull()
  })
})
