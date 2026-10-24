import React, { act } from 'react';
import { expect, spyOn, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { OpenCode } from '@opencode/client';

import type { Session } from '@/lib/opencode/model';
import { opencodeClient } from '@/lib/opencode/client';
import { git } from '@/lib/gitApi';
import { I18nProvider } from '@/lib/i18n';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { ThemeSystemProvider } from '@/contexts/ThemeSystemContext';
import { SyncProvider } from '@/sync/sync-context';
import { resetSessionOrdering, useSessionOrderingStore } from '@/sync/session-ordering';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
import { useMobileSessionExpansionStore } from '@/stores/useMobileSessionExpansionStore';
import { useMobileSessionTreeStore } from '@/stores/useMobileSessionTreeStore';
import { createWebAPIs } from '../../../web/src/api';
import { MobileSessionsSheet } from './MobileSessionsSheet';

const session = (id: string, directory: string, parentID?: string): Session => ({
  id,
  title: id,
  directory,
  parentID,
  projectID: 'project',
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
});

type TreeDriver = {
  mount: () => Promise<void>;
  titles: () => string[];
  groupExpanded: (label: string) => string | null | undefined;
  toggle: (sessionId: string) => Promise<void>;
  select: (sessionId: string) => Promise<void>;
  selected: Array<{ sessionId: string | null; directory: string | null }>;
};

const withTree = async (run: (tree: TreeDriver) => Promise<void>) => {
  const dom = new Window({ url: 'http://localhost' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const globals = {
    window: dom, document: dom.document, navigator: dom.navigator, location: dom.location, localStorage: dom.localStorage,
    Element: dom.Element, HTMLElement: dom.HTMLElement, HTMLInputElement: dom.HTMLInputElement, Node: dom.Node,
    Event: dom.Event, CustomEvent: dom.CustomEvent, KeyboardEvent: dom.KeyboardEvent, MouseEvent: dom.MouseEvent,
    MutationObserver: dom.MutationObserver, ResizeObserver: dom.ResizeObserver,
    getComputedStyle: dom.getComputedStyle.bind(dom), requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
    cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom), IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(globals)) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
    const path = new URL(input instanceof Request ? input.url : String(input), 'http://localhost').pathname;
    return Response.json(path === '/api/session-warming' ? { revision: 0, enabled: false, minutes: 5, sessions: [] } : {});
  }, originalFetch);
  const initialProjects = useProjectsStore.getState();
  const initialSessions = useGlobalSessionsStore.getState();
  const initialSessionUI = useSessionUIStore.getState();
  const initialDisplay = useSessionDisplayStore.getState();
  const initialExpansion = useMobileSessionExpansionStore.getState();
  const initialTree = useMobileSessionTreeStore.getState();
  const apis = createWebAPIs();
  const worktrees = [
    { path: '/project/worktree', projectDirectory: '/project', branch: 'feature', label: 'feature' },
    { path: '/project/second-worktree', projectDirectory: '/project', branch: 'second', label: 'second' },
  ];
  const selected: TreeDriver['selected'] = [];
  const spies = [
    spyOn(opencodeClient, 'getFilesystemHomeInfo').mockResolvedValue({ home: '/home' }),
    spyOn(opencodeClient, 'getFilesystemHome').mockResolvedValue('/home'),
    spyOn(opencodeClient, 'getLocation').mockResolvedValue({ directory: '/project', project: { id: 'project', directory: '/project', canonical: '/project' } }),
    spyOn(opencodeClient, 'getConfig').mockResolvedValue({}),
    spyOn(opencodeClient, 'listProjects').mockResolvedValue([]),
    spyOn(opencodeClient, 'listSessionsPage').mockImplementation(async () => ({
      sessions: [...useGlobalSessionsStore.getState().activeSessions, ...useGlobalSessionsStore.getState().archivedSessions], cursor: {},
    })),
    spyOn(opencodeClient, 'getHostSessionStatusSnapshot').mockResolvedValue({ sessions: {}, serverTime: 1 }),
    spyOn(apis.git, 'checkIsGitRepository').mockResolvedValue(true),
    spyOn(git.worktree, 'list').mockResolvedValue(worktrees.map((worktree) => ({ ...worktree, head: 'abc123', name: worktree.branch }))),
    spyOn(initialSessionUI, 'setCurrentSession').mockImplementation(async (sessionId, directory) => { selected.push({ sessionId, directory: directory ?? null }); }),
  ];
  const sdk = OpenCode.make({
    baseUrl: 'http://opencode.test',
    fetch: async (request) => new URL(request instanceof Request ? request.url : request.toString()).pathname.endsWith('/event')
      ? new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } })
      : Response.json({ data: [] }),
  });

  useProjectsStore.setState({ projects: [{ id: 'project', path: '/project', label: 'Project' }], activeProjectId: 'project' });
  useSessionUIStore.setState({
    availableWorktreesByProject: new Map([['/project', worktrees]]),
  });
  useSessionDisplayStore.setState({ sidebarViewMode: 'projects', showWorkSection: false, showPinnedSection: false });
  useMobileSessionExpansionStore.setState({ expandedParents: {} });
  useMobileSessionTreeStore.setState({ projectExpanded: {}, worktreeExpanded: {} });
  resetSessionOrdering();

  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const mount = async () => {
    await act(async () => root.render(
      <SyncProvider sdk={sdk} directory="">
        <I18nProvider>
          <ThemeSystemProvider>
            <RuntimeAPIContext.Provider value={apis}>
              <MobileSessionsSheet open variant="sidebar" onOpenChange={() => {}} />
            </RuntimeAPIContext.Provider>
          </ThemeSystemProvider>
        </I18nProvider>
      </SyncProvider>,
    ));
  };
  const titles = () => [...container.querySelectorAll('button [dir="auto"]')].map((element) => element.textContent ?? '');
  const groupExpanded = (label: string) => [...container.querySelectorAll('button')]
    .find((button) => button.textContent?.trim() === label)?.getAttribute('aria-expanded');
  const rowButton = (sessionId: string) => {
    const title = [...container.querySelectorAll('button [dir="auto"]')].find((element) => element.textContent === sessionId);
    const button = title?.closest('button');
    if (!button) throw new Error(`Missing session row for ${sessionId}`);
    return button;
  };
  const toggle = async (sessionId: string) => {
    const control = rowButton(sessionId).parentElement?.querySelector<HTMLButtonElement>('button[aria-expanded]');
    if (!control) throw new Error(`Missing expansion control for ${sessionId}`);
    await act(async () => { control.click(); });
  };
  const select = async (sessionId: string) => { await act(async () => { rowButton(sessionId).click(); }); };

  try {
    await run({ mount, titles, groupExpanded, toggle, select, selected });
  } finally {
    await act(async () => root.unmount());
    for (const spy of spies) spy.mockRestore();
    useProjectsStore.setState(initialProjects, true);
    useGlobalSessionsStore.setState(initialSessions, true);
    useSessionUIStore.setState(initialSessionUI, true);
    useSessionDisplayStore.setState(initialDisplay, true);
    useMobileSessionExpansionStore.setState(initialExpansion, true);
    useMobileSessionTreeStore.setState(initialTree, true);
    resetSessionOrdering();
    globalThis.fetch = originalFetch;
    await dom.happyDOM.close();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
};

