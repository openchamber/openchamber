import { beforeEach, describe, expect, test } from 'bun:test';

import { restoreDesktopRuntimeWithDependencies } from './desktopRelayRestore';
import type { DesktopHost, DesktopHostSelection, DesktopHostsConfig } from './desktopHosts';

const directE2ee = { wssUrl: 'wss://host.example/api/openchamber/direct-e2ee/ws', hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' } };
const relay = { relayUrl: 'wss://relay.example/ws', serverId: 'server', hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'rx', y: 'ry' } };
const host: DesktopHost = { id: 'host-1', label: 'Host', url: 'https://lan.example', apiUrl: 'https://lan.example', clientToken: 'bearer', requestHeaders: { 'X-Test': 'yes' }, directE2ee, relay };

describe('desktop encrypted runtime restore', () => {
  let config: DesktopHostsConfig;
  let selection: DesktopHostSelection;
  let selectedHost: DesktopHost | null;
  let switchCalls: Array<Record<string, unknown>>;

  const restore = async (targetHostId?: string): Promise<void> => restoreDesktopRuntimeWithDependencies({
    isElectronShell: () => true,
    getHosts: async () => config,
    selectTransport: async (value) => { selectedHost = value; return selection; },
    getRuntimeKey: () => 'local',
    switchRuntime: (options) => { switchCalls.push(options); },
    windowOrigin: () => 'openchamber-ui://app',
  }, targetHostId);

  beforeEach(() => {
    config = { hosts: [host], defaultHostId: host.id, initialHostChoiceCompleted: true };
    selection = { probe: { status: 'unreachable', latencyMs: 0 }, transport: null };
    selectedHost = null;
    switchCalls = [];
  });

  test('restores direct first when selected', async () => {
    selection = { probe: { status: 'ok', latencyMs: 1 }, transport: { kind: 'direct', url: host.apiUrl! } };
    await restore();
    expect(selectedHost).toEqual(host);
    expect(switchCalls).toEqual([{ apiBaseUrl: host.apiUrl, clientToken: 'bearer', requestHeaders: host.requestHeaders, runtimeKey: 'host:host-1' }]);
  });

  test('restores direct E2EE after direct fallback', async () => {
    selection = { probe: { status: 'ok', latencyMs: 2 }, transport: { kind: 'direct-e2ee', descriptor: directE2ee } };
    await restore();
    expect(switchCalls[0]?.tunnel).toEqual({ type: 'direct-e2ee', ...directE2ee });
  });

  test('restores hosted relay after direct and direct E2EE fallback', async () => {
    config = { hosts: [{ ...host, directE2ee: undefined }], defaultHostId: host.id, initialHostChoiceCompleted: true };
    selection = { probe: { status: 'ok', latencyMs: 3 }, transport: { kind: 'relay', descriptor: relay } };
    await restore();
    expect(switchCalls[0]?.relay).toEqual(relay);
  });

  test('does not switch when every transport fails', async () => {
    await restore();
    expect(switchCalls).toEqual([]);
  });

  test('does not publish a migrated tokenless direct-E2EE selection', async () => {
    config = { hosts: [{ ...host, clientToken: undefined, apiUrl: undefined, url: 'direct-e2ee://host.example', relay: undefined }], defaultHostId: host.id, initialHostChoiceCompleted: true };
    selection = { probe: { status: 'ok', latencyMs: 1 }, transport: { kind: 'direct-e2ee', descriptor: directE2ee } };
    await restore();
    expect(switchCalls).toEqual([]);
  });

  test('explicit target and restart with both descriptors preserve runtime-key semantics', async () => {
    const other = { ...host, id: 'other', apiUrl: undefined, url: 'direct-e2ee://host.example' };
    config = { hosts: [host, other], defaultHostId: host.id, initialHostChoiceCompleted: true };
    selection = { probe: { status: 'ok', latencyMs: 2 }, transport: { kind: 'direct-e2ee', descriptor: directE2ee } };
    await restore(other.id);
    expect(selectedHost?.id).toBe(other.id);
    expect(switchCalls[0]?.runtimeKey).toBe('host:other');
  });
});
