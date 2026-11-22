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
const opened: { url: string; clientToken: string | null }[] = [];
const saved: { hosts: { id: string; url: string; clientToken?: string }[]; defaultHostId: string | null }[] = [];
let failHostRead = false;
let releaseConnect: (() => void) | null = null;
let holdConnect = false;
let releaseOpen: (() => void) | null = null;
let holdOpen = false;
const desktop = await import('@/lib/desktop');
mock.module('@/lib/desktop', () => ({ ...desktop, isDesktopShell: () => true, isElectronShell: () => true }));
const hosts = await import('@/lib/desktopHosts');
mock.module('@/lib/desktopHosts', () => ({
  ...hosts,
  desktopHostsGet: async () => {
    if (failHostRead) throw new Error('Host read failed');
    return {
      hosts: ids.map((id) => connected.includes(id)
        ? { id, label: `SSH ${id}`, url: 'http://localhost:4321', clientToken: `token-${id}` }
        : { id, label: `SSH ${id}`, url: 'http://localhost' }),
      defaultHostId: 'local',
      localOrigin: 'http://localhost',
    };
  },
  desktopHostsSet: async (config: (typeof saved)[number]) => { saved.push(config); },
  desktopLocalClientTokenGet: async () => '',
  desktopHostProbe: async () => ({ status: 'ok', latencyMs: 1 }),
  desktopOpenNewWindowAtUrl: async (url: string, options: { clientToken: string | null }) => {
    opened.push({ url, clientToken: options.clientToken });
    if (holdOpen) await new Promise<void>((resolve) => { releaseOpen = resolve; });
  },
}));
const ssh = await import('@/lib/desktopSsh');
mock.module('@/lib/desktopSsh', () => ({
  ...ssh,
  desktopSshInstancesGet: async () => ({ instances: ids.map((id) => ({ id })) }),
  desktopSshStatus: async () => ids.map((id) => ({ id, phase: connected.includes(id) ? 'ready' : id, startedByUs: false, retryAttempt: 0, requiresUserAction: false, updatedAtMs: 0 })),
  desktopSshConnect: async (id: string) => {
    if (holdConnect) await new Promise<void>((resolve) => { releaseConnect = resolve; });
    connected.push(id);
  },
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

test('opening an idle SSH instance in a new window waits for the tunnel, opens once across a menu remount and keeps the refreshed entry', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  let root = createRoot(container);
  const render = async () => {
    await act(async () => { root.render(<I18nProvider><DesktopHostSwitcherDialog open embedded onOpenChange={() => undefined} /></I18nProvider>); });
  };
  try {
    await render();
    const row = (id: string) => [...container.querySelectorAll('span')].find((element) => element.textContent === `SSH ${id}`)?.closest('.group');
    const openButton = () => row('idle')?.querySelector<HTMLButtonElement>('button[aria-label="Open in new window"]');
    const starButton = () => row('ready')?.querySelector<HTMLButtonElement>('button[aria-label="Set as default"]');
    expect(openButton()?.disabled).toBe(false);

    holdConnect = true;
    await act(async () => { openButton()!.click(); });
    await act(async () => { openButton()!.click(); });
    expect(opened).toEqual([]);
    expect(openButton()?.disabled).toBe(true);
    expect(starButton()?.disabled).toBe(true);

    // The sidebar menu unmounts its switcher on close; the reopened one still sees the pending open.
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    expect(openButton()?.disabled).toBe(true);
    expect(starButton()?.disabled).toBe(true);

    holdConnect = false;
    holdOpen = true;
    await act(async () => { releaseConnect?.(); });
    expect(opened).toEqual([{ url: 'http://localhost:4321/', clientToken: 'token-idle' }]);
    expect(openButton()?.disabled).toBe(true);
    expect(starButton()?.disabled).toBe(false);

    holdOpen = false;
    await act(async () => { releaseOpen?.(); });
    expect(opened).toHaveLength(1);
    expect(openButton()?.disabled).toBe(false);

    await act(async () => { starButton()!.click(); });
    expect(saved.at(-1)?.hosts.find((host) => host.id === 'idle')).toMatchObject({ url: 'http://localhost:4321', clientToken: 'token-idle' });
  } finally {
    holdConnect = false;
    holdOpen = false;
    releaseConnect = null;
    releaseOpen = null;
    await act(async () => root.unmount());
    container.remove();
  }
});
