import { describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '@/lib/i18n';
import { useSessionFoldersStore } from '@/stores/useSessionFoldersStore';
import { useUIStore } from '@/stores/useUIStore';
import type { SessionFolder } from '@/stores/useSessionFoldersStore';
import type { Session } from '@opencode-ai/sdk/v2';
import type { GroupSearchData, SessionGroup } from '../types';
import type { SessionGroupSectionProps } from './SessionGroupSection';
import type { SessionTreeItemProps } from '../sessions/SessionTreeItem';
import { SESSION_GROUP_VIRTUALIZE_THRESHOLD } from '../sessions/sessionNodeItemUtils';
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

type RegistryCapture = {
  registry: SessionRowOrderRegistry | null;
};

type RowPropsCapture = Pick<SessionGroupSectionProps,
  | 'allowReselect'
  | 'onSessionSelected'
  | 'resetSessionSearch'
  | 'deleteSessionConfirm'
  | 'copiedSessionId'
  | 'setCopiedSessionId'
>;

let folderCallbacks: FolderCallbacks | null = null;
let rowPropsCapture: RowPropsCapture | null = null;
let renderedRowCalls: SessionTreeItemProps[] = [];

mock.module('../../SessionFolderItem', () => ({
  SessionFolderItem: (props: FolderCallbacks) => {
    folderCallbacks = props;
    return null;
  },
}));

mock.module('../folders/sessionFolderDnd', () => ({
  DroppableFolderWrapper: ({ children }: { children: (ref: () => void, isOver: boolean) => React.ReactNode }) => <>{children(() => undefined, false)}</>,
  SessionFolderDndScope: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

mock.module('@/sync/sync-context', () => ({
  setActiveSession: () => undefined,
  useChildStoreManager: () => ({
    subscribeBootstrap: () => () => undefined,
    getBootstrapState: () => null,
    getBootstrapFailure: () => undefined,
    requestBootstrap: () => undefined,
  }),
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

const { SessionGroupSection } = await import('./SessionGroupSection');

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

const nestedGroup = (childCount: number, idPrefix: string): SessionGroup => ({
  ...group,
  // SAFETY: SessionGroupSection only reads the fixture session ids and structure in this test.
  sessions: [{
    session: { id: `${idPrefix}-root` } as Session,
    children: Array.from({ length: childCount }, (_, index) => ({
      session: { id: `${idPrefix}-child-${String(index).padStart(2, '0')}` } as Session,
      children: [],
      worktree: null,
    })),
    worktree: null,
  }],
});

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
      // Both groups cross the virtualize threshold while searching; the
      // registry must still carry the full model order for offscreen rows.
      await renderSearched(searchedGroup(false));
      expect(capture.registry?.getOrderedIds()).toEqual(expectedIds);

      await renderSearched(searchedGroup(true));
      expect(capture.registry?.getOrderedIds()).toEqual(expectedIds);
    } finally {
      await act(async () => root.unmount());
      useSessionFoldersStore.setState(originalFolders, true);
      dom.restore();
    }
  });

  test('a large searched nested group flattens to one bounded row batch per session', async () => {
    const dom = installHookTestDom();
    const root = createRoot(dom.container);
    const originalFolders = useSessionFoldersStore.getState();
    useSessionFoldersStore.setState({ foldersMap: {} });
    const capture: RegistryCapture = { registry: null };
    const target = nestedGroup(60, 'nested');
    renderedRowCalls = [];

    try {
      await renderGroup(root, target, capture, { hasSessionSearchQuery: true, normalizedSessionSearchQuery: 'session' });

      // No scroll element resolves under the test DOM, so the pre-ready
      // fallback renders the first threshold batch of flat rows; the layout
      // effect flips to the virtual window before paint in a browser.
      expect(renderedRowCalls).toHaveLength(SESSION_GROUP_VIRTUALIZE_THRESHOLD);
      expect(renderedRowCalls.every((call) => call.renderChildren === false)).toBe(true);
      expect(renderedRowCalls.map((call) => call.depth)).toEqual([
        0,
        ...Array.from({ length: SESSION_GROUP_VIRTUALIZE_THRESHOLD - 1 }, () => 1),
      ]);
      expect(renderedRowCalls[0]?.node.session.id).toBe('nested-root');
      expect(capture.registry?.getOrderedIds()).toEqual([
        'nested-root',
        ...Array.from({ length: 60 }, (_, index) => `nested-child-${String(index).padStart(2, '0')}`),
      ]);
    } finally {
      await act(async () => root.unmount());
      useSessionFoldersStore.setState(originalFolders, true);
      renderedRowCalls = [];
      dom.restore();
    }
  });

  test('a searched group below the threshold keeps tree mode', async () => {
    const dom = installHookTestDom();
    const root = createRoot(dom.container);
    const originalFolders = useSessionFoldersStore.getState();
    useSessionFoldersStore.setState({ foldersMap: {} });
    const capture: RegistryCapture = { registry: null };
    const target = nestedGroup(10, 'small');
    renderedRowCalls = [];

    try {
      await renderGroup(root, target, capture, { hasSessionSearchQuery: true, normalizedSessionSearchQuery: 'session' });

      // Tree mode renders only the root row; its children stay nested inside.
      expect(renderedRowCalls).toHaveLength(1);
      expect(renderedRowCalls[0]?.node.session.id).toBe('small-root');
      expect(renderedRowCalls[0]?.renderChildren).toBeUndefined();
      expect(capture.registry?.getOrderedIds()).toHaveLength(11);
    } finally {
      await act(async () => root.unmount());
      useSessionFoldersStore.setState(originalFolders, true);
      renderedRowCalls = [];
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
      expect(capture.registry?.getOrderedIds()).toHaveLength(60);
    } finally {
      await act(async () => root.unmount());
      useSessionFoldersStore.setState(originalFolders, true);
      renderedRowCalls = [];
      dom.restore();
    }
  });

  test('a non-search archived bucket virtualizes whole roots, never flat rows', async () => {
    const dom = installHookTestDom();
    const root = createRoot(dom.container);
    const originalFolders = useSessionFoldersStore.getState();
    useSessionFoldersStore.setState({ foldersMap: {} });
    const capture: RegistryCapture = { registry: null };
    const target = flatRootGroup(60, true);
    renderedRowCalls = [];

    try {
      await renderGroup(root, target, capture, { visibleSessionCount: 60 });

      // Roots mode keeps whole subtrees as one item; flat rows would set
      // renderChildren=false.
      expect(renderedRowCalls).toHaveLength(60);
      expect(renderedRowCalls.every((call) => call.renderChildren === undefined)).toBe(true);
      expect(capture.registry?.getOrderedIds()).toHaveLength(60);
    } finally {
      await act(async () => root.unmount());
      useSessionFoldersStore.setState(originalFolders, true);
      renderedRowCalls = [];
      dom.restore();
    }
  });
});
