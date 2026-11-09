import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { ThemeSystemProvider } from './ThemeSystemContext';
import { useThemeSystem } from './useThemeSystem';
import type { ThemeContextValue } from './theme-system-context';
import { compactTheme } from '@/lib/theme/definition';
import { getDefaultTheme } from '@/lib/theme/themes';
import { switchRuntimeEndpoint } from '@/lib/runtime-switch';

test('theme rendering requires native alpha and removes translucent rules on an opaque palette', async () => {
  const dom = new Window({ url: 'http://theme.test' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const theme = {
    ...getDefaultTheme(true),
    metadata: { ...getDefaultTheme(true).metadata, id: 'transparent-fixture' },
    config: { backgroundOpacity: 0.5 },
  };
  for (const [name, value] of Object.entries({
    window: dom, document: dom.document, navigator: dom.navigator,
    localStorage: dom.localStorage, Element: dom.Element, HTMLElement: dom.HTMLElement,
    Node: dom.Node, Event: dom.Event, CustomEvent: dom.CustomEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
    fetch: () => Promise.resolve(Response.json({ themes: [compactTheme(theme)] })),
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
    return <output>{context.currentTheme.metadata.id}</output>;
  }
  const current = () => {
    if (!context) throw new Error('Theme provider has not mounted');
    return context;
  };
  const css = () => document.getElementById('opencode-theme-variables')?.textContent ?? '';
  try {
    switchRuntimeEndpoint({ apiBaseUrl: 'http://theme.test', runtimeKey: 'transparency-fixture' });
    await act(async () => root.render(<ThemeSystemProvider><Probe /></ThemeSystemProvider>));
    await act(async () => current().setTheme(theme.metadata.id));
    expect(container.textContent).toBe(theme.metadata.id);
    expect(css()).not.toContain('--oc-text-backdrop');

    Object.defineProperty(dom, '__OPENCHAMBER_ELECTRON__', {
      configurable: true, value: { runtime: 'electron', transparentWindow: true },
    });
    await act(async () => current().setTheme(getDefaultTheme(false).metadata.id));
    await act(async () => current().setTheme(theme.metadata.id));
    expect(css()).toContain('--oc-text-backdrop');
    await act(async () => current().setTheme(getDefaultTheme(false).metadata.id));
    expect(css()).not.toContain('--oc-text-backdrop');

    Object.defineProperty(dom, '__OPENCHAMBER_ELECTRON__', {
      configurable: true, value: { runtime: 'electron', transparentWindow: false },
    });
    await act(async () => current().setTheme(theme.metadata.id));
    expect(css()).not.toContain('--oc-text-backdrop');
  } finally {
    await act(async () => root.unmount());
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    await dom.happyDOM.close();
  }
});
