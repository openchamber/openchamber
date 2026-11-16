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
import { opencodeClient } from '@/lib/opencode/client';
import { applyBackgroundShellEvents, resetBackgroundShells } from '@/sync/background-shells';
import { stopForegroundShell } from '@/components/chat/message/parts/foregroundShellStop';
import { PluginPane } from './PluginPane';

// The command's chat row is stopping a command the turn waits for. An
// extension that stops the same command meanwhile is refused, so only the
// row's stop posts the note to the agent and removes the command.
test('an extension cannot stop a command its chat row is already stopping', async () => {
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
    capabilities: { requested: ['shells'], granted: ['shells'] },
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
  resetBackgroundShells();
  let finishBackground: (() => void) | undefined;
  const background = spyOn(opencodeClient, 'backgroundSessionWork').mockImplementation(() => {
    applyBackgroundShellEvents('/visible', [{
      type: 'message.tool.transition',
      properties: {
        sessionID: 'ses_root', messageID: 'msg_1', partID: 'call_sh_waited',
        transition: { kind: 'success', output: '', metadata: { status: 'running', shellID: 'sh_waited' }, executed: true, end: 2 },
      },
    }]);
    return new Promise<void>((resolve) => { finishBackground = resolve; });
  });
  const stop = spyOn(opencodeClient, 'stopBackgroundShells').mockResolvedValue(undefined);
  try {
    const panel = await openPanel();
    applyBackgroundShellEvents('/visible', [{ type: 'shell.started', properties: { shell: {
      id: 'sh_waited', sessionID: 'ses_root', command: 'bun run test', file: '/tmp/sh_waited.out', startedAt: 1,
    } } }]);
    const rowStop = stopForegroundShell({
      sessionID: 'ses_root',
      sessionDirectory: '/visible',
      shell: { shellID: 'sh_waited', shellDirectory: '/visible', command: 'bun run test' },
    });

    await panel.send({ channel: 'openchamber.sdk', v: 1, type: 'shell-stop', id: 'oc-1', payload: { shellId: 'sh_waited' } });
    await settle();
    expect(panel.received.find((message) => message.type === 'result' && message.id === 'oc-1')).toMatchObject({ ok: false, code: 'HOST_REJECTED' });
    expect(stop).not.toHaveBeenCalled();

    finishBackground?.();
    await act(async () => { await rowStop; });
    expect(stop.mock.calls).toEqual([[{
      sessionID: 'ses_root',
      sessionDirectory: '/visible',
      shells: [{ shellID: 'sh_waited', shellDirectory: '/visible', command: 'bun run test' }],
    }]]);
  } finally {
    finishBackground?.();
    background.mockRestore();
    stop.mockRestore();
    resetBackgroundShells();
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
