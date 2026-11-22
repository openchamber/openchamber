import { expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { OpenCode } from '@opencode/client';
import { Window } from 'happy-dom';
import { hostMessageSchema } from '@openchamber/sdk/schemas';
import type { HostMessage } from '@openchamber/sdk';

import { ThemeSystemContext, type ThemeContextValue } from '@/contexts/theme-system-context';
import { getDefaultTheme } from '@/lib/theme/themes';
import { I18nProvider } from '@/lib/i18n';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useGuestsStore } from '@/lib/guests/store';
import type { InstalledGuest } from '@/lib/guests/types';
import type { Message, Session } from '@/lib/opencode/model';
import { SyncProvider } from '@/sync/sync-context';
import { ChatColumnSessionContext } from '@/components/chat/chatColumnSession';
import { getSyncChildStores } from '@/sync/sync-refs';
import { useConfigStore } from '@/stores/useConfigStore';
import type { DirectoryScopedConfig, ProviderWithModelList } from '@/stores/config/types';
import { PluginPane } from './PluginPane';

// Usage changes with every step of a turn. Each change reaches the frame as one
// `session` message; `ready` and the other state callbacks are not replayed.
test('a usage change sends the frame one session update and nothing else', async () => {
  const dom = new Window({ url: 'http://guest.test', settings: { disableIframePageLoading: true } });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom, document: dom.document, navigator: dom.navigator,
    localStorage: dom.localStorage, getComputedStyle: dom.getComputedStyle.bind(dom), Event: dom.Event, MessageEvent: dom.MessageEvent,
    IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const target = String(input instanceof Request ? input.url : input);
    if (target.includes('/frame-grant')) return Response.json({ grant: 'grant-test', expiresAt: Date.now() + 60_000 });
    if (target.includes('/auth/url-token')) return Response.json({ token: 'scoped-test', expiresAt: Date.now() + 60_000 });
    if (target.includes('/event')) return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
    return Response.json({ data: [] });
  });
  const sdk = OpenCode.make({ baseUrl: 'http://sync.test', fetch: async (request) => {
    const path = new URL(request instanceof Request ? request.url : request.toString()).pathname;
    if (path.endsWith('/event')) return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
    return Response.json(path.endsWith('/session/active') ? {} : { data: [] });
  } });
  const theme = getDefaultTheme(false);
  const themeContext: ThemeContextValue = {
    currentTheme: theme, availableThemes: [theme], customThemeIds: [], setTheme: () => {}, customThemesLoading: false,
    reloadCustomThemes: async () => {}, importTheme: async () => theme, deleteImportedTheme: async () => {},
    isSystemPreference: false, setSystemPreference: () => {}, themeMode: 'light', setThemeMode: () => {},
    lightThemeId: theme.metadata.id, darkThemeId: theme.metadata.id, setLightThemePreference: () => {}, setDarkThemePreference: () => {},
  };
  const board: InstalledGuest = {
    id: 'board', name: 'Board', icon: 'window', entry: 'panel/index.html', source: 'path',
    capabilities: { requested: [], granted: [] },
  };
  const session = (input: number): Session => ({
    id: 'ses_1', directory: '/visible', projectID: 'project', title: 'Session', cost: 0,
    time: { created: 1, updated: 1 },
    tokens: { input, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
  });
  const step = (input: number): Message => ({
    id: 'msg_1', sessionID: 'ses_1', role: 'assistant', agent: 'build', providerID: 'acme', modelID: 'small', time: { created: 1, completed: 2 },
    tokens: { input, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
  });
  const configBefore = (({ activeDirectoryKey, providers, directoryScoped }) => ({ activeDirectoryKey, providers, directoryScoped }))(useConfigStore.getState());
  const runtimeKey = getRuntimeKey();
  useGuestsStore.getState().resetForRuntimeSwitch(runtimeKey);
  useGuestsStore.getState().replaceCatalog([board], runtimeKey);
  const column = { sessionId: 'ses_1', directory: '/visible' };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const restores: Array<() => void> = [];
  try {
    await act(async () => root.render(
      <I18nProvider><ThemeSystemContext.Provider value={themeContext}>
        <SyncProvider sdk={sdk} directory="/visible"><ChatColumnSessionContext.Provider value={column}>
          <PluginPane mode="plugin:board" surface="panel" pinnedDirectory="/visible" />
        </ChatColumnSessionContext.Provider></SyncProvider>
      </ThemeSystemContext.Provider></I18nProvider>,
    ));
    const store = getSyncChildStores().ensureChild('/visible', { bootstrap: false });
    await act(async () => store.setState({ session: [session(100)], message: { ses_1: [step(100)] } }));
    for (let attempt = 0; attempt < 100 && !container.querySelector('iframe'); attempt++) await act(async () => {});
    const frame = container.querySelector<HTMLIFrameElement>('iframe');
    if (!frame) throw new Error('Panel iframe did not mount');
    const guestWindow = new Window();
    restores.push(() => { void guestWindow.happyDOM.close(); });
    Object.defineProperty(frame, 'contentWindow', { configurable: true, value: guestWindow });
    const frameWindow = frame.contentWindow;
    if (!frameWindow) throw new Error('Guest window is missing');
    const received: HostMessage[] = [];
    const post = spyOn(frameWindow, 'postMessage').mockImplementation((data) => { received.push(hostMessageSchema.parse(data)); });
    restores.push(() => post.mockRestore());
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', { source: frameWindow, data: { channel: 'openchamber.sdk', v: 1, type: 'hello' } }));
    });
    const ready = received.find((message) => message.type === 'ready');
    expect(ready?.type === 'ready' ? ready.payload.session : null).toMatchObject({
      id: 'ses_1', context: { tokens: 110, limit: null }, tokens: { prompt: 100, output: 10 },
    });

    received.length = 0;
    await act(async () => store.setState({ session: [session(400)], message: { ses_1: [step(400)] } }));
    expect(received.map((message) => message.type)).toEqual(['session']);
    expect(received[0]?.type === 'session' ? received[0].payload.session : null).toMatchObject({
      context: { tokens: 410, limit: null }, tokens: { prompt: 400, output: 10 },
    });

    // The window comes from the session's directory catalog, not the active one.
    const acme = (context: number): ProviderWithModelList => ({
      id: 'acme', name: 'Acme', activation: 'enabled', package: 'acme',
      models: [{
        id: 'small', modelID: 'small', providerID: 'acme', name: 'small', capabilities: { tools: true, input: ['text'], output: ['text'] },
        variants: [], time: { released: 0 }, cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }], status: 'active', enabled: true,
        limit: { context, output: 0 },
      }],
    });
    const scoped: DirectoryScopedConfig = {
      providers: [acme(4000)], agents: [], currentProviderId: '', currentModelId: '', currentAgentName: undefined,
      selectedProviderId: '', agentModelSelections: {}, defaultProviders: {},
    };
    received.length = 0;
    await act(async () => useConfigStore.setState({
      activeDirectoryKey: '/active', providers: [acme(1000)], directoryScoped: { ...useConfigStore.getState().directoryScoped, '/visible': scoped },
    }));
    expect(received.map((message) => message.type)).toEqual(['session']);
    expect(received[0]?.type === 'session' ? received[0].payload.session?.context : null).toEqual({ tokens: 410, limit: 4000 });

    // A catalog change that leaves the window equal sends nothing.
    received.length = 0;
    await act(async () => useConfigStore.setState({ providers: [acme(1000), acme(2000)] }));
    expect(received).toEqual([]);
  } finally {
    useConfigStore.setState(configBefore);
    await act(async () => root.unmount());
    for (const restore of restores) restore();
    fetch.mockRestore();
    useGuestsStore.getState().resetForRuntimeSwitch(runtimeKey);
    await dom.happyDOM.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
