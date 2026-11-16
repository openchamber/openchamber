import { describe, expect, it } from 'vitest';

import { assembleFallbackActions, createQuotaFallbackAction } from './quota-fallback-action.js';

const catalog = [
  { id: 'claude-haiku-4-5', providerID: 'anthropic', name: 'Claude Haiku 4.5', cost: { input: 1, output: 5 } },
  { id: 'claude-sonnet-4-5', providerID: 'anthropic', name: 'Claude Sonnet 4.5', cost: { input: 3, output: 15 } },
  { id: 'gpt-5-codex', providerID: 'openai', name: 'GPT-5 Codex', cost: { input: 1.25, output: 10 } },
];

const tiers = [
  { tier: 'cheap', model: 'anthropic/claude-haiku-4-5' },
  { tier: 'standard', model: 'anthropic/claude-sonnet-4-5' },
  { tier: 'frontier', model: 'openai/gpt-5-codex' },
];

describe('assembleFallbackActions', () => {
  it('derives one action per kind from the catalog and the candidates', () => {
    const { current, actions } = assembleFallbackActions({ tiers, catalog, currentTier: 'standard', resetAt: '18:00 UTC' });
    expect(current).toEqual({ provider: 'anthropic', tier: 'standard' });
    expect(actions).toEqual([
      expect.objectContaining({ kind: 'switch-provider', provider: 'openai', tier: 'standard' }),
      expect.objectContaining({ kind: 'downgrade-tier', provider: 'openai', tier: 'frontier' }),
      expect.objectContaining({ kind: 'wait-for-reset', provider: 'anthropic', tier: 'standard', detail: 'Quota resets at 18:00 UTC' }),
    ]);
  });

  it('picks the nearest cheaper tier as the downgrade, not the cheapest', () => {
    const wider = [
      ...catalog,
      { id: 'claude-opus-4-5', providerID: 'anthropic', name: 'Claude Opus 4.5', cost: { input: 5, output: 25 } },
    ];
    const candidates = [...tiers, { tier: 'max', model: 'anthropic/claude-opus-4-5' }];
    const { actions } = assembleFallbackActions({ tiers: candidates, catalog: wider, currentTier: 'max' });
    expect(actions.find((action) => action.kind === 'downgrade-tier')).toEqual(
      expect.objectContaining({ tier: 'standard', provider: 'anthropic' }),
    );
  });

  it('names each unassemblable fallback instead of emitting a dead tile', () => {
    expect(() => assembleFallbackActions({ tiers, catalog, currentTier: 'nope' })).toThrow(/not one of the tier candidates/);
    expect(() => assembleFallbackActions({ tiers, catalog, currentTier: 'standard', currentProvider: 'openai' })).toThrow(/does not match/);
    const singleProvider = catalog.filter((model) => model.providerID === 'anthropic');
    expect(() => assembleFallbackActions({ tiers: tiers.slice(0, 2), catalog: singleProvider, currentTier: 'standard' })).toThrow(/no other provider/);
    expect(() => assembleFallbackActions({ tiers, catalog, currentTier: 'cheap' })).toThrow(/no cheaper tier/);
  });
});

describe('createQuotaFallbackAction', () => {
  it('builds the quota card for render.page and names the follow-up call', async () => {
    const action = createQuotaFallbackAction({ listModels: async () => catalog });
    const result = await action(
      { tiers, currentTier: 'standard', message: 'Anthropic quota exhausted for this window' },
      { sessionId: 's1', callId: 'c1' },
    );
    expect(result.title).toBe('Quota Limit Reached');
    expect(result.html).toContain('Quota Limit Reached');
    expect(result.html).toContain('Anthropic quota exhausted for this window');
    expect(result.html).toContain('switch-provider');
    expect(result.html).toContain('&quot;action&quot;:&quot;fallback&quot;');
    expect(result.actions).toHaveLength(3);
    expect(result.note).toContain('render.page');
    expect(result.note).toContain('awaitAnswer');
  });
});
