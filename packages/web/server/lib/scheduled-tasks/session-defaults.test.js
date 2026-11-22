import { describe, expect, it } from 'vitest';

import { resolveSessionDefaults } from './session-defaults.js';

describe('resolveSessionDefaults', () => {
  it('prefers the project default, then the global one, keeping each variant with its model', () => {
    const settings = { defaultModel: 'anthropic/claude-sonnet-5', defaultVariant: 'high', defaultAgent: 'build' };
    expect(resolveSessionDefaults({ settings, project: { defaultModel: 'openai/gpt-6', defaultAgent: 'plan' } }))
      .toEqual({ providerID: 'openai', modelID: 'gpt-6', variant: null, agent: 'plan' });
    expect(resolveSessionDefaults({ settings, project: {} }))
      .toEqual({ providerID: 'anthropic', modelID: 'claude-sonnet-5', variant: 'high', agent: 'build' });
  });

  it('leaves everything to OpenCode when nothing is set', () => {
    expect(resolveSessionDefaults({ settings: {}, project: null }))
      .toEqual({ providerID: null, modelID: null, variant: null, agent: null });
    expect(resolveSessionDefaults({ settings: { defaultModel: 'no-slash' }, project: null }).modelID).toBeNull();
  });

  // Oracle: the precedence stated in Settings: the effort configured next to the
  // default model, then the model's own default effort, else none at all.
  it('falls back to the model default effort, below the effort configured next to the default model', () => {
    const modelDefaultVariants = { 'openai/gpt-6': 'low', 'anthropic/claude-sonnet-5': 'max' };
    expect(resolveSessionDefaults({ settings: { defaultModel: 'openai/gpt-6', modelDefaultVariants }, project: null }).variant).toBe('low');
    expect(resolveSessionDefaults({ settings: { defaultModel: 'openai/gpt-6', defaultVariant: 'high', modelDefaultVariants }, project: null }).variant).toBe('high');
    expect(resolveSessionDefaults({ settings: { defaultModel: 'openai/gpt-6' }, project: null }).variant).toBeNull();
    expect(resolveSessionDefaults({ settings: { defaultModel: 'google/gemini', modelDefaultVariants }, project: null }).variant).toBeNull();
    // An inherited name never counts as an entry.
    expect(resolveSessionDefaults({ settings: { defaultModel: 'openai/toString', modelDefaultVariants }, project: null }).variant).toBeNull();
  });
});
