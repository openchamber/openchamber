import { describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Session } from '@opencode-ai/sdk/v2';
import type { ProjectEntry } from '@/lib/api/types';
import type { WorktreeMetadata } from '@/types/worktree';
import { I18nProvider } from '@/lib/i18n';
import { useSessionUIStore } from '@/sync/session-ui-store';
import type { SessionNode } from '../types';
import type { SessionNodeItemProps } from './SessionNodeItem';
import { installHookTestDom } from '../test-utils/testDom';

// SessionNodeItem's menu graph includes ProviderLogo, whose Vite-only asset
// discovery is unavailable under Bun. The comparator is module-local behavior;
// keep this focused test from importing that unrelated render-only dependency.
mock.module('@/components/multirun/MultiRunFusionDialog', () => ({
  MultiRunFusionDialog: () => null,
}));

const passthrough = ({ children }: { children?: React.ReactNode }): React.ReactNode => children ?? null;

let dropdownSubmenuCallbacks: Array<(open: boolean) => void> = [];

mock.module('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: passthrough,
  DropdownMenuContent: passthrough,
  DropdownMenuItem: passthrough,
  DropdownMenuSeparator: () => null,
  DropdownMenuSub: ({ children, onOpenChange }: { children?: React.ReactNode; onOpenChange?: (open: boolean) => void }) => {
    if (onOpenChange) dropdownSubmenuCallbacks.push(onOpenChange);
    return children ?? null;
  },
  DropdownMenuSubContent: passthrough,
  DropdownMenuSubTrigger: passthrough,
  DropdownMenuTrigger: passthrough,
}));

mock.module('@/components/ui/tooltip', () => ({
  Tooltip: passthrough,
  TooltipContent: passthrough,
  TooltipTrigger: passthrough,
}));

mock.module('@/components/ui', () => ({
  toast: { error: () => undefined, success: () => undefined, warning: () => undefined },
}));

mock.module('@/components/ui/button', () => ({ Button: passthrough }));
mock.module('@/components/ui/dialog', () => ({
  Dialog: () => null,
  DialogContent: passthrough,
  DialogDescription: passthrough,
  DialogFooter: passthrough,
  DialogHeader: passthrough,
  DialogTitle: passthrough,
}));
mock.module('@/components/icon/Icon', () => ({ Icon: () => null }));
mock.module('@/components/icons/FusionIcon', () => ({ FusionIcon: () => null }));
mock.module('../folders/sessionFolderDnd', () => ({ DraggableSessionRow: passthrough }));
mock.module('../sessions/DirectoryActionIndicator', () => ({ DirectoryActionIndicator: () => null }));
mock.module('@/components/session/SessionAiRenameMenuItem', () => ({ SessionAiRenameMenuItem: () => null }));
// Guest actions are outside this comparator and store-subscription test. Keep
// the lightweight DOM fixture independent from browser-only runtime detection.
mock.module('@/hooks/useGuestSurfaces', () => ({ useGuestActions: () => [] }));

type MockProjectsState = { projects: ProjectEntry[] };
const mockProjectsState: MockProjectsState = { projects: [] };
const useMockProjectsStore = <T,>(selector: (state: typeof mockProjectsState) => T): T => selector(mockProjectsState);
useMockProjectsStore.getState = () => mockProjectsState;

