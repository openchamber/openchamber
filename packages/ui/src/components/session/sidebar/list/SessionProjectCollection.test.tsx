import { describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '@/lib/i18n';
import type { SessionGroup } from '../types';
import { installHookTestDom } from '../test-utils/testDom';
import { buildSessionBootstrapDemands } from './sessionBootstrapDemands';

type CapturedChatsProps = {
  group?: SessionGroup;
  sessionBatchSize?: number;
};

let chatsSectionProps: CapturedChatsProps | null = null;

const EMPTY_LIVE_SESSIONS: never[] = [];
const childStoreManagerStub = {
  setBootstrapDemand: () => undefined,
  clearBootstrapDemand: () => undefined,
  subscribeBootstrap: () => () => undefined,
  getBootstrapState: () => null,
  getBootstrapFailure: () => undefined,
  requestBootstrap: () => undefined,
};

mock.module('@/sync/sync-context', () => ({
  setActiveSession: () => undefined,
  useAllLiveSessions: () => EMPTY_LIVE_SESSIONS,
  useChildStoreManager: () => childStoreManagerStub,
  useDirectoryStore: () => null,
  useGlobalSessionStatus: () => null,
  useSessionPermissions: () => null,
  useSessionQuestionCount: () => 0,
  useSyncSDK: () => null,
  useSyncDirectory: () => null,
  buildSessionMessageRecordsSnapshot: () => [],
}));

mock.module('@/sync/use-sync', () => ({
  usePrefetchSessionMessages: () => async () => undefined,
}));

mock.module('@/hooks/useRuntimeAPIs', () => ({
  useRuntimeAPIs: () => ({ github: null }),
}));

mock.module('@/hooks/useProviderLogo', () => ({
  preloadProviderLogos: () => undefined,
  useProviderLogo: () => ({ src: null, onError: () => undefined, hasLogo: false }),
}));

mock.module('@/components/icon/Icon', () => ({ Icon: () => null }));

mock.module('@/lib/platform', () => ({
  isCapacitorApp: () => false,
  isWindowsArm64: () => false,
  isIPadApp: () => false,
  getClientPlatform: () => 'web',
}));

mock.module('./SidebarTerminalActivity', () => ({ SidebarTerminalActivity: () => null }));
mock.module('./useSessionPrefetch', () => ({ SessionPrefetchEffect: () => null }));
mock.module('../folders/SessionBulkActions', () => ({ SessionBulkActions: () => null }));
mock.module('../projects/useProjectSessionSelection', () => ({
  ProjectSessionSelectionEffect: () => null,
}));
mock.module('../sessions/SessionTreeItem', () => ({ SessionTreeItem: () => null }));
mock.module('../projects/SessionProjectScroller', () => ({
  SessionProjectScroller: ({ model }: { model: { topContent?: React.ReactNode } }) => <>{model.topContent}</>,
}));
// The real group section is mocked so this test can read the props the chats
// render callback builds without mounting the whole project tree.
mock.module('../projects/SessionGroupSection', () => ({
  SessionGroupSection: (props: CapturedChatsProps) => {
    if (props.group?.id === 'managed-chats') chatsSectionProps = props;
    return null;
  },
}));

const { MAX_VISIBLE_RECENT_SESSIONS } = await import('../recent/SidebarActivitySections');
const { SessionProjectCollection } = await import('./SessionProjectCollection');

type CollectionProps = React.ComponentProps<typeof SessionProjectCollection>;

const topologyFixture: CollectionProps['topology'] = {
  projects: [],
  availableWorktreesByProject: new Map(),
  knownDirectories: new Set(),
  isVSCode: false,
  worktreeMetadata: new Map(),
  gitBranches: new Map(),
  projectRepoStatus: new Map(),
  projectRootBranches: new Map(),
  lastRepoStatus: false,
};

const viewFixture: CollectionProps['view'] = {
  isVisible: true,
  hasSessionSearchQuery: false,
  normalizedSessionSearchQuery: '',
  activeProjectId: null,
  showInlineArchived: false,
  useGroupedSections: false,
  homeDirectory: '/home/user',
  mobileVariant: false,
  hideDirectoryControls: false,
  showOnlyMainWorkspace: false,
  isDesktopShellRuntime: false,
  stickyZoneHeaders: false,
  projectSortOrder: 'manual',
  emptyState: null,
  searchEmptyState: null,
  isSessionsLoading: false,
  isWorktreeTopologyLoading: false,
  unresolvedWorktreeProjectPaths: new Set(),
  projectView: {
    collapsedProjects: new Set(),
    collapsedGroups: new Set(),
    groupOrderByProject: new Map(),
  },
  onSearchMatchCountChange: () => undefined,
};

const actionsFixture: CollectionProps['actions'] = {
  rowActions: {
    allowReselect: false,
    isSessionSearchOpen: false,
    sessionSearchQuery: '',
    setSessionSearchQuery: () => undefined,
    setIsSessionSearchOpen: () => undefined,
  },
  alwaysShowActions: false,
  notifyOnSubtasks: false,
  setActiveProjectIdOnly: () => undefined,
  setSessionSwitcherOpen: () => undefined,
  openNewSessionDraft: () => undefined,
  openNewWorktreeDialog: () => undefined,
  openWorktreesPage: () => undefined,
  openProjectEditDialog: () => undefined,
  removeProject: () => undefined,
  reorderProjects: () => undefined,
  startSessionWorktreeMenuLoad: () => ({
    cachedTargets: [],
    refreshTargets: Promise.resolve([]),
  }),
  initialActiveSessionByProject: new Map(),
  persistActiveSessionByProject: () => undefined,
  projectViewActions: {
    getOrderedGroups: (_projectId: string, groups: SessionGroup[]) => groups,
    setGroupOrderByProject: () => undefined,
    toggleGroup: () => undefined,
    toggleProject: () => undefined,
  },
};

describe('SessionProjectCollection', () => {
  test('preserves authoritative background demand when its visible rows are absent', () => {
    const demands = buildSessionBootstrapDemands({
      knownDirectories: ['/project', '/project/worktree'],
      activeProjectDirectory: '/project',
      activeProjectId: 'project',
      collapsedProjects: new Set(),
      collapsedGroups: new Set(),
      currentDirectory: null,
      currentSessionDirectory: null,
    });

    expect(demands.map((demand) => demand.directory)).toEqual(['/project', '/project/worktree']);
    expect(demands[0]?.priority).toBe('active-project');
    expect(demands[1]?.priority).toBe('background');
  });

  // Issue #3444: the managed chats section rendered every chat (20 at a time)
  // instead of the Recent list's 7-row default.
  test('caps the managed chats section at the recent default through the batch control', async () => {
    const dom = installHookTestDom();
    const root = createRoot(dom.container);

    try {
      await act(async () => root.render(
        <I18nProvider>
          <SessionProjectCollection topology={topologyFixture} view={viewFixture} actions={actionsFixture} />
        </I18nProvider>,
      ));

      expect(chatsSectionProps?.group?.id).toBe('managed-chats');
      expect(chatsSectionProps?.sessionBatchSize).toBe(MAX_VISIBLE_RECENT_SESSIONS);
    } finally {
      await act(async () => root.unmount());
      chatsSectionProps = null;
      dom.restore();
    }
  });
});
