import { describe, expect, test } from 'bun:test';
import type { Message, ModelSelection } from '@/lib/opencode/model';
import { failedModelsForPrompt, getModelPoolTargets, modelForRecoveryAnchor, nextModelPoolTarget, recoveryUserMessage } from './sessionErrorRecovery';

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

  // Oracle: the pool's configured order; a used-up pool has no next target.
  test('advances after failed targets and reports a used-up pool instead of wrapping', () => {
    const targets = [target('a', 'one'), target('b', 'two'), target('c', 'three')];
    expect(nextModelPoolTarget(targets, [{ providerID: 'b', id: 'two' }])).toEqual(targets[2]);
    expect(nextModelPoolTarget(targets, [{ providerID: 'c', id: 'three' }])).toBeNull();
    expect(nextModelPoolTarget(targets, [{ providerID: 'a', id: 'one' }, { providerID: 'b', id: 'two' }])).toEqual(targets[2]);
    expect(nextModelPoolTarget(targets)).toEqual(targets[1]);
    expect(nextModelPoolTarget([targets[0]])).toBeNull();
  });

  test('never offers a target that already failed, for every failure set', () => {
    const targets = [target('a', '1'), target('b', '2'), target('c', '3'), target('d', '4')];
    for (let mask = 1; mask < 16; mask++) {
      const failed = targets.filter((_, index) => mask & (1 << index));
      const next = nextModelPoolTarget(targets, failed);
      const last = Math.max(...failed.map((entry) => targets.indexOf(entry)));
      expect(next === null ? null : targets.indexOf(next)).toBe(last === targets.length - 1 ? null : last + 1);
    }
  });

  test('collects the models that failed the prompt, stopping at the next prompt', () => {
    const history: Message[] = [
      { id: 'u', sessionID: 's', role: 'user', time: { created: 1 } },
      { id: 'a1', sessionID: 's', role: 'assistant', time: { created: 2 }, agent: 'build', providerID: 'p', modelID: 'one', finish: 'error' },
      { id: 'a2', sessionID: 's', role: 'assistant', time: { created: 3 }, agent: 'build', providerID: 'p', modelID: 'two', finish: 'error' },
      { id: 'u2', sessionID: 's', role: 'user', time: { created: 4 } },
      { id: 'a3', sessionID: 's', role: 'assistant', time: { created: 5 }, agent: 'build', providerID: 'p', modelID: 'three', finish: 'error' },
    ];
    expect(failedModelsForPrompt(history, 'u')).toEqual([{ providerID: 'p', id: 'one' }, { providerID: 'p', id: 'two' }]);
    expect(failedModelsForPrompt(history, 'missing')).toEqual([]);
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
