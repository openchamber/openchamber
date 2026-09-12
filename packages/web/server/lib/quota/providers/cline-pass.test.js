import { describe, expect, it } from 'vitest';
import { fetchQuota, isConfigured } from './cline-pass.js';

const readAuth = () => ({ 'cline-pass': { key: 'test-token' } });

// Response shape verified by the contributor against the live ClinePass API.
const documentedPayload = {
  data: { limits: [
    { type: 'five_hour', percentUsed: 43, resetsAt: '2026-09-08T17:00:44.598174595Z' },
    { type: 'weekly', percentUsed: 17 },
    { type: 'monthly', percentUsed: 8 },
  ] },
  success: true,
};

describe('ClinePass quota provider', () => {
  it('maps the documented windows and sends credentials only in headers', async () => {
    const result = await fetchQuota({ readAuth, fetchImpl: async (url, options) => {
      expect(url).toBe('https://api.cline.bot/api/v1/users/me/plan/usage-limits');
      expect(new Headers(options.headers).get('Authorization')).toBe('Bearer test-token');
      expect(options.signal).toBeInstanceOf(AbortSignal);
      return Response.json(documentedPayload);
    } });
    expect(result.ok).toBe(true);
    expect(result.providerId).toBe('cline-pass');
    expect(Object.keys(result.usage.windows)).toEqual(['5h', 'weekly', 'monthly']);
    expect(result.usage.windows['5h'].usedPercent).toBe(43);
    expect(result.usage.windows['5h'].remainingPercent).toBe(57);
    expect(result.usage.windows['5h'].windowSeconds).toBe(18_000);
    expect(result.usage.windows['5h'].resetAt).toBe(Date.parse('2026-09-08T17:00:44.598174595Z'));
    expect(result.usage.windows.weekly.usedPercent).toBe(17);
    expect(result.usage.windows.weekly.windowSeconds).toBe(604_800);
    expect(result.usage.windows.monthly.usedPercent).toBe(8);
    expect(result.usage.windows.monthly.windowSeconds).toBeNull();
    expect(JSON.stringify(result)).not.toContain('test-token');
  });

  it.each([0, '0', '51'])('accepts finite percentage %s', async (percentUsed) => {
    const result = await fetchQuota({ readAuth, fetchImpl: async () => Response.json({ data: { limits: [{ type: 'weekly', percentUsed }] } }) });
    expect(result.ok).toBe(true);
    expect(result.usage.windows.weekly.usedPercent).toBe(Number(percentUsed));
  });

  it.each([
    { type: 'constructor', percentUsed: 5 }, { type: 'toString', percentUsed: 5 },
    { type: '__proto__', percentUsed: 5 }, { type: 'quarterly', percentUsed: 5 },
    { type: 'weekly', percentUsed: '' }, { type: 'weekly', percentUsed: ' ' },
    { type: 'weekly', percentUsed: null }, { type: 'weekly', percentUsed: true },
    { type: 'weekly', percentUsed: 'NaN' }, null,
  ])('ignores malformed windows without discarding valid siblings: %j', async (limit) => {
    const invalid = await fetchQuota({ readAuth, fetchImpl: async () => Response.json({ data: { limits: [limit] } }) });
    expect(invalid.ok).toBe(false);
    expect(invalid.configured).toBe(true);
    expect(invalid.usage).toBeNull();
    const mixed = await fetchQuota({ readAuth, fetchImpl: async () => Response.json({ data: { limits: [limit, { type: 'monthly', percentUsed: 8 }] } }) });
    expect(mixed.ok).toBe(true);
    expect(Object.keys(mixed.usage.windows)).toEqual(['monthly']);
  });

  it.each([null, [], {}, { data: null }, { data: { limits: [] } }])('rejects empty or malformed payload %j', async (payload) => {
    const result = await fetchQuota({ readAuth, fetchImpl: async () => Response.json(payload) });
    expect(result.ok).toBe(false);
    expect(result.usage).toBeNull();
    expect(result.error).toBe('No quota data in response');
  });

  it.each([{ key: '' }, { key: ' ' }, { key: 42 }, {}])('uses a usable token when the key is malformed: %j', async (entry) => {
    const auth = { 'cline-pass': { ...entry, token: 'test-token' } };
    expect(isConfigured(auth)).toBe(true);
    const result = await fetchQuota({ readAuth: () => auth, fetchImpl: async (_url, options) => {
      expect(new Headers(options.headers).get('Authorization')).toBe('Bearer test-token');
      return Response.json(documentedPayload);
    } });
    expect(result.ok).toBe(true);
  });

  it.each([{}, { 'cline-pass': { key: '' } }, { 'cline-pass': { key: 42 } }])('does not fetch without usable credentials: %j', async (auth) => {
    expect(isConfigured(auth)).toBe(false);
    const result = await fetchQuota({ readAuth: () => auth, fetchImpl: async () => { throw new Error('Unexpected fetch'); } });
    expect(result.configured).toBe(false);
    expect(result.error).toBe('Not configured');
  });

  it.each([[401, 'Session expired — please re-authenticate with ClinePass'], [503, 'API error: 503']])('reports HTTP %s', async (status, error) => {
    const result = await fetchQuota({ readAuth, fetchImpl: async () => new Response(null, { status }) });
    expect(result.ok).toBe(false);
    expect(result.usage).toBeNull();
    expect(result.error).toBe(error);
  });

  it('reports invalid JSON', async () => {
    const result = await fetchQuota({ readAuth, fetchImpl: async () => new Response('{') });
    expect(result.error).toBe('Invalid response from provider');
  });

  it('recognizes the timeout exception from AbortSignal.timeout', async () => {
    const result = await fetchQuota({ readAuth, fetchImpl: async () => { throw new DOMException('Timed out', 'TimeoutError'); } });
    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.usage).toBeNull();
    expect(result.error).toBe('Request timed out');
  });
});
