import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EventEmitter, once } from 'node:events';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { z } from 'zod';

import { I18nProvider } from '@/lib/i18n';
import { clearRuntimeUrlAuthToken, setRuntimeUrlAuthToken } from '@/lib/runtime-auth';
import { configureRuntimeUrlResolver, getRuntimeUrlResolver, setRuntimeUrlResolver } from '@/lib/runtime-url';
import { getDeferredSafeStorage } from '@/stores/utils/safeStorage';
import { MobileBrowserSurface } from './MobileBrowserSurface';
import { saveMobileBrowserSelection, type MobileBrowserScope } from './mobileBrowserSelection';

const commandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('list') }),
  z.object({ type: z.literal('attach'), sessionId: z.string() }),
  z.object({ type: z.literal('attachTab'), tabId: z.string() }),
]);
type Command = z.infer<typeof commandSchema>;
type Peer = { readonly directory: string; readonly commands: Command[]; closed: boolean };
type FixtureSocket = { readonly data: Peer; send(message: string): number };
type FixtureServer = {
  readonly url: URL;
  upgrade(request: Request, options: { readonly data: Peer }): boolean;
  stop(closeActiveConnections: boolean): Promise<void>;
};
declare const Bun: {
  serve(options: {
    readonly hostname: string;
    readonly port: number;
    fetch(request: Request, server: FixtureServer): Response | void;
    readonly websocket: {
      open(socket: FixtureSocket): void;
      message(socket: FixtureSocket, message: string | Buffer): void;
      close(socket: FixtureSocket): void;
    };
  }): FixtureServer;
};

const scope = { runtimeKey: 'runtime:first', directory: '/project' };
const selection = { sessionId: 'session-saved', serverTargetId: 'sc:selected' };
const originalResolver = getRuntimeUrlResolver();
const originalGlobals = new Map<string, PropertyDescriptor | undefined>();
const events = new EventEmitter();
let peers: Peer[] = [];
let server: FixtureServer | undefined;
let dom: Window | undefined;
let root: Root | undefined;
let host: HTMLDivElement;

