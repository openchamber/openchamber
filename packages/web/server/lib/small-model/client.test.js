import { describe, expect, it } from 'vitest';
import { getDefaultModelInfo, getTrustRefusal } from './client.js';

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
