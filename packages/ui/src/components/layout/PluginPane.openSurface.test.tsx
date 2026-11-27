import { expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { OpenCode } from '@opencode/client';
import { Window } from 'happy-dom';
import { hostMessageSchema } from '@openchamber/sdk/schemas';
import type { GuestMessage, HostMessage } from '@openchamber/sdk';

import { ThemeSystemContext, type ThemeContextValue } from '@/contexts/theme-system-context';
import { getDefaultTheme } from '@/lib/theme/themes';
import { useContextWindowStore } from '@/lib/contextWindow/store';
import { I18nProvider } from '@/lib/i18n';
import { markMiniChatWindow } from '@/lib/miniChatWindow';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useGuestsStore } from '@/lib/guests/store';
import type { InstalledGuest } from '@/lib/guests/types';
import { shownContextModes } from '@/lib/workspace/zones';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { SyncProvider } from '@/sync/sync-context';
import { ChatColumnSessionContext, type ChatColumnSession } from '@/components/chat/chatColumnSession';
import { PluginPane } from './PluginPane';
import { useRightSlotStore } from './rightSlot';

// A Work Status section in a chat draft without a project has no directory of
// its own. Its `openSurface` opens the extension's panel where the rail icon
// does, keeps it open when asked again, and refuses when nothing can open.
test('a status section without a project opens its panel under the chat, as the rail icon does', async () => {
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
  const repro: InstalledGuest = {
    id: 'repro', name: 'Repro', icon: 'window', entry: 'panel/index.html', statusEntry: 'panel/status.html', source: 'path',
    capabilities: { requested: [], granted: [] },
  };
  const chatDirectory = '/home/test/chats/one';
  const previousDraft = useSessionUIStore.getState().newSessionDraft;
  const previousSessionId = useSessionUIStore.getState().currentSessionId;
  const previousSessionDirectory = useSessionUIStore.getState().currentSessionDirectory;
  const previousDirectory = useDirectoryStore.getState().currentDirectory;
  const previousPlacement = useUIStore.getState().contextSurfaceZones;
  useSessionUIStore.setState({
    currentSessionId: null,
    newSessionDraft: { ...previousDraft, open: true, target: 'chat', directoryOverride: null, preparedChatDirectory: chatDirectory },
  });
  const runtimeKey = getRuntimeKey();
  useGuestsStore.getState().resetForRuntimeSwitch(runtimeKey);
  useGuestsStore.getState().replaceCatalog([repro], runtimeKey);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const restores: Array<() => void> = [];
  const shown = () => {
    const state = useUIStore.getState();
    return [...shownContextModes(state.contextPanelByDirectory[chatDirectory], state.contextSurfaceZones)];
  };
  const renderStatus = (statusDirectory: string | null, column: ChatColumnSession | null = null) => act(async () => root.render(
    <I18nProvider><ThemeSystemContext.Provider value={themeContext}>
      <SyncProvider sdk={sdk} directory="/visible"><ChatColumnSessionContext.Provider value={column}>
        <PluginPane mode="plugin:repro" surface="status" item={null} statusDirectory={statusDirectory} />
      </ChatColumnSessionContext.Provider></SyncProvider>
    </ThemeSystemContext.Provider></I18nProvider>,
  ));
  try {
    await renderStatus(null);
    for (let attempt = 0; attempt < 100 && !container.querySelector('iframe'); attempt++) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    }
    const frame = container.querySelector<HTMLIFrameElement>('iframe');
    if (!frame) throw new Error('Status frame did not mount');
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
    const result = (id: string) => received.find((message) => message.type === 'result' && message.id === id);
    await send({ channel: 'openchamber.sdk', v: 1, type: 'hello' });
    expect(received.find((message) => message.type === 'ready')).toMatchObject({ payload: { surface: 'status', directory: null } });

    await send({ channel: 'openchamber.sdk', v: 1, type: 'open-surface', id: 'open-1', payload: { surfaceId: 'plugin:repro' } });
    expect(result('open-1')).toMatchObject({ ok: true });
    expect(shown()).toEqual(['plugin:repro']);

    // Asking again keeps it open; the rail icon would toggle it closed.
    await send({ channel: 'openchamber.sdk', v: 1, type: 'open-surface', id: 'open-2', payload: { surfaceId: 'plugin:repro' } });
    expect(result('open-2')).toMatchObject({ ok: true });
    expect(shown()).toEqual(['plugin:repro']);

    const item = { kind: 'link', identifier: 'DEMO-1' } as const;
    await send({ channel: 'openchamber.sdk', v: 1, type: 'open-surface', id: 'foreign-panel', payload: {
      surfaceId: 'plugin:another-extension', options: { item },
    } });
    expect(result('foreign-panel')).toMatchObject({ ok: false, code: 'HOST_REJECTED' });
    expect(shown()).toEqual(['plugin:repro']);

    await send({ channel: 'openchamber.sdk', v: 1, type: 'open-surface', id: 'invalid-options', payload: {
      surfaceId: 'notes', options: null,
    } });
    expect(result('invalid-options')).toMatchObject({ ok: false, code: 'HOST_REJECTED' });
    expect(shown()).toEqual(['plugin:repro']);

    await renderStatus('/another-project');
    await send({ channel: 'openchamber.sdk', v: 1, type: 'open-surface', id: 'foreign-directory', payload: {
      surfaceId: 'plugin:repro', options: { item },
    } });
    expect(result('foreign-directory')).toMatchObject({ ok: false, code: 'UNSUPPORTED' });
    await renderStatus(null);

    useUIStore.setState({ contextSurfaceZones: { notes: 'bottom' } });
    useRightSlotStore.setState({ chatCovered: true });
    await send({ channel: 'openchamber.sdk', v: 1, type: 'open-surface', id: 'covered-zone', payload: {
      surfaceId: 'notes', options: { tab: 'plans' },
    } });
    expect(result('covered-zone')).toMatchObject({ ok: false, code: 'UNSUPPORTED' });
    expect(shown()).toEqual(['plugin:repro']);
    useRightSlotStore.setState({ chatCovered: false });

    useContextWindowStore.setState({ detached: true });
    await send({ channel: 'openchamber.sdk', v: 1, type: 'open-surface', id: 'detached-panel', payload: {
      surfaceId: 'plugin:repro', options: { item },
    } });
    expect(result('detached-panel')).toMatchObject({ ok: false, code: 'HOST_UNAVAILABLE' });
    useContextWindowStore.setState({ detached: false });

    // A chat column opens only beside a chat, so alone it shows nothing.
    await send({ channel: 'openchamber.sdk', v: 1, type: 'open-surface', id: 'open-chat', payload: { surfaceId: 'chat' } });
    expect(result('open-chat')).toMatchObject({ ok: false, code: 'UNSUPPORTED' });
    expect(shown()).toEqual(['plugin:repro']);

    await act(async () => {
      useSessionUIStore.setState({ newSessionDraft: { ...previousDraft, open: false } });
      useDirectoryStore.setState({ currentDirectory: chatDirectory });
    });
    await renderStatus(null, { sessionId: 'ses-pinned', directory: '/another-project' });
    await send({ channel: 'openchamber.sdk', v: 1, type: 'open-surface', id: 'pinned-chat', payload: {
      surfaceId: 'plugin:repro', options: { item },
    } });
    expect(result('pinned-chat')).toMatchObject({ ok: false, code: 'UNSUPPORTED' });
    await renderStatus(null);

    await act(async () => {
      useSessionUIStore.setState({
        newSessionDraft: { ...previousDraft, open: false },
        currentSessionDirectory: '/spaces/0123456789ab',
      });
      useDirectoryStore.setState({ currentDirectory: '/spaces/0123456789ab' });
    });
    await send({ channel: 'openchamber.sdk', v: 1, type: 'open-surface', id: 'space-knowledge', payload: {
      surfaceId: 'notes', options: { tab: 'plans' },
    } });
    expect(result('space-knowledge')).toMatchObject({ ok: false, code: 'UNSUPPORTED' });

    // Before the app knows any directory, nothing can open.
    await act(async () => {
      useSessionUIStore.setState({ newSessionDraft: { ...previousDraft, open: false } });
      useDirectoryStore.setState({ currentDirectory: '' });
    });
    await send({ channel: 'openchamber.sdk', v: 1, type: 'open-surface', id: 'open-none', payload: { surfaceId: 'plugin:repro' } });
    expect(result('open-none')).toMatchObject({ ok: false, code: 'NO_DIRECTORY' });

    await act(async () => {
      useSessionUIStore.setState({
        newSessionDraft: { ...previousDraft, open: true, target: 'chat', directoryOverride: null, preparedChatDirectory: chatDirectory },
      });
    });
    markMiniChatWindow();
    await send({ channel: 'openchamber.sdk', v: 1, type: 'open-surface', id: 'mini-chat', payload: {
      surfaceId: 'plugin:repro', options: { item },
    } });
    expect(result('mini-chat')).toMatchObject({ ok: false, code: 'UNSUPPORTED' });
  } finally {
    await act(async () => root.unmount());
    for (const restore of restores) restore();
    fetch.mockRestore();
    useSessionUIStore.setState({ newSessionDraft: previousDraft, currentSessionId: previousSessionId, currentSessionDirectory: previousSessionDirectory });
    useDirectoryStore.setState({ currentDirectory: previousDirectory });
    useUIStore.setState({ contextSurfaceZones: previousPlacement });
    useRightSlotStore.setState({ chatCovered: false });
    useContextWindowStore.setState({ detached: false });
    useGuestsStore.getState().resetForRuntimeSwitch(runtimeKey);
    await dom.happyDOM.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
