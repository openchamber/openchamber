import { expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { OpenCode } from '@opencode/client';
import { Window } from 'happy-dom';
import type { GuestMessage, GuestRequest, HostMessage } from '@openchamber/sdk';
import { hostMessageSchema } from '@openchamber/sdk/schemas';

import { ThemeSystemContext, type ThemeContextValue } from '@/contexts/theme-system-context';
import type { InstalledGuest } from '@/lib/guests/types';
import { useGuestsStore } from '@/lib/guests/store';
import { I18nProvider } from '@/lib/i18n';
import { adoptRelayTunnel } from '@/lib/relay/runtime-tunnel';
import { subscribeRuntimeEndpointWillChange, switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { getDefaultTheme } from '@/lib/theme/themes';
import { useConfigStore } from '@/stores/useConfigStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useBackgroundShellsStore, type TrackedShell } from '@/sync/background-shells';
import { SyncProvider } from '@/sync/sync-context';
import { PluginPane } from './PluginPane';

const direct = 'http://direct.test';
const relay = { relayUrl: 'wss://relay.test', serverId: 'fixture', hostEncPubJwk: {} };
const runtimeKey = 'server:fixture';
const guest: InstalledGuest = {
  id: 'status-fixture', name: 'Status fixture', icon: 'window', statusEntry: 'status.html',
  capabilities: { requested: ['sessions', 'shells'], granted: ['sessions', 'shells'] },
  service: { runtime: 'host', granted: true },
};
const envelope = { channel: 'openchamber.sdk', v: 1 } as const;
const lockedState = JSON.stringify({ locked: true });

async function withStatusFrame(run: (fixture: {
  send: (message: GuestMessage) => Promise<void>;
  result: (id: string) => HostMessage | undefined;
  messages: HostMessage[];
  switchToRelay: () => Promise<void>;
  switchServer: (outgoing: GuestMessage) => Promise<void>;
  calls: string[];
  finishWrite: () => void;
}) => Promise<void>) {
  const dom = new Window({ url: 'http://guest.test', settings: { disableIframePageLoading: true } });
  const guestWindow = new Window();
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
    getComputedStyle: dom.getComputedStyle.bind(dom), CustomEvent: dom.CustomEvent, MessageEvent: dom.MessageEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const calls: string[] = [];
  let finishWrite = () => {};
  const write = new Promise<Response>((resolve) => {
    finishWrite = () => resolve(Response.json({ status: 204, body: '' }));
  });
  const answer = (transport: string, input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(input instanceof Request ? input.url : String(input), dom.location.href).pathname;
    if (path.endsWith('/service/request')) {
      const request: GuestRequest = JSON.parse(String(init?.body));
      calls.push(`${transport} ${request.method} ${request.path}`);
      if (request.method === 'POST') return write;
      return Response.json({ status: 200, body: lockedState });
    }
    if (path.endsWith('/frame-grant')) return Response.json({ grant: 'fixture', expiresAt: Date.now() + 60_000 });
    if (path === '/auth/url-token') return Response.json({ token: 'fixture', expiresAt: Date.now() + 60_000 });
    if (path === '/api/session-warming') return Response.json({ revision: 0, enabled: false, minutes: 60, sessions: [] });
    if (transport === 'relay' && path === '/api/openchamber/events') {
      const event = { type: 'openchamber:guest-service-event', properties: { guestId: guest.id, topic: 'state', data: { locked: true } } };
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)); },
      }), { headers: { 'content-type': 'text/event-stream' } });
    }
    if (path.endsWith('/event') || path.endsWith('/events')) return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
    if (path.endsWith('/session/active')) return Response.json({});
    return Response.json({ data: [] });
  };
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => answer('direct', input, init));
  const sdk = () => OpenCode.make({ baseUrl: direct, fetch: async (input) => answer('sync', input) });
  const theme = getDefaultTheme(false);
  const themeContext: ThemeContextValue = {
    currentTheme: theme, availableThemes: [theme], customThemeIds: [], setTheme: () => {}, customThemesLoading: false,
    reloadCustomThemes: async () => {}, importTheme: async () => theme, deleteImportedTheme: async () => {},
    isSystemPreference: false, setSystemPreference: () => {}, themeMode: 'light', setThemeMode: () => {},
    lightThemeId: theme.metadata.id, darkThemeId: theme.metadata.id, setLightThemePreference: () => {}, setDarkThemePreference: () => {},
  };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const previousTransport = useConfigStore.getState().settingsMessageStreamTransport;
  const previousProjects = useProjectsStore.getState();
  const previousShells = useBackgroundShellsStore.getState();
  const messages: HostMessage[] = [];
  const post = spyOn(guestWindow, 'postMessage').mockImplementation((data) => { messages.push(hostMessageSchema.parse(data)); });
  const render = () => root.render(
    <I18nProvider><ThemeSystemContext.Provider value={themeContext}>
      <SyncProvider sdk={sdk()} directory="/visible"><PluginPane mode="plugin:status-fixture" surface="status" /></SyncProvider>
    </ThemeSystemContext.Provider></I18nProvider>,
  );
  try {
    useConfigStore.setState({ settingsMessageStreamTransport: 'sse' });
    switchRuntimeEndpoint({ apiBaseUrl: direct, runtimeKey });
    useGuestsStore.getState().resetForRuntimeSwitch(runtimeKey);
    useGuestsStore.getState().replaceCatalog([guest], runtimeKey);
    await act(async () => render());
    const frame = container.querySelector('iframe');
    if (!frame) throw new Error('Status frame did not mount');
    Object.defineProperty(frame, 'contentWindow', { configurable: true, value: guestWindow });
    const source = frame.contentWindow;
    const dispatch = (data: GuestMessage) => window.dispatchEvent(new MessageEvent('message', { source, data }));
    const send = async (message: GuestMessage) => { await act(async () => { dispatch(message); }); };
    await send({ ...envelope, type: 'hello' });
    expect(messages.some((message) => message.type === 'ready')).toBe(true);
    const switchToRelay = async () => {
      await act(async () => {
        adoptRelayTunnel(relay, {
          fetch: async (input, init) => answer('relay', input, init),
          openWebSocket() { throw new Error('Mobile uses SSE'); },
          getStatus: () => ({ state: 'connected' }),
          subscribeStatus: () => () => undefined,
          retry: () => undefined,
          close: () => undefined,
        });
        switchRuntimeEndpoint({ apiBaseUrl: '', runtimeKey, relay });
        render();
      });
    };
    await run({
      send, messages, calls, finishWrite, switchToRelay,
      result: (id) => messages.find((message) => message.type === 'result' && message.id === id),
      switchServer: async (outgoing) => {
        await act(async () => {
          const other = 'server:other';
          // This listener runs after the bridge's retirement callback, while
          // React still has the outgoing iframe mounted.
          const unsubscribe = subscribeRuntimeEndpointWillChange(() => { dispatch(outgoing); });
          try {
            switchRuntimeEndpoint({ apiBaseUrl: 'http://other.test', runtimeKey: other });
          } finally {
            unsubscribe();
          }
          useGuestsStore.getState().resetForRuntimeSwitch(other);
          useGuestsStore.getState().replaceCatalog([guest], other);
          render();
        });
      },
    });
  } finally {
    await act(async () => { finishWrite(); root.unmount(); });
    switchRuntimeEndpoint({ apiBaseUrl: '', runtimeKey: 'url:default' });
    useGuestsStore.getState().resetForRuntimeSwitch('url:default');
    useProjectsStore.setState(previousProjects);
    useBackgroundShellsStore.setState(previousShells);
    useConfigStore.setState({ settingsMessageStreamTransport: previousTransport });
    fetch.mockRestore();
    post.mockRestore();
    await guestWindow.happyDOM.close();
    await dom.happyDOM.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

test('an open Work Status frame can read fresh state over the relay after using a direct connection', async () => {
  await withStatusFrame(async ({ send, result, switchToRelay, calls }) => {
    const read = (id: string) => send({ ...envelope, id, type: 'service-request', payload: { method: 'GET', path: '/state' } });
    await read('before');
    expect(result('before')).toMatchObject({ ok: true, payload: { status: 200, body: lockedState } });
    await switchToRelay();
    await read('after');
    expect(calls).toEqual(['direct GET /state', 'relay GET /state']);
    expect(result('after')).toMatchObject({ ok: true, payload: { status: 200, body: lockedState } });
  });
});

test('switching to relay never resends an in-flight write', async () => {
  await withStatusFrame(async ({ send, result, switchToRelay, calls, finishWrite }) => {
    await send({ ...envelope, id: 'write', type: 'service-request', payload: { method: 'POST', path: '/unlock' } });
    expect(calls).toEqual(['direct POST /unlock']);
    await switchToRelay();
    await act(async () => finishWrite());
    expect(calls).toEqual(['direct POST /unlock']);
    expect(result('write')).toMatchObject({ ok: true, payload: { status: 204 } });
  });
});

test('the outgoing frame cannot call the same guest ID on another server', async () => {
  await withStatusFrame(async ({ send, result, switchServer, calls }) => {
    const read = (id: string): GuestMessage => ({ ...envelope, id, type: 'service-request', payload: { method: 'GET', path: '/state' } });
    await switchServer(read('during-switch'));
    await send(read('after-switch'));
    expect(calls).toEqual([]);
    expect(result('during-switch')).toBeUndefined();
    expect(result('after-switch')).toBeUndefined();
  });
});

test('existing guest subscriptions survive a same-server transport switch', async () => {
  await withStatusFrame(async ({ send, messages, result, switchToRelay }) => {
    await send({ ...envelope, id: 'projects', type: 'workspace-subscribe', payload: { subscriptionId: 'projects', query: { kind: 'projects' } } });
    await send({ ...envelope, id: 'shells', type: 'shells-subscribe', payload: { subscriptionId: 'shells', scope: { kind: 'global' } } });
    expect(result('projects')).toMatchObject({ ok: true });
    expect(result('shells')).toMatchObject({ ok: true });
    await switchToRelay();
    const project = { id: 'new-project', path: '/new-project', label: 'New project', addedAt: 1 };
    const shell: TrackedShell = { id: 'new-shell', sessionID: 'session', command: 'test', startedAt: 1, directory: '/new-project', background: true, file: 'shell.log' };
    await act(async () => {
      useProjectsStore.setState({ projects: [project], hasServerSnapshot: true });
      useBackgroundShellsStore.setState({ byId: new Map([[shell.id, shell]]) });
    });
    expect(messages.filter((message) => message.type === 'workspace').at(-1)).toMatchObject({
      payload: { subscriptionId: 'projects', snapshot: { projects: [{ id: project.id }] } },
    });
    expect(messages.filter((message) => message.type === 'shells').at(-1)).toMatchObject({
      payload: { subscriptionId: 'shells', snapshot: { shells: [{ id: shell.id }] } },
    });
    expect(messages.find((message) => message.type === 'service-event')).toMatchObject({
      payload: { topic: 'state', data: { locked: true } },
    });
  });
});
