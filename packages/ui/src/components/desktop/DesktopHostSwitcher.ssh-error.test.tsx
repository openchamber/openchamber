import { afterAll, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';

const dom = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: dom, document: dom.document, navigator: dom.navigator,
  Node: dom.Node, Element: dom.Element, HTMLElement: dom.HTMLElement,
  Event: dom.Event, MouseEvent: dom.MouseEvent, IS_REACT_ACT_ENVIRONMENT: true,
  localStorage: dom.localStorage, getComputedStyle: dom.getComputedStyle.bind(dom),
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
});

mock.module('@/stores/useUIStore', () => ({
  useUIStore: <T,>(select: (state: { setSettingsDialogOpen: () => void; setSettingsPage: () => void }) => T) => select({ setSettingsDialogOpen() {}, setSettingsPage() {} }),
}));
mock.module('@/stores/useConfigStore', () => ({
  useConfigStore: <T,>(select: (state: { isConnected: boolean }) => T) => select({ isConnected: true }),
}));
mock.module('@/components/ui', () => ({ toast: { success() {}, error() {} } }));

const ids = ['error', 'idle', 'ready', 'degraded', 'master_connecting'];
const connected: string[] = [];
const switches: Parameters<typeof import('@/lib/runtime-switch').switchRuntimeEndpoint>[0][] = [];
let failHostRead = false;
const desktop = await import('@/lib/desktop');
mock.module('@/lib/desktop', () => ({ ...desktop, isDesktopShell: () => true, isElectronShell: () => true }));
const hosts = await import('@/lib/desktopHosts');
mock.module('@/lib/desktopHosts', () => ({
  ...hosts,
  desktopHostsGet: async () => {
    if (failHostRead) throw new Error('Host read failed');
    return { hosts: ids.map((id) => ({ id, label: `SSH ${id}`, url: connected.includes(id) ? 'http://localhost:4321' : 'http://localhost' })), defaultHostId: 'local', localOrigin: 'http://localhost' };
  },
  desktopLocalClientTokenGet: async () => '',
  desktopHostProbe: async () => ({ status: 'ok', latencyMs: 1 }),
}));
const ssh = await import('@/lib/desktopSsh');
mock.module('@/lib/desktopSsh', () => ({
  ...ssh,
  desktopSshInstancesGet: async () => ({ instances: ids.map((id) => ({ id })) }),
  desktopSshStatus: async () => ids.map((id) => ({ id, phase: connected.includes(id) ? 'ready' : id, startedByUs: false, retryAttempt: 0, requiresUserAction: false, updatedAtMs: 0 })),
  desktopSshConnect: async (id: string) => { connected.push(id); },
}));
mock.module('@/lib/desktopRelayRestore', () => ({ scheduleDesktopHostCandidateRefresh: () => undefined }));
const runtime = await import('@/lib/runtime-switch');
mock.module('@/lib/runtime-switch', () => ({ ...runtime, switchRuntimeEndpoint: (config: Parameters<typeof runtime.switchRuntimeEndpoint>[0]) => { switches.push(config); } }));
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { DesktopHostSwitcherDialog } = await import('./DesktopHostSwitcher');

afterAll(async () => { await dom.happyDOM.close(); });

test('offers connect for error and idle SSH instances only and retries in place', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const onHostSwitched = mock(() => {});
  try {
    await act(async () => { root.render(<I18nProvider><DesktopHostSwitcherDialog open embedded onOpenChange={() => undefined} onHostSwitched={onHostSwitched} /></I18nProvider>); });
    const row = (id: string) => {
      const label = [...container.querySelectorAll('span')].find((element) => element.textContent === `SSH ${id}`);
      return label?.closest('.group');
    };
    const connect = (id: string) => [...(row(id)?.querySelectorAll('button') ?? [])].find((button) => button.textContent?.trim() === 'Connect');
    for (const id of ids) expect(row(id)).toBeDefined();
    expect(connect('error')).toBeDefined();
    expect(connect('idle')).toBeDefined();
    for (const id of ['ready', 'degraded', 'master_connecting']) expect(connect(id)).toBeUndefined();
    await act(async () => { connect('error')!.click(); });
    expect(connected).toEqual(['error']);
    expect(row('error')?.textContent).toContain('http://localhost:4321');
    expect(switches).toHaveLength(0);
    expect(onHostSwitched).not.toHaveBeenCalled();
    const switchButton = () => row('error')?.querySelector<HTMLButtonElement>('button[aria-label^="Switch to"]');
    failHostRead = true;
    await act(async () => { switchButton()?.click(); });
    expect(switches).toHaveLength(0);
    failHostRead = false;
    await act(async () => { switchButton()?.click(); });
    expect(switches[0]?.apiBaseUrl).toBe('http://localhost:4321');
  } finally {
    failHostRead = false;
    await act(async () => root.unmount());
    container.remove();
  }
});
