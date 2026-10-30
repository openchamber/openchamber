import { expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { I18nProvider } from '@/lib/i18n';
import { useProjectsStore } from '@/stores/useProjectsStore';
import type { SessionNodeItemProps } from './SessionNodeItem';
import type { SessionRefLine } from './useSessionRefLines';

const opened: Array<{ url: string; directory: string | null }> = [];
let refUrl = '';
let rowRenders = 0;
const syncContext = await import('@/sync/sync-context');
mock.module('@/sync/sync-context', () => ({
  ...syncContext,
  useSessionBlockingRequests: () => ({ hasPendingPermissions: false, hasPendingQuestions: false }),
}));
const aiRename = await import('@/sync/use-session-ai-rename');
mock.module('@/sync/use-session-ai-rename', () => ({
  ...aiRename,
  useIsSessionAiRenamePending: () => false,
}));
mock.module('@/components/sourceBoard/openTrackerItem', () => ({
  useOpenTrackerItem: () => (url: string, directory: string | null) => opened.push({ url, directory }),
}));
mock.module('./useSessionRefLines', () => ({
  useSessionRefLines: () => {
    rowRenders += 1;
    return {
      refLines: [{ key: 'ref', label: '#42', text: '#42', title: null, url: refUrl, icon: 'git-pull-request' } satisfies SessionRefLine],
      branchPrIconColor: null,
    };
  },
}));
const sync = await import('@/sync/use-sync');
mock.module('@/sync/use-sync', () => ({
  ...sync,
  useSessionMessageRecordsForExport: () => async () => [],
  usePrefetchSessionMessages: () => () => undefined,
}));
const { SessionNodeItem } = await import('./SessionNodeItem');

for (const [kind, ownerProjectId, directory, updateOwner] of [
  ['pull', 'project-b', '/project-b', false],
  ['issues', 'project-b', '/project-b', false],
  ['pull', null, '/project-b/worktree', false],
  ['pull', 'project-b', '/project-b', true],
] as const) {
test(`a child displayed in A opens ${kind} with owner ${ownerProjectId} through ${directory}${updateOwner ? ' after ownership updates' : ''}`, async () => {
  refUrl = `https://github.com/example/b/${kind}/42`;
  const win = new Window({ url: 'http://localhost/' });
  const globals = {
    window: win, document: win.document, navigator: win.navigator,
    Node: win.Node, Element: win.Element, HTMLElement: win.HTMLElement,
    HTMLIFrameElement: win.HTMLIFrameElement, Event: win.Event, MouseEvent: win.MouseEvent,
    getComputedStyle: win.getComputedStyle.bind(win),
    requestAnimationFrame: win.requestAnimationFrame.bind(win),
    cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
    ResizeObserver: win.ResizeObserver, IS_REACT_ACT_ENVIRONMENT: true,
  };
  const descriptors = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, globals);
  const originalProjects = useProjectsStore.getState();
  useProjectsStore.setState({ projects: [
    { id: 'project-a', path: '/project-a' },
    { id: 'project-b', path: '/project-b' },
  ] });
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const noop = () => undefined;
  const props: SessionNodeItemProps = {
    node: {
      session: {
        id: 'child', parentID: 'parent', projectID: 'project-b', title: 'Child',
        directory: '/project-b/worktree', cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 1, updated: 1 },
      },
      children: [], worktree: null,
    },
    ownsWork: false, projectId: 'project-a', ownerProjectId, renderContext: 'mixed-compact',
    folderOwnerKey: 'project-b', groupDirectory: '/project-a',
    pinnedSessionIds: new Set(), expandedParents: new Set(),
    hasSessionSearchQuery: false, normalizedSessionSearchQuery: '',
    editingId: null, editingRowKey: null, editTitle: '', openSidebarMenuKey: null,
    setEditingId: noop, setEditingRowKey: noop, setEditTitle: noop,
    handleSaveEdit: noop, handleCancelEdit: noop, toggleParent: noop,
    handleSessionSelect: noop, handleSessionDoubleClick: noop, handleCopySessionId: noop,
    setOpenSidebarMenuKey: noop, createFolderAndStartRename: () => null,
    handleDeleteSession: noop, handleRestoreSession: noop,
    startSessionWorktreeMenuLoad: () => ({ cachedTargets: [], refreshTargets: Promise.resolve([]) }),
    mobileVariant: false, alwaysShowActions: false,
    subtreeContainsEditing: new Set(), menuOpenSessionId: null, nodeStructureKey: '',
  };
  try {
    if (updateOwner) {
      const initialProps = { ...props, ownerProjectId: null, folderOwnerKey: 'project-a', selectionScopeKey: 'project-a' };
      const render = async (value: SessionNodeItemProps) => {
        await act(async () => root.render(<I18nProvider><SessionNodeItem {...value} /></I18nProvider>));
      };
      await render(initialProps);
      let renders = rowRenders;
      await render({ ...initialProps });
      expect(rowRenders).toBe(renders);
      const ownedProps = { ...initialProps, ownerProjectId };
      await render(ownedProps);
      expect(rowRenders).toBeGreaterThan(renders);
      renders = rowRenders;
      const folderProps = { ...ownedProps, folderOwnerKey: 'project-b' };
      await render(folderProps);
      expect(rowRenders).toBeGreaterThan(renders);
      renders = rowRenders;
      await render({ ...folderProps, selectionScopeKey: 'project-b' });
      expect(rowRenders).toBeGreaterThan(renders);
      expect(host.querySelector('[data-session-row]')?.getAttribute('data-session-scope')).toBe('project-b');
    } else {
      await act(async () => root.render(<I18nProvider><SessionNodeItem {...props} /></I18nProvider>));
    }
    const chip = host.querySelector<HTMLButtonElement>('button[aria-label="#42"]');
    expect(chip).not.toBeNull();
    await act(async () => chip?.click());
    expect(opened).toEqual([{ url: refUrl, directory }]);
  } finally {
    await act(async () => root.unmount());
    useProjectsStore.setState(originalProjects, true);
    opened.length = 0;
    await win.happyDOM.close();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
}
