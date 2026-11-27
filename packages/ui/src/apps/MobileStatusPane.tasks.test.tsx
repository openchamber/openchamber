import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { GitAPI, RuntimeAPIs } from '@/lib/api/types';
import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { I18nProvider } from '@/lib/i18n';
import { WORK_STATUS_SECTION_IDS } from '@/components/chat/work-status/sections';
import { useSessionTodosStore } from '@/stores/useSessionTodosStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { ChildStoreManager } from '@/sync/child-store';
import { SessionMessageLoader } from '@/sync/session-message-loader';
import { SyncRuntimeContext, type SyncRuntime } from '@/sync/sync-runtime-context';
import { OpenCode } from '@opencode/client';

let MobileStatusPane: typeof import('./MobileStatusPane').MobileStatusPane;

const DIR = '/workspace';
const ID = 'ses_tasks';

const unavailable = (): never => { throw new Error('not used'); };
// SAFETY: the Status list only destructures `git` once it shows Tasks; this test calls none of its methods.
const git = {} as GitAPI;
const runtimeApis: RuntimeAPIs = {
  runtime: { platform: 'web', isDesktop: false, isVSCode: false },
  get terminal() { return unavailable(); }, get git() { return git; },
  get files() { return unavailable(); }, get settings() { return unavailable(); },
  get permissions() { return unavailable(); }, get notifications() { return unavailable(); },
  get sourceControl() { return unavailable(); },
};

let dom: Window;
let runtime: SyncRuntime;
let root: Root;
let globals: Map<string, PropertyDescriptor | undefined>;
let previousUI: ReturnType<typeof useUIStore.getState>;
let previousSessionUI: ReturnType<typeof useSessionUIStore.getState>;
let previousDirectory: ReturnType<typeof useDirectoryStore.getState>;

const settle = () => act(async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); });
const render = async (visible: boolean, sectionsDialogOpen = false) => {
  await act(async () => root.render(
    <RuntimeAPIContext.Provider value={runtimeApis}><I18nProvider><SyncRuntimeContext.Provider value={runtime}>
      <MobileStatusPane visible={visible} onLeave={() => {}} sectionsDialogOpen={sectionsDialogOpen} onSectionsDialogOpenChange={() => {}} />
    </SyncRuntimeContext.Provider></I18nProvider></RuntimeAPIContext.Provider>,
  ));
  await settle();
};

beforeEach(async () => {
  previousUI = useUIStore.getState();
  previousSessionUI = useSessionUIStore.getState();
  previousDirectory = useDirectoryStore.getState();
  dom = new Window({ url: 'http://mobile-status.test' });
  globals = new Map();
  for (const [name, value] of Object.entries({
    window: dom, document: dom.document, navigator: dom.navigator,
    Node: dom.Node, HTMLElement: dom.HTMLElement, Element: dom.Element,
    HTMLButtonElement: dom.HTMLButtonElement, HTMLInputElement: dom.HTMLInputElement,
    SVGElement: dom.SVGElement, Document: dom.Document, DocumentFragment: dom.DocumentFragment,
    DOMRect: dom.DOMRect, Event: dom.Event, CustomEvent: dom.CustomEvent,
    MouseEvent: dom.MouseEvent, KeyboardEvent: dom.KeyboardEvent,
    Touch: dom.Touch, TouchEvent: dom.TouchEvent,
    getComputedStyle: dom.getComputedStyle.bind(dom), IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
    ResizeObserver: dom.ResizeObserver, MutationObserver: dom.MutationObserver,
  })) {
    globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  registerRuntimeAPIs(runtimeApis);
  ({ MobileStatusPane } = await import('./MobileStatusPane'));
  const childStores = new ChildStoreManager();
  const runtimeKey = 'mobile-status-tasks-test';
  runtime = {
    childStores, runtimeKey,
    sdk: OpenCode.make({ baseUrl: 'https://mobile-status.test', fetch: async () => { throw new Error('not used'); } }),
    messageLoader: new SessionMessageLoader(childStores, {
      sdk: { getSessionMessages: async () => { throw new Error('not used'); } },
      runtimeKey,
    }),
    currentDirectory: { get: () => DIR, subscribe: () => () => {} },
  };
  useUIStore.setState({ isMobile: true, mobileWorkStatusHiddenSections: WORK_STATUS_SECTION_IDS.filter((id) => id !== 'tasks') });
  useSessionUIStore.setState({ currentSessionId: ID, currentSessionDirectory: DIR });
  useDirectoryStore.setState({ currentDirectory: DIR });
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  runtime.messageLoader.dispose();
  runtime.childStores.disposeAll();
  registerRuntimeAPIs(null);
  useSessionTodosStore.getState().reset();
  useUIStore.setState(previousUI, true);
  useSessionUIStore.setState(previousSessionUI, true);
  useDirectoryStore.setState(previousDirectory, true);
  await dom.happyDOM.abort();
  for (const [name, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

test('with Tasks the only enabled section, Status finds them again after the todo tool comes back on', async () => {
  useSessionTodosStore.setState({ entries: { [ID]: { directory: DIR, state: 'off', todos: [], revision: 1, failures: 0 } } });
  const reads: string[] = [];
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    reads.push(input instanceof Request ? input.url : String(input));
    return Response.json({ revision: 2, state: 'ready', todos: [{ content: 'back on', status: 'pending' }] });
  });
  try {
    await render(true);
    expect(reads).toEqual([]);

    // The directory's config changed while Status is open: an `off` entry hides every section, yet Tasks still read.
    await act(async () => useSessionTodosStore.getState().refresh(DIR, () => true));
    await settle();
    expect(reads.length).toBe(1);
    expect(useSessionTodosStore.getState().entries[ID]?.state).toBe('ready');

    // Closed, the change only marks the entry stale; reopening reads it once.
    await act(async () => useSessionTodosStore.setState({ entries: { [ID]: { directory: DIR, state: 'off', todos: [], revision: 3, failures: 0 } } }));
    await render(false);
    await act(async () => useSessionTodosStore.getState().refresh(DIR, () => true));
    await settle();
    expect(reads.length).toBe(1);
    await render(true);
    expect(reads.length).toBe(2);
  } finally {
    fetchSpy.mockRestore();
  }
});

test('a hidden Tasks section stays unread until Panel sections opens, then lists so it can be re-enabled', async () => {
  useUIStore.setState({ isMobile: true, mobileWorkStatusHiddenSections: [...WORK_STATUS_SECTION_IDS] });
  const reads: string[] = [];
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    reads.push(input instanceof Request ? input.url : String(input));
    return Response.json({ revision: 1, state: 'ready', todos: [{ content: 'ship it', status: 'in_progress' }] });
  });
  try {
    await render(true, false);
    expect(reads).toEqual([]);

    await render(true, true);
    expect(reads.length).toBe(1);
    const tasksRow = document.querySelector<HTMLElement>('[data-settings-item="chat.work-status.section.tasks"]');
    expect(tasksRow).not.toBeNull();
    expect(tasksRow?.getAttribute('aria-pressed')).toBe('false');

    await act(async () => tasksRow?.click());
    expect(useUIStore.getState().mobileWorkStatusHiddenSections).not.toContain('tasks');
  } finally {
    fetchSpy.mockRestore();
  }
});
