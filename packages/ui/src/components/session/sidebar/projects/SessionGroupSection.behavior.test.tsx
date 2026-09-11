import { describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '@/lib/i18n';
import { useSessionFoldersStore } from '@/stores/useSessionFoldersStore';
import { useUIStore } from '@/stores/useUIStore';
import { getPinnedSessionKey } from '@/stores/useSessionPinnedStore';
import { getRuntimeKey } from '@/lib/runtime-switch';
import type { SessionFolder } from '@/stores/useSessionFoldersStore';
import type { Session } from '@opencode-ai/sdk/v2';
import type { SessionGroupSectionProps } from './SessionGroupSection';
import type { SessionNode } from '../types';
import { installHookTestDom } from '../test-utils/testDom';

type FolderCallbacks = {
  onRename: (name: string) => void;
  onDelete: () => void;
};

type RowPropsCapture = Pick<SessionGroupSectionProps,
  | 'allowReselect'
  | 'onSessionSelected'
  | 'isSessionSearchOpen'
  | 'sessionSearchQuery'
  | 'deleteSessionConfirm'
  | 'copiedSessionId'
  | 'setCopiedSessionId'
> & { node?: SessionNode };

let folderCallbacks: FolderCallbacks | null = null;
let rowPropsCapture: RowPropsCapture | null = null;
let renderedNodes: SessionNode[] = [];

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
  SessionTreeItem: (props: RowPropsCapture) => {
    rowPropsCapture = props;
    if (props.node) renderedNodes.push(props.node);
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

const rootSession = (id: string, updated: number): Session => ({
  id,
  slug: id,
  projectID: 'project',
  title: id,
  version: '1',
  directory: '/workspace',
  time: { created: updated, updated },
});

const childSession = (id: string, parentID: string, updated: number): Session => ({
  id,
  slug: id,
  projectID: 'project',
  title: id,
  version: '1',
  directory: '/workspace',
  parentID,
  time: { created: updated, updated },
});

const node = (session: Session, children: SessionNode[] = []): SessionNode => ({
  session,
  children,
  worktree: null,
});

const createProps = (): SessionGroupSectionProps => ({
  group,
  groupKey: 'project:main',
  projectId: 'project',
  hideGroupLabel: true,
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
  sessionOrderRanks: new Map(),
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
  isSessionSearchOpen: false,
  sessionSearchQuery: '',
  setSessionSearchQuery: () => undefined,
  setIsSessionSearchOpen: () => undefined,
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

  test('propagates confirmation, search/navigation, and copy ownership changes to rendered rows', async () => {
    const dom = installHookTestDom();
    const root = createRoot(dom.container);
    const firstSelected = () => undefined;
    const nextSelected = () => undefined;
    const firstCopied = () => undefined;
    const nextCopied = () => undefined;
    const initialProps = createProps();

    try {
      await act(async () => root.render(<I18nProvider><SessionGroupSection {...initialProps} group={groupWithSession} onSessionSelected={firstSelected} setCopiedSessionId={firstCopied} /></I18nProvider>));
      expect(rowPropsCapture?.onSessionSelected).toBe(firstSelected);
      expect(rowPropsCapture?.sessionSearchQuery).toBe('');
      expect(rowPropsCapture?.deleteSessionConfirm).toBeNull();
      expect(rowPropsCapture?.copiedSessionId).toBeNull();
      expect(rowPropsCapture?.setCopiedSessionId).toBe(firstCopied);

      // SAFETY: the confirmation is only forwarded by identity to the row mock.
      const confirmation = { session: { id: 'session-a' } as Session, descendantCount: 0, descendantIds: [], archivedBucket: false };
      await act(async () => root.render(<I18nProvider><SessionGroupSection {...initialProps} group={groupWithSession} allowReselect onSessionSelected={nextSelected} isSessionSearchOpen sessionSearchQuery="search" deleteSessionConfirm={confirmation} copiedSessionId="session-a" setCopiedSessionId={nextCopied} /></I18nProvider>));
      expect(rowPropsCapture?.allowReselect).toBe(true);
      expect(rowPropsCapture?.onSessionSelected).toBe(nextSelected);
      expect(rowPropsCapture?.isSessionSearchOpen).toBe(true);
      expect(rowPropsCapture?.sessionSearchQuery).toBe('search');
      expect(rowPropsCapture?.deleteSessionConfirm).toBe(confirmation);
      expect(rowPropsCapture?.copiedSessionId).toBe('session-a');
      expect(rowPropsCapture?.setCopiedSessionId).toBe(nextCopied);
    } finally {
      await act(async () => root.unmount());
      rowPropsCapture = null;
      dom.restore();
    }
  });

  test('orders nested children by live lifecycle rank instead of ownership order', async () => {
    const dom = installHookTestDom();
    const root = createRoot(dom.container);
    const ranks = new Map([
      ['child-b', 2],
      ['child-a', 1],
      ['grandchild-new', 4],
      ['grandchild-old', 0.5],
    ]);
    const nestedGroup: SessionGroupSectionProps['group'] = {
      ...group,
      sessions: [
        node(rootSession('session-parent', 1), [
          node(childSession('child-a', 'session-parent', 100), [
            node(childSession('grandchild-old', 'child-a', 50)),
            node(childSession('grandchild-new', 'child-a', 60)),
          ]),
          node(childSession('child-b', 'session-parent', 200)),
        ]),
      ],
    };

    try {
      renderedNodes = [];
      await act(async () => root.render(
        <I18nProvider>
          <SessionGroupSection {...createProps()} group={nestedGroup} sessionOrderRanks={ranks} />
        </I18nProvider>,
      ));

      const parentNode = renderedNodes.find((entry) => entry.session.id === 'session-parent');
      expect(parentNode?.children.map((child) => child.session.id)).toEqual(['child-b', 'child-a']);
      expect(parentNode?.children[1]?.children.map((child) => child.session.id))
        .toEqual(['grandchild-new', 'grandchild-old']);
    } finally {
      await act(async () => root.unmount());
      renderedNodes = [];
      dom.restore();
    }
  });

  test('orders nested children by live ranks when timestamps contradict them', async () => {
    const dom = installHookTestDom();
    const root = createRoot(dom.container);
    // Both children are absent from `sessionOrderIndex`, so the fallback
    // comparator runs. Ranks disagree with `time.updated`, so an empty
    // ranks fallback would emit timestamp order (newer timestamp first)
    // instead of the rank order asserted below.
    const rankGroup: SessionGroupSectionProps['group'] = {
      ...group,
      sessions: [
        node(rootSession('session-parent', 1), [
          node(childSession('child-newer-timestamp', 'session-parent', 300)),
          node(childSession('child-newer-rank', 'session-parent', 100)),
        ]),
      ],
    };

    try {
      renderedNodes = [];
      await act(async () => root.render(
        <I18nProvider>
          <SessionGroupSection
            {...createProps()}
            group={rankGroup}
            sessionOrderRanks={new Map([
              ['child-newer-timestamp', 1],
              ['child-newer-rank', 2],
            ])}
          />
        </I18nProvider>,
      ));

      const parentNode = renderedNodes.find((entry) => entry.session.id === 'session-parent');
      expect(parentNode?.children.map((child) => child.session.id))
        .toEqual(['child-newer-rank', 'child-newer-timestamp']);
    } finally {
      await act(async () => root.unmount());
      renderedNodes = [];
      dom.restore();
    }
  });

  test('keeps pinned nested children ahead of a newer unpinned sibling', async () => {
    const dom = installHookTestDom();
    const root = createRoot(dom.container);
    const pinnedKey = getPinnedSessionKey(getRuntimeKey(), '/workspace', 'child-pinned');
    const pinnedGroup: SessionGroupSectionProps['group'] = {
      ...group,
      sessions: [
        node(rootSession('session-parent', 1), [
          node(childSession('child-new', 'session-parent', 300)),
          node(childSession('child-pinned', 'session-parent', 10)),
        ]),
      ],
    };

    try {
      renderedNodes = [];
      await act(async () => root.render(
        <I18nProvider>
          <SessionGroupSection
            {...createProps()}
            group={pinnedGroup}
            pinnedSessionIds={new Set(pinnedKey ? [pinnedKey] : [])}
            sessionOrderRanks={new Map([['child-new', 2], ['child-pinned', 1]])}
          />
        </I18nProvider>,
      ));

      const parentNode = renderedNodes.find((entry) => entry.session.id === 'session-parent');
      expect(parentNode?.children.map((child) => child.session.id)).toEqual(['child-pinned', 'child-new']);
    } finally {
      await act(async () => root.unmount());
      renderedNodes = [];
      dom.restore();
    }
  });
});
