import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAntigravityModels, fetchAntigravityQuotaSummary } from './api.js';
import { warnIfGeminiGroupMissing } from './client.js';
import { parseBucket, transformModels, transformSummary } from './transforms.js';

afterEach(() => vi.unstubAllGlobals());

describe('Antigravity unchecked boundary behavior', () => {
  for (const fetchPayload of [fetchAntigravityModels, fetchAntigravityQuotaSummary]) {
    it(`${fetchPayload.name} preserves successful JSON without a payload shape`, async () => {
      for (const body of ['null', 'false', '"models"', '[]', '{"models":"ab"}', '{"groups":[null,1]}']) {
        vi.stubGlobal('fetch', async () => new Response(body));
        expect(await fetchPayload('test-access')).toEqual(JSON.parse(body));
      }
    });
  }

  it('retains the native failures for truthy non-string display names and labels', () => {
    const summary = { groups: [{ displayName: 17 }] };
    expect(() => warnIfGeminiGroupMissing(summary, vi.fn())).toThrow(TypeError);
    expect(() => transformSummary(summary)).toThrow(TypeError);
    expect(() => parseBucket({ window: 17 })).toThrow(TypeError);
    expect(() => parseBucket({ bucketId: 17 })).toThrow(TypeError);
  });

  it('retains primitive payload and model dictionary behavior', () => {
    expect(transformSummary(false)).toEqual({ modelGroupWindows: [] });
    expect(transformModels(false)).toEqual({});
    expect(Object.keys(transformModels({ models: 'ab' }))).toEqual(['0', '1']);
    expect(transformSummary({ groups: [{ displayName: false, buckets: [null] }] })
      .modelGroupWindows[0].groupType).toBe('gemini');
  });
});
