import { afterAll, beforeEach, expect, spyOn, test } from 'bun:test';
import { plugin } from 'bun';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';
import type { RuntimeAPIs } from '@/lib/api/types';

/**
 * A magic prompt command typed in the composer reads the prompts that apply
 * in the directory the send lands in: the session's worktree here. The
 * server decides which project owns it.
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

const WORKTREE = '/elsewhere/feature';

let promptReads: URL[] = [];
let promptsStatus = 200;

spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
  const url = new URL(input instanceof Request ? input.url : input.toString(), 'http://localhost/');
  if (url.pathname === '/api/magic-prompts') {
    promptReads.push(url);
    return Response.json(promptsStatus === 200
      ? { version: 1, overrides: { 'session.review.visible': 'Project review', 'session.review.instructions': 'Project review rules' } }
      : { error: 'Project prompts are invalid', code: 'project_prompts_invalid' }, { status: promptsStatus });
  }
  if (url.pathname.endsWith('/location')) {
    return Response.json({ directory: WORKTREE, project: { id: 'project', directory: WORKTREE, canonical: WORKTREE } });
  }
  if (url.pathname.endsWith('/session')) return Response.json({ data: [] });
  return Response.json({});
});

// Vite-only module forms the composer's import graph reaches, loaded as the keystroke test does.
plugin({
  name: 'composer-magic-prompts-vite-modules',
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
const { OpenCode } = await import('@opencode/client');

const sdk = OpenCode.make({
  baseUrl: 'https://sync.test',
  fetch: async (request) => {
    const path = new URL(request instanceof Request ? request.url : request.toString()).pathname;
    if (path.endsWith('/event')) {
      return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
    }
    const body = path.endsWith('/location')
      ? { directory: WORKTREE, project: { id: 'project', directory: WORKTREE, canonical: WORKTREE } }
      : path.endsWith('/session/active') ? {}
      : { data: [] };
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  },
});

// SAFETY: The composer reads only the runtime descriptor and the source-control
// object's identity here; no runtime API method is invoked.
const runtimeAPIs = { runtime: { platform: 'web', isDesktop: false, isVSCode: false }, sourceControl: {} } as RuntimeAPIs;

type SentMessage = { content: string; synthetic: string[] };
let sent: SentMessage[] = [];

beforeEach(() => {
  promptReads = [];
  promptsStatus = 200;
  sent = [];
  useDirectoryStore.setState({ currentDirectory: WORKTREE });
  useSessionUIStore.setState({
    currentSessionId: 'ses_feature',
    currentSessionDirectory: WORKTREE,
    sendMessage: async (content, _providerID, _modelID, _agent, _attachments, _agentMention, additionalParts) => {
      sent.push({ content, synthetic: (additionalParts ?? []).filter((part) => part.synthetic).map((part) => part.text) });
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

/** Mounts the composer, types `text`, submits it and returns the editor text afterwards. */
const submitInComposer = async (text: string): Promise<string> => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <RuntimeAPIContext.Provider value={runtimeAPIs}>
          <ThemeSystemProvider>
            <I18nProvider>
              <SyncProvider sdk={sdk} directory={WORKTREE}>
                <ChatInput />
              </SyncProvider>
            </I18nProvider>
          </ThemeSystemProvider>
        </RuntimeAPIContext.Provider>,
      );
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });

    const content = container.querySelector<HTMLElement>('.cm-content');
    const view = content ? EditorView.findFromDOM(content) : null;
    const form = container.querySelector('form');
    if (!view || !form) throw new Error('The composer did not mount');
    await act(async () => {
      // Replaces the whole draft: a draft an earlier send gave back is restored on mount.
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, userEvent: 'input.type' });
    });
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    return view.state.doc.toString();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
};

test("sends the command with the prompts that apply in the session's directory", async () => {
  await submitInComposer('/workspace-review');

  expect(promptReads.map((url) => url.searchParams.get('sessionDirectory'))).toEqual([WORKTREE]);
  expect(sent).toHaveLength(1);
  expect(sent[0].content).toBe('Project review');
  expect(sent[0].synthetic).toContain('Project review rules');
});

test('a failed prompt read sends nothing and gives the text back', async () => {
  promptsStatus = 409;

  const remaining = await submitInComposer('/workspace-review');

  expect(promptReads).toHaveLength(1);
  expect(sent).toEqual([]);
  expect(remaining).toBe('/workspace-review');
});

// The draft fields the composer routes a first send by.
type DraftTarget = { target: 'chat' | 'project'; directoryOverride: string | null; preparedChatDirectory?: string };

const promptDirectoryForDraft = async (draft: DraftTarget): Promise<string | null> => {
  useSessionUIStore.setState({
    currentSessionId: null,
    currentSessionDirectory: null,
    newSessionDraft: { draftId: 7, open: true, parentID: null, ...draft },
  });

  await submitInComposer('/workspace-review');

  expect(promptReads).toHaveLength(1);
  return promptReads[0].searchParams.get('sessionDirectory');
};

test('a new chat, which has no folder yet, reads the global prompts', async () => {
  expect(await promptDirectoryForDraft({ target: 'chat', directoryOverride: null, preparedChatDirectory: '/chats/today' })).toBeNull();
});

test('a project draft reads the prompts of the folder it opens in', async () => {
  expect(await promptDirectoryForDraft({ target: 'project', directoryOverride: '/repo' })).toBe('/repo');
});
