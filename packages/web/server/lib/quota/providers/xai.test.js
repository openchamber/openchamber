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
  it.each([
    { bytes: [], error: 'empty protobuf response' },
    { bytes: [0, 0, 0, 0, 1], error: 'malformed gRPC-web framing' },
    { bytes: [0, 0, 0, 0, 0, 1], error: 'malformed gRPC-web framing' },
    { bytes: [0x0d, 0], error: 'malformed protobuf' },
    { bytes: [0x08, 0x80], error: 'malformed protobuf' },
  ])('preserves binary boundary failures for $bytes', async ({ bytes, error }) => {
    const result = await fetchQuota({
      readAuth: authWith({ access: 'valid-access', refresh: '', expires: Date.now() + 3_600_000 }),
      fetchImpl: async () => new Response(new Uint8Array(bytes)),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain(error);
  });

  it('reads a big-endian gRPC-web frame length and a successful trailer', async () => {
    const payload = new Uint8Array(await usageResponse(42).arrayBuffer());
    const trailer = Buffer.from('grpc-status: 0\r\n');
    const frame = Buffer.alloc(5 + payload.length + 5 + trailer.length);
    frame.writeUInt32BE(payload.length, 1);
    frame.set(payload, 5);
    const trailerOffset = 5 + payload.length;
    frame[trailerOffset] = 0x80;
    frame.writeUInt32BE(trailer.length, trailerOffset + 1);
    frame.set(trailer, trailerOffset + 5);

    const result = await fetchQuota({
      readAuth: authWith({ access: 'valid-access', refresh: '', expires: Date.now() + 3_600_000 }),
      fetchImpl: async () => new Response(frame),
    });

    expect(result.ok).toBe(true);
    expect(result.usage.windows.billing_cycle.usedPercent).toBe(42);
  });

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
