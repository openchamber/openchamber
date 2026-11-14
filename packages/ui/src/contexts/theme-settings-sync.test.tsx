import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { ThemeSystemProvider } from './ThemeSystemContext';
import { useThemeSystem } from './useThemeSystem';
import type { ThemeContextValue } from './theme-system-context';
import { getRuntimeKey, switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { getThemePreferencesStorageKey, writeThemePreferencesForRuntime } from './theme-storage';

type Variant = 'light' | 'dark';

async function withProvider(prefersColorScheme: Variant, run: (current: () => ThemeContextValue, settingsWrites: string[], dom: Window) => Promise<void>) {
  const dom = new Window({ url: 'http://theme.test', settings: { device: { prefersColorScheme } } });
  Object.assign(dom, {
    __OPENCHAMBER_API_BASE_URL__: 'http://theme.test',
    __OPENCHAMBER_LOCAL_ORIGIN__: 'http://theme.test',
  });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const settingsWrites: string[] = [];
  const fetchResponse = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    if (init?.method === 'PUT' && url.includes('/api/config/settings')) settingsWrites.push(url);
    return Promise.resolve(Response.json(url.includes('/api/config/themes')
      ? { themes: [] }
      : init?.method === 'PUT' ? JSON.parse(String(init.body)) : {}));
  };
  for (const [name, value] of Object.entries({
    window: dom, document: dom.document, navigator: dom.navigator,
    localStorage: dom.localStorage, Element: dom.Element, HTMLElement: dom.HTMLElement,
    Node: dom.Node, Event: dom.Event, CustomEvent: dom.CustomEvent, StorageEvent: dom.StorageEvent,
    fetch: fetchResponse, IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const { createRoot } = await import('react-dom/client');
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let context: ThemeContextValue | undefined;
  function Probe() {
    context = useThemeSystem();
    return null;
  }
  const current = () => {
    if (!context) throw new Error('Theme context has not mounted');
    return context;
  };
  try {
    await act(async () => root.render(<ThemeSystemProvider><Probe /></ThemeSystemProvider>));
    await run(current, settingsWrites, dom);
  } finally {
    await act(async () => root.unmount());
    await new Promise((resolve) => setTimeout(resolve, 250));
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    await dom.happyDOM.close();
  }
}

test('incoming System mode waits for the OS-variant palette without writing settings back', async () => {
  await withProvider('dark', async (current, settingsWrites) => {
    await act(async () => current().setThemeMode('light'));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 250)));
    const before = current().currentTheme;
    const dark = current().availableThemes.find((theme) => theme.metadata.variant === 'dark');
    if (!dark) throw new Error('No dark theme is available for the fixture');
    const arriving = { ...dark, metadata: { ...dark.metadata, id: 'pending-system-dark' } };
    settingsWrites.length = 0;
    await act(async () => window.dispatchEvent(new CustomEvent('openchamber:settings-synced', {
      detail: { adoptTheme: true, settings: {
        useSystemTheme: true, lightThemeId: current().lightThemeId, darkThemeId: arriving.metadata.id,
      } },
    })));
    expect(current().themeMode).toBe('light');
    expect(current().currentTheme.metadata.id).toBe(before.metadata.id);
    expect(document.documentElement.classList.contains('light')).toBe(true);
    await act(async () => window.dispatchEvent(new CustomEvent('openchamber:settings-synced', {
      detail: { adoptTheme: false, settings: { themeId: before.metadata.id, useSystemTheme: false } },
    })));
    await act(async () => window.dispatchEvent(new CustomEvent('openchamber:theme-hmr', { detail: arriving })));
    expect(current().themeMode).toBe('system');
    expect(current().currentTheme.metadata.id).toBe(arriving.metadata.id);
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 250)));
    expect(settingsWrites).toHaveLength(0);
  });
});

test('pending System adoption checks the current OS variant when palettes arrive', async () => {
  await withProvider('dark', async (current, _settingsWrites, dom) => {
    await act(async () => current().setThemeMode('light'));
    const light = current().currentTheme;
    const arriving = { ...light, metadata: { ...light.metadata, id: 'pending-system-light' } };
    await act(async () => window.dispatchEvent(new CustomEvent('openchamber:settings-synced', {
      detail: { adoptTheme: true, settings: {
        useSystemTheme: true, lightThemeId: arriving.metadata.id, darkThemeId: 'pending-system-dark',
      } },
    })));
    expect(current().themeMode).toBe('light');
    dom.happyDOM.settings.device.prefersColorScheme = 'light';
    await act(async () => window.dispatchEvent(new CustomEvent('openchamber:theme-hmr', { detail: arriving })));
    expect(current().themeMode).toBe('system');
    expect(current().currentTheme.metadata.id).toBe(arriving.metadata.id);
  });
});

test('an explicit custom theme uses its actual metadata despite a stale saved variant', async () => {
  await withProvider('light', async (current, settingsWrites) => {
    const dark = current().availableThemes.find((theme) => theme.metadata.variant === 'dark');
    if (!dark) throw new Error('No dark theme is available for the fixture');
    const selected = { ...dark, metadata: { ...dark.metadata, id: 'selected-custom-dark' } };
    await act(async () => window.dispatchEvent(new CustomEvent('openchamber:theme-hmr', { detail: selected })));
    await act(async () => window.dispatchEvent(new CustomEvent('openchamber:settings-synced', {
      detail: { adoptTheme: true, settings: {
        useSystemTheme: false, themeId: selected.metadata.id, themeVariant: 'light',
      } },
    })));
    expect(current().themeMode).toBe('dark');
    expect(current().currentTheme.metadata.id).toBe(selected.metadata.id);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 250)));
    expect(settingsWrites).toHaveLength(0);
  });
});

for (const cancellation of ['local', 'runtime', 'storage'] as const) {
  test(`a ${cancellation} selection cancels pending file adoption`, async () => {
    await withProvider('dark', async (current) => {
      const dark = current().availableThemes.find((theme) => theme.metadata.variant === 'dark');
      if (!dark) throw new Error('No dark theme is available for the fixture');
      const arriving = { ...dark, metadata: { ...dark.metadata, id: 'cancelled-pending-dark' } };
      await act(async () => window.dispatchEvent(new CustomEvent('openchamber:settings-synced', {
        detail: { adoptTheme: true, settings: {
          useSystemTheme: false, themeId: arriving.metadata.id, themeVariant: 'dark',
        } },
      })));
      await act(async () => {
        if (cancellation === 'local') current().setThemeMode(current().themeMode);
        else if (cancellation === 'runtime') switchRuntimeEndpoint({ apiBaseUrl: 'http://other-theme.test', runtimeKey: 'other-theme' });
        else {
          writeThemePreferencesForRuntime(getRuntimeKey(), {
            themeMode: 'light', lightThemeId: current().lightThemeId, darkThemeId: current().darkThemeId,
          });
          window.dispatchEvent(new StorageEvent('storage', {
            key: getThemePreferencesStorageKey(getRuntimeKey()), storageArea: localStorage,
          }));
        }
      });
      const before = current().currentTheme.metadata.id;
      const mode = current().themeMode;
      await act(async () => window.dispatchEvent(new CustomEvent('openchamber:theme-hmr', { detail: arriving })));
      expect(current().themeMode).toBe(mode);
      expect(current().currentTheme.metadata.id).toBe(before);
    });
  });
}
