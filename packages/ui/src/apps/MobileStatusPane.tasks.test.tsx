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
import { MobileStatusPane } from './MobileStatusPane';

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
const render = async (visible: boolean) => {
  await act(async () => root.render(
    <RuntimeAPIContext.Provider value={runtimeApis}><I18nProvider><SyncRuntimeContext.Provider value={runtime}>
      <MobileStatusPane visible={visible} onLeave={() => {}} sectionsDialogOpen={false} onSectionsDialogOpenChange={() => {}} />
    </SyncRuntimeContext.Provider></I18nProvider></RuntimeAPIContext.Provider>,
  ));
  await settle();
};

beforeEach(() => {
  previousUI = useUIStore.getState();
  previousSessionUI = useSessionUIStore.getState();
  previousDirectory = useDirectoryStore.getState();
  dom = new Window({ url: 'http://mobile-status.test' });
  globals = new Map();
  for (const [name, value] of Object.entries({
    window: dom, document: dom.document, HTMLElement: dom.HTMLElement, Element: dom.Element,
    Event: dom.Event, CustomEvent: dom.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
    ResizeObserver: dom.ResizeObserver, MutationObserver: dom.MutationObserver,
  })) {
    globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  registerRuntimeAPIs(runtimeApis);
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
  root = createRoot(document.body);
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
