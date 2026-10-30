import { afterAll, expect, spyOn, test } from 'bun:test';
import { plugin } from 'bun';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';
import type { RuntimeAPIs } from '@/lib/api/types';
import type { Session } from '@/lib/opencode/model';
import type { EditorView as CodeMirrorView } from '@codemirror/view';
import type { Root } from 'react-dom/client';

/**
 * Counts which components render per keystroke without instrumenting them.
 *
 * React reports every commit to the DevTools hook. The walk mirrors React
 * DevTools' own render detection: a subtree whose child pointer is unchanged
 * was skipped entirely, and a component fiber carrying the PerformedWork flag
 * actually ran its render function in this commit (a memo bailout does not).
 */
type ComponentFunction = { name: string };
type CommitFiber = {
  tag: number;
  // Read only for component tags: the function itself (0, 15), a forwardRef
  // object with `render` (11), or a memo object with `type` (14).
  type: (ComponentFunction & { type?: ComponentFunction; render?: ComponentFunction }) | null;
  flags: number;
  child: CommitFiber | null;
  sibling: CommitFiber | null;
  alternate: CommitFiber | null;
};

const FUNCTION_COMPONENT = 0;
const FORWARD_REF = 11;
const MEMO_COMPONENT = 14;
const SIMPLE_MEMO_COMPONENT = 15;
const COMPONENT_TAGS = new Set([FUNCTION_COMPONENT, FORWARD_REF, MEMO_COMPONENT, SIMPLE_MEMO_COMPONENT]);
const PERFORMED_WORK = 1;

const renderedByName = new Map<string, number>();
let counting = false;

const fiberName = (fiber: CommitFiber): string => {
  if (fiber.tag === FORWARD_REF) return fiber.type?.render?.name ?? '';
  if (fiber.tag === MEMO_COMPONENT) return fiber.type?.type?.name ?? '';
  return fiber.type?.name ?? '';
};

const walk = (fiber: CommitFiber | null, mounted: boolean): void => {
  for (let node = fiber; node; node = node.sibling) {
    const isMount = mounted || node.alternate === null;
    const didRender = isMount || (node.flags & PERFORMED_WORK) === PERFORMED_WORK;
    if (didRender && COMPONENT_TAGS.has(node.tag)) {
      const name = fiberName(node);
      if (name) renderedByName.set(name, (renderedByName.get(name) ?? 0) + 1);
    }
    if (isMount || node.child !== node.alternate?.child) {
      walk(node.child, isMount);
    }
  }
};

Object.assign(globalThis, {
  __REACT_DEVTOOLS_GLOBAL_HOOK__: {
    isDisabled: false,
    supportsFiber: true,
    renderers: new Map(),
    inject: () => 1,
    onScheduleFiberRoot: () => undefined,
    onCommitFiberRoot: (_id: number, root: { current: CommitFiber }) => {
      if (!counting) return;
      const current = root.current;
      walk(current.child, current.alternate === null);
    },
    onCommitFiberUnmount: () => undefined,
    onPostCommitFiberRoot: () => undefined,
    checkDCE: () => undefined,
  },
});

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

// Nothing typed here reaches a server; every request answers empty.
spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
  const path = new URL(input instanceof Request ? input.url : input.toString(), 'http://localhost/').pathname;
  if (path.endsWith('/location')) {
    return Response.json({ directory: '/workspace', project: { id: 'project', directory: '/workspace', canonical: '/workspace' } });
  }
  if (path.endsWith('/session')) return Response.json({ data: [] });
  return Response.json({});
});

