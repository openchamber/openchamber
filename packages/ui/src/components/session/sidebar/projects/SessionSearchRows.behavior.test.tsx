import { afterAll, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import type { Session } from '@opencode-ai/sdk/v2';
import type { SessionTreeItemProps } from '../sessions/SessionTreeItem';
import { SessionRowOrderProvider, useSessionRowOrderRegistry, type SessionRowOrderRegistry } from '../sessions/sessionRowOrder';
import { installHookTestDom } from '../test-utils/testDom';
import type { SessionSearchRowsProps } from './SessionSearchRows';
import type { SessionSearchFolderRow, SessionSearchRowModel } from './sessionSearchRowModel';
import { I18nProvider } from '@/lib/i18n';
import { useSessionFoldersStore, type SessionFoldersMap } from '@/stores/useSessionFoldersStore';

const renderedRows: SessionTreeItemProps[] = [];
type RegistryCapture = { current: SessionRowOrderRegistry | null };
type SearchFolderDropTarget = { folderId: string; scopeKey: string; ownerKey: string };
type SearchFolderDropHandler = (sessionId: string, target: SearchFolderDropTarget, sourceOwnerKey: string) => void;
let searchFolderDropHandler: SearchFolderDropHandler | null = null;
const droppableStates: Array<{ folderId: string; scopeKey: string; disabled: boolean }> = [];

const installRealTestDom = () => {
  const browser = new Window({ url: 'http://localhost' });
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    localStorage: browser.localStorage,
    Element: browser.Element,
    HTMLElement: browser.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true });
  }
  Object.defineProperty(browser.HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get: () => 32,
  });
  const container = document.createElement('div');
  document.body.append(container);
  return {
    container,
    restore: async () => {
      await browser.happyDOM.close();
      for (const [key, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
};

// Install a real DOM before loading react-virtual. Its layout-effect choice is
// made at module evaluation time, so the virtualizer must see `document` here.
const initialDom = installRealTestDom();
afterAll(async () => initialDom.restore());

mock.module('../sessions/SessionTreeItem', () => ({
  SessionTreeItem: (props: SessionTreeItemProps) => {
    renderedRows.push(props);
    return <div data-session-row>{props.node.session.id}</div>;
  },
}));

mock.module('../folders/sessionFolderDnd', () => ({
  DroppableFolderWrapper: ({ folderId, scopeKey, disabled, children }: {
    folderId: string;
    scopeKey: string;
    disabled?: boolean;
    children: (ref: () => void, isOver: boolean) => React.ReactNode;
  }) => {
    droppableStates.push({ folderId, scopeKey, disabled: disabled === true });
    return <>{children(() => undefined, false)}</>;
  },
  SessionFolderDndScope: ({ children, onSessionDroppedOnFolder }: {
    children: React.ReactNode;
    onSessionDroppedOnFolder: SearchFolderDropHandler;
  }) => {
    searchFolderDropHandler = onSessionDroppedOnFolder;
    return <>{children}</>;
  },
}));

mock.module('../../SessionFolderItem', () => ({
  SessionFolderItem: () => <div data-session-folder />,
}));

mock.module('./sortableItems', () => ({
  SortableProjectItem: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));

mock.module('@/stores/useGitHubPrStatusStore', () => ({
  getGitHubPrStatusKey: () => '',
  usePrVisualSummary: () => null,
}));

const { SessionSearchRows } = await import('./SessionSearchRows');

const makeSession = (id: string): Session => ({
  id,
  slug: id,
  projectID: 'project',
  title: `Release ${id}`,
  version: '1',
  directory: '/repo/project',
  time: { created: 1, updated: 1 },
});

const makeModel = (count: number): SessionSearchRowModel => {
  const rows = Array.from({ length: count }, (_, index) => {
    const session = makeSession(`ses_${index}`);
    return {
      kind: 'session' as const,
      key: `session:${session.id}`,
      node: { session, children: [], worktree: null },
      depth: 0,
      projectId: 'project',
      groupDirectory: '/repo/project',
      folderOwnerKey: 'project',
      archivedBucket: false,
      renderContext: 'project' as const,
    };
  });
  return {
    rows,
    entries: rows.map((row) => ({ id: row.node.session.id, rowKey: row.key, scopeKey: 'project', archived: false })),
    projectSections: [],
    hasResults: true,
    hasRecentRows: false,
    folderRows: [],
    searchMatchCount: count,
    activeFolderScopesByOwner: new Map(),
  };
};

const makeFolderRow = (
  scopeKey: string,
  ownerKey: string,
  folder: SessionSearchFolderRow['folder'],
  archivedBucket = false,
): SessionSearchFolderRow => ({
  kind: 'folder',
  key: `folder:${scopeKey}:${folder.id}`,
  folder,
  group: {
    id: 'main',
    label: 'Project',
    branch: null,
    description: null,
    isMain: true,
    worktree: null,
    directory: scopeKey,
    folderScopeKey: scopeKey,
    sessions: [],
  },
  displayName: folder.name,
  scopeKey,
  scopeDirectory: scopeKey,
  folderOwnerKey: ownerKey,
  nodes: [],
  projectId: 'project',
  groupDirectory: scopeKey,
  archivedBucket,
  isCollapsed: false,
  deleteSessions: [],
  subFolderCount: 0,
});

const makeFolderModel = (
  row: SessionSearchFolderRow,
  activeFolderScopesByOwner: SessionSearchRowModel['activeFolderScopesByOwner'],
): SessionSearchRowModel => ({
  rows: [row],
  entries: [],
  projectSections: [],
  hasResults: true,
  hasRecentRows: false,
  folderRows: [row],
  searchMatchCount: 0,
  activeFolderScopesByOwner,
});

const prepareSearchViewport = (container: HTMLElement): void => {
  container.className = 'overlay-scrollbar-container';
  Object.defineProperty(container, 'offsetHeight', { configurable: true, value: 96 });
  Object.defineProperty(container, 'offsetWidth', { configurable: true, value: 320 });
  container.getBoundingClientRect = () => new window.DOMRect(0, 0, 320, 96);
};

const makeScanCountingModel = (count: number) => {
  const model = makeModel(count);
  const scanCalls = { some: 0, filter: 0 };
  const rows = [...model.rows];
  const originalSome = rows.some;
  const originalFilter = rows.filter;
  Object.defineProperty(rows, 'some', {
    configurable: true,
    value: (...args: Parameters<typeof originalSome>) => {
      scanCalls.some += 1;
      return originalSome.call(rows, ...args);
    },
  });
  Object.defineProperty(rows, 'filter', {
    configurable: true,
    value: (...args: Parameters<typeof originalFilter>) => {
      scanCalls.filter += 1;
      return originalFilter.call(rows, ...args);
    },
  });
  return { model: { ...model, rows }, scanCalls };
};

const makeProps = (
  model: SessionSearchRowModel,
  scrollContainerRef: React.RefObject<HTMLElement | null> = React.createRef<HTMLElement>(),
): SessionSearchRowsProps => ({
  model,
  scrollContainerRef,
  homeDirectory: '/home/user',
  hideDirectoryControls: false,
  isDesktopShellRuntime: false,
  stickyZoneHeaders: false,
  mobileVariant: false,
  alwaysShowActions: false,
  singleProjectMode: false,
  projectPickerOptions: [],
  activeProjectId: 'project',
  projectRepoStatus: new Map(),
  openSidebarMenuKey: null,
  setOpenSidebarMenuKey: () => undefined,
  sessionProps: {
    hasSessionSearchQuery: true,
    normalizedSessionSearchQuery: 'release',
    mobileVariant: false,
    alwaysShowActions: false,
    activeProjectId: 'project',
    notifyOnSubtasks: false,
    pinnedSessionIds: new Set(),
    expandedParents: new Set(),
    editingId: null,
    editTitle: '',
    copiedSessionId: null,
    setEditingId: () => undefined,
    setEditTitle: () => undefined,
    toggleParent: () => undefined,
    setOpenSidebarMenuKey: () => undefined,
    allowReselect: false,
    resetSessionSearch: () => undefined,
    deleteSessionConfirm: null,
    setDeleteSessionConfirm: () => undefined,
    startFolderRename: () => undefined,
    setCopiedSessionId: () => undefined,
    startSessionWorktreeMenuLoad: () => ({ cachedTargets: [], refreshTargets: Promise.resolve([]) }),
    folderRename: null,
    setFolderRenameDraft: () => undefined,
    clearFolderRename: () => undefined,
    onToggleCollapsedGroup: () => undefined,
  },
  toggleProject: () => undefined,
  setActiveProjectIdOnly: () => undefined,
  setSessionSwitcherOpen: () => undefined,
  openNewSessionDraft: () => undefined,
  openNewWorktreeDialog: () => undefined,
  openWorktreesPage: () => undefined,
  openProjectEditDialog: () => undefined,
  removeProject: () => undefined,
  setSingleProjectId: () => undefined,
  onNewChat: () => undefined,
  toggleActivitySection: () => undefined,
  projectHeaderSentinelRefs: {
    current: new Map(),
  },
  renderProjectStatusIndicator: undefined,
});

describe('SessionSearchRows public behavior', () => {
  test('keeps the logical row registry complete while the initial DOM mount is bounded', async () => {
    const dom = installHookTestDom();
    const root = createRoot(dom.container);
    const registryCapture: RegistryCapture = { current: null };
    const model = makeModel(260);

    try {
      await act(async () => root.render(
        <SessionRowOrderProvider>
          <RegistryProbe capture={registryCapture} />
          <SessionSearchRows {...makeProps(model)} />
        </SessionRowOrderProvider>,
      ));

      expect(renderedRows).toHaveLength(0);
      // SAFETY: the search content wrapper is the only child mounted by the
      // mocked DnD scope in this unresolved-scroller fixture.
      const content = dom.container.childNodes[0] as HTMLElement | undefined;
      expect(content?.style.height).toBe(`${260 * 32}px`);
      expect(registryCapture.current?.getOrderedEntries()).toHaveLength(260);
      expect(registryCapture.current?.getOrderedEntries()[0]?.id).toBe('ses_0');
      expect(registryCapture.current?.getOrderedEntries()[259]?.id).toBe('ses_259');
    } finally {
      await act(async () => root.unmount());
      renderedRows.length = 0;
      dom.restore();
    }
  });

  test('mounts only the viewport window plus overscan once the scroll element is available', async () => {
    const dom = installRealTestDom();
    const scrollContainer = dom.container;
    scrollContainer.className = 'overlay-scrollbar-container';
    Object.defineProperty(scrollContainer, 'offsetHeight', { configurable: true, value: 96 });
    Object.defineProperty(scrollContainer, 'offsetWidth', { configurable: true, value: 320 });
    scrollContainer.getBoundingClientRect = () => new window.DOMRect(0, 0, 320, 96);
    const root = createRoot(scrollContainer);
    const model = makeModel(260);
    renderedRows.length = 0;

    try {
      await act(async () => root.render(<SessionSearchRows {...makeProps(model)} />));

      expect(renderedRows.length).toBeGreaterThan(0);
      expect(renderedRows.length).toBeLessThan(model.rows.length);
    } finally {
      await act(async () => root.unmount());
      renderedRows.length = 0;
      await dom.restore();
    }
  });

  test('does not scan the full row model during an ordinary virtualizer rerender', async () => {
    const dom = installRealTestDom();
    const scrollContainer = dom.container;
    scrollContainer.className = 'overlay-scrollbar-container';
    Object.defineProperty(scrollContainer, 'offsetHeight', { configurable: true, value: 96 });
    Object.defineProperty(scrollContainer, 'offsetWidth', { configurable: true, value: 320 });
    scrollContainer.getBoundingClientRect = () => new window.DOMRect(0, 0, 320, 96);
    const root = createRoot(scrollContainer);
    const scrollContainerRef = { current: scrollContainer };
    const { model, scanCalls } = makeScanCountingModel(1000);
    renderedRows.length = 0;

    try {
      await act(async () => root.render(<SessionSearchRows {...makeProps(model, scrollContainerRef)} />));
      const initialScanCalls = { ...scanCalls };

      await act(async () => root.render(<SessionSearchRows {...makeProps(model, scrollContainerRef)} />));

      expect(scanCalls).toEqual(initialScanCalls);
    } finally {
      await act(async () => root.unmount());
      renderedRows.length = 0;
      await dom.restore();
    }
  });

  test('passes distinct row keys to duplicate session occurrences', async () => {
    const dom = installRealTestDom();
    Object.defineProperty(dom.container, 'offsetHeight', { configurable: true, value: 96 });
    Object.defineProperty(dom.container, 'offsetWidth', { configurable: true, value: 320 });
    dom.container.className = 'overlay-scrollbar-container';
    const root = createRoot(dom.container);
    const session = makeSession('ses_duplicate');
    const node = { session, children: [], worktree: null };
    const model: SessionSearchRowModel = {
      rows: [
        {
          kind: 'session',
           key: 'activity:active-now:ses_duplicate:0:session:ses_duplicate',
          node,
          depth: 0,
           projectId: 'project',
           groupDirectory: '/repo/project',
           folderOwnerKey: 'project',
           archivedBucket: false,
          renderContext: 'recent',
        },
        {
          kind: 'session',
           key: 'project:project:session:ses_duplicate',
          node,
          depth: 0,
           projectId: 'project',
           groupDirectory: '/repo/project',
           folderOwnerKey: 'project',
           archivedBucket: false,
          renderContext: 'project',
        },
      ],
      entries: [
        { id: session.id, rowKey: 'activity:active-now:ses_duplicate:0:session:ses_duplicate', scopeKey: 'project', archived: false },
        { id: session.id, rowKey: 'project:project:session:ses_duplicate', scopeKey: 'project', archived: false },
      ],
      projectSections: [],
      hasResults: true,
      hasRecentRows: true,
      folderRows: [],
      searchMatchCount: 1,
      activeFolderScopesByOwner: new Map(),
    };

    try {
      await act(async () => root.render(
        <SessionRowOrderProvider><SessionSearchRows {...makeProps(model, { current: dom.container })} /></SessionRowOrderProvider>,
      ));

      expect([...new Set(renderedRows.map((row) => row.dragKey))]).toEqual([
         'activity:active-now:ses_duplicate:0:session:ses_duplicate',
        'project:project:session:ses_duplicate',
      ]);
      expect([...new Set(renderedRows.map((row) => row.rowKey))]).toEqual([
         'activity:active-now:ses_duplicate:0:session:ses_duplicate',
        'project:project:session:ses_duplicate',
      ]);
    } finally {
      await act(async () => root.unmount());
      renderedRows.length = 0;
      await dom.restore();
    }
  });

  test('keeps the Recent relative-time tick behavior', async () => {
    const dom = installRealTestDom();
    const scrollContainer = dom.container;
    scrollContainer.className = 'overlay-scrollbar-container';
    Object.defineProperty(scrollContainer, 'offsetHeight', { configurable: true, value: 96 });
    Object.defineProperty(scrollContainer, 'offsetWidth', { configurable: true, value: 320 });
    scrollContainer.getBoundingClientRect = () => new window.DOMRect(0, 0, 320, 96);
    const root = createRoot(scrollContainer);
    const scrollContainerRef = { current: scrollContainer };
    const session = makeSession('ses_recent');
    const row = {
      kind: 'session' as const,
      key: 'activity:active-now:ses_recent:session:ses_recent',
      node: { session, children: [], worktree: null },
      depth: 0,
      projectId: 'project',
      groupDirectory: '/repo/project',
      folderOwnerKey: 'project',
      archivedBucket: false,
      renderContext: 'recent' as const,
    };
    const model: SessionSearchRowModel = {
      rows: [row],
      entries: [{ id: session.id, rowKey: row.key, scopeKey: 'project', archived: false }],
      projectSections: [],
      hasResults: true,
      hasRecentRows: true,
      folderRows: [],
      searchMatchCount: 1,
      activeFolderScopesByOwner: new Map(),
    };
    const intervalCallbacks: Array<() => void> = [];
    const originalSetInterval = window.setInterval;
    const originalClearInterval = window.clearInterval;
    Object.defineProperty(window, 'setInterval', {
      configurable: true,
      value: (callback: () => void) => {
        intervalCallbacks.push(callback);
        return 1;
      },
    });
    Object.defineProperty(window, 'clearInterval', {
      configurable: true,
      value: () => undefined,
    });
    renderedRows.length = 0;

    try {
      await act(async () => root.render(<SessionSearchRows {...makeProps(model, scrollContainerRef)} />));

      expect(intervalCallbacks).toHaveLength(1);
      expect(renderedRows.at(-1)?.renderExtras?.relativeTimeTick).toBe(0);

      await act(async () => intervalCallbacks[0]?.());

      expect(renderedRows.at(-1)?.renderExtras?.relativeTimeTick).toBe(1);
    } finally {
      await act(async () => root.unmount());
      Object.defineProperty(window, 'setInterval', { configurable: true, value: originalSetInterval });
      Object.defineProperty(window, 'clearInterval', { configurable: true, value: originalClearInterval });
      renderedRows.length = 0;
      await dom.restore();
    }
  });

  test('marks search activity headers as sticky when the display setting is enabled', async () => {
    const dom = installRealTestDom();
    Object.defineProperty(dom.container, 'offsetHeight', { configurable: true, value: 96 });
    Object.defineProperty(dom.container, 'offsetWidth', { configurable: true, value: 320 });
    dom.container.className = 'overlay-scrollbar-container';
    const root = createRoot(dom.container);
    const model: SessionSearchRowModel = {
      rows: [{
        kind: 'activity-header',
        key: 'activity:chats:header',
        activityKey: 'chats',
        showNewChat: true,
        isCollapsed: false,
      }],
      entries: [],
      projectSections: [],
      hasResults: true,
      hasRecentRows: false,
      folderRows: [],
      searchMatchCount: 0,
      activeFolderScopesByOwner: new Map(),
    };

    try {
      await act(async () => root.render(
        <I18nProvider><SessionSearchRows {...makeProps(model, { current: dom.container })} stickyZoneHeaders /></I18nProvider>,
      ));

      const header = dom.container.querySelector('[data-sidebar-sticky-header="true"]');
      expect(header?.className).toContain('sticky');
      expect(header?.querySelector('[data-sidebar-activity-start="chats"]')).not.toBeNull();
    } finally {
      await act(async () => root.unmount());
      renderedRows.length = 0;
      await dom.restore();
    }
  });

  test('cleans hidden active scopes while leaving archived scope membership unchanged', async () => {
    const dom = installRealTestDom();
    prepareSearchViewport(dom.container);
    const root = createRoot(dom.container);
    const ownerKey = 'project';
    const projectRoot = '/repo/project';
    const worktreeRoot = '/repo/project-worktree';
    const archivedScope = `__archived__:${projectRoot}`;
    const targetFolder = { id: 'target-folder', name: 'Target', sessionIds: [], createdAt: 1 };
    const hiddenFolder = { id: 'hidden-folder', name: 'Hidden', sessionIds: ['ses_move'], createdAt: 1 };
    const archivedFolder = { id: 'archived-folder', name: 'Archived', sessionIds: ['ses_move'], createdAt: 1 };
    const row = makeFolderRow(projectRoot, ownerKey, targetFolder);
    const archivedRow = makeFolderRow(archivedScope, ownerKey, archivedFolder, true);
    const model = {
      ...makeFolderModel(row, new Map([[ownerKey, {
        scopeKeys: [projectRoot, worktreeRoot],
        complete: true,
      }]])),
      rows: [row, archivedRow],
      folderRows: [row, archivedRow],
    } satisfies SessionSearchRowModel;
    const originalFoldersMap = useSessionFoldersStore.getState().foldersMap;
    const foldersMap: SessionFoldersMap = {
      [projectRoot]: [targetFolder],
      [worktreeRoot]: [hiddenFolder],
      [archivedScope]: [archivedFolder],
    };

    try {
      useSessionFoldersStore.setState({ foldersMap });
      await act(async () => root.render(
        <I18nProvider><SessionSearchRows {...makeProps(model, { current: dom.container })} /></I18nProvider>,
      ));

      expect(droppableStates.find((state) => state.folderId === targetFolder.id)).toEqual({
        folderId: targetFolder.id,
        scopeKey: projectRoot,
        disabled: false,
      });
      expect(droppableStates.find((state) => state.folderId === archivedFolder.id)?.disabled).toBe(true);
      await act(async () => searchFolderDropHandler?.('ses_move', {
        folderId: targetFolder.id,
        scopeKey: projectRoot,
        ownerKey,
      }, ownerKey));

      const updated = useSessionFoldersStore.getState().foldersMap;
      expect(updated[projectRoot]?.[0]?.sessionIds).toEqual(['ses_move']);
      expect(updated[worktreeRoot]?.[0]?.sessionIds).toEqual([]);
      expect(updated[archivedScope]?.[0]?.sessionIds).toEqual(['ses_move']);
    } finally {
      await act(async () => root.unmount());
      useSessionFoldersStore.setState({ foldersMap: originalFoldersMap });
      searchFolderDropHandler = null;
      droppableStates.length = 0;
      await dom.restore();
    }
  });

  test('disables and ignores drops for incomplete owner scope authority', async () => {
    const dom = installRealTestDom();
    prepareSearchViewport(dom.container);
    const root = createRoot(dom.container);
    const ownerKey = 'project';
    const projectRoot = '/repo/project';
    const targetFolder = { id: 'target-folder', name: 'Target', sessionIds: [], createdAt: 1 };
    const hiddenFolder = { id: 'hidden-folder', name: 'Hidden', sessionIds: ['ses_move'], createdAt: 1 };
    const row = makeFolderRow(projectRoot, ownerKey, targetFolder);
    const model = makeFolderModel(row, new Map([[ownerKey, {
      scopeKeys: [],
      complete: false,
    }]]));
    const originalFoldersMap = useSessionFoldersStore.getState().foldersMap;
    const foldersMap: SessionFoldersMap = {
      [projectRoot]: [targetFolder],
      ['/repo/project-worktree']: [hiddenFolder],
    };

    try {
      useSessionFoldersStore.setState({ foldersMap });
      await act(async () => root.render(
        <I18nProvider><SessionSearchRows {...makeProps(model, { current: dom.container })} /></I18nProvider>,
      ));

      expect(droppableStates.at(-1)?.disabled).toBe(true);
      await act(async () => searchFolderDropHandler?.('ses_move', {
        folderId: targetFolder.id,
        scopeKey: projectRoot,
        ownerKey,
      }, ownerKey));

      expect(useSessionFoldersStore.getState().foldersMap).toEqual(foldersMap);
    } finally {
      await act(async () => root.unmount());
      useSessionFoldersStore.setState({ foldersMap: originalFoldersMap });
      searchFolderDropHandler = null;
      droppableStates.length = 0;
      await dom.restore();
    }
  });

  test('rejects a target that is not a visible search folder row', async () => {
    const dom = installRealTestDom();
    prepareSearchViewport(dom.container);
    const root = createRoot(dom.container);
    const ownerKey = 'project';
    const projectRoot = '/repo/project';
    const visibleFolder = { id: 'visible-folder', name: 'Visible', sessionIds: [], createdAt: 1 };
    const hiddenFolder = { id: 'hidden-folder', name: 'Hidden', sessionIds: ['ses_move'], createdAt: 1 };
    const row = makeFolderRow(projectRoot, ownerKey, visibleFolder);
    const model = makeFolderModel(row, new Map([[ownerKey, {
      scopeKeys: [projectRoot],
      complete: true,
    }]]));
    const originalFoldersMap = useSessionFoldersStore.getState().foldersMap;
    const foldersMap: SessionFoldersMap = { [projectRoot]: [visibleFolder, hiddenFolder] };

    try {
      useSessionFoldersStore.setState({ foldersMap });
      await act(async () => root.render(
        <I18nProvider><SessionSearchRows {...makeProps(model, { current: dom.container })} /></I18nProvider>,
      ));

      await act(async () => searchFolderDropHandler?.('ses_move', {
        folderId: hiddenFolder.id,
        scopeKey: projectRoot,
        ownerKey,
      }, ownerKey));

      expect(useSessionFoldersStore.getState().foldersMap).toEqual(foldersMap);
    } finally {
      await act(async () => root.unmount());
      useSessionFoldersStore.setState({ foldersMap: originalFoldersMap });
      searchFolderDropHandler = null;
      droppableStates.length = 0;
      await dom.restore();
    }
  });

  test('keeps the search group header toggle affordance visible when actions are always shown', async () => {
    const dom = installRealTestDom();
    prepareSearchViewport(dom.container);
    const root = createRoot(dom.container);
    const group = {
      id: 'worktree-group',
      label: 'Worktree A',
      branch: 'feature-a',
      description: null,
      isMain: false,
      worktree: null,
      directory: '/repo/project-worktree',
      sessions: [],
    };
    const model: SessionSearchRowModel = {
      rows: [{
        kind: 'group-header',
        key: 'project:project:worktree-group:header',
        group,
        groupKey: 'project:worktree-group',
        projectId: 'project',
        hideGroupLabel: false,
        isCollapsed: false,
        allGroupSessions: [],
      }],
      entries: [],
      projectSections: [],
      hasResults: true,
      hasRecentRows: false,
      folderRows: [],
      searchMatchCount: 0,
      activeFolderScopesByOwner: new Map(),
    };

    try {
      await act(async () => root.render(
        <I18nProvider><SessionSearchRows {...makeProps(model, { current: dom.container })} /></I18nProvider>,
      ));

      const hoverStaticIcon = dom.container.querySelector<HTMLElement>('[data-gh-icon-static="git-branch"]');
      const hoverArrowSwap = dom.container.querySelector<HTMLElement>('span[data-gh-icon-swap="git-branch"]');
      expect(hoverStaticIcon?.className).toContain('group-hover/gh:hidden');
      expect(hoverArrowSwap?.className).toContain('group-hover/gh:inline-flex');

      await act(async () => root.render(
        <I18nProvider><SessionSearchRows {...makeProps(model, { current: dom.container })} alwaysShowActions /></I18nProvider>,
      ));

      const alwaysStaticIcon = dom.container.querySelector<HTMLElement>('[data-gh-icon-static="git-branch"]');
      const alwaysArrowSwap = dom.container.querySelector<HTMLElement>('span[data-gh-icon-swap="git-branch"]');
      expect(alwaysStaticIcon?.className).toContain('hidden');
      expect(alwaysStaticIcon?.className).not.toContain('group-hover/gh:hidden');
      expect(alwaysArrowSwap?.className).toContain('inline-flex');
      expect(alwaysArrowSwap?.className).not.toContain('group-hover/gh:inline-flex');
    } finally {
      await act(async () => root.unmount());
      await dom.restore();
    }
  });
});

const RegistryProbe: React.FC<{ capture: RegistryCapture }> = ({ capture }) => {
  capture.current = useSessionRowOrderRegistry();
  return null;
};
