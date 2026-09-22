import { describe, expect, test } from 'bun:test'
import type { Message, Part } from '@opencode-ai/sdk/v2'

import {
  extractUserModelChoice,
  findLatestUserModelChoice,
  shouldPreserveManualModelOverride,
  rememberLoadedUserChoiceRestore,
  type LoadedUserChoiceRestore,
} from './userModelChoice'

const userMessage = (
  id: string,
  model: { providerID: string; modelID: string },
  agent = 'custom-agent',
  created = 1,
): Message => ({
  id,
  sessionID: 'ses_1',
  role: 'user',
  time: { created },
  agent,
  model,
} as Message)

const assistantMessage = (id: string): Message => ({
  id,
  sessionID: 'ses_1',
  role: 'assistant',
  time: { created: 2 },
  parentID: 'u1',
  modelID: 'model-a',
  providerID: 'provider',
} as Message)

const textPart = (id: string, text: string, synthetic = false): Part => ({
  id,
  sessionID: 'ses_1',
  messageID: 'u1',
  type: 'text',
  text,
  ...(synthetic ? { synthetic: true } : {}),
} as Part)

describe('findLatestUserModelChoice', () => {
  test('returns the latest real user prompt model', () => {
    const messages = [
      userMessage('u1', { providerID: 'provider', modelID: 'model-a' }),
      assistantMessage('a1'),
      userMessage('u2', { providerID: 'provider', modelID: 'model-b' }),
    ]
    const partsById: Record<string, Part[]> = {
      u1: [textPart('p1', 'first')],
      u2: [textPart('p2', 'second')],
    }

    const choice = findLatestUserModelChoice(messages, (id) => partsById[id])
    expect(choice?.id).toBe('u2')
    expect(choice?.modelID).toBe('model-b')
    expect(choice?.providerID).toBe('provider')
    expect(choice?.agent).toBe('custom-agent')
  })

  test('[issue-2404] skips synthetic subagent-completion nudges so manual override is not clobbered', () => {
    // Real prompt sent with the manual override (model-b).
    const realPrompt = userMessage('u-real', { providerID: 'provider', modelID: 'model-b' })
    // After a delegated child session goes idle, OpenCode injects a synthetic
    // user nudge that often carries the agent default model (model-a).
    const syntheticNudge = userMessage('u-nudge', { providerID: 'provider', modelID: 'model-a' })
    const messages = [realPrompt, assistantMessage('a1'), syntheticNudge]
    const partsById: Record<string, Part[]> = {
      'u-real': [textPart('p-real', 'please investigate', false)],
      'u-nudge': [textPart('p-nudge', 'Subagent finished.', true)],
    }

    const choice = findLatestUserModelChoice(messages, (id) => partsById[id])
    expect(choice?.id).toBe('u-real')
    expect(choice?.modelID).toBe('model-b')
  })

  test('skips user messages whose parts have not loaded yet', () => {
    const messages = [
      userMessage('u1', { providerID: 'provider', modelID: 'model-a' }),
      userMessage('u2', { providerID: 'provider', modelID: 'model-b' }),
    ]
    const partsById: Record<string, Part[]> = {
      u1: [textPart('p1', 'first')],
      // u2 parts missing
    }

    const choice = findLatestUserModelChoice(messages, (id) => partsById[id])
    expect(choice?.id).toBe('u1')
    expect(choice?.modelID).toBe('model-a')
  })

  test('returns null when only synthetic user messages exist', () => {
    const messages = [userMessage('u-nudge', { providerID: 'provider', modelID: 'model-a' })]
    const partsById: Record<string, Part[]> = {
      'u-nudge': [textPart('p-nudge', 'Subagent finished.', true)],
    }

    expect(findLatestUserModelChoice(messages, (id) => partsById[id])).toBeNull()
  })
})