// Vite-only module forms the composer's import graph reaches.
plugin({
  name: 'composer-keystroke-vite-modules',
  setup(build) {
    // A load transform, as the sibling tests do it, and never an onResolve into a namespace of
    // its own: Bun keeps transpiled files in a cache on disk that every test process shares, and
    // a rewritten import specifier cached from this file broke every later file that imports
    // markdown-worker with "Cannot find module 'worker-url:...'".
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

const { act, Profiler } = await import('react');
const { createRoot } = await import('react-dom/client');
const { EditorView } = await import('@codemirror/view');
const { setLanguageContext } = await import('../composer/editor/composerLanguage');
const { I18nProvider } = await import('@/lib/i18n');
const { ThemeSystemProvider } = await import('@/contexts/ThemeSystemContext');
const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
const { ChatInput } = await import('../ChatInput');
const { SyncProvider } = await import('@/sync/sync-context');
const { useDirectoryStore } = await import('@/stores/useDirectoryStore');
const { getSyncChildStores } = await import('@/sync/sync-refs');
const { OpenCode } = await import('@opencode/client');

const sdk = OpenCode.make({
  baseUrl: 'https://sync.test',
  fetch: async (request) => {
    const path = new URL(request instanceof Request ? request.url : request.toString()).pathname;
    if (path.endsWith('/event')) {
      return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
    }
    const body = path.endsWith('/location')
      ? { directory: '/workspace', project: { id: 'project', directory: '/workspace', canonical: '/workspace' } }
      : path.endsWith('/session/active') ? {}
      : { data: [] };
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  },
});

// SAFETY: Mounting and typing read only the runtime descriptor and the
// source-control object's identity; no runtime API method is invoked.
const runtimeAPIs = { runtime: { platform: 'web', isDesktop: false, isVSCode: false }, sourceControl: {} } as RuntimeAPIs;

const { useSessionUIStore } = await import('@/sync/session-ui-store');
const { dispatchPromptHistorySearch } = await import('../composer/state/promptHistorySearchRoute');
const { createInputHistoryIdentity, useInputHistoryStore } = await import('@/stores/useInputHistoryStore');
const { getRuntimeKey } = await import('@/lib/runtime-switch');

// Stands in for the window keydown listener that useKeyboardShortcuts installs
// for search_prompt_history: the combo match is the dispatcher's job, and the
// route it hands the event to is the real one the composer registers.
window.addEventListener('keydown', (event: KeyboardEvent) => {
  if (event.key === 'ArrowUp' && event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
    dispatchPromptHistorySearch(event);
  }
});

const KEYSTROKES = 20;

type TypingCost = {
  commits: number;
  renderMs: number;
  componentRenders: number;
  languageContextUpdates: number;
  rendersByComponent: Map<string, number>;
};

type ComposerRun = {
  commits: number;
  renderMs: number;
  languageContextUpdates: number;
  rendersByComponent: Map<string, number>;
};

/** Mounts a fresh composer, counts the renders `drive` causes, and unmounts it. */
const countComposerRenders = async (
  scenario: 'session' | 'draft',
  drive: (view: InstanceType<typeof EditorView>) => Promise<void>,
): Promise<ComposerRun> => {
  useDirectoryStore.setState({ currentDirectory: '/workspace' });
  useSessionUIStore.setState(scenario === 'session'
    ? { currentSessionId: 'ses_typing', currentSessionDirectory: '/workspace' }
    : {
        currentSessionId: null,
        currentSessionDirectory: null,
        newSessionDraft: { ...useSessionUIStore.getState().newSessionDraft, open: true, target: 'project', directoryOverride: '/workspace' },
      });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  let commits = 0;
  let renderMs = 0;
  try {
    await act(async () => {
      root.render(
        <RuntimeAPIContext.Provider value={runtimeAPIs}>
          <ThemeSystemProvider>
            <I18nProvider>
              <SyncProvider sdk={sdk} directory="/workspace">
                <Profiler id="composer" onRender={(_id, _phase, actual) => { commits += 1; renderMs += actual; }}>
                  <ChatInput />
                </Profiler>
              </SyncProvider>
            </I18nProvider>
          </ThemeSystemProvider>
        </RuntimeAPIContext.Provider>,
      );
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });

    const content = container.querySelector<HTMLElement>('.cm-content');
    const view = content ? EditorView.findFromDOM(content) : null;
    if (!view) throw new Error('The composer editor did not mount');

    let languageContextUpdates = 0;
    const update = view.update.bind(view);
    view.update = (transactions) => {
      if (transactions.some((transaction) => transaction.effects.some((effect) => effect.is(setLanguageContext)))) {
        languageContextUpdates += 1;
      }
      update(transactions);
    };

    commits = 0;
    renderMs = 0;
    renderedByName.clear();
    counting = true;
    await drive(view);
    counting = false;
    return { commits, renderMs, languageContextUpdates, rendersByComponent: new Map(renderedByName) };
  } finally {
    counting = false;
    await act(async () => root.unmount());
    container.remove();
  }
};

/** Mounts a fresh composer, types KEYSTROKES characters, and reports the per-keystroke cost. */
const measureTyping = async (scenario: 'session' | 'draft'): Promise<TypingCost> => {
  const run = await countComposerRenders(scenario, async (view) => {
    for (let index = 0; index < KEYSTROKES; index += 1) {
      await act(async () => {
        view.dispatch({ changes: { from: view.state.doc.length, insert: 'a' }, userEvent: 'input.type' });
      });
    }
    // The instrument has to have fired: every keystroke reaches the editor.
    expect(view.state.doc.length).toBe(KEYSTROKES);
  });
  const componentRenders = [...run.rendersByComponent.values()].reduce((sum, count) => sum + count, 0);
  const cost: TypingCost = {
    commits: run.commits / KEYSTROKES,
    renderMs: run.renderMs / KEYSTROKES,
    componentRenders: componentRenders / KEYSTROKES,
    languageContextUpdates: run.languageContextUpdates,
    rendersByComponent: run.rendersByComponent,
  };
  console.log(`[${scenario}] commits/keystroke=${cost.commits} renderMs/keystroke=${cost.renderMs.toFixed(2)} componentRenders/keystroke=${cost.componentRenders} languageContextUpdates=${cost.languageContextUpdates}`);
  console.log([...run.rendersByComponent.entries()].map(([name, count]) => `${name}:${count / KEYSTROKES}`).sort().join(' '));
  return cost;
};

afterAll(() => {
  browser.close();
});

/**
 * Children of the composer that do not depend on the draft text. Each may
 * render once over the run, on the first keystroke, when the composer turns
 * from empty to sendable; never on every keystroke.
 *
 * Before this guard (same scenario, 20 keystrokes): an existing session
 * rendered 23 components and re-tokenized the editor's language context on
 * every keystroke; a new-session draft rendered 52 components per keystroke.
 */
const TEXT_INDEPENDENT_CHILDREN = [
  'ComposerFooterView',
  'ComposerAutocompletePopupsView',
  'PermissionDockView',
  'FormDockView',
  'BtwPanelView',
  'DraftTargetSelectorsView',
  'DraftPresetChipsView',
  'ReviewFlowDialogView',
  'QueuedMessagesStrip',
  'ComposerDictation',
  'SessionGoalObjectiveCounter',
];

const expectOnlyTheEditorFollowsTheText = (cost: TypingCost) => {
  expect(cost.rendersByComponent.get('ChatInputComponent')).toBe(KEYSTROKES);
  expect(cost.languageContextUpdates).toBe(0);
  for (const name of TEXT_INDEPENDENT_CHILDREN) {
    // Paired with the name so a failure says which child followed the text.
    const renders = cost.rendersByComponent.get(name) ?? 0;
    expect([name, renders]).toEqual([name, Math.min(renders, 1)]);
  }
};

test('typing in an existing session re-renders only the composer shell and its editor', async () => {
  expectOnlyTheEditorFollowsTheText(await measureTyping('session'));
});

test('typing in a new-session draft re-renders only the composer shell and its editor', async () => {
  expectOnlyTheEditorFollowsTheText(await measureTyping('draft'));
});

const STREAMED_STEPS = 10;

const streamedSession = (updated: number): Session => ({
  id: 'ses_typing',
  projectID: 'project',
  directory: '/workspace',
  title: 'Streaming',
  time: { created: 1, updated },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
});

/**
 * A streamed step replaces the directory's session list (`session.updated`
 * moves `time.updated`); nothing the composer shows changes with it.
 *
 * Before this guard (same scenario, 10 steps): ChatInputComponent and the
 * editor rendered once per step, through the session list read for the
 * file-search directory.
 */
test('a streaming session updating its record does not re-render the composer', async () => {
  const run = await countComposerRenders('session', async () => {
    // The mounted provider's store, so read only once it is mounted.
    const store = getSyncChildStores().ensureChild('/workspace', { bootstrap: false });
    await act(async () => { store.setState({ session: [streamedSession(1)] }); });
    renderedByName.clear();
    for (let step = 2; step <= STREAMED_STEPS + 1; step += 1) {
      await act(async () => { store.setState({ session: [streamedSession(step)] }); });
    }
    // The stimulus has to have landed: the store holds the last step.
    expect(store.getState().session[0]?.time.updated).toBe(STREAMED_STEPS + 1);
  });
  expect(run.rendersByComponent.get('ChatInputComponent') ?? 0).toBe(0);
  expect(run.rendersByComponent.get('ComposerEditor') ?? 0).toBe(0);
});

type MountedComposer = { container: HTMLDivElement; root: Root; view: CodeMirrorView };

const SEARCH_SESSION_ID = 'ses_prompt_history_search';

/** Mounts the composer on a fixed session and sets its draft text to `draftText`. */
const mountComposer = async (draftText: string): Promise<MountedComposer> => {
  useDirectoryStore.setState({ currentDirectory: '/workspace' });
  useSessionUIStore.setState({ currentSessionId: SEARCH_SESSION_ID, currentSessionDirectory: '/workspace' });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <RuntimeAPIContext.Provider value={runtimeAPIs}>
        <ThemeSystemProvider>
          <I18nProvider>
            <SyncProvider sdk={sdk} directory="/workspace">
              <ChatInput />
            </SyncProvider>
          </I18nProvider>
        </ThemeSystemProvider>
      </RuntimeAPIContext.Provider>,
    );
  });
  await flushFrames();
  const content = container.querySelector<HTMLElement>('.cm-content');
  const view = content ? EditorView.findFromDOM(content) : null;
  if (!view) throw new Error('The composer editor did not mount');
  await act(async () => {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: draftText } });
  });
  return { container, root, view };
};

