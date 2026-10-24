import { describe, expect, test } from 'bun:test';

import { useUIStore } from '@/stores/useUIStore';
import { resolveEffortChoice, resolveEffortForModelSelection } from './modelEfforts';

describe('resolveEffortChoice', () => {
  const variants = ['low', 'high'];

  test('uses the first source the model offers', () => {
    expect(resolveEffortChoice(['low', 'high'], variants)).toBe('low');
    expect(resolveEffortChoice([undefined, 'high'], variants)).toBe('high');
  });

  test('ignores a level the model no longer offers instead of choosing Default', () => {
    expect(resolveEffortChoice(['removed', undefined], variants)).toBeUndefined();
    expect(resolveEffortChoice(['removed', null], variants)).toBeNull();
  });

  test('an explicit Default stops lower-priority sources', () => {
    expect(resolveEffortChoice(['high', null, 'low'], variants)).toBe('high');
    expect(resolveEffortChoice([undefined, null, 'low'], variants)).toBeNull();
  });

  test('nothing offered resolves to no choice', () => {
    expect(resolveEffortChoice([undefined, undefined], variants)).toBeUndefined();
    expect(resolveEffortChoice([], variants)).toBeUndefined();
  });
});

describe('resolveEffortForModelSelection', () => {
  test('an agent pin for the model wins over the remembered level', () => {
    expect(resolveEffortForModelSelection({
      providerID: 'openai',
      modelID: 'gpt-5.5',
      variants: ['low', 'high'],
      agents: [{ name: 'plan', model: { providerID: 'openai', id: 'gpt-5.5', variant: 'high' } }],
      agentName: 'plan',
      configuredVariant: 'low',
    })).toBe('high');
  });

  test('falls back through configuration and memory to Default', () => {
    const original = useUIStore.getState().lastUsedEfforts;
    try {
      const base = { providerID: 'openai', modelID: 'gpt-5.5', variants: ['low', 'high'] };
      expect(resolveEffortForModelSelection({ ...base, configuredVariant: 'low' })).toBe('low');
      useUIStore.setState({ lastUsedEfforts: { 'openai/gpt-5.5': 'high' } });
      expect(resolveEffortForModelSelection(base)).toBe('high');
      useUIStore.setState({ lastUsedEfforts: { 'openai/gpt-5.5': null } });
      expect(resolveEffortForModelSelection(base)).toBeNull();
    } finally {
      useUIStore.setState({ lastUsedEfforts: original });
    }
  });
});
