import { describe, expect, it, vi } from 'vitest';
import { getDefaultModelInfo, getTrustRefusal, listModelInfos, listProviderInfos, resetOpenCodeRuntimeProviders } from './client.js';

describe('default model boundary', () => {
  const read = (payload) => getDefaultModelInfo({ model: { default: async () => payload } });

  it('accepts an enveloped model after checking only its id', async () => {
    const model = { id: 'model', providerID: 17, settings: 'unchecked' };
    expect(await read({ data: model })).toBe(model);
  });

  it('retains the direct-response fallback', async () => {
    const model = { id: 'model', providerID: 'provider' };
    expect(await read(model)).toBe(model);
  });

  it('retains an envelope with an id when its data is null', async () => {
    const payload = { data: null, id: 'model' };
    expect(await read(payload)).toBe(payload);
  });

  it.each([null, undefined, {}, { id: 17 }, { data: { id: 17 } }])('rejects a default without a string id: %j', async (payload) => {
    expect(await read(payload)).toBeNull();
  });
});

describe('trust refusal boundary', () => {
  it('checks only the refusal code and keeps unchecked fields', () => {
    const refusal = { code: 'opencode_trust_required', message: 17, directory: null };
    expect(getTrustRefusal(refusal)).toBe(refusal);
    expect(getTrustRefusal({ cause: refusal })).toBe(refusal);
  });

  it('retains inherited refusal codes', () => {
    const refusal = Object.create({ code: 'opencode_trust_required' });
    expect(getTrustRefusal(refusal)).toBe(refusal);
  });

  it.each([null, undefined, 17, 'failed', { code: 'constructor' }])('ignores unrelated failures: %j', (error) => {
    expect(getTrustRefusal(error)).toBeNull();
  });
});

describe('small-model catalog readiness', () => {
  it('does not publish or cache a partial catalog before native plugins activate', async () => {
    vi.useFakeTimers();
    try {
      let active = false;
      const client = {
        plugin: { list: async () => ({ data: active ? [{}] : [] }) },
        debug: { location: { list: async () => [{ directory: '/native' }] } },
        model: { list: async () => ({ data: [{ id: active ? 'ready' : 'early' }] }) },
        provider: { list: async () => ({ data: [{ id: active ? 'ready' : 'early' }] }) },
      };
      const read = Promise.all([listModelInfos(client, '/native'), listProviderInfos(client)]);
      await vi.advanceTimersByTimeAsync(5_100);
      expect(await read).toEqual([[], []]);

      active = true;
      expect(await listModelInfos(client, '/native')).toEqual([{ id: 'ready' }]);
      expect(await listProviderInfos(client)).toEqual([{ id: 'ready' }]);
    } finally {
      resetOpenCodeRuntimeProviders();
      vi.useRealTimers();
    }
  });
});
