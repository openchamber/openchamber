import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchGoogleModels, fetchGoogleQuotaBuckets } from './api.js';
import { resolveGoogleAuthSources } from './auth.js';
import { refreshGoogleAccessToken } from './oauth.js';
import { parseGoogleRefreshToken, transformModelData, transformQuotaBucket } from './transforms.js';

afterEach(() => vi.unstubAllGlobals());

describe('Google boundary values', () => {
  for (const fetchPayload of [fetchGoogleModels, fetchGoogleQuotaBuckets]) {
    it(`${fetchPayload.name} preserves JSON without promising a model shape`, async () => {
      for (const body of ['null', 'false', '"models"', '[]', '{"models":"ab"}', '{"buckets":[null,1]}', '1e400']) {
        vi.stubGlobal('fetch', async () => new Response(body));
        expect(await fetchPayload('access')).toEqual(JSON.parse(body));
      }
    });

    it(`${fetchPayload.name} preserves deeply nested JSON`, async () => {
      const body = '{"unused":'.repeat(12000) + '0' + '}'.repeat(12000);
      vi.stubGlobal('fetch', async () => new Response(body));
      expect(await fetchPayload('access')).not.toBeNull();
    });
  }

  it('keeps credential defaults, normalization and nested OAuth selection', () => {
    expect(resolveGoogleAuthSources({ google: ' access ' })).toEqual([{
      sourceId: 'gemini', sourceLabel: 'Gemini', accessToken: 'access',
      refreshToken: null, projectId: null, expires: null,
    }]);
    expect(resolveGoogleAuthSources({ google: { oauth: {
      refresh: ' refresh | | managed ', expires: '2026-01-01T00:00:00Z',
    } } })).toEqual([{
      sourceId: 'gemini', sourceLabel: 'Gemini', accessToken: null,
      refreshToken: 'refresh', projectId: 'managed', expires: Date.parse('2026-01-01T00:00:00Z'),
    }]);
    expect(resolveGoogleAuthSources({ google: [] })).toEqual([]);
    expect(resolveGoogleAuthSources({ google: { oauth: [], access: 'ignored' } })).toEqual([]);
    expect(resolveGoogleAuthSources({})).toEqual([]);
  });

  it('recognizes timeout names on plain thrown objects', async () => {
    vi.stubGlobal('fetch', async () => { throw { name: 'TimeoutError' }; });
    expect(await refreshGoogleAccessToken('refresh', 'gemini')).toEqual({
      ok: false, status: null, error: 'timeout',
    });
  });

  it('retains the unchecked Date constructor coercion in model resets', () => {
    expect(transformModelData('model', { quotaInfo: { resetTime: true } }, 'gemini')
      ['gemini/model'].windows.daily.resetAt).toBe(1);
    expect(transformModelData('model', { quotaInfo: { resetTime: {} } }, 'gemini')
      ['gemini/model'].windows.daily.resetAt).toBeNaN();
    expect(transformModelData('model', { quotaInfo: { resetTime: 1000 } }, 'gemini')
      ['gemini/model'].windows.daily.resetAt).toBe(1000);
  });

  it('preserves missing and primitive transform inputs', () => {
    for (const value of [undefined, null, false, true, 0, 1, '', 'model', [], {}]) {
      expect(transformQuotaBucket(value, 'gemini')).toBeNull();
      expect(transformModelData('constructor', value, 'gemini')
        ['gemini/constructor'].windows.daily).toMatchObject({ usedPercent: null, resetAt: null });
      expect(transformModelData('model', { quotaInfo: value }, 'gemini')
        ['gemini/model'].windows.daily).toMatchObject({ usedPercent: null, resetAt: null });
    }
  });

  it('keeps numeric checks distinct from bucket number parsing', () => {
    expect(transformQuotaBucket({ modelId: 'model', remainingFraction: '0.75' }, 'gemini')
      ['gemini/model'].windows.daily.usedPercent).toBe(25);
    for (const value of ['0.75', true, null, {}, []]) {
      expect(transformModelData('model', { quotaInfo: { remainingFraction: value } }, 'gemini')
        ['gemini/model'].windows.daily.usedPercent).toBeNull();
    }
  });

  it('preserves reset coercion and failures for every JSON kind', () => {
    for (const value of [false, 0, '', null]) {
      expect(transformModelData('model', { quotaInfo: { resetTime: value } }, 'gemini')
        ['gemini/model'].windows.daily.resetAt).toBeNull();
    }
    for (const value of [true, 1000, '2026-01-01', [], [1], {}, { valueOf: 1 }]) {
      expect(transformModelData('model', { quotaInfo: { resetTime: value } }, 'gemini')
        ['gemini/model'].windows.daily.resetAt).toBe(new Date(value).getTime());
    }
    expect(() => transformModelData('model', { quotaInfo: { resetTime: { toString: 1 } } }, 'gemini'))
      .toThrow(TypeError);
  });

  it('parses unchecked refresh values without tightening acceptance', () => {
    for (const value of [undefined, null, false, 1, [], {}]) {
      expect(parseGoogleRefreshToken(value)).toEqual({
        refreshToken: null, projectId: null, managedProjectId: null,
      });
    }
    expect(parseGoogleRefreshToken(' token | project | managed | ignored ')).toEqual({
      refreshToken: 'token', projectId: 'project', managedProjectId: 'managed',
    });
  });
});
