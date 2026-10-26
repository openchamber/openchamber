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
});
