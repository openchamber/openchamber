import { expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { OpenCode } from '@opencode/client';
import { Window } from 'happy-dom';
import { hostMessageSchema } from '@openchamber/sdk/schemas';
import type { GuestMessage, HostMessage } from '@openchamber/sdk';

import { ThemeSystemContext, type ThemeContextValue } from '@/contexts/theme-system-context';
import { getDefaultTheme } from '@/lib/theme/themes';
import { I18nProvider } from '@/lib/i18n';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useGuestsStore } from '@/lib/guests/store';
import type { InstalledGuest } from '@/lib/guests/types';
import { SyncProvider } from '@/sync/sync-context';
import { PluginPane } from './PluginPane';

// The user presses Generate, closes the panel before the model answers, and
// opens it again: the answer reaches the new frame once, through
// `generate-late`, instead of being thrown away with the old frame.
test('a generate answer that arrives after its panel closed reaches the reopened panel once', async () => {
  const dom = new Window({ url: 'http://guest.test', settings: { disableIframePageLoading: true } });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom, document: dom.document, navigator: dom.navigator,
    localStorage: dom.localStorage, getComputedStyle: dom.getComputedStyle.bind(dom), Event: dom.Event, MessageEvent: dom.MessageEvent,
    IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const answers: Array<(text: string) => void> = [];
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const target = String(input instanceof Request ? input.url : input);
    if (target.includes('/frame-grant')) return Response.json({ grant: 'grant-test', expiresAt: Date.now() + 60_000 });
    if (target.includes('/auth/url-token')) return Response.json({ token: 'scoped-test', expiresAt: Date.now() + 60_000 });
    if (target.includes('/api/guests/writer/generate')) {
      return new Promise<Response>((resolve) => { answers.push((text) => resolve(Response.json({ ok: true, result: { text } }))); });
    }
    if (target.includes('/event')) return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
    if (target.includes('/session/active')) return Response.json({});
    if (target.includes('/location')) return Response.json({ directory: '/visible', project: { id: 'project', directory: '/visible', canonical: '/visible' } });
    return Response.json({ data: [] });
  });
  const sdk = OpenCode.make({ baseUrl: 'http://sync.test', fetch: async (request) => {
    const path = new URL(request instanceof Request ? request.url : request.toString()).pathname;
    if (path.endsWith('/event')) return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
    const body = path.endsWith('/location')
      ? { directory: '/visible', project: { id: 'project', directory: '/visible', canonical: '/visible' } }
      : path.endsWith('/session/active') ? {}
      : { data: [] };
    return Response.json(body);
  } });
  const theme = getDefaultTheme(false);
  const themeContext: ThemeContextValue = {
    currentTheme: theme, availableThemes: [theme], customThemeIds: [], setTheme: () => {}, customThemesLoading: false,
    reloadCustomThemes: async () => {}, importTheme: async () => theme, deleteImportedTheme: async () => {},
    isSystemPreference: false, setSystemPreference: () => {}, themeMode: 'light', setThemeMode: () => {},
    lightThemeId: theme.metadata.id, darkThemeId: theme.metadata.id, setLightThemePreference: () => {}, setDarkThemePreference: () => {},
  };
  const writer: InstalledGuest = {
    id: 'writer', storageId: 'store-1', name: 'Writer', icon: 'window', entry: 'panel/index.html', source: 'path',
    capabilities: { requested: ['model'], granted: ['model'] },
  };
  const runtimeKey = getRuntimeKey();
  useGuestsStore.getState().resetForRuntimeSwitch(runtimeKey);
  useGuestsStore.getState().replaceCatalog([writer], runtimeKey);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const restores: Array<() => void> = [];
  const pane = (open: boolean, headless = false) => (
    <I18nProvider><ThemeSystemContext.Provider value={themeContext}>
      <SyncProvider sdk={sdk} directory="/visible">{open ? <PluginPane mode="plugin:writer" surface="panel" headless={headless} /> : null}</SyncProvider>
    </ThemeSystemContext.Provider></I18nProvider>
  );
  // Mount the panel and attach a stand-in for the document inside its frame.
  const openPanel = async (headless = false) => {
    await act(async () => root.render(pane(true, headless)));
    for (let attempt = 0; attempt < 100 && !container.querySelector('iframe'); attempt++) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    }
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
    const send = async (message: GuestMessage) => {
      await act(async () => { window.dispatchEvent(new MessageEvent('message', { source: frameWindow, data: message })); });
    };
    await send({ channel: 'openchamber.sdk', v: 1, type: 'hello' });
    return { received, send };
  };
  const settle = async () => {
    for (let attempt = 0; attempt < 5; attempt++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  };
  const late = (received: HostMessage[]) => received.filter((message) => message.type === 'generate-late');
  try {
    const first = await openPanel();
    expect(first.received.find((message) => message.type === 'ready')).toMatchObject({ payload: { features: { lateGenerateResults: true } } });
    await first.send({ channel: 'openchamber.sdk', v: 1, type: 'generate', id: 'oc-1', payload: { prompt: 'Write a brief' } });
    expect(answers).toHaveLength(1);

    // An answer while the panel is open goes back as the call's result, and nothing is kept.
    await first.send({ channel: 'openchamber.sdk', v: 1, type: 'generate', id: 'oc-2', payload: { prompt: 'Quick one' } });
    answers[1]('Quick.');
    await settle();
    expect(first.received.find((message) => message.type === 'result' && message.id === 'oc-2')).toMatchObject({ ok: true, payload: { text: 'Quick.' } });

    await act(async () => root.render(pane(false)));
    answers[0]('The brief.');
    await settle();
    expect(first.received.some((message) => message.type === 'result' && message.id === 'oc-1')).toBe(false);

    // The hidden pane a slash command loads is nobody's panel: it is not
    // offered the kept answer, and what it asks for is not kept either.
    const hidden = await openPanel(true);
    const hiddenReady = hidden.received.find((message) => message.type === 'ready');
    expect(hiddenReady?.type === 'ready' ? hiddenReady.payload.features?.lateGenerateResults : 'no ready').toBeUndefined();
    await hidden.send({ channel: 'openchamber.sdk', v: 1, type: 'generate-late-listen' });
    expect(late(hidden.received)).toEqual([]);
    await hidden.send({ channel: 'openchamber.sdk', v: 1, type: 'generate', id: 'oc-1', payload: { prompt: 'From a command' } });
    await act(async () => root.render(pane(false)));
    answers[2]('Not kept.');
    await settle();

    const second = await openPanel();
    expect(late(second.received)).toEqual([]);
    await second.send({ channel: 'openchamber.sdk', v: 1, type: 'generate-late-listen' });
    expect(late(second.received).map((message) => message.type === 'generate-late' && message.payload)).toEqual([
      { request: { prompt: 'Write a brief' }, ok: true, result: { text: 'The brief.' } },
    ]);

    // Handed over once: listening again, or another panel, gets nothing more.
    await second.send({ channel: 'openchamber.sdk', v: 1, type: 'generate-late-listen' });
    await act(async () => root.render(pane(false)));
    const third = await openPanel();
    await third.send({ channel: 'openchamber.sdk', v: 1, type: 'generate-late-listen' });
    expect(late(second.received)).toHaveLength(1);
    expect(late(third.received)).toEqual([]);
  } finally {
    await act(async () => root.unmount());
    for (const restore of restores) restore();
    fetch.mockRestore();
    await dom.happyDOM.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