mock.module('@/stores/useProjectsStore', () => ({
  useProjectsStore: useMockProjectsStore,
}));
mock.module('@/stores/useSessionFoldersStore', () => ({
  useSessionFoldersStore: <T,>(selector: (state: {
    getFoldersForScope: () => never[];
    getSessionFolderId: () => null;
    removeSessionFromFolder: () => void;
    addSessionToFolder: () => void;
  }) => T): T => selector({
    getFoldersForScope: () => [],
    getSessionFolderId: () => null,
    removeSessionFromFolder: () => undefined,
    addSessionToFolder: () => undefined,
  }),
}));
mock.module('@/stores/useSessionPinnedStore', () => ({
  isSessionPinned: () => false,
  useSessionPinnedStore: <T,>(selector: (state: { toggle: () => void }) => T): T => selector({ toggle: () => undefined }),
}));
mock.module('@/stores/useUIStore', () => ({
  useUIStore: <T,>(selector: (state: { openContextPanelTab: () => void }) => T): T => selector({ openContextPanelTab: () => undefined }),
}));
mock.module('@/stores/useSessionDisplayStore', () => ({
  useSessionDisplayStore: <T,>(selector: (state: { sessionGroupingMode: 'by-worktree' }) => T): T => selector({ sessionGroupingMode: 'by-worktree' }),
}));
mock.module('@/stores/useSessionMultiSelectStore', () => ({
  useSessionMultiSelectStore: <T,>(selector: (state: {
    enabled: false;
    selectedIds: Set<string>;
    toggleSelected: () => void;
    setRange: () => void;
  }) => T): T => selector({
    enabled: false,
    selectedIds: new Set(),
    toggleSelected: () => undefined,
    setRange: () => undefined,
  }),
}));
mock.module('@/sync/viewport-store', () => ({
  useViewportStore: <T,>(selector: (state: { sessionMemoryState: Map<string, never> }) => T): T => selector({ sessionMemoryState: new Map<string, never>() }),
  viewportSessionKey: (sessionId: string) => sessionId,
}));
mock.module('@/stores/useGitHubPrStatusStore', () => ({
  getGitHubPrStatusKey: () => null,
  usePrVisualSummary: () => null,
}));
mock.module('@/sync/sync-context', () => ({
  useGlobalSessionStatus: () => undefined,
  useSessionPermissions: () => [],
  useSessionQuestionCount: () => 0,
}));
mock.module('@/sync/use-sync', () => ({
  usePrefetchSessionMessages: () => () => Promise.resolve(),
  useSessionMessageRecordsForExport: () => () => Promise.resolve([]),
}));
mock.module('@/sync/sync-refs', () => ({
  getSyncSessionMaterializationStatus: () => ({ renderable: true }),
}));
mock.module('@/sync/session-activity-timing', () => ({ useHasSessionActivityDuration: () => false }));
mock.module('@/sync/use-session-ai-rename', () => ({ useIsSessionAiRenamePending: () => false }));
mock.module('@/sync/notification-store', () => ({ useSessionUnseenCount: () => 0 }));
mock.module('@/lib/desktop', () => ({
  canUseElectronDesktopIPC: () => false,
  invokeDesktop: () => Promise.resolve(),
  isVSCodeRuntime: () => false,
}));
mock.module('@/lib/worktrees/sessionWorktreeMove', () => ({
  buildSessionTreeMoveMessages: () => ({ success: '', failure: '' }),
  requestSessionTreeMove: () => undefined,
  useIsSessionWorktreeMovePending: () => false,
}));

mock.module('@base-ui/react/context-menu', () => ({
  ContextMenu: {
    Root: passthrough,
    Trigger: ({ render, children }: { render?: React.ReactNode; children?: React.ReactNode }) => React.createElement(React.Fragment, null, render, children),
    Portal: passthrough,
    Positioner: passthrough,
    Popup: passthrough,
    Item: passthrough,
    Separator: () => null,
    SubmenuRoot: passthrough,
    SubmenuTrigger: passthrough,
  },
}));

const { SessionNodeItem } = await import('./SessionNodeItem');

type SessionNodeItemWithComparator = typeof SessionNodeItem & {
  compare: (previous: SessionNodeItemProps, next: SessionNodeItemProps) => boolean;
};

const hasMemoComparator = (component: typeof SessionNodeItem): component is SessionNodeItemWithComparator => (
  Object.prototype.hasOwnProperty.call(component, 'compare')
);

if (!hasMemoComparator(SessionNodeItem)) {
  throw new Error('SessionNodeItem memo comparator is unavailable');
}

// SAFETY: React.memo stores its custom comparator on the memoized component;
// this narrow test hook reads that runtime metadata without mounting the row.
const compareSessionNodeItemProps = SessionNodeItem.compare;

const noop = () => undefined;

// SAFETY: the comparator only reads these session fields from the fixture.
const session = { id: 'session', title: 'Session', directory: '/workspace' } as Session;
const node: SessionNode = { session, children: [], worktree: null };

