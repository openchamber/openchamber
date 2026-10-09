import { describe, expect, mock, test } from 'bun:test';
import type { RelayTunnelStatus } from '@/lib/relay/tunnel-client';
import type { DesktopHostRelay } from './desktopHosts';

type TunnelStub = {
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
  getStatus: () => RelayTunnelStatus;
  close: () => void;
};

let nextTunnel: (() => TunnelStub) | null = null;
const tunnelModule = await import('@/lib/relay/tunnel-client');
mock.module('@/lib/relay/tunnel-client', () => ({
  ...tunnelModule,
  createRelayTunnelClient: () => {
    if (!nextTunnel) throw new Error('no tunnel stub registered');
    return nextTunnel();
  },
}));

const { desktopHostProbe, desktopHostsGet, desktopHostsSet, desktopHostUpdateServer, importDesktopHostPairing, probeRelayDesktopHost, redactSensitiveUrl, resolveDesktopHostUrl, waitForDesktopHostUpdated } = await import('./desktopHosts');

const withDesktopBridge = async <T>(handler: (cmd: string, args: Record<string, unknown>) => unknown | Promise<unknown>, run: () => Promise<T>): Promise<T> => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      __OPENCHAMBER_DESKTOP__: {
        invoke: handler,
      },
    },
  });
  try {
    return await run();
  } finally {
    if (previousWindow) {
      Object.defineProperty(globalThis, 'window', previousWindow);
    } else {
      Reflect.deleteProperty(globalThis, 'window');
    }
  }
};

describe('resolveDesktopHostUrl', () => {
  test('keeps regular host URLs unchanged', () => {
    expect(resolveDesktopHostUrl('https://example.com/app?x=1')).toEqual({
      persistedUrl: 'https://example.com/app?x=1',
      redeemUrl: null,
      kind: 'normal-host',
    });
  });

  test('detects tunnel connect links and stores only origin', () => {
    expect(resolveDesktopHostUrl('https://example.trycloudflare.com/connect?t=secret-token')).toEqual({
      persistedUrl: 'https://example.trycloudflare.com',
      redeemUrl: 'https://example.trycloudflare.com/connect?t=secret-token',
      kind: 'tunnel-connect-link',
    });
  });

  test('detects tunnel connect links with trailing slash', () => {
    expect(resolveDesktopHostUrl('https://example.trycloudflare.com/connect/?t=secret-token#section')).toEqual({
      persistedUrl: 'https://example.trycloudflare.com',
      redeemUrl: 'https://example.trycloudflare.com/connect/?t=secret-token',
      kind: 'tunnel-connect-link',
    });
  });

  test('redacts tunnel tokens from labels', () => {
    expect(redactSensitiveUrl('https://example.trycloudflare.com/connect?t=secret-token')).toBe(
      'https://example.trycloudflare.com/connect?t=%5BREDACTED%5D',
    );
  });
});

describe('importDesktopHostPairing', () => {
  test('rejects malformed pairing links before changing hosts', async () => {
    await expect(importDesktopHostPairing('not-a-connect-link', [])).rejects.toThrow('invalid-connect-link');
  });
});

describe('desktop host runtime headers', () => {
  test('parses persisted request headers from desktop config', async () => {
    await withDesktopBridge(async (cmd) => {
      expect(cmd).toBe('desktop_hosts_get');
      return {
        hosts: [{
          id: 'remote-1',
          label: 'Remote',
          url: 'https://remote.example',
          requestHeaders: {
            ' CF-Access-Client-Id ': ' client-id ',
            Authorization: 'Bearer should-not-be-read',
            'Bad:Name': 'bad',
          },
        }],
        defaultHostId: 'remote-1',
        initialHostChoiceCompleted: true,
      };
    }, async () => {
      const config = await desktopHostsGet();
      expect(config.hosts[0]?.requestHeaders).toEqual({
        'CF-Access-Client-Id': 'client-id',
      });
    });
  });

  test('passes request headers through host save and probe IPC calls', async () => {
    const calls: Array<{ cmd: string; args: Record<string, unknown> }> = [];
    await withDesktopBridge(async (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === 'desktop_host_probe') return { status: 'ok', latencyMs: 7 };
      return null;
    }, async () => {
      const requestHeaders = { 'CF-Access-Client-Id': 'client-id' };
      await desktopHostsSet({
        hosts: [{ id: 'remote-1', label: 'Remote', url: 'https://remote.example', requestHeaders }],
        defaultHostId: 'remote-1',
      });
      const probe = await desktopHostProbe('https://remote.example', { requestHeaders });
      expect(probe).toEqual({ status: 'ok', latencyMs: 7 });
    });

    expect(calls[0]).toEqual({
      cmd: 'desktop_hosts_set',
      args: {
        input: {
          hosts: [{ id: 'remote-1', label: 'Remote', url: 'https://remote.example', requestHeaders: { 'CF-Access-Client-Id': 'client-id' } }],
          defaultHostId: 'remote-1',
          initialHostChoiceCompleted: undefined,
        },
      },
    });
    expect(calls[1]).toEqual({
      cmd: 'desktop_host_probe',
      args: {
        url: 'https://remote.example',
        requestHeaders: { 'CF-Access-Client-Id': 'client-id' },
      },
    });
  });
});

