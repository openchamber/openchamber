import { describe, expect, test } from 'bun:test';
import { desktopHostProbe, desktopHostsGet, desktopHostsSet, directE2eeHostFingerprint, getDesktopHostRuntimeSwitchOptions, probeDesktopHostTransports, probeDesktopHostTransportsForActivation, redactSensitiveUrl, resolveDesktopHostUrl, shouldDelegateDesktopHostActivation } from './desktopHosts';
import type { DesktopHost, HostProbeResult } from './desktopHosts';

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

describe('desktop host runtime headers', () => {
  test('strictly parses a direct E2EE descriptor and drops private key fields', async () => {
    await withDesktopBridge(async () => ({
      hosts: [{ id: 'e2ee', label: 'E2EE', url: 'direct-e2ee://host.example', directE2ee: {
        wssUrl: 'wss://host.example/api/openchamber/direct-e2ee/ws',
        hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y', d: 'private' },
      } }],
      defaultHostId: 'e2ee',
    }), async () => {
      const host = (await desktopHostsGet()).hosts[0]!;
      expect(host.directE2ee?.hostEncPubJwk).toEqual({ kty: 'EC', crv: 'P-256', x: 'x', y: 'y' });
      expect(directE2eeHostFingerprint(host.directE2ee!)).toBe('p256:x.y');
    });
  });
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

describe('probeDesktopHostTransports', () => {
  const directE2ee = { wssUrl: 'wss://host.example/api/openchamber/direct-e2ee/ws', hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' } };
  const relay = { relayUrl: 'wss://relay.example/ws', serverId: 'server', hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'rx', y: 'ry' } };
  const host: DesktopHost = { id: 'host', label: 'Host', url: 'https://direct.example', apiUrl: 'https://direct.example', clientToken: 'bearer', requestHeaders: { 'X-Test': 'yes' }, directE2ee, relay };
  const result = (status: HostProbeResult['status']): HostProbeResult => ({ status, latencyMs: 1 });

  test('direct success skips encrypted transports', async () => {
    const calls: string[] = [];
    const selected = await probeDesktopHostTransports(host, {
      probeDirect: async (_url, options) => { calls.push(`direct:${options.clientToken}:${options.requestHeaders?.['X-Test']}`); return result('ok'); },
      probeDirectE2ee: async () => { calls.push('direct-e2ee'); return result('ok'); },
      probeRelay: async () => { calls.push('relay'); return result('ok'); },
    });
    expect(calls).toEqual(['direct:bearer:yes']);
    expect(selected.transport).toEqual({ kind: 'direct', url: 'https://direct.example' });
  });

  test('blocked direct falls through to direct E2EE and skips relay', async () => {
    const calls: string[] = [];
    const selected = await probeDesktopHostTransports(host, {
      probeDirect: async () => { calls.push('direct'); return result('wrong-service'); },
      probeDirectE2ee: async (_descriptor, token) => { calls.push(`direct-e2ee:${token}`); return result('ok'); },
      probeRelay: async () => { calls.push('relay'); return result('ok'); },
    });
    expect(calls).toEqual(['direct', 'direct-e2ee:bearer']);
    expect(selected.transport?.kind).toBe('direct-e2ee');
  });

  test('direct E2EE auth or reachability failure falls through to relay', async () => {
    for (const status of ['auth', 'unreachable'] as const) {
      const calls: string[] = [];
      const selected = await probeDesktopHostTransports({ ...host, apiUrl: undefined, url: 'direct-e2ee://host.example' }, {
        probeDirect: async () => { calls.push('direct'); return result('ok'); },
        probeDirectE2ee: async () => { calls.push('direct-e2ee'); return result(status); },
        probeRelay: async (_descriptor, token) => { calls.push(`relay:${token}`); return result('ok'); },
      });
      expect(calls).toEqual(['direct-e2ee', 'relay:bearer']);
      expect(selected.transport?.kind).toBe('relay');
    }
  });

  test('direct E2EE security failures do not probe relay', async () => {
    for (const failureClassification of ['crypto', 'protocol', 'terminal'] as const) {
      const calls: string[] = [];
      const selected = await probeDesktopHostTransports({ ...host, apiUrl: undefined, url: 'direct-e2ee://host.example' }, {
        probeDirect: async () => result('ok'),
        probeDirectE2ee: async () => { calls.push('direct-e2ee'); return { ...result('unreachable'), failureClassification }; },
        probeRelay: async () => { calls.push('relay'); return result('ok'); },
      });
      expect(calls).toEqual(['direct-e2ee']);
      expect(selected).toEqual({ probe: { ...result('unreachable'), failureClassification }, transport: null });
    }
  });

  test('returns the final failure when every candidate fails', async () => {
    const selected = await probeDesktopHostTransports(host, {
      probeDirect: async () => result('unreachable'),
      probeDirectE2ee: async () => result('auth'),
      probeRelay: async () => result('unreachable'),
    });
    expect(selected).toEqual({ probe: result('unreachable'), transport: null });
  });

  test('direct-only host probes its HTTP descriptor', async () => {
    const directOnly: DesktopHost = { id: 'direct', label: 'Direct', url: 'https://direct.example', apiUrl: 'https://direct.example' };
    let probed = '';
    const selected = await probeDesktopHostTransports(directOnly, {
      probeDirect: async (url) => { probed = url; return result('ok'); },
      probeDirectE2ee: async () => result('unreachable'),
      probeRelay: async () => result('unreachable'),
    });
    expect(probed).toBe('https://direct.example');
    expect(selected.transport?.kind).toBe('direct');
  });

  test('cached selected transport activates the exact descriptor', () => {
    expect(getDesktopHostRuntimeSwitchOptions(host, { kind: 'relay', descriptor: relay }, 'openchamber-ui://app', 'host:host')).toEqual({
      apiBaseUrl: 'openchamber-ui://app', clientToken: 'bearer', runtimeKey: 'host:host', relay,
    });
    expect(getDesktopHostRuntimeSwitchOptions(host, { kind: 'direct-e2ee', descriptor: directE2ee }, 'openchamber-ui://app', 'host:host')?.tunnel).toEqual({ type: 'direct-e2ee', ...directE2ee });
  });

  test('direct-only without a token returns auth without opening a tunnel', async () => {
    let directE2eeCalls = 0;
    const selected = await probeDesktopHostTransports({ id: 'host', label: 'Host', url: 'direct-e2ee://host.example', directE2ee }, {
      probeDirect: async () => result('unreachable'),
      probeDirectE2ee: async () => { directE2eeCalls += 1; return result('ok'); },
      probeRelay: async () => result('ok'),
    });
    expect(directE2eeCalls).toBe(0);
    expect(selected).toEqual({ probe: result('auth'), transport: null });
  });

  test('direct plus relay without a token skips direct E2EE and selects a valid relay', async () => {
    const calls: string[] = [];
    const selected = await probeDesktopHostTransports({ id: 'host', label: 'Host', url: 'direct-e2ee://host.example', directE2ee, relay }, {
      probeDirect: async () => result('unreachable'),
      probeDirectE2ee: async () => { calls.push('direct-e2ee'); return result('ok'); },
      probeRelay: async (_descriptor, token) => { calls.push(`relay:${token}`); return result('ok'); },
    });
    expect(calls).toEqual(['relay:null']);
    expect(selected.transport?.kind).toBe('relay');
  });

  test('runtime options refuse tokenless direct E2EE activation', () => {
    expect(getDesktopHostRuntimeSwitchOptions({ id: 'host', label: 'Host', url: 'direct-e2ee://host.example', directE2ee }, { kind: 'direct-e2ee', descriptor: directE2ee }, 'openchamber-ui://app', 'host:host')).toBeNull();
  });

  test('status probes close and omit relay tunnels by default', async () => {
    let closeCalls = 0;
    const close = () => { closeCalls += 1; };
    const tunnel = { close } as never;
    const selected = await probeDesktopHostTransports({ id: 'host', label: 'Host', url: 'relay://server', relay }, {
      probeDirect: async () => result('unreachable'),
      probeDirectE2ee: async () => result('unreachable'),
      probeRelay: async () => ({ ...result('ok'), tunnel }),
    });

    expect(selected.transport).toEqual({ kind: 'relay', descriptor: relay });
    expect('tunnel' in selected.probe).toBe(false);
    expect(closeCalls).toBe(1);
  });

  test('activation probes retain and return the live relay tunnel', async () => {
    let closeCalls = 0;
    const close = () => { closeCalls += 1; };
    const tunnel = { close } as never;
    const selected = await probeDesktopHostTransportsForActivation({ id: 'host', label: 'Host', url: 'relay://server', relay }, {
      probeDirect: async () => result('unreachable'),
      probeDirectE2ee: async () => result('unreachable'),
      probeRelay: async (_descriptor, _token, options) => ({ ...result('ok'), tunnel: options.keepTunnel ? tunnel : undefined }),
    });

    expect(selected.transport).toEqual({ kind: 'relay', descriptor: relay, tunnel });
    expect(closeCalls).toBe(0);
  });
});

describe('remote desktop host activation', () => {
  test('delegates by opaque host id outside the local desktop origin', () => {
    expect(shouldDelegateDesktopHostActivation(false)).toBe(true);
    expect(shouldDelegateDesktopHostActivation(true)).toBe(false);
  });
});
