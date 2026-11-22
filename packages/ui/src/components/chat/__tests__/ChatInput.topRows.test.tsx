import { afterAll, expect, spyOn, test } from 'bun:test';
import { plugin } from 'bun';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';
import type { PersistentPtyInfo } from '@opencode/client';
import type { RuntimeAPIs } from '@/lib/api/types';
import type { RunningShell } from '@/lib/opencode/background-shell';

/**
 * The composer's top rows are siblings of one fragment. A background command
 * and an agent terminal of the same session each put a strip there, and both
 * strips used to take the session id as their React key. React cannot tell
 * siblings with one key apart: every render of the composer then left the old
 * background commands strip in the page, frozen, and mounted a new one beside it.
 * Before the fix this test counted 10 background commands strips after the
 * mount and six keystrokes.
 */

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
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

// Nothing here reaches a server; every request answers empty.
spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
  const path = new URL(input instanceof Request ? input.url : input.toString(), 'http://localhost/').pathname;
  if (path.endsWith('/location')) {
    return Response.json({ directory: '/workspace', project: { id: 'project', directory: '/workspace', canonical: '/workspace' } });
  }
  if (path.endsWith('/session')) return Response.json({ data: [] });
  return Response.json({});
});

// Vite-only module forms the composer's import graph reaches, loaded the way
// ChatInput.keystroke.test.tsx loads them (see the note there on why it is a
// load transform).
plugin({
  name: 'composer-top-rows-vite-modules',
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
const { useSessionUIStore } = await import('@/sync/session-ui-store');
const { opencodeClient } = await import('@/lib/opencode/client');
const { applyBackgroundShellEvents } = await import('@/sync/background-shells');
const { applyPersistentPtyEvents } = await import('@/sync/persistent-ptys');
const { OpenCode } = await import('@opencode/client');

const DIRECTORY = '/workspace';
const SESSION = 'ses_jobs';

const sdk = OpenCode.make({
  baseUrl: 'https://sync.test',
  fetch: async (request) => {
    const path = new URL(request instanceof Request ? request.url : request.toString()).pathname;
    if (path.endsWith('/event')) {
      return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
    }
    const body = path.endsWith('/location')
      ? { directory: DIRECTORY, project: { id: 'project', directory: DIRECTORY, canonical: DIRECTORY } }
      : path.endsWith('/session/active') ? {}
      : { data: [] };
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  },
});

// SAFETY: Mounting and typing read only the runtime descriptor and the
// source-control object's identity; no runtime API method is invoked.
const runtimeAPIs = { runtime: { platform: 'web', isDesktop: false, isVSCode: false }, sourceControl: {} } as RuntimeAPIs;

const devServer: RunningShell = {
  id: 'shl_dev', sessionID: SESSION, command: 'bun run dev', file: '/tmp/shl_dev.out', startedAt: Date.now() - 5_000,
};

const watcher: PersistentPtyInfo = {
  id: 'pty_watch',
  title: 'watch',
  command: 'bun',
  args: ['run', 'watch'],
  cwd: DIRECTORY,
  status: 'running',
  pid: 1,
  sessionID: SESSION,
  foregroundProcess: null,
  size: { cols: 120, rows: 40 },
  output: { head: 0, tail: 0 },
};

// The lists OpenCode would answer with, so a bootstrap or a list read keeps both.
spyOn(opencodeClient, 'listRunningShells').mockImplementation(async () => ({ directory: DIRECTORY, shells: [devServer] }));
spyOn(opencodeClient, 'listSessionTerminals').mockImplementation(async () => [watcher]);

afterAll(() => {
  browser.close();
});

const KEYSTROKES = 6;

test('a session with a background command and an agent terminal shows each strip once, however often the composer renders', async () => {
  useDirectoryStore.setState({ currentDirectory: DIRECTORY });
  useSessionUIStore.setState({ currentSessionId: SESSION, currentSessionDirectory: DIRECTORY });
  applyBackgroundShellEvents(DIRECTORY, [
    { type: 'shell.started', properties: { shell: devServer } },
    {
      type: 'message.tool.transition',
      properties: {
        sessionID: SESSION,
        messageID: 'msg_1',
        partID: 'call_dev',
        transition: { kind: 'success', output: '', metadata: { status: 'running', shellID: devServer.id }, executed: true, end: devServer.startedAt },
      },
    },
  ]);
  applyPersistentPtyEvents(DIRECTORY, [{ type: 'persistent-pty.added', properties: { sessionID: SESSION, terminal: watcher } }]);

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const strips = (label: string) => container.querySelectorAll(`[role="group"][aria-label="${label}"]`).length;
  try {
    await act(async () => {
      root.render(
        <RuntimeAPIContext.Provider value={runtimeAPIs}>
          <ThemeSystemProvider>
            <I18nProvider>
              <SyncProvider sdk={sdk} directory={DIRECTORY}>
                <ChatInput />
              </SyncProvider>
            </I18nProvider>
          </ThemeSystemProvider>
        </RuntimeAPIContext.Provider>,
      );
    });
    await act(async () => { await new Promise((done) => setTimeout(done, 50)); });

    // The premise: both strips are on screen, each saying what it holds.
    expect(strips('Background commands')).toBeGreaterThan(0);
    expect(strips('Terminals')).toBeGreaterThan(0);
    expect(container.textContent).toContain('bun run dev');
    expect(container.textContent).toContain('bun run watch');

    const content = container.querySelector<HTMLElement>('.cm-content');
    const view = content ? EditorView.findFromDOM(content) : null;
    if (!view) throw new Error('The composer editor did not mount');
    // Every keystroke renders the composer again, as status changes and
    // streamed steps do in a real session.
    for (let index = 0; index < KEYSTROKES; index += 1) {
      await act(async () => {
        view.dispatch({ changes: { from: view.state.doc.length, insert: 'a' }, userEvent: 'input.type' });
      });
    }
    expect(view.state.doc.length).toBe(KEYSTROKES);

    expect([strips('Background commands'), strips('Terminals')]).toEqual([1, 1]);

    // The command ends: the strip says how, and no copy of it still offers Stop.
    await act(async () => {
      applyBackgroundShellEvents(DIRECTORY, [{
        type: 'shell.ended',
        properties: { shellID: devServer.id, end: { kind: 'exited', status: 'exited', exit: 0 }, endedAt: Date.now() },
      }]);
    });
    expect(container.textContent).toContain('exit code 0');
    expect(container.querySelectorAll('button[aria-label="Stop bun run dev"]')).toHaveLength(0);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
