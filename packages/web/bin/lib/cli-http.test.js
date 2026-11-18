import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchSystemInfoFromPort, fetchTunnelProvidersFromPort, requestJson, waitForServerHealth } from './cli-http.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CLI HTTP discovery inputs', () => {
  it.each([null, {}, { providers: 'constructor' }, { providers: 'toString' }])(
    'rejects provider values that are not arrays %#',
    async (body) => {
      const fetchImpl = vi.fn(async () => Response.json(body));
      expect(await fetchTunnelProvidersFromPort(3000, fetchImpl)).toBeNull();
    },
  );

  it('keeps provider array elements unchecked', async () => {
    const providers = [null, 17, { provider: 'cloudflare', modes: [] }];
    const fetchImpl = vi.fn(async () => Response.json({ providers }));
    expect(await fetchTunnelProvidersFromPort(3000, fetchImpl)).toEqual(providers);
  });

  it.each([-7, 1.5, 0, 42])('preserves finite system-info pids %s', async (pid) => {
    const fetchImpl = vi.fn(async () => Response.json({ runtime: 'cli', pid }));
    expect(await fetchSystemInfoFromPort(3000, fetchImpl)).toEqual({ runtime: 'cli', pid });
  });

  it.each(['42', null, undefined])('maps nonnumeric pids to null %#', async (pid) => {
    const fetchImpl = vi.fn(async () => Response.json({ runtime: 'cli', pid }));
    expect(await fetchSystemInfoFromPort(3000, fetchImpl)).toEqual({ runtime: 'cli', pid: null });
  });

  it('rejects an unchecked runtime field', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ runtime: 17, pid: 42 }));
    expect(await fetchSystemInfoFromPort(3000, fetchImpl)).toBeNull();
  });
});

describe('CLI HTTP request and health contracts', () => {
  it('keeps JSON scalars unchecked and forwards only fetch request fields', async () => {
    const fetchImpl = vi.fn(async () => Response.json(17));
    vi.stubGlobal('fetch', fetchImpl);
    const { body } = await requestJson(3000, '/health', {
      method: 'POST',
      body: 'payload',
      headers: { Authorization: 'existing-test-auth' },
      session: 'not-a-fetch-option',
    });
    expect(body).toBe(17);
    const [, options] = fetchImpl.mock.calls[0];
    expect(options).toMatchObject({
      method: 'POST',
      body: 'payload',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: 'existing-test-auth' },
    });
    expect(options).not.toHaveProperty('session');
  });

  it('calls the health callback before probing and after success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('healthy')));
    const ticks = [];
    expect(await waitForServerHealth(3000, { onTick: (tick) => ticks.push(tick) })).toBe(true);
    expect(ticks).toHaveLength(2);
    expect(ticks[0]).toMatchObject({ timeoutMs: 60000 });
    expect(ticks[0]).not.toHaveProperty('complete');
    expect(ticks[1]).toMatchObject({ timeoutMs: 60000, complete: true });
  });
});
