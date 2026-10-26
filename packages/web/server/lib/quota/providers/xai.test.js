import { describe, expect, it } from 'vitest';
import { fetchQuota } from './xai.js';

const USAGE_URL = 'https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig';

// Minimal protobuf the parser accepts: field 1, wire type 5 (fixed32) carrying a
// used-percent float, which `parseUsage` reads as the current-period usage.
const usageResponse = (usedPercent) => {
  const bytes = Buffer.alloc(5);
  bytes[0] = 0x0d;
  bytes.writeFloatLE(usedPercent, 1);
  return new Response(new Uint8Array(bytes));
};

const authWith = (entry) => () => ({ xai: { type: 'oauth', ...entry } });

describe('xAI quota provider', () => {
  it('reads usage with the stored access token while it is still valid', async () => {
    const requests = [];
    const result = await fetchQuota({
      readAuth: authWith({ access: 'valid-access', refresh: 'rotating-1', expires: Date.now() + 3_600_000 }),
      fetchImpl: async (url) => {
        requests.push(String(url));
        return usageResponse(42);
      },
    });

    expect(result.ok).toBe(true);
    expect(result.usage.windows.billing_cycle.usedPercent).toBe(42);
    expect(requests).toEqual([USAGE_URL]);
  });

  it('never exchanges the rotating refresh token when the access token is expired', async () => {
    const requests = [];
    const result = await fetchQuota({
      readAuth: authWith({ access: 'stale-access', refresh: 'rotating-1', expires: Date.now() - 1_000 }),
      fetchImpl: async (url) => {
        requests.push(String(url));
        return usageResponse(42);
      },
    });

    // The bug: the quota module POSTed the rotating refresh token to auth.x.ai,
    // which xAI invalidates on use, leaving OpenCode with a consumed token.
    expect(requests.filter((url) => url.includes('auth.x.ai'))).toEqual([]);
    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.error).toMatch(/expired/i);
  });

  it('reports a missing credential as unconfigured without contacting xAI', async () => {
    let requests = 0;
    const result = await fetchQuota({
      readAuth: () => ({}),
      fetchImpl: async () => {
        requests += 1;
        return usageResponse(42);
      },
    });

    expect(result.configured).toBe(false);
    expect(requests).toBe(0);
  });
});
