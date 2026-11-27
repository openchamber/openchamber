import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';

test('desktop titles follow saved instance names across transport changes and retain names on read failure', async () => {
  const dom = new Window({ url: 'http://localhost:4100' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({
    window: dom, document: dom.document, navigator: dom.navigator, location: dom.location,
    localStorage: dom.localStorage, Element: dom.Element, HTMLElement: dom.HTMLElement,
    Node: dom.Node, Event: dom.Event, CustomEvent: dom.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async () => new Response('{}', { status: 503 }), originalFetch);
  const hosts = [{ id: 'remote', label: 'Build server', url: 'https://server.example' }];
  let failHostRead = false;
  Object.assign(dom, {
    __OPENCHAMBER_ELECTRON__: { runtime: 'electron' },
    __OPENCHAMBER_LOCAL_ORIGIN__: 'http://localhost:4100',
    __OPENCHAMBER_DESKTOP__: {
      invoke: async (command: string) => {
        if (command !== 'desktop_hosts_get') return null;
        if (failHostRead) throw new Error('Host storage unavailable');
        return { hosts, localOrigin: 'http://localhost:4100' };
      },
    },
  });
  const { createRoot } = await import('react-dom/client');
  const { switchRuntimeEndpoint } = await import('@/lib/runtime-switch');
  const { useWindowTitle } = await import('./useWindowTitle');
  const { I18nProvider } = await import('@/lib/i18n');
  const { useProjectsStore } = await import('@/stores/useProjectsStore');
  const previousProjects = useProjectsStore.getState();
  useProjectsStore.setState({ activeProjectId: null });
  const root = createRoot(document.createElement('div'));
  function Harness() {
    useWindowTitle();
    return null;
  }
  try {
    switchRuntimeEndpoint({ apiBaseUrl: 'http://localhost:4100', runtimeKey: 'local' });
    await act(async () => { root.render(<I18nProvider><Harness /></I18nProvider>); });
    expect(document.title).toBe('OpenChamber - Local');

    await act(async () => {
      switchRuntimeEndpoint({ apiBaseUrl: 'https://server.example', runtimeKey: 'host:remote' });
    });
    expect(document.title).toBe('OpenChamber - Build server');

    // The stable host key still names the server when its transport URL changes.
    await act(async () => {
      switchRuntimeEndpoint({ apiBaseUrl: '', runtimeKey: 'host:remote' });
      dom.dispatchEvent(new dom.Event('focus'));
    });
    expect(document.title).toBe('OpenChamber - Build server');

    hosts[0].label = 'Production';
    await act(async () => { dom.dispatchEvent(new dom.Event('focus')); });
    expect(document.title).toBe('OpenChamber - Production');
    failHostRead = true;
    await act(async () => { dom.dispatchEvent(new dom.Event('focus')); });
    expect(document.title).toBe('OpenChamber - Production');

    await act(async () => {
      switchRuntimeEndpoint({ apiBaseUrl: 'http://localhost:4100', runtimeKey: 'local' });
    });
    expect(document.title).toBe('OpenChamber - Local');

    await act(async () => { root.unmount(); });
    Object.assign(dom, { __OPENCHAMBER_ELECTRON__: undefined });
    const webRoot = createRoot(document.createElement('div'));
    await act(async () => { webRoot.render(<I18nProvider><Harness /></I18nProvider>); });
    expect(document.title).toBe('OpenChamber');
    await act(async () => { webRoot.unmount(); });
  } finally {
    await act(async () => { root.unmount(); });
    useProjectsStore.setState(previousProjects);
    globalThis.fetch = originalFetch;
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
