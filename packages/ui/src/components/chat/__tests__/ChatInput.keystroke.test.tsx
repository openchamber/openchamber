import { afterAll, expect, spyOn, test } from 'bun:test';
import { plugin } from 'bun';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';
import type { RuntimeAPIs } from '@/lib/api/types';
import type { QueuedMessage } from '@/stores/messageQueueStore';
import type { AttachedFile } from '@/stores/types/sessionTypes';

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

let serverQueue: QueuedMessage[] = [];
let queueTakeRequests = 0;

// Requests stay inside the fixture; queue takes model their destructive effect.
spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
  const path = new URL(input instanceof Request ? input.url : input.toString(), 'http://localhost/').pathname;
  if (path.includes('/message-queue/')) {
    const items = serverQueue;
    if (path.endsWith('/take')) {
      queueTakeRequests += 1;
      serverQueue = [];
    }
    return Response.json({
      revision: queueTakeRequests + 1,
      session: { sessionId: 'ses_submit', directory: '/workspace', items: serverQueue, sendingId: null },
      items,
    });
  }
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
const { useConfigStore } = await import('@/stores/useConfigStore');
const { useUIStore } = await import('@/stores/useUIStore');
const { useInputStore } = await import('@/sync/input-store');
const { getSyncChildStores } = await import('@/sync/sync-refs');
const { registerRuntimeAPIs } = await import('@/contexts/runtimeAPIRegistry');
const { getRuntimeKey } = await import('@/lib/runtime-switch');
const { createChatDraftIdentity } = await import('@/lib/chatDraftPersistence');
const { createMessageQueueTarget, getMessageQueueKey, useMessageQueueStore } = await import('@/stores/messageQueueStore');

const KEYSTROKES = 20;

type TypingCost = {
  commits: number;
  renderMs: number;
  componentRenders: number;
  languageContextUpdates: number;
  rendersByComponent: Map<string, number>;
};

/** Mounts a fresh composer, types KEYSTROKES characters, and reports the per-keystroke cost. */
const measureTyping = async (scenario: 'session' | 'draft'): Promise<TypingCost> => {
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
    for (let index = 0; index < KEYSTROKES; index += 1) {
      await act(async () => {
        view.dispatch({ changes: { from: view.state.doc.length, insert: 'a' }, userEvent: 'input.type' });
      });
    }
    counting = false;
    // The instrument has to have fired: every keystroke reaches the editor.
    expect(view.state.doc.length).toBe(KEYSTROKES);
    const componentRenders = [...renderedByName.values()].reduce((sum, count) => sum + count, 0);
    const cost: TypingCost = {
      commits: commits / KEYSTROKES,
      renderMs: renderMs / KEYSTROKES,
      componentRenders: componentRenders / KEYSTROKES,
      languageContextUpdates,
      rendersByComponent: new Map(renderedByName),
    };
    console.log(`[${scenario}] commits/keystroke=${cost.commits} renderMs/keystroke=${cost.renderMs.toFixed(2)} componentRenders/keystroke=${cost.componentRenders} languageContextUpdates=${languageContextUpdates}`);
    console.log([...renderedByName.entries()].map(([name, count]) => `${name}:${count / KEYSTROKES}`).sort().join(' '));
    return cost;
  } finally {
    counting = false;
    await act(async () => root.unmount());
    container.remove();
  }
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

for (const isVSCode of [false, true]) {
  test(`Mod+Enter sends the current draft and leaves the ${isVSCode ? 'local' : 'server-owned'} queue untouched`, async () => {
    runtimeAPIs.runtime.isVSCode = isVSCode;
    registerRuntimeAPIs(runtimeAPIs);
    const target = createMessageQueueTarget('ses_submit', '/workspace', getRuntimeKey());
    if (!target) throw new Error('Queue target missing');
    const key = getMessageQueueKey(target);
    const identity = createChatDraftIdentity(target.runtimeKey, target.directory, target.sessionId);
    const attachment = (filename: string): AttachedFile => ({
      id: filename, filename, mimeType: 'text/plain', size: 1, source: 'local',
      file: new File(['x'], filename, { type: 'text/plain' }),
      dataUrl: 'data:text/plain;base64,eA==',
    });
    const queued: QueuedMessage[] = ['A', 'B'].map((text) => ({
      id: text, content: text, text, createdAt: 1,
      attachments: [attachment(`${text}.txt`)],
      context: [{ kind: 'synthetic', text: `${text} context` }],
      sendConfig: { providerID: 'p', modelID: 'm' },
    }));
    serverQueue = queued;
    queueTakeRequests = 0;
    useDirectoryStore.setState({ currentDirectory: '/workspace' });
    useSessionUIStore.setState({
      currentSessionId: target.sessionId, currentSessionDirectory: target.directory,
      newSessionDraft: { ...useSessionUIStore.getState().newSessionDraft, open: false },
    });
    useConfigStore.setState({ currentProviderId: 'p', currentModelId: 'm' });
    useUIStore.setState({ isMobile: false, enterToSend: true, enterToSendConfigured: true });
    useMessageQueueStore.setState({ queuedMessages: { [key]: queued }, sendingIds: {}, followUpBehavior: 'queue' });
    useInputStore.getState().setAttachedFiles([attachment('C.txt')], identity);
    useInputStore.getState().setPendingSyntheticParts([{ text: 'C context', synthetic: true }]);
    const send = spyOn(useSessionUIStore.getState(), 'sendMessage');
    const sent = new Promise<Parameters<typeof send>>((resolve) => {
      send.mockImplementation(async (...args) => { resolve(args); });
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(
        <RuntimeAPIContext.Provider value={runtimeAPIs}>
          <ThemeSystemProvider><I18nProvider><SyncProvider sdk={sdk} directory="/workspace">
            <ChatInput />
          </SyncProvider></I18nProvider></ThemeSystemProvider>
        </RuntimeAPIContext.Provider>,
      ));
      await act(async () => {
        getSyncChildStores().ensureChild('/workspace').setState({ session_status: { [target.sessionId]: { type: 'busy' } } });
      });
      const content = container.querySelector<HTMLElement>('.cm-content');
      const view = content ? EditorView.findFromDOM(content) : null;
      if (!view || !content) throw new Error('Composer editor missing');
      await act(async () => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'C' }, userEvent: 'input.type' }));
      await act(async () => {
        content.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', ctrlKey: isVSCode, metaKey: !isVSCode, bubbles: true, cancelable: true }));
        await sent;
      });
      const args = await sent;
      expect(send.mock.calls).toHaveLength(1);
      expect(args[0]).toBe('C');
      expect(args[4]?.map((file) => file.filename)).toEqual(['C.txt']);
      expect(args[6]?.map((part) => part.text)).toEqual(['C context']);
      expect(useMessageQueueStore.getState().getQueueForTarget(target)).toEqual(queued);
      expect(serverQueue).toEqual(queued);
      expect(queueTakeRequests).toBe(0);
      expect(view.state.doc.toString()).toBe('');
    } finally {
      await act(async () => root.unmount());
      container.remove();
      send.mockRestore();
      useMessageQueueStore.setState({ queuedMessages: {}, sendingIds: {} });
      useInputStore.getState().setAttachedFiles([], identity);
      useInputStore.getState().setPendingSyntheticParts(null);
      runtimeAPIs.runtime.isVSCode = false;
      registerRuntimeAPIs(null);
      serverQueue = [];
    }
  });
}
