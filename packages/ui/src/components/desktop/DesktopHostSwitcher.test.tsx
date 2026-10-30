import { afterEach, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import type { DesktopHost, HostProbeResult } from '@/lib/desktopHosts';

const dom = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: dom, document: dom.document, navigator: dom.navigator,
  Node: dom.Node, Element: dom.Element, HTMLElement: dom.HTMLElement,
  Event: dom.Event, MouseEvent: dom.MouseEvent, IS_REACT_ACT_ENVIRONMENT: true,
  localStorage: dom.localStorage,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  getComputedStyle: dom.getComputedStyle.bind(dom),
});

mock.module('@/stores/useUIStore', () => ({
  useUIStore: (select: (state: unknown) => unknown) => select({ setSettingsDialogOpen() {}, setSettingsPage() {} }),
}));
mock.module('@/stores/useConfigStore', () => ({
  useConfigStore: (select: (state: unknown) => unknown) => select({ isConnected: true }),
}));
mock.module('@/components/ui', () => ({ toast: { error() {} } }));

const host: DesktopHost = {
  id: 'paired', label: 'Paired server', url: 'relay://server-1',
  apiUrl: 'http://192.0.2.10:3000', clientToken: 'paired-token',
  relay: { serverId: 'server-1', relayUrl: 'wss://relay.example/ws', hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'x' } },
};
let releaseBackground!: () => void;
const background = new Promise<void>((resolve) => { releaseBackground = resolve; });
const directOptions: unknown[] = [];
let directCalls = 0;
const switches: Array<{ relay?: unknown; apiBaseUrl: string }> = [];
let relayCalls = 0;

const desktop = await import('@/lib/desktop');
mock.module('@/lib/desktop', () => ({ ...desktop, isDesktopShell: () => true, isElectronShell: () => true }));
const hosts = await import('@/lib/desktopHosts');
mock.module('@/lib/desktopHosts', () => ({
  ...hosts,
  desktopHostsGet: async () => ({ hosts: [host], defaultHostId: 'local', localOrigin: 'http://localhost' }),
  desktopLocalClientTokenGet: async () => 'local-token',
  desktopHostProbe: async (url: string, options: unknown): Promise<HostProbeResult> => {
    if (url !== host.apiUrl) return { status: 'ok', latencyMs: 1 };
    directOptions.push(options);
    if (++directCalls === 1) await background;
    return { status: 'wrong-service', latencyMs: 1 };
  },
  probeRelayDesktopHost: async () => { relayCalls += 1; return { status: 'ok', latencyMs: 2 }; },
}));
const ssh = await import('@/lib/desktopSsh');
mock.module('@/lib/desktopSsh', () => ({ ...ssh, desktopSshInstancesGet: async () => ({ instances: [] }), desktopSshStatus: async () => [] }));
const runtime = await import('@/lib/runtime-switch');
mock.module('@/lib/runtime-switch', () => ({
  ...runtime, switchRuntimeEndpoint: (config: { relay?: unknown; apiBaseUrl: string }) => { switches.push(config); },
}));
mock.module('@/lib/desktopRelayRestore', () => ({ scheduleDesktopHostCandidateRefresh: () => undefined }));

const { I18nProvider } = await import('@/lib/i18n');
const { DesktopHostSwitcherDialog } = await import('./DesktopHostSwitcher');
const { isDesktopHostStatusPending } = await import('@/lib/desktopHostStatus');
afterEach(async () => {
  releaseBackground();
  await dom.happyDOM.close();
});

test('selecting a learned relay host during its background probe checks identity and falls back to relay', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const mounted = createRoot(container);
  try {
    await act(async () => {
      mounted.render(<I18nProvider><DesktopHostSwitcherDialog open embedded onOpenChange={() => undefined} /></I18nProvider>);
    });
    expect(isDesktopHostStatusPending(host.id)).toBe(true);
    const row = [...container.querySelectorAll<HTMLElement>('[role="button"], button')]
      .find((element) => element.textContent?.includes(host.label));
    expect(row).toBeDefined();
    await act(async () => row!.click());
    expect(directCalls).toBe(2);
    expect(directOptions[1]).toMatchObject({ expectedServerId: host.relay!.serverId, clientToken: host.clientToken });
    expect(relayCalls).toBe(1);
    expect(switches).toHaveLength(1);
    expect(switches[0]?.relay).toEqual(host.relay);
  } finally {
    await act(async () => mounted.unmount());
  }
});