const unmountComposer = async (composer: MountedComposer) => {
  await act(async () => composer.root.unmount());
  composer.container.remove();
};

/** Lets pending animation frames and their scheduled focus work run. */
const flushFrames = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });

const keyEvent = (key: string, init: KeyboardEventInit = {}) => new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });

const pressKey = async (target: Element, key: string, init: KeyboardEventInit = {}) => {
  await act(async () => {
    target.dispatchEvent(keyEvent(key, init));
  });
};

const openPromptHistorySearch = (composer: MountedComposer) => pressKey(composer.view.contentDOM, 'ArrowUp', { ctrlKey: true });

const searchInput = (composer: MountedComposer) => composer.container.querySelector<HTMLInputElement>('[data-prompt-history-search-input]');

/** Seeds the global bucket the composer reads for ordinary and searched recall; the newest entry is the last one. */
const seedGlobalHistory = (text: string) => {
  const identity = createInputHistoryIdentity(getRuntimeKey(), '/workspace', SEARCH_SESSION_ID);
  if (!identity) throw new Error('No input history identity for the test runtime');
  useInputHistoryStore.getState().applyScope('global');
  useInputHistoryStore.getState().appendSubmissions(identity, [{ text, attachmentKeys: [], restorableAttachments: [] }]);
};