const baseProps = (): SessionNodeItemProps => ({
  node,
  groupDirectory: '/workspace',
  projectId: 'project',
  folderOwnerKey: 'project',
  selectionScopeKey: 'project',
  pinnedSessionIds: new Set(),
  expandedParents: new Set(),
  hasSessionSearchQuery: false,
  normalizedSessionSearchQuery: '',
  notifyOnSubtasks: false,
  editingId: null,
  setEditingId: noop,
  editTitle: '',
  setEditTitle: noop,
  handleSaveEdit: noop,
  handleCancelEdit: noop,
  toggleParent: noop,
  handleSessionSelect: noop,
  handleSessionDoubleClick: noop,
  handleShareSession: noop,
  copiedSessionId: null,
  handleCopyShareUrl: noop,
  handleCopySessionId: noop,
  handleUnshareSession: noop,
  openSidebarMenuKey: null,
  setOpenSidebarMenuKey: noop,
  createFolderAndStartRename: () => null,
  handleDeleteSession: noop,
  handleRestoreSession: noop,
  startSessionWorktreeMenuLoad: () => ({
    cachedTargets: [],
    refreshTargets: Promise.resolve([]),
  }),
  mobileVariant: false,
  alwaysShowActions: false,
  subtreeContainsEditing: new Set(),
  menuOpenSessionId: null,
  nodeStructureKey: 'session',
});

const worktree = (overrides: Partial<WorktreeMetadata> = {}): WorktreeMetadata => ({
  path: '/workspace/worktree',
  projectDirectory: '/workspace',
  branch: 'feature',
  label: 'Feature',
  name: 'feature',
  worktreeRoot: '/workspace/worktree',
  worktreeStatus: 'ready',
  worktreeSource: 'existing',
  headState: 'branch',
  ...overrides,
});

const sessionWithMetadata = (metadata: NonNullable<Session['metadata']>): Session => ({
  ...session,
  metadata,
});

const goalMetadata = (status: 'active' | 'paused' | 'blocked' | 'budgetLimited' | 'complete') => ({
  openchamber: {
    goal: {
      id: 'goal',
      objective: 'Keep the work moving',
      status,
    },
  },
});

