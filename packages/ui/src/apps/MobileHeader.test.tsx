import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Session } from '@/lib/opencode/model';
import { I18nProvider } from '@/lib/i18n';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useUIStore } from '@/stores/useUIStore';
import { ChildStoreManager } from '@/sync/child-store';
import { SessionMessageLoader } from '@/sync/session-message-loader';
import { SyncRuntimeContext, type SyncRuntime } from '@/sync/sync-runtime-context';
import { useDirectoryStore as useAppDirectoryStore } from '@/stores/useDirectoryStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { forgetDirCache } from '@/sync/persist-cache';
import { MobileHeader } from './MobileHeader';
import { OpenCode } from '@opencode/client';

const DIR = '/workspace';
const WORKTREE_DIR = '/worktrees/workspace-feature';
const ID = 'ses_selected';
const session = (title: string, id = ID, directory = DIR): Session => ({
  id, projectID: 'proj_1', directory, title, cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
});

describe('MobileHeader session title', () => {
  let dom: Window;
  let root: Root;
  let previousSessionUI: ReturnType<typeof useSessionUIStore.getState>;
  let previousGlobal: ReturnType<typeof useGlobalSessionsStore.getState>;
  let previousDirectory: ReturnType<typeof useAppDirectoryStore.getState>;
  let previousUI: ReturnType<typeof useUIStore.getState>;
  let previousProjects: ReturnType<typeof useProjectsStore.getState>;
  let runtime: SyncRuntime;
  let globals: Map<string, PropertyDescriptor | undefined>;
  const sdk = OpenCode.make({
    baseUrl: 'https://mobile-header.test',
    fetch: async () => { throw new Error('Header title should use the stores without a request'); },
  });
  const render = async () => act(async () => root.render(
    <I18nProvider><SyncRuntimeContext.Provider value={runtime}>
      <MobileHeader onOpenSessions={() => {}} onOpenWorkspace={() => {}} />
    </SyncRuntimeContext.Provider></I18nProvider>,
  ));
  const seedLive = async (records: Session[], directory = DIR) => {
    const store = runtime.childStores.ensureChild(directory, { bootstrap: false });
    await act(async () => store.setState({ session: records }));
  };
  const visibleTitle = () => dom.document.querySelector('header button[aria-haspopup="dialog"] span span')?.textContent;

  beforeEach(() => {
    previousSessionUI = useSessionUIStore.getState();
    previousGlobal = useGlobalSessionsStore.getState();
    previousDirectory = useAppDirectoryStore.getState();
    previousUI = useUIStore.getState();
    previousProjects = useProjectsStore.getState();
    forgetDirCache(DIR);
    forgetDirCache(WORKTREE_DIR);
    dom = new Window();
    globals = new Map();
    for (const [name, value] of Object.entries({
      window: dom, document: dom.document, HTMLElement: dom.HTMLElement, Element: dom.Element,
      Event: dom.Event, CustomEvent: dom.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true,
    })) {
      globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
      Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    }
    const childStores = new ChildStoreManager();
    const runtimeKey = 'mobile-header-test';
    runtime = {
      childStores, runtimeKey, sdk,
      messageLoader: new SessionMessageLoader(childStores, {
        sdk: { getSessionMessages: async () => { throw new Error('Header title should not load messages'); } },
        runtimeKey,
      }),
      currentDirectory: { get: () => DIR, subscribe: () => () => {} },
    };
    root = createRoot(document.body);
    useSessionUIStore.setState({ currentSessionId: ID, currentSessionDirectory: DIR });
    useAppDirectoryStore.setState({ currentDirectory: DIR });
    useGlobalSessionsStore.getState().resetForRuntimeSwitch();
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    runtime.messageLoader.dispose();
    runtime.childStores.disposeAll();
    forgetDirCache(DIR);
    forgetDirCache(WORKTREE_DIR);
    useSessionUIStore.setState(previousSessionUI, true);
    useProjectsStore.setState(previousProjects, true);
    useGlobalSessionsStore.setState(previousGlobal, true);
    useAppDirectoryStore.setState(previousDirectory, true);
    useUIStore.setState(previousUI, true);
    await dom.happyDOM.abort();
    for (const [name, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  });

  test('uses the selected session global title while its directory record is missing', async () => {
    await render();
    expect(visibleTitle()).toBe('Untitled session');
    await act(async () => useGlobalSessionsStore.getState().upsertSession(session('  Global title  ')));
    expect(visibleTitle()).toBe('Global title');
  });

  test('prefers a trimmed live title and drops the cached title when the live title is blank', async () => {
    useGlobalSessionsStore.getState().upsertSession(session('Stale title'));
    await render();
    expect(visibleTitle()).toBe('Stale title');
    await seedLive([session('   ')]);
    expect(visibleTitle()).toBe('Untitled session');
    await seedLive([session('  Live rename  ')]);
    expect(visibleTitle()).toBe('Live rename');
    await seedLive([session('')]);
    expect(visibleTitle()).toBe('Untitled session');
  });

  test('shows a live title before any global record and follows a different selection', async () => {
    await seedLive([session('Live title')]);
    await render();
    expect(visibleTitle()).toBe('Live title');
    await act(async () => useGlobalSessionsStore.getState().upsertSession(session('Arrived global title')));
    expect(visibleTitle()).toBe('Live title');
    await seedLive([]);
    expect(visibleTitle()).toBe('Arrived global title');
    await act(async () => {
      useGlobalSessionsStore.getState().upsertSession(session('Second title', 'ses_other'));
      useSessionUIStore.setState({ currentSessionId: 'ses_other' });
    });
    expect(visibleTitle()).toBe('Second title');
  });

  test('clearing runtime cache removes same-ID fallback and leaves unnamed sessions untitled', async () => {
    useGlobalSessionsStore.getState().upsertSession(session('Cached title'));
    await render();
    expect(visibleTitle()).toBe('Cached title');
    await act(async () => useGlobalSessionsStore.getState().resetForRuntimeSwitch());
    expect(visibleTitle()).toBe('Untitled session');
    await seedLive([session('')]);
    expect(visibleTitle()).toBe('Untitled session');
  });

  test('leaves the existing title fallback alone when an open run is unavailable', async () => {
    useGlobalSessionsStore.getState().upsertSession(session('Global title'));
    await render();
    expect(visibleTitle()).toBe('Global title');
    await act(async () => useUIStore.setState({ runOverviewKey: 'unavailable-run' }));
    expect(visibleTitle()).toBe('Untitled session');
  });

  test('shows the draft label after leaving a named session', async () => {
    useGlobalSessionsStore.getState().upsertSession(session('Global title'));
    await render();
    expect(visibleTitle()).toBe('Global title');
    await act(async () => useSessionUIStore.setState((state) => ({
      currentSessionId: null, newSessionDraft: { ...state.newSessionDraft, open: true },
    })));
    expect(visibleTitle()).toBe('New session');
  });

  test('matches the switcher row for a worktree session until the worktree record arrives', async () => {
    useProjectsStore.setState({ projects: [{ id: 'proj_1', path: DIR }], activeProjectId: 'proj_1' });
    useSessionUIStore.setState({
      currentSessionId: 'ses_root', currentSessionDirectory: DIR,
      availableWorktreesByProject: new Map([[DIR, [{ path: WORKTREE_DIR, projectDirectory: DIR, branch: 'feature', label: 'feature' }]]]),
    });
    useGlobalSessionsStore.getState().upsertSession(session('Root session', 'ses_root'));
    useGlobalSessionsStore.getState().upsertSession(session('Worktree session', 'ses_worktree', WORKTREE_DIR));
    await seedLive([session('Root session', 'ses_root'), session('Root store copy', 'ses_worktree')]);
    await render();
    expect(visibleTitle()).toBe('Root session');

    await act(async () => document.querySelector<HTMLButtonElement>('header button[aria-haspopup="dialog"]')?.click());
    const row = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
      .find((button) => button.textContent?.includes('Worktree session'));
    expect(row).toBeDefined();
    await act(async () => row?.click());
    expect(useSessionUIStore.getState().currentSessionId).toBe('ses_worktree');
    expect(useSessionUIStore.getState().getDirectoryForSession('ses_worktree')).toBe(WORKTREE_DIR);
    expect(visibleTitle()).toBe('Worktree session');

    await seedLive([session('Worktree live title', 'ses_worktree', WORKTREE_DIR)], WORKTREE_DIR);
    expect(visibleTitle()).toBe('Worktree live title');
  });
});
