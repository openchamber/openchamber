import { afterAll, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChildStoreManager } from '@/sync/child-store';
import { I18nProvider } from '@/lib/i18n';
import { useSessionFoldersStore } from '@/stores/useSessionFoldersStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionMultiSelectStore } from '@/stores/useSessionMultiSelectStore';
import type { SessionFolder } from '@/stores/useSessionFoldersStore';
import type { Session } from '@opencode-ai/sdk/v2';
import type { GroupSearchData, SessionGroup } from '../types';
import type { SessionGroupSectionProps } from './SessionGroupSection';
import type { SessionTreeItemProps } from '../sessions/SessionTreeItem';
import { installHookTestDom } from '../test-utils/testDom';
import {
  SessionRowOrderProvider,
  useSessionRowOrderRegistry,
  type SessionRowOrderRegistry,
} from '../sessions/sessionRowOrder';

type FolderCallbacks = {
  onRename: (name: string) => void;
  onDelete: () => void;
};

type FolderPropsCapture = FolderCallbacks & {
  renderBody?: boolean;
  children?: React.ReactNode;
};

type RegistryCapture = {
  registry: SessionRowOrderRegistry | null;
};

const orderedIds = (registry: SessionRowOrderRegistry | null): string[] => (
  registry?.getOrderedEntries().map((entry) => entry.id) ?? []
);

type RowPropsCapture = Pick<SessionGroupSectionProps,
  | 'allowReselect'
  | 'onSessionSelected'
  | 'resetSessionSearch'
  | 'deleteSessionConfirm'
  | 'copiedSessionId'
  | 'setCopiedSessionId'
>;

let folderCallbacks: FolderCallbacks | null = null;
let renderedFolderBodies: boolean[] = [];
let rowPropsCapture: RowPropsCapture | null = null;
let renderedRowCalls: SessionTreeItemProps[] = [];
const childStores = new ChildStoreManager();

mock.module('../../SessionFolderItem', () => ({
  SessionFolderItem: (props: FolderPropsCapture) => {
    folderCallbacks = props;
    renderedFolderBodies.push(props.renderBody ?? true);
    return props.children ?? null;
  },
}));