describe('remote host update', () => {
  test('asks the shell to update a saved host by id only', async () => {
    const calls: Array<{ cmd: string; args: unknown }> = [];
    const result = await withDesktopBridge(async (cmd, args) => {
      calls.push({ cmd, args });
      return { status: 'failed', error: 'Run openchamber update on the server.' };
    }, () => desktopHostUpdateServer('remote-1'));

    expect(calls).toEqual([{ cmd: 'desktop_host_update_server', args: { hostId: 'remote-1' } }]);
    expect(result).toEqual({ status: 'failed', error: 'Run openchamber update on the server.' });
  });

  test('reads an unexpected or failed shell answer as a failure without a reason', async () => {
    expect(await withDesktopBridge(async () => ({ status: 'done' }), () => desktopHostUpdateServer('remote-1')))
      .toEqual({ status: 'failed', error: null });
    expect(await withDesktopBridge(async () => { throw new Error('ipc'); }, () => desktopHostUpdateServer('remote-1')))
      .toEqual({ status: 'failed', error: null });
  });

  const host = { id: 'remote-1', label: 'Remote', url: 'https://remote.example', clientToken: 'token' };
  const readHosts = async () => ({ hosts: [host], defaultHostId: 'remote-1', initialHostChoiceCompleted: true });

  test('waits through the old version and the restart until the host answers compatible', async () => {
    const answers = ['incompatible', 'unreachable', 'ok'] as const;
    const probed: Array<{ url: string; clientToken?: string | null }> = [];
    const outcome = await waitForDesktopHostUpdated('remote-1', {
      intervalMs: 0,
      readHosts,
      probe: async (url, options) => {
        probed.push({ url, clientToken: options?.clientToken });
        return { status: answers[probed.length - 1] ?? 'ok', latencyMs: 1 };
      },
    });

    expect(outcome).toBe('updated');
    expect(probed).toHaveLength(3);
    expect(probed[0]).toEqual({ url: 'https://remote.example', clientToken: 'token' });
  });

  test('gives up when the host never comes back compatible', async () => {
    const outcome = await waitForDesktopHostUpdated('remote-1', {
      maxWaitMs: 20,
      intervalMs: 5,
      readHosts,
      probe: async () => ({ status: 'incompatible', latencyMs: 1 }),
    });
    expect(outcome).toBe('timeout');
  });
});

describe('probeRelayDesktopHost', () => {
  const relay: DesktopHostRelay = {
    relayUrl: 'wss://relay.example',
    serverId: 'server-a',
    hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
  };

  const withTimerWindow = async <T>(run: () => Promise<T>): Promise<T> => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { setTimeout: setTimeout.bind(globalThis), clearTimeout: clearTimeout.bind(globalThis) },
    });
    try {
      return await run();
    } finally {
      if (previousWindow) {
        Object.defineProperty(globalThis, 'window', previousWindow);
      } else {
        Reflect.deleteProperty(globalThis, 'window');
      }
    }
  };

  const stubTunnel = (
    responses: Array<Response | Error>,
    state: RelayTunnelStatus['state'] = 'reconnecting',
  ) => {
    const calls: string[] = [];
    let closed = false;
    nextTunnel = () => ({
      fetch: async (path) => {
        calls.push(path);
        const next = responses.shift();
        if (!next) throw new Error('relay tunnel reset');
        if (next instanceof Error) throw next;
        return next;
      },
      getStatus: () => ({ state }),
      close: () => { closed = true; },
    });
    return { calls, isClosed: () => closed };
  };

  test('a cold first attempt is retried instead of reported unreachable', async () => {
    // The tunnel rejects waiters on its first failed connect and then
    // reconnects; the probe must span that, not read it as an unreachable host.
    const tunnel = stubTunnel([
      new Error('relay tunnel reset: connection failed'),
      new Response('{}', { status: 200 }),
      new Response('{}', { status: 200 }),
    ]);

    const result = await withTimerWindow(() => probeRelayDesktopHost(relay, { clientToken: 'token' }));

    expect(result.status).toBe('ok');
    expect(tunnel.calls).toEqual(['/health', '/health', '/auth/session']);
    expect(tunnel.isClosed()).toBe(true);
  });

  test('a terminal tunnel state ends the probe without retrying', async () => {
    // Auth failed / duplicate client / limit reached will not resolve by waiting.
    const tunnel = stubTunnel([new Error('relay connection replaced by another client')], 'error');

    const result = await withTimerWindow(() => probeRelayDesktopHost(relay, { clientToken: 'token' }));

    expect(result.status).toBe('unreachable');
    expect(tunnel.calls).toEqual(['/health']);
  });

  test('a rejected client token is reported as auth, not unreachable', async () => {
    const tunnel = stubTunnel([
      new Response('{}', { status: 200 }),
      new Response('{}', { status: 401 }),
    ]);

    const result = await withTimerWindow(() => probeRelayDesktopHost(relay, { clientToken: 'stale' }));

    expect(result.status).toBe('auth');
    expect(tunnel.calls).toEqual(['/health', '/auth/session']);
  });
});