describe('shouldPreserveManualModelOverride', () => {
  for (const [name, previousID, previousTime, candidateID, candidateTime, preserve] of [
    ['newer with predecessor paged out', 'msg_fff', 10, 'msg_000', 20, false],
    ['older exposed by removal', 'msg_000', 20, 'msg_fff', 10, true],
    ['equal-time later prompt', 'msg_a', 10, 'msg_b', 10, false],
    ['equal-time older prompt', 'msg_b', 10, 'msg_a', 10, true],
    ['same-message timestamp update', 'msg_a', 10, 'msg_a', 20, true],
  ] satisfies Array<[string, string, number, string, number, boolean]>) {
    test(name, () => {
      expect(shouldPreserveManualModelOverride({
        selectionSource: 'manual',
        savedSessionModel: { providerId: 'provider', modelId: 'model-plan' },
        previousMessage: { id: previousID, time: { created: previousTime } },
        candidate: { id: candidateID, time: { created: candidateTime }, providerID: 'provider', modelID: 'model-build' },
      })).toBe(preserve)
    })
  }

  test('preserves manual override when a late update to the same message differs', () => {
    expect(shouldPreserveManualModelOverride({
      selectionSource: 'manual',
      savedSessionModel: { providerId: 'provider', modelId: 'model-b' },
      previousMessage: { id: 'u1', time: { created: 1 } },
      candidate: { id: 'u1', time: { created: 1 }, providerID: 'provider', modelID: 'model-a' },
    })).toBe(true)
  })

  test('[issue-3236] lets a new real user prompt replace the manual agent model', () => {
    const messages = [
      userMessage('u-plan', { providerID: 'provider', modelID: 'model-plan' }, 'plan'),
      userMessage('u-build', { providerID: 'provider', modelID: 'model-build' }, 'build', 2),
    ]
    const partsById = new Map([
      ['u-plan', [textPart('p-plan', 'Create a plan')]],
      ['u-build', [textPart('p-build', 'Execute the approved plan')]],
    ])

    const latestChoice = findLatestUserModelChoice(messages, (id) => partsById.get(id))

    expect(latestChoice?.id).toBe('u-build')
    expect(latestChoice?.agent).toBe('build')
    expect(shouldPreserveManualModelOverride({
      selectionSource: 'manual',
      savedSessionModel: { providerId: 'provider', modelId: 'model-plan' },
      previousMessage: { id: 'u-plan', time: { created: 1 } },
      candidate: latestChoice,
    })).toBe(false)
  })

  test('preserves manual override when removal exposes an older real user message', () => {
    const planPrompt = userMessage('u-plan', { providerID: 'provider', modelID: 'model-plan' }, 'plan')
    const buildPrompt = userMessage('u-build', { providerID: 'provider', modelID: 'model-build' }, 'build', 2)
    const partsById = new Map([
      ['u-plan', [textPart('p-plan', 'Create a plan')]],
      ['u-build', [textPart('p-build', 'Execute the approved plan')]],
    ])
    const latestAfterRemoval = findLatestUserModelChoice([planPrompt], (id) => partsById.get(id))

    expect(latestAfterRemoval?.id).toBe('u-plan')
    expect(shouldPreserveManualModelOverride({
      selectionSource: 'manual',
      savedSessionModel: { providerId: 'provider', modelId: 'model-build' },
      previousMessage: buildPrompt,
      candidate: latestAfterRemoval,
    })).toBe(true)
  })

  test('preserves manual override when no previous message has been observed', () => {
    expect(shouldPreserveManualModelOverride({
      selectionSource: 'manual',
      savedSessionModel: { providerId: 'provider', modelId: 'model-b' },
      previousMessage: undefined,
      candidate: { id: 'u1', time: { created: 1 }, providerID: 'provider', modelID: 'model-a' },
    })).toBe(true)
  })

  test('does not preserve when selection matches the candidate', () => {
    expect(shouldPreserveManualModelOverride({
      selectionSource: 'manual',
      savedSessionModel: { providerId: 'provider', modelId: 'model-b' },
      previousMessage: { id: 'u1', time: { created: 1 } },
      candidate: { id: 'u1', time: { created: 1 }, providerID: 'provider', modelID: 'model-b' },
    })).toBe(false)
  })

  test('does not preserve auto selections', () => {
    expect(shouldPreserveManualModelOverride({
      selectionSource: 'auto',
      savedSessionModel: { providerId: 'provider', modelId: 'model-b' },
      previousMessage: { id: 'u1', time: { created: 1 } },
      candidate: { id: 'u1', time: { created: 1 }, providerID: 'provider', modelID: 'model-a' },
    })).toBe(false)
  })

  test('preserves manual override when candidate has no model', () => {
    expect(shouldPreserveManualModelOverride({
      selectionSource: 'manual',
      savedSessionModel: { providerId: 'provider', modelId: 'model-b' },
      previousMessage: { id: 'u1', time: { created: 1 } },
      candidate: { id: 'u1', time: { created: 1 }, providerID: undefined, modelID: undefined },
    })).toBe(true)
  })
})

describe('rememberLoadedUserChoiceRestore', () => {
  test('removal records the processed key without moving chronology backward', () => {
    const restores = new Map<string, LoadedUserChoiceRestore>()
    const latest = { id: 'msg_000', time: { created: 20 } }
    rememberLoadedUserChoiceRestore(restores, 'session', { message: latest, restoreKey: 'new' })
    rememberLoadedUserChoiceRestore(restores, 'session', {
      message: { id: 'msg_fff', time: { created: 10 } }, restoreKey: 'old',
    })
    expect(restores.get('session')).toEqual({ message: latest, restoreKey: 'old' })
  })

  test('retains 150 recently written scopes and isolates runtime/directory identities', () => {
    const restores = new Map<string, LoadedUserChoiceRestore>()
    const restore = { message: { id: 'msg', time: { created: 1 } }, restoreKey: 'initial' }
    for (let index = 0; index < 150; index += 1) {
      rememberLoadedUserChoiceRestore(restores, JSON.stringify(['runtime-a', `/dir-${index}`, 'session']), restore)
    }
    const first = JSON.stringify(['runtime-a', '/dir-0', 'session'])
    rememberLoadedUserChoiceRestore(restores, first, { ...restore, restoreKey: 'touched' })
    const otherRuntime = JSON.stringify(['runtime-b', '/dir-0', 'session'])
    rememberLoadedUserChoiceRestore(restores, otherRuntime, restore)
    expect(restores.size).toBe(150)
    expect(restores.get(first)?.restoreKey).toBe('touched')
    expect(restores.get(otherRuntime)?.restoreKey).toBe('initial')
    expect(restores.has(JSON.stringify(['runtime-a', '/dir-1', 'session']))).toBe(false)
  })
})

describe('extractUserModelChoice', () => {
  test('reads variant from model.variant', () => {
    const message = {
      ...userMessage('u1', { providerID: 'provider', modelID: 'model-b' }),
      model: { providerID: 'provider', modelID: 'model-b', variant: 'high' },
    } as Message
    expect(extractUserModelChoice(message as never)?.variant).toBe('high')
  })
})