mock.module('../folders/sessionFolderDnd', () => ({
  DroppableFolderWrapper: ({ children }: { children: (ref: () => void, isOver: boolean) => React.ReactNode }) => <>{children(() => undefined, false)}</>,
  SessionFolderDndScope: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

mock.module('@/sync/sync-context', () => ({
  setActiveSession: () => undefined,
  useChildStoreManager: () => childStores,
  useDirectoryStore: () => null,
  useGlobalSessionStatus: () => null,
  useSessionPermissions: () => null,
  useSessionQuestionCount: () => 0,
  useSyncSDK: () => null,
  useSyncDirectory: () => null,
  buildSessionMessageRecordsSnapshot: () => [],
}));

mock.module('../sessions/collapsedActivityIndicator', () => ({
  CollapsedSessionActivityIndicator: () => null,
}));

mock.module('../sessions/collapsedActivityState', () => ({
  useCollapsedSessionActivityState: () => null,
}));

mock.module('../sessions/SessionTreeItem', () => ({
  SessionTreeItem: (props: SessionTreeItemProps) => {
    rowPropsCapture = props;
    renderedRowCalls.push(props);
    return null;
  },
}));

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
  Object.defineProperty(browser.HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get: () => 320,
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

// Install a real DOM before loading react-virtual so its layout-effect path is
// selected for the mounted-window regression below.
const initialDom = installRealTestDom();

const { SessionGroupSection } = await import('./SessionGroupSection');

afterAll(async () => initialDom.restore());

const folder: SessionFolder = {
  id: 'folder-a',
  name: 'Initial folder',
  parentId: null,
  sessionIds: [],
  createdAt: 1,
};

const group: SessionGroupSectionProps['group'] = {
  id: 'main',
  label: 'Main',
  branch: null,
  description: null,
  isMain: true,
  worktree: null,
  directory: '/workspace',
  folderScopeKey: '/workspace',
  sessions: [],
};

const groupWithSession: SessionGroupSectionProps['group'] = {
  ...group,
  // SAFETY: SessionGroupSection only reads the fixture session's id in this test.
  sessions: [{ session: { id: 'session-a' } as Session, children: [], worktree: null }],
};

const createProps = (): SessionGroupSectionProps => ({
  group,
  groupKey: 'project:main',
  projectId: 'project',
  hideGroupLabel: true,
  rowOrderBase: 1000,
  hasSessionSearchQuery: false,
  normalizedSessionSearchQuery: '',
  groupSearchDataByGroup: new WeakMap(),
  collapsedGroups: new Set(),
  hideDirectoryControls: false,
  showMoreGroupSessions: () => undefined,
  resetGroupSessionLimit: () => undefined,
  mobileVariant: false,
  alwaysShowActions: false,
  activeProjectId: null,
  setActiveProjectIdOnly: () => undefined,
  setSessionSwitcherOpen: () => undefined,
  openNewSessionDraft: () => undefined,
  pinnedSessionIds: new Set(),
  sessionOrderIndex: new Map(),
  notifyOnSubtasks: false,
  expandedParents: new Set(),
  editingId: null,
  editTitle: '',
  copiedSessionId: null,
  openSidebarMenuKey: null,
  setEditingId: () => undefined,
  setEditTitle: () => undefined,
  toggleParent: () => undefined,
  setOpenSidebarMenuKey: () => undefined,
  startFolderRename: () => undefined,
  allowReselect: false,
  resetSessionSearch: () => undefined,
  deleteSessionConfirm: null,
  setDeleteSessionConfirm: () => undefined,
  setCopiedSessionId: () => undefined,
  startSessionWorktreeMenuLoad: () => ({
    cachedTargets: [],
    refreshTargets: Promise.resolve([]),
  }),
  onToggleCollapsedGroup: () => undefined,
  folderRename: null,
  setFolderRenameDraft: () => undefined,
  clearFolderRename: () => undefined,
});

type Root = ReturnType<typeof createRoot>;

const RegistryCaptureProbe = ({ capture }: { capture: RegistryCapture }) => {
  capture.registry = useSessionRowOrderRegistry();
  return null;
};

const searchDataFor = (target: SessionGroup): WeakMap<SessionGroup, GroupSearchData> => new WeakMap([[
  target,
  {
    filteredNodes: target.sessions,
    matchedSessionCount: target.sessions.length,
    folderNameMatchCount: 0,
    groupMatches: true,
    hasMatch: true,
  },
]]);

const flatRootGroup = (rootCount: number, isArchivedBucket: boolean): SessionGroup => ({
  ...group,
  isArchivedBucket,
  // SAFETY: SessionGroupSection only reads the fixture session ids in this test.
  sessions: Array.from({ length: rootCount }, (_, index) => ({
    session: { id: `session-${String(index).padStart(2, '0')}` } as Session,
    children: [],
    worktree: null,
  })),
});

const renderGroup = async (
  root: Root,
  target: SessionGroup,
  capture: RegistryCapture,
  overrides: Partial<SessionGroupSectionProps> = {},
): Promise<void> => {
  await act(async () => root.render(
    <I18nProvider>
      <SessionRowOrderProvider>
        <RegistryCaptureProbe capture={capture} />
        <SessionGroupSection
          {...createProps()}
          group={target}
          groupSearchDataByGroup={searchDataFor(target)}
          {...overrides}
        />
      </SessionRowOrderProvider>
    </I18nProvider>,
  ));
};

describe('SessionGroupSection public behavior', () => {
  test('an empty successful list does not spin for initialization and keeps initialization failure retryable', async () => {
    let rejectInitialization!: (error: Error) => void;
    const initialization = new Promise<void>((_resolve, reject) => { rejectInitialization = reject; });
    childStores.configure({ onBootstrap: (context) => { context.trackInitialization(initialization); } });
    childStores.requestBootstrap({ directory: '/workspace', priority: 'selected', reason: 'selected-session' });
    await Promise.resolve();
    await Promise.resolve();
    try {
      const waiting = renderToStaticMarkup(<I18nProvider><SessionGroupSection {...createProps()} /></I18nProvider>);
      expect(waiting).toContain('No sessions in this workspace yet.');
      expect(waiting).not.toContain('Loading sessions');
      rejectInitialization(new Error('initialization failed'));
      await Promise.resolve();
      await Promise.resolve();
      const failed = renderToStaticMarkup(<I18nProvider><SessionGroupSection {...createProps()} /></I18nProvider>);
      expect(failed).toContain('Could not initialize workspace.');
      expect(failed).toContain('Try again');
      expect(failed).not.toContain('Could not refresh sessions.');
    } finally {
      rejectInitialization(new Error('test finished'));
      childStores.disposeAll();
    }
  });

  test('routes rendered folder rename and delete actions to the owning folder store', async () => {
    const dom = installHookTestDom();
    const root = createRoot(dom.container);
    const originalFolders = useSessionFoldersStore.getState();
    const originalUi = useUIStore.getState();
    useSessionFoldersStore.setState({ foldersMap: { '/workspace': [folder] } });
    useUIStore.setState({ showDeletionDialog: false });

    try {
      await act(async () => root.render(<I18nProvider><SessionGroupSection {...createProps()} /></I18nProvider>));
      expect(folderCallbacks).not.toBeNull();

      await act(async () => folderCallbacks?.onRename('Renamed folder'));
      expect(useSessionFoldersStore.getState().foldersMap['/workspace']?.[0]?.name).toBe('Renamed folder');

      await act(async () => folderCallbacks?.onDelete());
      expect(useSessionFoldersStore.getState().foldersMap['/workspace']).toEqual([]);
    } finally {
      await act(async () => root.unmount());
      useSessionFoldersStore.setState(originalFolders, true);
      useUIStore.setState(originalUi, true);
      folderCallbacks = null;
      dom.restore();
    }
  });

  test('propagates confirmation, search reset, and copy ownership changes to rendered rows', async () => {
    const dom = installHookTestDom();
    const root = createRoot(dom.container);
    const firstSelected = () => undefined;
    const nextSelected = () => undefined;
    const firstReset = () => undefined;
    const nextReset = () => undefined;
    const firstCopied = () => undefined;
    const nextCopied = () => undefined;
    const initialProps = createProps();

    try {
      await act(async () => root.render(<I18nProvider><SessionGroupSection {...initialProps} group={groupWithSession} onSessionSelected={firstSelected} resetSessionSearch={firstReset} setCopiedSessionId={firstCopied} /></I18nProvider>));
      expect(rowPropsCapture?.onSessionSelected).toBe(firstSelected);
      expect(rowPropsCapture?.resetSessionSearch).toBe(firstReset);
      expect(rowPropsCapture?.deleteSessionConfirm).toBeNull();
      expect(rowPropsCapture?.copiedSessionId).toBeNull();
      expect(rowPropsCapture?.setCopiedSessionId).toBe(firstCopied);

      // SAFETY: the confirmation is only forwarded by identity to the row mock.
      const confirmation = { session: { id: 'session-a' } as Session, descendantCount: 0, descendantIds: [], archivedBucket: false };
      await act(async () => root.render(<I18nProvider><SessionGroupSection {...initialProps} group={groupWithSession} allowReselect onSessionSelected={nextSelected} resetSessionSearch={nextReset} deleteSessionConfirm={confirmation} copiedSessionId="session-a" setCopiedSessionId={nextCopied} /></I18nProvider>));
      expect(rowPropsCapture?.allowReselect).toBe(true);
      expect(rowPropsCapture?.onSessionSelected).toBe(nextSelected);
      expect(rowPropsCapture?.resetSessionSearch).toBe(nextReset);
      expect(rowPropsCapture?.deleteSessionConfirm).toBe(confirmation);
      expect(rowPropsCapture?.copiedSessionId).toBe('session-a');
      expect(rowPropsCapture?.setCopiedSessionId).toBe(nextCopied);
    } finally {
      await act(async () => root.unmount());
      rowPropsCapture = null;
      dom.restore();
    }
  });

  test('keeps managed-chat selection scoped to the shared root, not the dated session directory', async () => {
    const dom = installHookTestDom();
    const root = createRoot(dom.container);
     const capture: RegistryCapture = { registry: null };
     const chatsRoot = '/home/user/.config/openchamber/chats';
     const datedDirectory = `${chatsRoot}/2026-09-13/session-chat`;
     // SAFETY: The mocked row renderer only reads the session identity and directory;
     // the fixture intentionally omits unrelated SDK fields.
     const managedChatSession = { id: 'chat', directory: datedDirectory } as Session;
     const managedChatGroup: SessionGroupSectionProps['group'] = {
       ...group,
       directory: chatsRoot,
       folderScopeKey: chatsRoot,
       folderScopes: [{ scopeKey: chatsRoot, directory: chatsRoot }],
       sessions: [{ session: managedChatSession, children: [], worktree: null }],
     };
    renderedRowCalls = [];

    try {
      await renderGroup(root, managedChatGroup, capture, { projectId: null });

      expect(renderedRowCalls[0]?.selectionScopeKey).toBe(chatsRoot);
      expect(capture.registry?.getOrderedEntries().map((entry) => entry.scopeKey)).toEqual([chatsRoot]);
    } finally {
      await act(async () => root.unmount());
      renderedRowCalls = [];
      dom.restore();
    }
  });

  test('keeps rendered folder row keys aligned with the registry for shift-range selection', async () => {
    const dom = installHookTestDom();
    const root = createRoot(dom.container);
    const originalFolders = useSessionFoldersStore.getState();
    const originalSelection = useSessionMultiSelectStore.getState();
    const sessionIds = ['folder-session-a', 'folder-session-b'];
    const folderWithSessions: SessionFolder = { ...folder, sessionIds };
    const folderGroup: SessionGroupSectionProps['group'] = {
      ...group,
      sessions: sessionIds.map((id) => ({
        // SAFETY: The mocked row renderer only reads the fixture session id.
        session: { id } as Session,
        children: [],
        worktree: null,
      })),
    };
    const capture: RegistryCapture = { registry: null };
    renderedRowCalls = [];
    useSessionFoldersStore.setState({ foldersMap: { '/workspace': [folderWithSessions] } });

    try {
      await renderGroup(root, folderGroup, capture);

      const renderedRowKeys = renderedRowCalls.map((row) => row.rowKey);
      const orderedEntries = capture.registry?.getOrderedEntries() ?? [];
      expect(renderedRowKeys).toEqual(orderedEntries.map((entry) => entry.rowKey));
      expect(renderedRowCalls.map((row) => row.dragKey)).toEqual(renderedRowKeys);

      const firstRowKey = renderedRowKeys[0];
      const clickedRowKey = renderedRowKeys[1];
      if (!firstRowKey || !clickedRowKey) throw new Error('Expected two folder session rows');
      useSessionMultiSelectStore.getState().setRange(
        firstRowKey,
        clickedRowKey,
        orderedEntries,
        'project',
      );

      expect([...useSessionMultiSelectStore.getState().selectedIds]).toEqual(sessionIds);
      expect(useSessionMultiSelectStore.getState().anchorRowKey).toBe(firstRowKey);
    } finally {
      await act(async () => root.unmount());
      useSessionFoldersStore.setState(originalFolders, true);
      useSessionMultiSelectStore.setState(originalSelection, true);
      renderedRowCalls = [];
      dom.restore();
    }
  });

  test('gives duplicate normal folder occurrences distinct drag keys', async () => {
    const dom = installHookTestDom();
    const root = createRoot(dom.container);
    const originalFolders = useSessionFoldersStore.getState();
    const duplicateSessionId = 'folder-session-duplicate';
    const firstFolder: SessionFolder = { ...folder, id: 'folder-a', sessionIds: [duplicateSessionId] };
    const secondFolder: SessionFolder = { ...folder, id: 'folder-b', sessionIds: [duplicateSessionId] };
    const duplicateGroup: SessionGroupSectionProps['group'] = {
      ...group,
      sessions: [{
        // SAFETY: The mocked row renderer only reads the fixture session id.
        session: { id: duplicateSessionId } as Session,
        children: [],
        worktree: null,
      }],
    };
    const capture: RegistryCapture = { registry: null };
    renderedRowCalls = [];
    useSessionFoldersStore.setState({ foldersMap: { '/workspace': [firstFolder, secondFolder] } });

    try {
      await renderGroup(root, duplicateGroup, capture);

      const dragKeys = renderedRowCalls.map((row) => row.dragKey);
      expect(dragKeys).toHaveLength(2);
      expect(dragKeys[0]).toBeDefined();
      expect(dragKeys[0]).not.toBe(dragKeys[1]);
    } finally {
      await act(async () => root.unmount());
      useSessionFoldersStore.setState(originalFolders, true);
      renderedRowCalls = [];
      dom.restore();
    }
  });

  test('a large searched list keeps every model row registered in order for both buckets', async () => {
    const dom = installHookTestDom();
    const root = createRoot(dom.container);
    const originalFolders = useSessionFoldersStore.getState();
    useSessionFoldersStore.setState({ foldersMap: {} });
    const capture: RegistryCapture = { registry: null };
    const RegistryCaptureProbe = () => {
      capture.registry = useSessionRowOrderRegistry();
      return null;
    };
    const searchedGroup = (isArchivedBucket: boolean): SessionGroup => ({
      ...group,
      isArchivedBucket,
      // SAFETY: SessionGroupSection only reads the fixture session ids in this test.
      sessions: Array.from({ length: 60 }, (_, index) => ({
        session: { id: `session-${String(index).padStart(2, '0')}` } as Session,
        children: [],
        worktree: null,
      })),
    });
    const searchDataByGroup = (target: SessionGroup): WeakMap<SessionGroup, GroupSearchData> => new WeakMap([[
      target,
      {
        filteredNodes: target.sessions,
        matchedSessionCount: target.sessions.length,
        folderNameMatchCount: 0,
        groupMatches: true,
        hasMatch: true,
      },
    ]]);
    const renderSearched = async (target: SessionGroup): Promise<void> => {
      await act(async () => root.render(
        <I18nProvider>
          <SessionRowOrderProvider>
            <RegistryCaptureProbe />
            <SessionGroupSection
              {...createProps()}
              group={target}
              hasSessionSearchQuery
              normalizedSessionSearchQuery="session"
              groupSearchDataByGroup={searchDataByGroup(target)}
            />
          </SessionRowOrderProvider>
        </I18nProvider>,
      ));
    };
    const expectedIds = Array.from({ length: 60 }, (_, index) => `session-${String(index).padStart(2, '0')}`);

    try {
      // Both buckets must keep the full model order available to selection.
      await renderSearched(searchedGroup(false));
      expect(orderedIds(capture.registry)).toEqual(expectedIds);

      await renderSearched(searchedGroup(true));
      expect(orderedIds(capture.registry)).toEqual(expectedIds);
    } finally {
      await act(async () => root.unmount());
      useSessionFoldersStore.setState(originalFolders, true);
      dom.restore();
    }
  });

  test('a non-search active group with many roots stays in normal flow', async () => {
    const dom = installHookTestDom();
    const root = createRoot(dom.container);
    const originalFolders = useSessionFoldersStore.getState();
    useSessionFoldersStore.setState({ foldersMap: {} });
    const capture: RegistryCapture = { registry: null };
    const target = flatRootGroup(60, false);
    renderedRowCalls = [];

    try {
      await renderGroup(root, target, capture, { visibleSessionCount: 60 });

      expect(renderedRowCalls).toHaveLength(60);
      expect(renderedRowCalls.every((call) => call.renderChildren === undefined)).toBe(true);
      expect(orderedIds(capture.registry)).toHaveLength(60);
    } finally {
      await act(async () => root.unmount());
      useSessionFoldersStore.setState(originalFolders, true);
      renderedRowCalls = [];
      dom.restore();
    }
  });

  test('a non-search archived bucket does not mount rows before the scroll element resolves', async () => {
    const dom = installHookTestDom();
    const root = createRoot(dom.container);
    const originalFolders = useSessionFoldersStore.getState();
    useSessionFoldersStore.setState({ foldersMap: {} });
    const capture: RegistryCapture = { registry: null };
    const target = flatRootGroup(60, true);
    renderedRowCalls = [];

    try {
      await renderGroup(root, target, capture, { visibleSessionCount: 60 });

      // The hook-test DOM intentionally has no real scrolling ancestor. The
      // virtual fallback must reserve space without eagerly mounting the full
      // archived model.
      expect(renderedRowCalls).toHaveLength(0);
      expect(orderedIds(capture.registry)).toHaveLength(60);
    } finally {
      await act(async () => root.unmount());
      useSessionFoldersStore.setState(originalFolders, true);
      renderedRowCalls = [];
      dom.restore();
    }
  });

  test('a non-search archived bucket virtualizes the complete render-row model', async () => {
    const dom = installRealTestDom();
    const scrollContainer = dom.container;
    Object.defineProperty(scrollContainer, 'clientHeight', { configurable: true, value: 640 });
    Object.defineProperty(scrollContainer, 'scrollTop', { configurable: true, writable: true, value: 0 });
    Object.defineProperty(scrollContainer, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ top: 0, left: 0, right: 320, bottom: 640, width: 320, height: 640 }),
    });
    const root = createRoot(scrollContainer);
    const originalFolders = useSessionFoldersStore.getState();
    const capture: RegistryCapture = { registry: null };
    const target = flatRootGroup(60, true);
    const archivedFolder: SessionFolder = {
      ...folder,
      sessionIds: target.sessions.map((node) => node.session.id),
    };
    useSessionFoldersStore.setState({ foldersMap: { '/workspace': [archivedFolder] } });
    renderedFolderBodies = [];
    renderedRowCalls = [];

    try {
      await renderGroup(root, target, capture, {
        visibleSessionCount: 60,
        scrollContainerRef: { current: scrollContainer },
      });

      expect(renderedRowCalls.length).toBeGreaterThan(0);
      expect(renderedRowCalls.length).toBeLessThan(60);
      expect(renderedRowCalls.every((call) => call.renderChildren === false)).toBe(true);
      expect(renderedFolderBodies).toContain(false);
      expect(renderedFolderBodies).not.toContain(true);
      expect(orderedIds(capture.registry)).toHaveLength(60);
    } finally {
      await act(async () => root.unmount());
      useSessionFoldersStore.setState(originalFolders, true);
      renderedFolderBodies = [];
      renderedRowCalls = [];
      await dom.restore();
    }
  });
});