test('Escape closes the history search and returns focus to the composer', async () => {
  const composer = await mountComposer('draft text');
  try {
    await openPromptHistorySearch(composer);
    const input = searchInput(composer);
    if (!input) throw new Error('The history search did not open');
    expect(document.activeElement === input).toBe(true);
    await pressKey(input, 'Escape');
    await flushFrames();
    expect(searchInput(composer) === null).toBe(true);
    expect(composer.view.hasFocus).toBe(true);
    expect(composer.view.state.doc.toString()).toBe('draft text');
  } finally {
    await unmountComposer(composer);
  }
});

test('reopening the history search before the closing focus frame runs keeps the new search focused', async () => {
  const composer = await mountComposer('draft text');
  try {
    await openPromptHistorySearch(composer);
    const first = searchInput(composer);
    if (!first) throw new Error('The history search did not open');
    // Synchronous act: both commits land before any timer, so the close's
    // deferred composer focus is still pending when the search reopens.
    act(() => { first.dispatchEvent(keyEvent('Escape')); });
    act(() => { composer.view.contentDOM.dispatchEvent(keyEvent('ArrowUp', { ctrlKey: true })); });
    const reopened = searchInput(composer);
    if (!reopened) throw new Error('The history search did not reopen');
    await flushFrames();
    // Identity checks, not toBe: a failing DOM-node diff prints the whole tree.
    expect(searchInput(composer) === reopened).toBe(true);
    expect(document.activeElement === reopened).toBe(true);
    expect(composer.view.state.doc.toString()).toBe('draft text');
  } finally {
    await unmountComposer(composer);
  }
});

test('reopening the history search after picking a prompt keeps the new search focused', async () => {
  seedGlobalHistory('older prompt');
  const composer = await mountComposer('');
  try {
    await openPromptHistorySearch(composer);
    const input = searchInput(composer);
    if (!input) throw new Error('The history search did not open');
    act(() => { input.dispatchEvent(keyEvent('Enter')); });
    expect(composer.view.state.doc.toString()).toBe('older prompt');
    // Reopen in the same synchronous turn as the pick, before its focus frame.
    act(() => { composer.view.contentDOM.dispatchEvent(keyEvent('ArrowUp', { ctrlKey: true })); });
    const reopened = searchInput(composer);
    if (!reopened) throw new Error('The history search did not reopen');
    await flushFrames();
    expect(searchInput(composer) === reopened).toBe(true);
    expect(document.activeElement === reopened).toBe(true);
    expect(composer.view.state.doc.toString()).toBe('older prompt');
  } finally {
    await unmountComposer(composer);
  }
});

test('a picked prompt with CRLF line breaks leaves the caret at the end of the editor text', async () => {
  seedGlobalHistory('first\r\nsecond');
  const composer = await mountComposer('');
  try {
    await openPromptHistorySearch(composer);
    const input = searchInput(composer);
    if (!input) throw new Error('The history search did not open');
    await pressKey(input, 'Enter');
    await flushFrames();
    const end = composer.view.state.doc.length;
    expect(composer.view.state.doc.toString()).toBe('first\nsecond');
    expect(composer.view.state.selection.main.head).toBe(end);
    expect(composer.view.state.selection.main.empty).toBe(true);
    expect(composer.view.hasFocus).toBe(true);
  } finally {
    await unmountComposer(composer);
  }
});