describe('sessionNodeItemPropsChange identity behavior', () => {
  const identityChanges = [
    ['folderOwnerKey', 'folder-owner-a', 'folder-owner-b'],
    ['selectionScopeKey', 'selection-scope-a', 'selection-scope-b'],
  ] as const;

  for (const [key, previousValue, nextValue] of identityChanges) {
    test(`invalidates the memo boundary when ${key} changes`, () => {
      const previous = { ...baseProps(), [key]: previousValue };
      const next = { ...previous, [key]: nextValue };

      expect(compareSessionNodeItemProps(previous, next)).toBe(false);
    });
  }

  test('keeps the bailout when owner and scope values are equivalent', () => {
    const previous = baseProps();
    const equivalent = { ...previous, folderOwnerKey: 'project', selectionScopeKey: 'project' };

    expect(compareSessionNodeItemProps(previous, equivalent)).toBe(true);
  });

  test('invalidates the memo boundary when consumed worktree semantics change', () => {
    const semanticChanges = [
      ['path', { path: '/workspace/other-worktree' }],
      ['projectDirectory', { projectDirectory: '/other-workspace' }],
      ['branch', { branch: 'other-feature' }],
      ['label', { label: 'Other feature' }],
      ['name', { name: 'other-feature' }],
      ['worktreeRoot', { worktreeRoot: '/workspace/other-worktree-root' }],
      ['worktreeStatus', { worktreeStatus: 'pending' }],
      ['worktreeSource', { worktreeSource: 'created-for-session' }],
      ['headState', { headState: 'detached' }],
    ] as const;

    for (const [, change] of semanticChanges) {
      const previous = {
        ...baseProps(),
        node: { ...node, worktree: worktree() },
      };
      const next = {
        ...previous,
        node: { ...previous.node, worktree: worktree(change) },
      };

      expect(compareSessionNodeItemProps(previous, next)).toBe(false);
    }
  });

  test('keeps the bailout for equivalent normalized worktree semantics', () => {
    const previous = {
      ...baseProps(),
      node: {
        ...node,
        worktree: worktree({
          path: '/workspace/worktree/',
          projectDirectory: '/workspace/',
          worktreeRoot: '/workspace/worktree/',
        }),
      },
    };
    const equivalent = {
      ...previous,
      node: {
        ...previous.node,
        worktree: worktree(),
      },
    };

    expect(compareSessionNodeItemProps(previous, equivalent)).toBe(true);
  });

  test('invalidates goal presence and status changes but ignores unrelated metadata', () => {
    const activeGoal = goalMetadata('active');
    const previous = {
      ...baseProps(),
      node: { ...node, session: sessionWithMetadata({ ...activeGoal, unrelated: 'before' }) },
    };
    const changedStatus = {
      ...previous,
      node: {
        ...previous.node,
        session: sessionWithMetadata({ ...activeGoal, openchamber: { goal: { ...activeGoal.openchamber.goal, status: 'paused' } }, unrelated: 'after' }),
      },
    };
    const absentGoal = {
      ...previous,
      node: { ...previous.node, session: sessionWithMetadata({ unrelated: 'after' }) },
    };
    const unrelatedMetadata = {
      ...previous,
      node: { ...previous.node, session: sessionWithMetadata({ ...activeGoal, unrelated: 'after' }) },
    };

    expect(compareSessionNodeItemProps(previous, changedStatus)).toBe(false);
    expect(compareSessionNodeItemProps(previous, absentGoal)).toBe(false);
    expect(compareSessionNodeItemProps(previous, unrelatedMetadata)).toBe(true);
  });

  test('observes one session worktree attachment and refreshes its menu closure', async () => {
    const dom = installHookTestDom();
    const root = createRoot(dom.container);
    const originalSessionUI = useSessionUIStore.getState();
    const pendingMetadata = worktree({ worktreeStatus: 'pending' });
    const readyMetadata = worktree({ projectDirectory: '/workspace/project', worktreeStatus: 'ready' });
    const menuLoadArgs: Array<Parameters<SessionNodeItemProps['startSessionWorktreeMenuLoad']>[0]> = [];
    const props: SessionNodeItemProps = {
      ...baseProps(),
      node: { ...node, worktree: pendingMetadata },
      startSessionWorktreeMenuLoad: (args) => {
        menuLoadArgs.push(args);
        return { cachedTargets: [], refreshTargets: Promise.resolve([]) };
      },
    };

    try {
      useSessionUIStore.setState({
        worktreeMetadata: new Map([[session.id, pendingMetadata]]),
        availableWorktreesByProject: new Map(),
      });

      await act(async () => {
        root.render(React.createElement(I18nProvider, null, React.createElement(SessionNodeItem, props)));
      });
      const firstCallbackCount = dropdownSubmenuCallbacks.length;
      const firstOpen = dropdownSubmenuCallbacks.at(-1);
      expect(firstCallbackCount).toBeGreaterThan(0);

      await act(async () => {
        firstOpen?.(true);
        await Promise.resolve();
      });
      expect(menuLoadArgs.at(-1)?.currentWorktree).toBe(pendingMetadata);

      await act(async () => {
        useSessionUIStore.setState({ worktreeMetadata: new Map([[session.id, readyMetadata]]) });
      });
      const afterAttachmentUpdateCount = dropdownSubmenuCallbacks.length;
      expect(afterAttachmentUpdateCount).toBeGreaterThan(firstCallbackCount);

      await act(async () => {
        dropdownSubmenuCallbacks.at(-1)?.(true);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(menuLoadArgs.at(-1)?.currentWorktree).toBe(readyMetadata);
      const afterMenuRefreshCount = dropdownSubmenuCallbacks.length;

      await act(async () => {
        useSessionUIStore.setState({
          worktreeMetadata: new Map([
            [session.id, readyMetadata],
            ['other-session', worktree({ path: '/workspace/other' })],
          ]),
          availableWorktreesByProject: new Map([['/other-project', []]]),
        });
      });
      expect(dropdownSubmenuCallbacks.length).toBe(afterMenuRefreshCount);
    } finally {
      await act(async () => root.unmount());
      useSessionUIStore.setState(originalSessionUI, true);
      dropdownSubmenuCallbacks = [];
      dom.restore();
    }
  });
});