beforeEach(() => {
  peers = [];
  server = undefined;
  dom = undefined;
  root = undefined;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request, currentServer) {
      const url = new URL(request.url);
      if (url.pathname !== '/api/browser-surface' || url.searchParams.get('oc_url_token') !== 'surface-test') {
        return new Response(null, { status: 403 });
      }
      const peer: Peer = { directory: url.searchParams.get('directory') ?? '', commands: [], closed: false };
      if (currentServer.upgrade(request, { data: peer })) return;
      return new Response(null, { status: 400 });
    },
    websocket: {
      open(socket) {
        peers.push(socket.data);
        socket.send(JSON.stringify({ type: 'hello' }));
      },
      message(socket, message) {
        const command = commandSchema.parse(JSON.parse(String(message)));
        socket.data.commands.push(command);
        switch (command.type) {
          case 'list':
            socket.send(JSON.stringify({ type: 'list', sessions: [] }));
            events.emit('ready');
            break;
          case 'attach':
            socket.send(JSON.stringify({
              type: 'attached',
              session: { id: command.sessionId, directory: socket.data.directory, persistence: 'project' },
              tabs: [
                { id: 'sc:first', targetId: 'first', url: 'https://first.example' },
                { id: 'sc:selected', targetId: 'selected', url: 'https://selected.example' },
              ],
            }));
            break;
          case 'attachTab':
            events.emit('ready');
            break;
        }
      },
      close(socket) {
        socket.data.closed = true;
        events.emit('closed');
      },
    },
  });
  dom = new Window({ url: server.url.toString() });
  const globals = {
    window: dom, document: dom.document, navigator: dom.navigator,
    HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node,
    Event: dom.Event, CustomEvent: dom.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(globals)) {
    originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  getDeferredSafeStorage().clear();
  configureRuntimeUrlResolver({ apiBaseUrl: server.url.toString() });
  setRuntimeUrlAuthToken('surface-test', Date.now() + 60_000);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  await server?.stop(true);
  events.removeAllListeners();
  getDeferredSafeStorage().clear();
  clearRuntimeUrlAuthToken();
  setRuntimeUrlResolver(originalResolver);
  await dom?.happyDOM.abort();
  for (const [name, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  originalGlobals.clear();
});

const renderSurface = async (active: boolean, nextScope = scope): Promise<void> => {
  const currentRoot = root;
  if (!currentRoot) throw new Error('Expected the browser surface test root');
  await act(async () => {
    currentRoot.render(<I18nProvider><MobileBrowserSurface active={active} scope={nextScope} /></I18nProvider>);
  });
};

const openSurface = async (nextScope: MobileBrowserScope = scope): Promise<Peer> => {
  const ready = once(events, 'ready');
  await renderSurface(true, nextScope);
  await act(async () => { await ready; });
  const peer = peers.at(-1);
  if (!peer) throw new Error('Expected a connected browser surface');
  return peer;
};

describe('MobileBrowserSurface', () => {
  test('keeps the viewer and transport absent when inactive', async () => {
    // Given a previous browser selection.
    saveMobileBrowserSelection(scope, selection);
    // When the drawer keeps the browser inactive.
    await renderSurface(false);
    // Then no viewer or browser connection mounts.
    expect(host.querySelector('canvas')).toBeNull();
    expect(peers).toHaveLength(0);
  });

  test('attaches the saved session and selected server tab when opened', async () => {
    // Given a selection whose tab is not the session's first tab.
    saveMobileBrowserSelection(scope, selection);
    // When the browser is opened.
    const peer = await openSurface();
    // Then the real viewer attaches that exact remote page.
    expect(host.querySelector('canvas')).not.toBeNull();
    expect(peer.commands).toEqual([
      { type: 'attach', sessionId: selection.sessionId },
      { type: 'attachTab', tabId: selection.serverTargetId },
    ]);
  });

  test('closes the real browser connection when deactivated', async () => {
    // Given an attached viewer.
    saveMobileBrowserSelection(scope, selection);
    const peer = await openSurface();
    const closed = once(events, 'closed');
    // When another tab or a closed drawer deactivates the browser.
    await renderSurface(false);
    await closed;
    // Then the canvas and its WebSocket are released.
    expect(host.querySelector('canvas')).toBeNull();
    expect(peer.closed).toBe(true);
  });

  test('reads the latest saved selection when reopened', async () => {
    // Given a closed viewer and a selection updated while it was inactive.
    saveMobileBrowserSelection(scope, selection);
    await openSurface();
    const closed = once(events, 'closed');
    await renderSurface(false);
    await closed;
    saveMobileBrowserSelection(scope, { sessionId: 'session-new', serverTargetId: 'sc:first' });
    // When the same component is activated again.
    const reopened = await openSurface();
    // Then the new transport restores the latest selection.
    expect(peers).toHaveLength(2);
    expect(reopened.commands).toEqual([
      { type: 'attach', sessionId: 'session-new' },
      { type: 'attachTab', tabId: 'sc:first' },
    ]);
  });

  test('reattaches the selected session and target when transport changes within the same runtime', async () => {
    // Given an attached viewer on the current runtime.
    saveMobileBrowserSelection(scope, selection);
    const previous = await openSurface();
    const closed = once(events, 'closed');
    const ready = once(events, 'ready');
    // When a new transport is published for the same runtime.
    await act(async () => {
      window.dispatchEvent(new CustomEvent('openchamber:runtime-endpoint-changed', { detail: {
        previousRuntimeKey: scope.runtimeKey, runtimeKey: scope.runtimeKey,
        previousApiBaseUrl: window.location.origin, apiBaseUrl: window.location.origin,
      } }));
      await Promise.all([closed, ready]);
    });
    // Then the previous connection closes and its real attachment is restored.
    expect(previous.closed).toBe(true);
    expect(peers).toHaveLength(2);
    expect(peers[1]?.commands).toEqual([
      { type: 'attach', sessionId: selection.sessionId },
      { type: 'attachTab', tabId: selection.serverTargetId },
    ]);
  });

  test('releases the socket while hidden and restores the selected page when visible again', async () => {
    // Given an attached viewer with a saved remote page.
    saveMobileBrowserSelection(scope, selection);
    const previous = await openSurface();
    const closed = once(events, 'closed');
    // When the document is hidden and then shown again.
    await act(async () => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      await closed;
    });
    expect(previous.closed).toBe(true);
    const ready = once(events, 'ready');
    await act(async () => {
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      await ready;
    });
    // Then a fresh socket reattaches the same session and selected target.
    expect(peers).toHaveLength(2);
    expect(peers[1]?.commands).toEqual([
      { type: 'attach', sessionId: selection.sessionId },
      { type: 'attachTab', tabId: selection.serverTargetId },
    ]);
  });

  for (const nextScope of [
    { runtimeKey: 'runtime:second', directory: scope.directory },
    { runtimeKey: scope.runtimeKey, directory: '/other-project' },
  ]) {
    test(`releases the old viewer without reusing its selection when scope changes to ${JSON.stringify(nextScope)}`, async () => {
      // Given an active browser scoped to the original runtime and project.
      saveMobileBrowserSelection(scope, selection);
      const previous = await openSurface();
      const closed = once(events, 'closed');
      // When the owning runtime or project changes.
      const next = await openSurface(nextScope);
      await closed;
      // Then the old connection closes and the new scope requests its own sessions.
      expect(previous.closed).toBe(true);
      expect(next.directory).toBe(nextScope.directory);
      expect(next.commands).toEqual([{ type: 'list' }]);
    });
  }
});
