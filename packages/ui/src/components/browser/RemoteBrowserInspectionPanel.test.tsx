import React, { act } from 'react';
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';

import { ThemeSystemContext, type ThemeContextValue } from '@/contexts/theme-system-context';
import { RemoteSurfaceClient } from '@/lib/browser/remoteSurface';
import { getDefaultTheme } from '@/lib/theme/themes';
import type { BrowserInspectionMode } from './RemoteBrowserChrome';

const dom = new Window({ url: 'http://localhost/' });
const bindings = {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  Element: dom.Element,
  Node: dom.Node,
  Event: dom.Event,
  KeyboardEvent: dom.KeyboardEvent,
  getComputedStyle: dom.getComputedStyle.bind(dom),
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const original = Object.keys(bindings).map((name) => ({ name, descriptor: Object.getOwnPropertyDescriptor(globalThis, name) }));
Object.assign(globalThis, bindings);

const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { RemoteBrowserInspectionPanel } = await import('./RemoteBrowserInspectionPanel');
const theme = getDefaultTheme(false);
const themeContext: ThemeContextValue = {
  currentTheme: theme,
  availableThemes: [theme],
  setTheme: () => undefined,
  customThemesLoading: false,
  reloadCustomThemes: async () => undefined,
  isSystemPreference: false,
  setSystemPreference: () => undefined,
  themeMode: theme.metadata.variant,
  setThemeMode: () => undefined,
  lightThemeId: 'openchamber-light',
  darkThemeId: 'openchamber-dark',
  setLightThemePreference: () => undefined,
  setDarkThemePreference: () => undefined,
};
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
afterAll(() => {
  for (const { name, descriptor } of original) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  dom.happyDOM.abort();
});

const mountPanel = async (element: React.ReactNode) => {
  const host = document.createElement('div');
  document.body.append(host);
  const root: Root = createRoot(host);
  cleanups.push(async () => { await act(async () => root.unmount()); host.remove(); });
  await act(async () => root.render(<I18nProvider><ThemeSystemContext.Provider value={themeContext}>
    {element}
  </ThemeSystemContext.Provider></I18nProvider>));
  return { host };
};

function PanelHarness({ initialMode = 'simple' }: { readonly initialMode?: Exclude<BrowserInspectionMode, null> }) {
  const client = React.useMemo(() => new RemoteSurfaceClient({ directory: '/project' }), []);
  const [mode, setMode] = React.useState<BrowserInspectionMode>(initialMode);
  const [maximized, setMaximized] = React.useState(false);
  const returnFocus = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => {
    client.inspector.setOpen(mode === 'simple');
    return () => client.inspector.setOpen(false);
  }, [client, mode]);
  return <>
    <button ref={returnFocus} type="button">Return to inspector</button>
    {mode ? <RemoteBrowserInspectionPanel client={client} mode={mode} onModeChange={setMode}
      maximized={maximized} onMaximizedChange={setMaximized} returnFocus={returnFocus} /> : null}
  </>;
}

describe('RemoteBrowserInspectionPanel', () => {
  test('keeps DevTools as the only visible inspector mode', async () => {
    const { host } = await mountPanel(<PanelHarness initialMode="devtools" />);

    expect(host.textContent).toContain('Chrome DevTools');
    expect(host.querySelectorAll('button[aria-pressed]').length).toBe(0);
  });

  test('clamps keyboard resizing and restores focus after closing a maximized panel', async () => {
    const { host } = await mountPanel(<PanelHarness />);
    expect(host.querySelector('[aria-label="Page inspector"]')).not.toBeNull();
    expect(host.querySelectorAll('button[aria-label="Close inspector"]').length).toBe(1);
    const separator = host.querySelector<HTMLElement>('[role="separator"]');
    if (!separator) throw new Error('Expected the inspector resize separator');

    await act(async () => separator.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true })));
    expect(separator.getAttribute('aria-valuenow')).toBe('20');
    await act(async () => separator.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true })));
    expect(separator.getAttribute('aria-valuenow')).toBe('80');

    const maximize = host.querySelector<HTMLButtonElement>('button[aria-label="Maximize inspector"]');
    if (!maximize) throw new Error('Expected inspector maximize action');
    await act(async () => maximize.click());
    expect(host.querySelector('[role="separator"]')).toBeNull();
    const restore = host.querySelector<HTMLButtonElement>('button[aria-label="Restore page and inspector"]');
    if (!restore) throw new Error('Expected inspector restore action');

    const close = host.querySelector<HTMLButtonElement>('button[aria-label="Close inspector"]');
    if (!close) throw new Error('Expected inspector close action');
    await act(async () => close.click());
    expect(host.querySelector('[aria-label="Close inspector"]')).toBeNull();
    expect(document.activeElement?.textContent).toBe('Return to inspector');
  });
});
