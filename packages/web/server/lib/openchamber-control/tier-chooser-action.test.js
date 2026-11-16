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

  it('rejects an empty tier list and a model the catalog does not know', () => {
    expect(() => assembleTierOptions({ tiers: [], catalog })).toThrow(/non-empty list/);
    expect(() => assembleTierOptions({ tiers: [{ tier: 'cheap', model: 'nope' }], catalog })).toThrow(/not in the catalog/);
    expect(() => assembleTierOptions({ tiers: [{ model: 'gpt-5-codex' }], catalog })).toThrow(/every tier needs/);
  });
});

describe('createTierChooserAction', () => {
  it('renders the standardized card through render.page and returns the submitted pick', async () => {
    const renderPage = vi.fn(async (input) => {
      expect(input.awaitAnswer).toBe(true);
      expect(input.html).toContain('Select Execution Tier');
      expect(input.html).toContain('anthropic/claude-sonnet-4-5');
      return {
        title: 'Select Execution Tier',
        answer: { answered: true, summary: 'Selected Standard Tier', data: { tier: 'standard', model: 'anthropic/claude-sonnet-4-5' } },
        note: 'answered',
      };
    });
    const action = createTierChooserAction({ listModels: async () => catalog, renderPage });
    const result = await action(
      { tiers: [{ tier: 'standard', model: 'claude-sonnet-4-5' }] },
      { sessionId: 's1', callId: 'c1' },
    );
    expect(result).toEqual({
      title: 'Select Execution Tier',
      tier: 'standard',
      model: 'anthropic/claude-sonnet-4-5',
      summary: 'Selected Standard Tier',
      note: 'answered',
    });
    expect(renderPage).toHaveBeenCalledTimes(1);
  });

  it('propagates the render error when the tool is off, changing nothing', async () => {
    const renderPage = vi.fn(async () => {
      throw new Error('The render tool is turned off in OpenChamber settings');
    });
    const action = createTierChooserAction({ listModels: async () => catalog, renderPage });
    await expect(action({ tiers: [{ tier: 'cheap', model: 'claude-haiku-4-5' }] }, {})).rejects.toThrow(/turned off/);
  });
});
