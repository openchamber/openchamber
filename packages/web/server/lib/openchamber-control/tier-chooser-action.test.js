import { describe, expect, it, vi } from 'vitest';

import { assembleTierOptions, createTierChooserAction } from './tier-chooser-action.js';

const catalog = [
  { id: 'claude-haiku-4-5', providerID: 'anthropic', name: 'Claude Haiku 4.5', cost: { input: 1, output: 5 } },
  { id: 'claude-sonnet-4-5', providerID: 'anthropic', name: 'Claude Sonnet 4.5', cost: { input: 3, output: 15 } },
  { id: 'gpt-5-codex', providerID: 'openai', name: 'GPT-5 Codex', cost: { input: 1.25, output: 10 } },
];

describe('assembleTierOptions', () => {
  it('fills pricing and labels from the catalog, keyed by provider/model', () => {
    const tiers = assembleTierOptions({
      tiers: [
        { tier: 'cheap', model: 'anthropic/claude-haiku-4-5' },
        { tier: 'frontier', model: 'gpt-5-codex' },
      ],
      catalog,
    });
    expect(tiers).toEqual([
      expect.objectContaining({
        tier: 'cheap',
        model: 'anthropic/claude-haiku-4-5',
        label: 'Claude Haiku 4.5',
        inputPerM: 1,
        outputPerM: 5,
      }),
      expect.objectContaining({ tier: 'frontier', model: 'openai/gpt-5-codex', inputPerM: 1.25, outputPerM: 10 }),
    ]);
  });

  it('rejects a bare model id more than one provider offers', () => {
    const shared = [
      ...catalog,
      { id: 'gpt-5-codex', providerID: 'azure', name: 'GPT-5 Codex (Azure)', cost: { input: 2, output: 12 } },
    ];
    expect(() => assembleTierOptions({ tiers: [{ tier: 'frontier', model: 'gpt-5-codex' }], catalog: shared })).toThrow(/more than one provider/);
    const [option] = assembleTierOptions({ tiers: [{ tier: 'frontier', model: 'azure/gpt-5-codex' }], catalog: shared });
    expect(option.inputPerM).toBe(2);
  });

  it('rejects an empty tier list and a model the catalog does not know', () => {
    expect(() => assembleTierOptions({ tiers: [], catalog })).toThrow(/non-empty list/);
    expect(() => assembleTierOptions({ tiers: [{ tier: 'cheap', model: 'nope' }], catalog })).toThrow(/not in the catalog/);
    expect(() => assembleTierOptions({ tiers: [{ model: 'gpt-5-codex' }], catalog })).toThrow(/every tier needs/);
  });
});

describe('createTierChooserAction', () => {
  it('builds the standardized card for render.page and names the follow-up call', async () => {
    const action = createTierChooserAction({ listModels: async () => catalog });
    const result = await action(
      { tiers: [{ tier: 'standard', model: 'claude-sonnet-4-5' }] },
      { sessionId: 's1', callId: 'c1' },
    );
    expect(result.title).toBe('Select Execution Tier');
    expect(result.html).toContain('Select Execution Tier');
    expect(result.html).toContain('anthropic/claude-sonnet-4-5');
    expect(result.tiers).toEqual([
      expect.objectContaining({ tier: 'standard', model: 'anthropic/claude-sonnet-4-5', inputPerM: 3, outputPerM: 15 }),
    ]);
    expect(result.note).toContain('render.page');
    expect(result.note).toContain('awaitAnswer');
  });

  it('honors a caller-provided title', async () => {
    const action = createTierChooserAction({ listModels: async () => catalog });
    const result = await action({ title: 'Pick a lane', tiers: [{ tier: 'cheap', model: 'claude-haiku-4-5' }] }, {});
    expect(result.title).toBe('Pick a lane');
    expect(result.html).toContain('Pick a lane');
  });
});
