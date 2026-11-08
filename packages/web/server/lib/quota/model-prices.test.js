import { afterEach, describe, expect, it, vi } from 'vitest';

import { refreshProviderPrices, registerModelPriceSink, resetModelPriceCache } from './model-prices.js';

const MODEL_ID = 'deepseek-ai/DeepSeek-V4.1-Flash-1017';
const COSTS = { [MODEL_ID]: { input: 0.098, output: 0.294, cache_read: 0.00294 } };

// One refresher call answers to a source keyed by the quota provider id, so a
// test never reaches DeepInfra. `now` is passed in for the TTL cases.
const harness = ({ providerId = 'deepinfra', modelIds = [MODEL_ID], fetchPrices, now = 1_000, ttlMs = 60_000 } = {}) => {
  const source = fetchPrices ?? vi.fn().mockResolvedValue(COSTS);
  const notify = vi.fn().mockResolvedValue(true);
  const run = (overrides = {}) => refreshProviderPrices(providerId, {
    now,
    ttlMs,
    readModelIds: () => modelIds,
    sources: new Map([[providerId, source]]),
    notify,
    ...overrides,
  });
  return { source, notify, run };
};

afterEach(() => {
  registerModelPriceSink(null);
  resetModelPriceCache();
  vi.restoreAllMocks();
});

describe('provider model prices', () => {
  it('hands the reported prices to the config layer', async () => {
    const { source, notify, run } = harness();

    await expect(run()).resolves.toEqual({ updated: true, reason: 'applied' });

    expect(source).toHaveBeenCalledWith({ modelIds: [MODEL_ID] });
    expect(notify).toHaveBeenCalledWith('deepinfra', COSTS);
  });

  it('asks nothing while no model of that provider is configured', async () => {
    const { source, notify, run } = harness({ modelIds: [] });

    await expect(run()).resolves.toEqual({ updated: false, reason: 'no-configured-models' });

    expect(source).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('ignores a provider without a price source', async () => {
    const { source, run } = harness({ providerId: 'codex' });

    await expect(run({ sources: new Map() })).resolves.toEqual({ updated: false, reason: 'no-price-source' });

    expect(source).not.toHaveBeenCalled();
  });

  it('reads once per TTL and again after it', async () => {
    const { source, run } = harness({ ttlMs: 60_000 });

    await run({ now: 1_000 });
    await expect(run({ now: 30_000 })).resolves.toEqual({ updated: false, reason: 'fresh' });
    await run({ now: 90_000 });

    expect(source).toHaveBeenCalledTimes(2);
  });

  it('shares one request between reads that arrive together', async () => {
    const { source, run } = harness();

    const [first, second] = await Promise.all([run(), run()]);

    expect(source).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
  });

  it('drops the prices when nobody applies them', async () => {
    const source = vi.fn().mockResolvedValue(COSTS);
    const { run } = harness({ source });

    await expect(run({ notify: () => Promise.resolve(false) })).resolves.toEqual({ updated: false, reason: 'not-applied' });
  });

  it('keeps a failed read out of the quota answer', async () => {
    const error = new Error('DeepInfra model list: 503');
    const { run } = harness({ fetchPrices: vi.fn().mockRejectedValue(error) });

    await expect(run()).resolves.toEqual({ updated: false, reason: 'failed', error });
  });

  it('does nothing when the provider reports no prices', async () => {
    const { notify, run } = harness({ fetchPrices: vi.fn().mockResolvedValue({}) });

    await expect(run()).resolves.toEqual({ updated: false, reason: 'no-prices' });

    expect(notify).not.toHaveBeenCalled();
  });

  it('sends the prices to the registered sink', async () => {
    const sink = vi.fn().mockResolvedValue(true);
    registerModelPriceSink(sink);

    await expect(refreshProviderPrices('deepinfra', {
      readModelIds: () => [MODEL_ID],
      sources: new Map([['deepinfra', vi.fn().mockResolvedValue(COSTS)]]),
    })).resolves.toEqual({ updated: true, reason: 'applied' });

    expect(sink).toHaveBeenCalledWith('deepinfra', COSTS);
  });
});
