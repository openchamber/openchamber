import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchQuota as deepinfraFetch, isConfigured as deepinfraConfigured } from './deepinfra.js';
import { fetchQuota as deepseekFetch, isConfigured as deepseekConfigured } from './deepseek.js';
import { fetchQuota as neuralwattFetch, isConfigured as neuralwattConfigured } from './neuralwatt.js';
import { fetchQuota as nanogptFetch, isConfigured as nanogptConfigured } from './nanogpt.js';
import { fetchQuota as openrouterFetch, isConfigured as openrouterConfigured } from './openrouter.js';
import { fetchQuota as zaiFetch, isConfigured as zaiConfigured, useZaiGiftReset } from './zai.js';
import { fetchQuota as codexFetch, isConfigured as codexConfigured } from './codex.js';
import {
  fetchQuota as copilotFetch,
  isConfigured as copilotConfigured
} from './copilot.js';

// Regression suite for #1751 (sibling of #1747): every provider below used to
// pick its credential with `||` in isConfigured but `??` in fetchQuota, so an
// empty first field reported "configured" while the fetch never ran, and a
// whitespace first field was sent as a blank bearer instead of falling
// through to the valid second field. The oracle is agreement: isConfigured
// and the Authorization header a fetch actually sends must select the same
// credential through the shared asNonEmptyString helper.
const okResponse = () => ({ ok: true, status: 200, json: async () => ({}) });

const SPECS = [
  { name: 'deepinfra', alias: 'deepinfra', first: 'key', isConfigured: deepinfraConfigured, fetchQuota: deepinfraFetch, argName: 'readCredentials', headerFor: (v) => `Bearer ${v}` },
  { name: 'deepseek', alias: 'deepseek', first: 'key', isConfigured: deepseekConfigured, fetchQuota: deepseekFetch, headerFor: (v) => `Bearer ${v}` },
  { name: 'neuralwatt', alias: 'neuralwatt', first: 'key', isConfigured: neuralwattConfigured, fetchQuota: neuralwattFetch, headerFor: (v) => `Bearer ${v}` },
  { name: 'nanogpt', alias: 'nano-gpt', first: 'key', isConfigured: nanogptConfigured, fetchQuota: nanogptFetch, useFetchImpl: true, headerFor: (v) => `Bearer ${v}` },
  { name: 'openrouter', alias: 'openrouter', first: 'key', isConfigured: openrouterConfigured, fetchQuota: openrouterFetch, headerFor: (v) => `Bearer ${v}` },
  { name: 'zai', alias: 'zai', first: 'key', isConfigured: zaiConfigured, fetchQuota: zaiFetch, headerFor: (v) => `Bearer ${v}` },
  { name: 'codex', alias: 'codex', first: 'access', isConfigured: codexConfigured, fetchQuota: codexFetch, headerFor: (v) => `Bearer ${v}` },
  { name: 'copilot', alias: 'github-copilot', first: 'access', isConfigured: copilotConfigured, fetchQuota: copilotFetch, headerFor: (v) => `token ${v}` }
];

afterEach(() => {
  vi.unstubAllGlobals();
});

const authFor = (spec, firstValue, secondValue) => ({
  [spec.alias]: { [spec.first]: firstValue, token: secondValue }
});

const runFetch = (spec, auth, fetchMock) => {
  if (spec.useFetchImpl) {
    return spec.fetchQuota({ readAuth: async () => auth, fetchImpl: fetchMock });
  }
  const argName = spec.argName ?? 'readAuth';
  return spec.fetchQuota({ [argName]: async () => auth });
};

const sentAuthorization = (fetchMock) => fetchMock.mock.calls[0]?.[1]?.headers?.Authorization;

for (const spec of SPECS) {
  describe(`${spec.name} credential selection (#1751)`, () => {
    it.each([
      ['empty', ''],
      ['whitespace-only', '   ']
    ])('falls through from a %s first field to the valid token in both isConfigured and fetchQuota', async (_label, firstValue) => {
      const auth = authFor(spec, firstValue, 'valid-token');
      expect(spec.isConfigured(auth)).toBe(true);

      const fetchMock = vi.fn().mockResolvedValue(okResponse());
      vi.stubGlobal('fetch', fetchMock);
      const result = await runFetch(spec, auth, fetchMock);

      expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
      // zai fetchQuota also fetches its gift-reset list; every call must
      // carry the fallen-through token, never the blank first field.
      for (const call of fetchMock.mock.calls) {
        expect(call[1]?.headers?.Authorization).toBe(spec.headerFor('valid-token'));
      }
      expect(result.configured).toBe(true);
    });

    it('reports not configured in both when both fields are empty or whitespace', async () => {
      const auth = authFor(spec, ' ', '');
      expect(spec.isConfigured(auth)).toBe(false);

      const fetchMock = vi.fn().mockResolvedValue(okResponse());
      vi.stubGlobal('fetch', fetchMock);
      const result = await runFetch(spec, auth, fetchMock);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.configured).toBe(false);
    });

    it('keeps using the first field when it holds a real value', async () => {
      const auth = authFor(spec, 'real-first', 'valid-token');
      expect(spec.isConfigured(auth)).toBe(true);

      const fetchMock = vi.fn().mockResolvedValue(okResponse());
      vi.stubGlobal('fetch', fetchMock);
      await runFetch(spec, auth, fetchMock);

      expect(sentAuthorization(fetchMock)).toBe(spec.headerFor('real-first'));
    });
  });
}

describe('second fetch paths (#1751)', () => {
  it('zai gift-reset use falls through an empty key to the valid token', async () => {
    const auth = { zai: { key: '', token: 'valid-token' } };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true }) });
    vi.stubGlobal('fetch', fetchMock);

    await expect(useZaiGiftReset({ recordId: 1, resetType: 'WEEK', readAuth: async () => auth })).resolves.toBe(true);
    expect(sentAuthorization(fetchMock)).toBe('Bearer valid-token');
  });
});
