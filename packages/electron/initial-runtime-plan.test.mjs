import { describe, expect, test } from 'bun:test';

import { planInitialRuntime, planRuntimeForHost } from './initial-runtime-plan.mjs';

const local = {
  localUiUrl: 'openchamber-ui://app/index.html',
  localUrl: 'http://127.0.0.1:3901',
  localClientToken: 'local-runtime-token',
};

describe('initial runtime plan', () => {
  test.each([
    ['direct E2EE', { id: 'host-e2ee', url: 'direct-e2ee://workspace.example', clientToken: 'remote-secret', directE2ee: { authority: 'workspace.example' } }],
    ['relay', { id: 'host-relay', url: 'relay://workspace.example', clientToken: 'remote-secret', relay: { hostId: 'opaque' } }],
  ])('boots the local runtime for a persisted %s host without an HTTP probe', (_label, host) => {
    expect(planInitialRuntime({ ...local, defaultHostId: host.id, hosts: [host] })).toEqual({
      initialUrl: local.localUiUrl,
      apiBaseUrl: local.localUrl,
      clientToken: local.localClientToken,
      requestHeaders: {},
      relayHostId: host.id,
      probeRemote: false,
    });
  });

  test('keeps direct HTTP hosts on the remote probe path', () => {
    expect(planInitialRuntime({
      ...local,
      defaultHostId: 'host-http',
      hosts: [{
        id: 'host-http',
        url: 'https://ui.example',
        apiUrl: 'https://api.example',
        clientToken: 'remote-token',
        requestHeaders: { 'CF-Access-Client-Id': 'client-id' },
      }],
    })).toEqual({
      initialUrl: 'openchamber-ui://app/index.html',
      apiBaseUrl: 'https://api.example',
      clientToken: 'remote-token',
      requestHeaders: { 'CF-Access-Client-Id': 'client-id' },
      relayHostId: '',
      probeRemote: true,
    });
  });

  test('keeps the environment target above the persisted default host', () => {
    expect(planInitialRuntime({
      ...local,
      envTarget: 'https://env.example',
      defaultHostId: 'host-relay',
      hosts: [{ id: 'host-relay', relay: {} }],
    })).toEqual({
      initialUrl: local.localUiUrl,
      apiBaseUrl: 'https://env.example',
      clientToken: '',
      requestHeaders: {},
      relayHostId: '',
      probeRemote: true,
    });
  });

  test.each([
    ['unconfigured', '', []],
    ['local default', 'local', [{ id: 'remote', url: 'https://remote.example' }]],
  ])('uses the local runtime for %s startup', (_label, defaultHostId, hosts) => {
    expect(planInitialRuntime({ ...local, defaultHostId, hosts })).toEqual({
      initialUrl: local.localUiUrl,
      apiBaseUrl: local.localUrl,
      clientToken: local.localClientToken,
      requestHeaders: {},
      relayHostId: '',
      probeRemote: false,
    });
  });

  test('keeps mixed direct and relay host data in one runtime plan', () => {
    expect(planRuntimeForHost({
      ...local,
      hostId: 'mixed',
      hosts: [{
        id: 'mixed',
        url: 'https://ui.example',
        apiUrl: 'https://api.example',
        clientToken: 'remote-token',
        requestHeaders: { 'CF-Access-Client-Id': 'client-id' },
        relay: { serverId: 'server' },
      }],
    })).toEqual({
      initialUrl: local.localUiUrl,
      apiBaseUrl: 'https://api.example',
      clientToken: 'remote-token',
      requestHeaders: { 'CF-Access-Client-Id': 'client-id' },
      relayHostId: 'mixed',
      probeRemote: true,
    });
  });

  test('uses remote UI for direct hosts only when requested by development mode', () => {
    const host = { id: 'direct', url: 'https://ui.example', apiUrl: 'https://api.example' };
    expect(planRuntimeForHost({ ...local, hostId: host.id, hosts: [host], useRemoteUi: true })?.initialUrl).toBe('https://ui.example');
    expect(planRuntimeForHost({ ...local, hostId: host.id, hosts: [host], useRemoteUi: false })?.initialUrl).toBe(local.localUiUrl);
  });

  test('plans local, relay-only, and direct-E2EE-only hosts without remote UI navigation', () => {
    const relay = { id: 'relay', url: 'relay://server', relay: { serverId: 'server' } };
    const directE2ee = { id: 'e2ee', url: 'direct-e2ee://server', directE2ee: { wssUrl: 'wss://server/ws' } };
    expect(planRuntimeForHost({ ...local, hostId: 'local', hosts: [] })).toEqual({
      initialUrl: local.localUiUrl,
      apiBaseUrl: local.localUrl,
      clientToken: local.localClientToken,
      requestHeaders: {},
      relayHostId: '',
      probeRemote: false,
    });
    expect(planRuntimeForHost({ ...local, hostId: relay.id, hosts: [relay], useRemoteUi: true })).toMatchObject({
      initialUrl: local.localUiUrl,
      apiBaseUrl: local.localUrl,
      clientToken: local.localClientToken,
      relayHostId: relay.id,
      probeRemote: false,
    });
    expect(planRuntimeForHost({ ...local, hostId: directE2ee.id, hosts: [directE2ee], useRemoteUi: true })).toMatchObject({
      initialUrl: local.localUiUrl,
      apiBaseUrl: local.localUrl,
      clientToken: local.localClientToken,
      relayHostId: directE2ee.id,
      probeRemote: false,
    });
  });

  test('returns null for missing or invalid hosts', () => {
    expect(planRuntimeForHost({ ...local, hostId: 'missing', hosts: [] })).toBeNull();
    expect(planRuntimeForHost({ ...local, hostId: 'invalid', hosts: [{ id: 'invalid', url: 'relay://missing-descriptor' }] })).toBeNull();
  });
});
