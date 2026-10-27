import { afterAll, beforeEach, expect, spyOn, test } from 'bun:test';
import { plugin } from 'bun';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';
import type { RuntimeAPIs } from '@/lib/api/types';

/**
 * While a draft's session is being created the composer keeps taking text, but
 * sending waits: Send does nothing, the typed text stays, and a status line
 * says the session is on its way. Once it exists, sending works again.
 */

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  // CodeMirror's coordsAtPos tests `instanceof Window` on its scroll targets.
  Window,
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  localStorage: browser.localStorage,
  sessionStorage: browser.sessionStorage,
  Node: browser.Node,
  Text: browser.Text,
  Element: browser.Element,
  HTMLElement: browser.HTMLElement,
  HTMLInputElement: browser.HTMLInputElement,
  HTMLTextAreaElement: browser.HTMLTextAreaElement,
  HTMLFormElement: browser.HTMLFormElement,
  Range: browser.Range,
  Selection: browser.Selection,
  DocumentFragment: browser.DocumentFragment,
  Event: browser.Event,
  KeyboardEvent: browser.KeyboardEvent,
  MouseEvent: browser.MouseEvent,
  FocusEvent: browser.FocusEvent,
  InputEvent: browser.InputEvent,
  CustomEvent: browser.CustomEvent,
  MutationObserver: browser.MutationObserver,
  ResizeObserver: browser.ResizeObserver,
  IntersectionObserver: browser.IntersectionObserver,
  matchMedia: browser.matchMedia.bind(browser),
  getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  customElements: browser.customElements,
  HTMLDivElement: browser.HTMLDivElement,
  HTMLSpanElement: browser.HTMLSpanElement,
  SVGElement: browser.SVGElement,
  ShadowRoot: browser.ShadowRoot,
  CSSStyleSheet: browser.CSSStyleSheet,
  DOMParser: browser.DOMParser,
  IS_REACT_ACT_ENVIRONMENT: true,
});

const PROJECT = '/repo';

spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
  const url = new URL(input instanceof Request ? input.url : input.toString(), 'http://localhost/');
  if (url.pathname.endsWith('/location')) {
    return Response.json({ directory: PROJECT, project: { id: 'project', directory: PROJECT, canonical: PROJECT } });
  }
  if (url.pathname.endsWith('/session')) return Response.json({ data: [] });
  return Response.json({});
});

// Vite-only module forms the composer's import graph reaches, loaded as the keystroke test does.
plugin({
  name: 'composer-draft-session-creating-vite-modules',
  setup(build) {
    build.onLoad({ filter: /markdown-shiki\.worker\.ts\?worker&url$/ }, () => ({ contents: 'export default "";', loader: 'js' }));
    build.onLoad({ filter: /useProviderLogo\.ts$/ }, ({ path }) => {
      const directory = resolve(dirname(path), '../assets/provider-logos');
      const logos = Object.fromEntries(readdirSync(directory).filter((name) => name.endsWith('.svg')).map((name) => [
        `../assets/provider-logos/${name}`, pathToFileURL(resolve(directory, name)).href,
      ]));
      return { contents: readFileSync(path, 'utf8').replace(/import\.meta\.glob<string>\([\s\S]*?\);/, `${JSON.stringify(logos)};`), loader: 'ts' };
    });
  },
});

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { EditorView } = await import('@codemirror/view');
const { I18nProvider } = await import('@/lib/i18n');
const { ThemeSystemProvider } = await import('@/contexts/ThemeSystemContext');
const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
const { ChatInput } = await import('../ChatInput');
const { SyncProvider } = await import('@/sync/sync-context');
const { useDirectoryStore } = await import('@/stores/useDirectoryStore');
const { useConfigStore } = await import('@/stores/useConfigStore');
const { useSessionUIStore } = await import('@/sync/session-ui-store');
const { getRuntimeKey } = await import('@/lib/runtime-switch');
const { OpenCode } = await import('@opencode/client');

const sdk = OpenCode.make({
  baseUrl: 'https://sync.test',
  fetch: async (request) => {
    const path = new URL(request instanceof Request ? request.url : request.toString()).pathname;
    if (path.endsWith('/event')) {
      return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
    }
    const body = path.endsWith('/location')
      ? { directory: PROJECT, project: { id: 'project', directory: PROJECT, canonical: PROJECT } }
      : path.endsWith('/session/active') ? {}
      : { data: [] };
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  },
});

// SAFETY: The composer reads only the runtime descriptor and the source-control
// object's identity here; no runtime API method is invoked.
const runtimeAPIs = { runtime: { platform: 'web', isDesktop: false, isVSCode: false }, sourceControl: {} } as RuntimeAPIs;

const DRAFT_ID = 11;
let sent: string[] = [];