test('mobile Tree nests cross-worktree descendants and preserves sibling lifecycle order', async () => {
  await withTree(async (tree) => {
    const parent = session('ses_parent', '/project');
    const child = session('ses_child', '/project/worktree', parent.id);
    const sibling = session('ses_sibling', '/project', parent.id);
    const grandchild = session('ses_grandchild', '/project/second-worktree', child.id);
    const worktreeRoot = session('ses_worktree_root', '/project/worktree');
    const btw = {
      ...session('ses_btw', '/project/worktree', parent.id),
      metadata: { openchamber: { kind: 'btw', originalSessionID: parent.id } },
    };
    const archived = { ...session('ses_archived', '/project/worktree', parent.id), time: { created: 1, updated: 1, archived: 2 } };
    useGlobalSessionsStore.getState().applySnapshot([parent, child, sibling, grandchild, worktreeRoot, btw], [archived]);
    useSessionOrderingStore.setState({ rankById: new Map([[child.id, 2], [sibling.id, 3]]) });

    await tree.mount();
    expect(tree.titles()).toEqual([parent.id, worktreeRoot.id]);
    expect(tree.groupExpanded('second')).toBeNull();
    await tree.toggle(parent.id);
    expect(tree.titles()).toEqual([parent.id, sibling.id, child.id, worktreeRoot.id]);
    await tree.toggle(child.id);
    expect(tree.titles()).toEqual([parent.id, sibling.id, child.id, grandchild.id, worktreeRoot.id]);
    await tree.select(child.id);
    expect(tree.selected).toEqual([{ sessionId: child.id, directory: child.directory }]);
    await tree.toggle(parent.id);
    expect(tree.titles()).toEqual([parent.id, worktreeRoot.id]);
  });
});

for (const archived of [false, true]) {
  test(`mobile Tree clears the missing-parent fallback when an ${archived ? 'archived' : 'active'} parent arrives`, async () => {
    await withTree(async (tree) => {
      const parent = session('ses_late_parent', '/project');
      const child = session('ses_early_child', '/project/worktree', parent.id);
      useGlobalSessionsStore.getState().applySnapshot([child], []);
      await tree.mount();
      expect(tree.titles()).toEqual([child.id]);

      await act(async () => {
        useGlobalSessionsStore.getState().upsertSession(archived ? { ...parent, time: { ...parent.time, archived: 2 } } : parent);
      });
      expect(tree.titles()).toEqual(archived ? [] : [parent.id]);
      if (!archived) {
        await tree.toggle(parent.id);
        expect(tree.titles()).toEqual([parent.id, child.id]);
      }
    });
  });
}
