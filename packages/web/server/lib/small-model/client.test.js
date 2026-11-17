import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CATALOG_READ_TIMEOUT_MS,
  getConfiguredSmallModelRef,
  getDefaultModelInfo,
  listModelInfos,
  listProviderInfos,
  resetOpenCodeRuntimeProviders,
} from './client.js';

// A transport that never answers: the promise settles only when the
// caller's signal aborts it, which is how the SDK's fetch behaves against
// a stalled OpenCode. Without a deadline signal from the caller this
// promise never settles and the test times out instead of passing.
const stallMethod = (calls, name) => (_input, options) => {
  calls.push({ name, options });
  return new Promise((_resolve, reject) => {
    options?.signal?.addEventListener('abort', () => reject(options.signal.reason), { once: true });
  });
};

const stallClient = (calls) => ({
  model: { list: stallMethod(calls, 'model.list'), default: stallMethod(calls, 'model.default') },
  provider: { list: stallMethod(calls, 'provider.list') },
  agent: { get: stallMethod(calls, 'agent.get') },
});

const shrinkDeadline = () => {
  const nativeTimeout = AbortSignal.timeout;
  const requested = [];
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
    requested.push(milliseconds);
    // Fire in 25 ms so the test proves the deadline path without waiting
    // out the production value; the collected argument keeps it asserted.
    return nativeTimeout(25);
  });
  return requested;
};

beforeEach(() => {
  resetOpenCodeRuntimeProviders();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('small-model catalog read deadlines', () => {
  it('bounds a stalled model.list and falls back to an empty catalog', async () => {
    const requested = shrinkDeadline();
    const calls = [];
    const started = Date.now();

    await expect(listModelInfos(stallClient(calls), '/stall-dir')).resolves.toEqual([]);

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(requested).toEqual([CATALOG_READ_TIMEOUT_MS]);
    expect(calls).toHaveLength(1);
    expect(calls[0].options?.signal).toBeInstanceOf(AbortSignal);
  });

  it('bounds a stalled provider.list and falls back to an empty catalog', async () => {
    const requested = shrinkDeadline();
    const calls = [];

    await expect(listProviderInfos(stallClient(calls))).resolves.toEqual([]);

    expect(requested).toEqual([CATALOG_READ_TIMEOUT_MS]);
    expect(calls[0].options?.signal).toBeInstanceOf(AbortSignal);
  });

  it('bounds a stalled model.default and falls back to null', async () => {
    const requested = shrinkDeadline();
    const calls = [];

    await expect(getDefaultModelInfo(stallClient(calls))).resolves.toBeNull();

    expect(requested).toEqual([CATALOG_READ_TIMEOUT_MS]);
    expect(calls[0].options?.signal).toBeInstanceOf(AbortSignal);
  });

  it('bounds a stalled agent.get and falls back to null', async () => {
    const requested = shrinkDeadline();
    const calls = [];

    await expect(getConfiguredSmallModelRef(stallClient(calls))).resolves.toBeNull();

    expect(requested).toEqual([CATALOG_READ_TIMEOUT_MS]);
    expect(calls).toHaveLength(1);
    expect(calls[0].options?.signal).toBeInstanceOf(AbortSignal);
  });

  it('still returns answers from a healthy client, with the deadline attached', async () => {
    const client = {
      model: {
        list: async () => ({ data: [{ id: 'm1', providerID: 'p1' }] }),
        default: async () => ({ data: { id: 'm1' } }),
      },
      provider: { list: async () => ({ data: [{ id: 'p1' }] }) },
      agent: { get: async () => ({ data: { model: { providerID: 'p1', id: 'm1' } } }) },
    };

    await expect(listModelInfos(client, '/healthy-dir')).resolves.toEqual([{ id: 'm1', providerID: 'p1' }]);
    await expect(listProviderInfos(client)).resolves.toEqual([{ id: 'p1' }]);
    await expect(getDefaultModelInfo(client)).resolves.toEqual({ id: 'm1' });
    await expect(getConfiguredSmallModelRef(client)).resolves.toEqual({ providerID: 'p1', modelID: 'm1' });
  });
});