beforeEach(() => {
  sent = [];
  useDirectoryStore.setState({ currentDirectory: PROJECT });
  useSessionUIStore.setState({
    currentSessionId: null,
    currentSessionDirectory: null,
    newSessionDraft: { draftId: DRAFT_ID, open: true, parentID: null, target: 'project', directoryOverride: PROJECT },
    draftSessionsCreating: [{ runtimeKey: getRuntimeKey(), draftId: DRAFT_ID }],
    sendMessage: async (content) => {
      sent.push(content);
    },
  });
  useConfigStore.setState({
    currentProviderId: 'provider',
    currentModelId: 'model',
    isConnected: true,
    hasEverConnected: true,
  });
});

afterAll(() => {
  browser.close();
});

/** Mounts the composer, types `text`, runs `between`, submits, and reports what is left. */
const typeAndSubmit = async (text: string, between?: () => void) => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <RuntimeAPIContext.Provider value={runtimeAPIs}>
          <ThemeSystemProvider>
            <I18nProvider>
              <SyncProvider sdk={sdk} directory={PROJECT}>
                <ChatInput />
              </SyncProvider>
            </I18nProvider>
          </ThemeSystemProvider>
        </RuntimeAPIContext.Provider>,
      );
    });
    await act(async () => { await new Promise((resolveWait) => setTimeout(resolveWait, 50)); });

    const content = container.querySelector<HTMLElement>('.cm-content');
    const view = content ? EditorView.findFromDOM(content) : null;
    const form = container.querySelector('form');
    if (!view || !form) throw new Error('The composer did not mount');
    await act(async () => {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, userEvent: 'input.type' });
    });
    const statusWhileTyping = container.querySelector('[role="status"]')?.textContent ?? null;
    if (between) await act(async () => between());
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await new Promise((resolveWait) => setTimeout(resolveWait, 300));
    });
    return { remaining: view.state.doc.toString(), statusWhileTyping };
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
};

test('while the session is being created, sending waits and the typed text stays', async () => {
  const { remaining, statusWhileTyping } = await typeAndSubmit('next message');

  expect(statusWhileTyping).toBe('Creating session…');
  expect(sent).toEqual([]);
  expect(remaining).toBe('next message');
});

test('the new session keeps the wait until the first message has gone out', async () => {
  useSessionUIStore.setState({
    currentSessionId: 'ses_new',
    currentSessionDirectory: PROJECT,
    newSessionDraft: { draftId: DRAFT_ID, open: false, parentID: null, target: 'project', directoryOverride: PROJECT },
    draftSessionsCreating: [{ runtimeKey: getRuntimeKey(), draftId: DRAFT_ID, sessionId: 'ses_new' }],
  });

  const { remaining, statusWhileTyping } = await typeAndSubmit('next message');

  expect(statusWhileTyping).toBe('Creating session…');
  expect(sent).toEqual([]);
  expect(remaining).toBe('next message');
});

test('a failed creation gives the sent text back under what was typed meanwhile', async () => {
  useSessionUIStore.setState({ draftSessionsCreating: [] });
  let failCreation: () => void = () => {};
  useSessionUIStore.setState({
    sendMessage: (content) => {
      sent.push(content);
      useSessionUIStore.setState({ draftSessionsCreating: [{ runtimeKey: getRuntimeKey(), draftId: DRAFT_ID }] });
      return new Promise((_resolveSend, rejectSend) => {
        failCreation = () => {
          useSessionUIStore.setState({ draftSessionsCreating: [] });
          rejectSend(new Error('Failed to create session'));
        };
      });
    },
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <RuntimeAPIContext.Provider value={runtimeAPIs}>
          <ThemeSystemProvider>
            <I18nProvider>
              <SyncProvider sdk={sdk} directory={PROJECT}>
                <ChatInput />
              </SyncProvider>
            </I18nProvider>
          </ThemeSystemProvider>
        </RuntimeAPIContext.Provider>,
      );
    });
    await act(async () => { await new Promise((resolveWait) => setTimeout(resolveWait, 50)); });
    const content = container.querySelector<HTMLElement>('.cm-content');
    const view = content ? EditorView.findFromDOM(content) : null;
    const form = container.querySelector('form');
    if (!view || !form) throw new Error('The composer did not mount');
    await act(async () => {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'first message' }, userEvent: 'input.type' });
    });
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await new Promise((resolveWait) => setTimeout(resolveWait, 300));
    });
    expect(view.state.doc.toString()).toBe('');
    await act(async () => {
      view.dispatch({ changes: { from: 0, insert: 'typed meanwhile' }, userEvent: 'input.type' });
    });
    await act(async () => {
      failCreation();
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    });

    expect(sent).toEqual(['first message']);
    expect(view.state.doc.toString()).toBe('typed meanwhile\n\nfirst message');
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test('once the creation ends, the composer sends again', async () => {
  const { remaining } = await typeAndSubmit('next message', () => {
    useSessionUIStore.setState({ draftSessionsCreating: [] });
  });

  expect(sent).toEqual(['next message']);
  expect(remaining).toBe('');
});
