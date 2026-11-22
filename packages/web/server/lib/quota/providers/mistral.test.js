import { afterEach, describe, expect, it, vi } from 'vitest';

const readAuth = async () => ({ mistral: { key: 'test-token' } });
const readEmptyAuth = async () => ({});

import { fetchQuota, fetchQuotaForCredential, isConfigured } from './mistral.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const mockResponse = (body, init = {}) => ({
  ok: true,
  status: 200,
  json: async () => body,
  ...init,
});

// Documented payload shape from GET https://api.mistral.ai/v1/models
const DOCUMENTED_PAYLOAD = {
  object: 'list',
  data: [
    { id: 'mistral-medium-latest', object: 'model' },
    { id: 'codestral-2508', object: 'model' }
  ]
};

describe('Mistral quota provider (key-validity class)', () => {
  it('reports a valid key with empty windows and the console-only marker', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse(DOCUMENTED_PAYLOAD)));

    const result = await fetchQuota({ readAuth });

    expect(result.ok).toBe(true);
    expect(result.configured).toBe(true);
    expect(result.providerId).toBe('mistral');
    expect(result.usage.windows).toEqual({});
    expect(result.usage.usageAvailability).toBe('console-only');
  });

  it('is not configured without an enrolled credential', async () => {
    const result = await fetchQuota({ readAuth: readEmptyAuth });

    expect(result.ok).toBe(false);
    expect(result.configured).toBe(false);
    expect(result.error).toBe('Not configured');
    expect(isConfigured({})).toBe(false);
    expect(isConfigured({ mistral: { key: 'test-token' } })).toBe(true);
  });

  it('fetches with the token when the key field is empty', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse(DOCUMENTED_PAYLOAD));
    vi.stubGlobal('fetch', fetchMock);
    const result = await fetchQuota({ readAuth: async () => ({ mistral: { key: '', token: 'real-token' } }) });
    expect(result.ok).toBe(true);
    expect(result.configured).toBe(true);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer real-token');
    expect(isConfigured({ mistral: { key: '', token: 'real-token' } })).toBe(true);
  });

  it('fetches with the access value when the key field is whitespace-only', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse(DOCUMENTED_PAYLOAD));
    vi.stubGlobal('fetch', fetchMock);
    const result = await fetchQuotaForCredential({ value: { key: '   ', access: 'real-access' } });
    expect(result.ok).toBe(true);
    expect(result.configured).toBe(true);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer real-access');
    expect(isConfigured({ mistral: { key: '   ', access: 'real-access' } })).toBe(true);
  });

  it('reports not configured from both entry points when every field is empty', async () => {
    const entry = { key: '', token: '  ', access: '' };
    const viaAuth = await fetchQuota({ readAuth: async () => ({ mistral: entry }) });
    expect(viaAuth.configured).toBe(false);
    expect(viaAuth.error).toBe('Not configured');
    const viaCredential = await fetchQuotaForCredential({ value: entry });
    expect(viaCredential.configured).toBe(false);
    expect(viaCredential.error).toBe('Not configured');
    expect(isConfigured({ mistral: entry })).toBe(false);
  });

  it.each([401, 403])('classifies a %i as an invalid or revoked key', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({}, { ok: false, status })));

    const result = await fetchQuota({ readAuth });

    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.error).toContain('Invalid or revoked API key');
  });

  it('classifies other HTTP failures as API errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({}, { ok: false, status: 500 })));

    const result = await fetchQuota({ readAuth });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('API error: 500');
  });

  it('classifies a 200 without the documented data array as malformed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({ object: 'list' })));

    const result = await fetchQuota({ readAuth });

    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.error).toBe('No quota data in response');
  });

  it('classifies a transport failure as an error, not a wall', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('socket hang up')));

    const result = await fetchQuota({ readAuth });

    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.error).toBe('socket hang up');
  });
});
