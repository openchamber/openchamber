import { describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import type { RepositoryReferenceKind, ProjectEntry } from '@/lib/api/types';
import { TooltipProvider } from '@/components/ui/tooltip';
import { I18nProvider } from '@/lib/i18n';
import type { Metadata, Session } from '@/lib/opencode/model';
import { ChildStoreManager } from '@/sync/child-store';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSourceBoardStore } from '@/stores/useSourceBoardStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { githubLikeDescriptor } from '@/lib/source-control/providers/descriptor.fixture';
import { useSourceControlProviderRegistry } from '@/lib/source-control/providers/registry';
import type { SessionGroupSectionProps } from './SessionGroupSection';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
  Element: browser.Element, HTMLElement: browser.HTMLElement, Node: browser.Node,
  MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser), requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
});

// The system browser is where a misrouted chip would end up.
const childStores = new ChildStoreManager();
// A linked issue reads as GitHub's through the served provider's URL patterns.
const github = githubLikeDescriptor();
useSourceControlProviderRegistry.setState({ ordered: [github], byId: new Map([[github.id, github]]), status: 'ready', holdsList: true });

mock.module('@/components/ui/button', () => ({
  Button: ({ children }: { children?: React.ReactNode }) => <button>{children}</button>,
}));

mock.module('../../SessionFolderItem', () => ({
  SessionFolderItem: () => null,
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
  useSessionBlockingRequests: () => ({ hasPermission: false, hasForm: false }),
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
  SessionTreeItem: () => null,
}));

const { SessionGroupSection } = await import('./SessionGroupSection');

const ISSUE_URL = 'https://github.com/openchamber/openchamber/issues/5028';
const PROJECT: ProjectEntry = { id: 'proj-1', path: '/repo' };
// The real failure mode of issue #5028: a worktree directory outside the
// project root. No path prefix matches it and the worktree map is empty, so
// only the group's own project can route its chip in the app.
const WORKTREE_DIRECTORY = '/home/user/.local/share/opencode/worktree/abc';

const linkedIssuesMetadata: Metadata = {
  openchamber: {
    linked_issues: [{
      id: 'openchamber/openchamber#5028',
      kind: 'issue',
      number: 5028,
      title: 'Worktree chip opens the browser instead of the board',
      url: ISSUE_URL,
      linkedAt: 1,
    }],
  },
};
// SAFETY: the group header only reads the fixture session's linked issues.
const linkedIssueSession = { id: 'session-a', metadata: linkedIssuesMetadata } as Session;

const group: SessionGroupSectionProps['group'] = {
  id: 'wt',
  label: 'feature',
  branch: 'feature',
  description: null,
  isMain: false,
  worktree: null,
  directory: WORKTREE_DIRECTORY,
  folderScopeKey: WORKTREE_DIRECTORY,
  sessions: [{
    session: linkedIssueSession,
    children: [],
    worktree: null,
  }],
};

const createProps = (): SessionGroupSectionProps => ({
  group,
  groupKey: 'project:wt',
  projectId: PROJECT.id,
  hideGroupLabel: false,
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
  expandedParents: new Set(),
  editingId: null,
  editingRowKey: null,
  editTitle: '',
  openSidebarMenuKey: null,
  setEditingId: () => undefined,
  setEditingRowKey: () => undefined,
  setEditTitle: () => undefined,
  toggleParent: () => undefined,
  setOpenSidebarMenuKey: () => undefined,
  startFolderRename: () => undefined,
  allowReselect: false,
  resetSessionSearch: () => undefined,
  deleteSessionConfirm: null,
  setDeleteSessionConfirm: () => undefined,
  startSessionWorktreeMenuLoad: () => ({
    cachedTargets: [],
    refreshTargets: Promise.resolve([]),
  }),
  onToggleCollapsedGroup: () => undefined,
  folderRename: null,
  setFolderRenameDraft: () => undefined,
  clearFolderRename: () => undefined,
});

describe('SessionGroupSection chip routing', () => {
  test('a worktree group outside every project path opens its issue chip through the project', async () => {
    // The system browser is where a misrouted chip would end up.
    const windowOpens: string[] = [];
    browser.open = (url?: string) => {
      windowOpens.push(url ?? '');
      return null;
    };
    const boardFocus: { projectId: string; kind: RepositoryReferenceKind; query: string }[] = [];
    const originalProjects = useProjectsStore.getState().projects;
    const originalBoard = useSourceBoardStore.getState();
    const originalWorktrees = useSessionUIStore.getState().availableWorktreesByProject;
    useProjectsStore.setState({ projects: [PROJECT] });
    useSessionUIStore.setState({ availableWorktreesByProject: new Map() });
    useSourceBoardStore.setState({
      focusRepositoryItem: (projectId, kind, query) => { boardFocus.push({ projectId, kind, query }); },
    });

    const host = document.createElement('div');
    document.body.append(host);
    const root: Root = createRoot(host);

    try {
      await act(async () => root.render(
        <I18nProvider><TooltipProvider><SessionGroupSection {...createProps()} /></TooltipProvider></I18nProvider>,
      ));

      // The group header chip for the session's linked issue.
      const chip = document.querySelector<HTMLButtonElement>('button[aria-label="#5028"]');
      expect(chip).not.toBeNull();
      await act(async () => chip!.click());

      // With no chat on screen the item shows on the board, read through the
      // project itself ('/repo') rather than the group's unresolvable worktree
      // directory, and never falls through to the system browser.
      expect(boardFocus).toEqual([{ projectId: PROJECT.id, kind: 'issue', query: ISSUE_URL }]);
      expect(windowOpens).toEqual([]);
    } finally {
      await act(async () => root.unmount());
      host.remove();
      useProjectsStore.setState({ projects: originalProjects });
      useSessionUIStore.setState({ availableWorktreesByProject: originalWorktrees });
      useSourceBoardStore.setState({ focusRepositoryItem: originalBoard.focusRepositoryItem });
    }
  });
});
