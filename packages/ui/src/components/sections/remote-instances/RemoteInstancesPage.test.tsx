import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import type { DesktopHost, HostProbeResult } from '@/lib/desktopHosts';

const dom = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
  Node: dom.Node, Element: dom.Element, HTMLElement: dom.HTMLElement,
  Event: dom.Event, MouseEvent: dom.MouseEvent, MutationObserver: dom.MutationObserver,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  getComputedStyle: dom.getComputedStyle.bind(dom), IS_REACT_ACT_ENVIRONMENT: true,
});

const sshState = {
  instances: [], statusesById: {}, importCandidates: [],
  load: async () => {}, loadImports: async () => {}, refreshStatuses: async () => {},
};
mock.module('@/stores/useDesktopSshStore', () => ({ useDesktopSshStore: (select: (state: unknown) => unknown) => select(sshState) }));
mock.module('@/stores/useUIStore', () => ({ useUIStore: (select: (state: unknown) => unknown) => select({ settingsRemoteInstancesSelectedId: null }) }));
mock.module('@/hooks/useRuntimeAPIs', () => ({ useRuntimeAPIs: () => ({}) }));
mock.module('@/components/ui', () => ({ toast: { error() {} } }));

const desktop = await import('@/lib/desktop');
mock.module('@/lib/desktop', () => ({ ...desktop, isDesktopShell: () => true, isElectronShell: () => true }));
const baseHost: DesktopHost = {
  id: 'paired', label: 'Paired server', url: 'relay://server-1', clientToken: 'paired-token',
  requestHeaders: { 'X-Test': 'value' },
  relay: { serverId: 'server-1', relayUrl: 'wss://relay.example/ws', hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'x' } },
};
let host: DesktopHost;
let saved: DesktopHost[];
let directStatus: HostProbeResult['status'];
let directOptions: unknown[];
let relayCalls: number;
const hosts = await import('@/lib/desktopHosts');
mock.module('@/lib/desktopHosts', () => ({
  ...hosts,
  desktopHostsGet: async () => ({ hosts: [host], defaultHostId: 'local' }),
  desktopHostsSet: async (config: { hosts: DesktopHost[] }) => { saved = config.hosts; },
  desktopHostProbe: async (_url: string, options: unknown) => {
    directOptions.push(options);
    return { status: directStatus, latencyMs: 1 };
  },
  probeRelayDesktopHost: async () => { relayCalls += 1; return { status: 'ok', latencyMs: 2 }; },
}));

const { I18nProvider } = await import('@/lib/i18n');
const { RemoteInstancesPage } = await import('./RemoteInstancesPage');
const { createRoot } = await import('react-dom/client');
let root: Root;
beforeEach(() => {
  host = { ...baseHost };
  saved = [];
  directStatus = 'wrong-service';
  directOptions = [];
  relayCalls = 0;
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
});

const render = async () => {
  await act(async () => root.render(<I18nProvider><RemoteInstancesPage /></I18nProvider>));
};
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')]
  .find((element) => element.textContent?.trim() === text)!;

for (const apiUrl of [undefined, 'http://192.0.2.10:3000/']) {
  test(`relay host rename preserves transport fields ${apiUrl ? 'after' : 'before'} learning a LAN address`, async () => {
    host = { ...host, ...(apiUrl ? { apiUrl } : {}) };
    await render();
    await act(async () => button('Edit').click());
    const dialog = document.querySelector('[role="dialog"]')!;
    const inputs = dialog.querySelectorAll<HTMLInputElement>('input');
    expect(inputs).toHaveLength(1);
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, 'value')!.set!.call(inputs[0], 'Renamed server');
      inputs[0]!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => button('Save changes').click());
    expect(saved).toEqual([{ ...host, label: 'Renamed server' }]);
  });
}

for (const status of ['wrong-service', 'incompatible'] as const) {
  test(`shows a connected host when direct is ${status} and relay answers`, async () => {
    host = { ...host, apiUrl: 'http://192.0.2.10:3000/' };
    directStatus = status;
    await render();
    expect(directOptions).toHaveLength(1);
    expect(directOptions[0]).toMatchObject({ expectedServerId: host.relay!.serverId, clientToken: host.clientToken });
    expect(relayCalls).toBe(1);
    expect(document.body.textContent).toContain('Connected');
    expect(document.body.textContent).not.toContain(status === 'wrong-service' ? 'Wrong service' : 'Incompatible');
  });
}
