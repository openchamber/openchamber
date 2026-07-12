import { describe, expect, test } from 'bun:test';

import { planInitialRuntime } from './initial-runtime-plan.mjs';

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
});
