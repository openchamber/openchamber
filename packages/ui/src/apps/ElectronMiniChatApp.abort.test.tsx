import { plugin } from 'bun';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';


// Bun does not implement Vite's worker asset-query imports.
plugin({
  name: 'mini-chat-abort-worker-url',
  setup(build) {
    build.onLoad({ filter: /\.worker\.ts\?worker&url$/ }, ({ path }) => ({
      contents: `export default ${JSON.stringify(`blob:${path}`)};`,
      loader: 'js',
    }));
  },
});

const directory = '/workspace/mini-chat-abort';
const sessionId = 'ses_mini';

// The real Mini Chat app root, with its own provider placement: the
// shortcuts read the session's activity through the sync runtime, so they
// must run under SyncProvider. Then double Escape from its composer stops
// Mini Chat's own running session while the draft stays typed.
test('Mini Chat mounts its shortcuts under the sync provider, and double Escape stops its own run', async () => {
  const dom = new Window({ url: `http://mini-chat.test/?mode=session&sessionId=${sessionId}&directory=${encodeURIComponent(directory)}` });
  const requests: { method: string; path: string }[] = [];
  const fetchResponse = async (input: Request | URL | string, init?: RequestInit) => {
    const request = input instanceof Request ? input : null;
    const path = new URL(request ? request.url : input.toString(), 'http://mini-chat.test').pathname;
    requests.push({ method: request?.method ?? init?.method ?? 'GET', path });
    if (path.endsWith('/event')) return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
    return new Promise<Response>(() => undefined);
  };
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({
    window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
    sessionStorage: dom.sessionStorage, location: dom.location,
    Element: dom.Element, HTMLElement: dom.HTMLElement, HTMLInputElement: dom.HTMLInputElement,
    HTMLTextAreaElement: dom.HTMLTextAreaElement, Node: dom.Node, Event: dom.Event,
    KeyboardEvent: dom.KeyboardEvent, CustomEvent: dom.CustomEvent, MutationObserver: dom.MutationObserver,
    ResizeObserver: dom.ResizeObserver, customElements: dom.customElements, getComputedStyle: dom.getComputedStyle.bind(dom),
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (handle: number) => clearTimeout(handle),
    IS_REACT_ACT_ENVIRONMENT: true,
    fetch: fetchResponse,
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }

  const { ElectronMiniChatApp } = await import('./ElectronMiniChatApp');
  const { createWebAPIs } = await import('../../../web/src/api/index');
  const { I18nProvider } = await import('@/lib/i18n');
  const { ThemeSystemProvider } = await import('@/contexts/ThemeSystemContext');
  const { ThemeProvider } = await import('@/components/providers/ThemeProvider');
  const { useSessionUIStore } = await import('@/sync/session-ui-store');
  const { getSyncChildStores } = await import('@/sync/sync-refs');
  const { opencodeClient } = await import('@/lib/opencode/client');
  opencodeClient.reconnectToRuntimeBaseUrl();

  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => {
      // As renderElectronMiniChatApp mounts it (the auth gate aside).
      root.render(
        <I18nProvider>
          <ThemeSystemProvider>
            <ThemeProvider>
              <ElectronMiniChatApp apis={createWebAPIs()} />
            </ThemeProvider>
          </ThemeSystemProvider>
        </I18nProvider>,
      );
    });
    // Opening Mini Chat renders, with no "must be used within <SyncProvider>".
    expect(host.childElementCount).toBeGreaterThan(0);

    // The session Mini Chat opened on is listed and running, and selected as
    // its bootstrap selects it.
    await act(async () => {
      getSyncChildStores().getChild(directory)?.setState({
        session: [{ id: sessionId, projectID: 'project', directory, title: 'Mini', cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 } }],
        session_status: { [sessionId]: { type: 'busy' } },
        sessionStatusReady: true,
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const { useProjectsStore } = await import('@/stores/useProjectsStore');
    await act(async () => {
      useProjectsStore.setState({ projects: [{ id: 'project', path: directory }], activeProjectId: 'project' });
      useSessionUIStore.getState().setCurrentSession(sessionId, directory);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(useSessionUIStore.getState().currentSessionId).toBe(sessionId);

    const composer = document.createElement('div');
    composer.dataset.chatInput = 'true';
    composer.contentEditable = 'true';
    composer.textContent = 'a draft typed during the run';
    document.body.append(composer);
    const pressEscape = async () => {
      const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      await act(async () => { composer.dispatchEvent(event); await Promise.resolve(); });
      return event;
    };
    const aborts = () => requests.filter((request) => request.method === 'POST' && request.path.includes(sessionId) && request.path.endsWith('/interrupt')).length;

    expect((await pressEscape()).defaultPrevented).toBe(true);
    expect(aborts()).toBe(0);
    await pressEscape();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(aborts()).toBe(1);
    expect(composer.textContent).toBe('a draft typed during the run');
  } finally {
    await act(async () => root.unmount());
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    await dom.happyDOM.close();
  }
});
