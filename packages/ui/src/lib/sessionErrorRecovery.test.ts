import { describe, expect, test } from 'bun:test';
import type { Message, ModelSelection } from '@/lib/opencode/model';
import { getModelPoolTargets, modelForRecoveryAnchor, nextModelPoolTarget, recoveryUserMessage } from './sessionErrorRecovery';

const target = (providerID: string, id: string, variant?: string): ModelSelection => {
  const selection: ModelSelection = { providerID, id };
  if (variant) selection.variant = variant;
  return selection;
};

const messages: Message[] = [
  { id: 'user-1', sessionID: 's', role: 'user', time: { created: 1 } },
  { id: 'assistant-1', sessionID: 's', role: 'assistant', time: { created: 2 }, agent: 'build', providerID: 'provider-a', modelID: 'model-a' },
  { id: 'user-2', sessionID: 's', role: 'user', time: { created: 3 } },
  { id: 'assistant-2', sessionID: 's', role: 'assistant', time: { created: 4 }, agent: 'build', providerID: 'provider-b', modelID: 'model-b', finish: 'error' },
];

describe('session error recovery helpers', () => {
  test('reads concrete and nested targets from the selected pool model settings', () => {
    const providers = [{
      id: 'opencode-route',
      models: [{
        id: 'fast',
        settings: {
          opencodeRoute: {
            targets: [
              { providerID: 'provider-a', id: 'model-a' },
              { providerID: 'opencode-route', id: 'nested', variant: 'high' },
              { providerID: 4, id: 'invalid' },
            ],
          },
        },
      }],
    }];

    expect(getModelPoolTargets(providers, 'opencode-route', 'fast')).toEqual([
      target('provider-a', 'model-a'),
      target('opencode-route', 'nested', 'high'),
    ]);
    expect(getModelPoolTargets(providers, 'provider-a', 'model-a')).toEqual([]);
  });

  test('advances after the failed pool target and starts at the first fallback when unknown', () => {
    const targets = [target('a', 'one'), target('b', 'two'), target('c', 'three')];
    expect(nextModelPoolTarget(targets, { providerID: 'b', id: 'two' })).toEqual(targets[2]);
    expect(nextModelPoolTarget(targets, { providerID: 'c', id: 'three' })).toEqual(targets[0]);
    expect(nextModelPoolTarget(targets)).toEqual(targets[1]);
    expect(nextModelPoolTarget([targets[0]])).toBeNull();
  });

  test('finds the prompt associated with an assistant error or the latest prompt', () => {
    expect(recoveryUserMessage(messages, 'assistant-2')?.id).toBe('user-2');
    expect(recoveryUserMessage(messages)?.id).toBe('user-2');
    expect(recoveryUserMessage(messages, 'missing')).toBeNull();
  });

  test('uses the failed assistant model, otherwise the previous reply model', () => {
    expect(modelForRecoveryAnchor(messages, 'assistant-2', 'user-2')).toEqual({ providerID: 'provider-b', id: 'model-b' });
    expect(modelForRecoveryAnchor(messages, undefined, 'user-2')).toEqual({ providerID: 'provider-a', id: 'model-a' });
  });
});
