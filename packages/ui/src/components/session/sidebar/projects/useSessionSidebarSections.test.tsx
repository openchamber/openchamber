import { describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Session } from '@opencode-ai/sdk/v2';
import type { SessionFoldersMap } from '@/stores/useSessionFoldersStore';
import type { WorktreeMetadata } from '@/types/worktree';
import { I18nProvider } from '@/lib/i18n';
import { useSessionGrouping } from './useSessionGrouping';
import { useSessionSidebarSections } from './useSessionSidebarSections';
import type { SessionGroup, SessionNode } from '../types';
import { installHookTestDom } from '../test-utils/testDom';

const CHATS_ROOT = '/home/user/.config/openchamber/chats';

const chatSession = (id: string, title: string): Session => ({
  id,
  slug: id,
  projectID: 'chats',
  title,
  version: '1',
  directory: `${CHATS_ROOT}/2026-08-28/session-${id}`,
  time: { created: 1, updated: 1 },
});

const chatsGroup = (sessions: Session[]): SessionGroup => ({
  id: 'managed-chats',
  label: '',
  branch: null,
  description: null,
  isMain: true,
  worktree: null,
  directory: CHATS_ROOT,
  folderScopeKey: CHATS_ROOT,
  folderScopes: [{ scopeKey: CHATS_ROOT, directory: CHATS_ROOT }],
  draftTarget: 'chat',
  sessions: sessions.map((session) => ({ session, children: [], worktree: null })),
});

type Sections = ReturnType<typeof useSessionSidebarSections>;

// The real matcher and the real grouping callbacks run here: the reported bug
// was never about matching, so a stubbed matcher would test nothing.
const renderSections = (group: SessionGroup, query: string, projectSessions?: Session[]): Sections => {
  let captured: Sections | null = null;
  const Harness = () => {
    const grouping = useSessionGrouping({
      homeDirectory: '/home/user',
      worktreeMetadata: new Map(),
      pinnedSessionIds: new Set(),
      sessionOrderRanks: new Map(),
      gitBranches: new Map(),
      isVSCode: false,
    });
    captured = useSessionSidebarSections({
      normalizedProjects: projectSessions ? [{ id: 'project', path: CHATS_ROOT, normalizedPath: CHATS_ROOT }] : [],
      getSessionsForProject: () => projectSessions?.filter((session) => !session.time.archived) ?? [],
      getArchivedSessionsForProject: () => projectSessions?.filter((session) => Boolean(session.time.archived)) ?? [],
      availableWorktreesByProject: new Map(),
      projectRepoStatus: new Map(),
      projectRootBranches: new Map(),
      gitBranches: new Map(),
      lastRepoStatus: false,
      buildGroupedSessions: grouping.buildGroupedSessions,
      hasSessionSearchQuery: query.length > 0,
      normalizedSessionSearchQuery: query,
      filterSessionNodesForSearch: grouping.filterSessionNodesForSearch,
      buildGroupSearchText: grouping.buildGroupSearchText,
      foldersMap: { [CHATS_ROOT]: [{ id: 'folder', name: group.label, sessionIds: [], createdAt: 1 }] },
      standaloneGroups: projectSessions ? [] : [group],
    });
    return null;
  };

  renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(Harness)));
  if (!captured) throw new Error('sections hook was not mounted');
  return captured;
};

// Issue #3200: the managed chats render outside every project section. They
// were left out of the search pass, and a group without search data renders
// `filteredNodes ?? []` — so every chat disappeared as soon as a query was
// typed, however well its title matched.
describe('sidebar search over standalone groups', () => {
  const targetId = 'ses_f88b1a2b3c4d';

  test('finds project sessions in flat results without searching their archived bucket', () => {
    const active = { ...chatSession(targetId, 'Active'), directory: CHATS_ROOT };
    const archived = { ...chatSession('ses_archived', 'Archived'), directory: CHATS_ROOT, time: { created: 1, updated: 1, archived: 2 } };
    const group = chatsGroup([]);
    const sections = renderSections(group, targetId, [active, archived]);
    expect(sections.flatSectionsForRender[0].groups[0].sessions.map((node) => node.session.id)).toEqual([targetId]);
    expect(sections.searchMatchCount).toBe(1);
    const archivedSearch = renderSections(group, archived.id, [active, archived]);
    expect(archivedSearch.flatSectionsForRender).toEqual([]);
    expect(archivedSearch.searchMatchCount).toBe(0);
  });

  test('matches only a complete ID, ignoring case and surrounding whitespace', () => {
    const group = chatsGroup([
      chatSession(targetId, 'Release notes'),
      chatSession('ses_f88b1a2b3c4e', targetId),
    ]);
    group.label = targetId;
    for (const query of [targetId, `  ${targetId.toUpperCase()}\n`]) {
      const sections = renderSections(group, query);
      const data = sections.groupSearchDataByGroup.get(group);
      expect(data?.filteredNodes.map((node) => node.session.id)).toEqual([targetId]);
      expect(data?.groupMatches).toBe(false);
      expect(data?.folderNameMatchCount).toBe(0);
      expect(sections.searchMatchCount).toBe(1);
    }
    for (const query of ['ses_', 'ses_f88b', 'ses_f88b1a2b3c4f', `${targetId}x`, `${targetId} error`]) {
      expect(renderSections(group, query).searchMatchCount).toBe(0);
    }
  });

  test('keeps tree context and counts only the ID match', () => {
    const group = chatsGroup([chatSession('ses_parent', 'Parent')]);
    const parent = group.sessions[0];
    parent.children = [
      { session: chatSession(targetId, 'Child'), children: [], worktree: null },
      { session: chatSession('ses_sibling', 'Sibling'), children: [], worktree: null },
    ];
    const sections = renderSections(group, targetId);
    const nodes = sections.groupSearchDataByGroup.get(group)?.filteredNodes;
    expect(nodes?.map((node) => node.session.id)).toEqual(['ses_parent']);
    expect(nodes?.[0].children.map((node) => node.session.id)).toEqual([targetId]);
    expect(sections.searchMatchCount).toBe(1);
    const parentSections = renderSections(group, 'ses_parent');
    expect(parentSections.groupSearchDataByGroup.get(group)?.filteredNodes[0]).toBe(parent);
    expect(parentSections.searchMatchCount).toBe(1);
    expect(parent.children).toHaveLength(2);
  });

  test('does not return archived sessions for an ID query', () => {
    const archived = chatSession(targetId, 'Archived');
    archived.time.archived = 2;
    const group = chatsGroup([archived]);
    expect(renderSections(group, targetId).searchMatchCount).toBe(0);
  });

  test('keeps a matching chat in the group the sidebar renders', () => {
    const group = chatsGroup([
      chatSession('ses_a', 'Release notes for 1.21'),
      chatSession('ses_b', 'Unrelated grocery list'),
    ]);

    const sections = renderSections(group, 'release');
    const data = sections.groupSearchDataByGroup.get(group);

    expect(data).toBeDefined();
    expect(data?.filteredNodes.map((node) => node.session.id)).toEqual(['ses_a']);
    expect(data?.hasMatch).toBe(true);
  });

  test('counts chat matches in the header count', () => {
    const group = chatsGroup([
      chatSession('ses_a', 'Release notes for 1.21'),
      chatSession('ses_b', 'Release checklist'),
      chatSession('ses_c', 'Unrelated grocery list'),
    ]);

    expect(renderSections(group, 'release').searchMatchCount).toBe(2);
  });

  test('reports no match for a chat group nothing matches in', () => {
    const group = chatsGroup([chatSession('ses_a', 'Release notes for 1.21')]);

    const sections = renderSections(group, 'groceries');
    const data = sections.groupSearchDataByGroup.get(group);

    expect(data?.filteredNodes).toEqual([]);
    expect(data?.hasMatch).toBe(false);
    expect(sections.searchMatchCount).toBe(0);
  });

  test('skips the search pass entirely when no query is active', () => {
    const group = chatsGroup([chatSession('ses_a', 'Release notes for 1.21')]);

    const sections = renderSections(group, '');

    expect(sections.groupSearchDataByGroup.has(group)).toBe(false);
    expect(sections.searchMatchCount).toBe(0);
  });

  test('counts archived text matches and keeps the flat merge counts exact', () => {
    const active = { ...chatSession('ses_active', 'Release notes'), directory: CHATS_ROOT };
    const archived = {
      ...chatSession('ses_archived', 'Release archive'),
      directory: CHATS_ROOT,
      time: { created: 1, updated: 1, archived: 2 },
    };
    const sections = renderSections(chatsGroup([]), 'release', [active, archived]);
    const rootGroup = sections.sectionsForRender[0]?.groups.find((group) => group.isMain);
    const archivedGroup = sections.sectionsForRender[0]?.groups.find((group) => group.isArchivedBucket);
    if (!rootGroup || !archivedGroup) throw new Error('expected the active and archived groups');

    expect(sections.groupSearchDataByGroup.get(rootGroup)?.matchedSessionCount).toBe(1);
    expect(sections.groupSearchDataByGroup.get(archivedGroup)?.matchedSessionCount).toBe(1);
    expect(sections.searchMatchCount).toBe(2);
    expect(sections.flatSectionsForRender[0]?.groups[0]?.sessions.map((node) => node.session.id)).toEqual(['ses_active']);
  });

  test('keeps group and folder name matches in the header count', () => {
    const group = chatsGroup([chatSession('ses_a', 'Unrelated grocery list')]);
    group.label = 'Release workspace';

    const sections = renderSections(group, 'release');
    const data = sections.groupSearchDataByGroup.get(group);

    expect(data?.matchedSessionCount).toBe(0);
    expect(data?.groupMatches).toBe(true);
    expect(data?.folderNameMatchCount).toBe(1);
    expect(data?.hasMatch).toBe(true);
    expect(sections.searchMatchCount).toBe(2);
  });
});

const PROJECT_ROOT = '/repo/perf';
const PROJECTS = [{ id: 'project', path: PROJECT_ROOT, normalizedPath: PROJECT_ROOT }];
const EMPTY_WORKTREE_LIST: WorktreeMetadata[] = [];
const EMPTY_WORKTREES = new Map<string, WorktreeMetadata[]>();
const EMPTY_WORKTREE_METADATA = new Map<string, WorktreeMetadata>();
const EMPTY_PINNED = new Set<string>();
const EMPTY_RANKS = new Map<string, number>();
const EMPTY_BRANCHES = new Map<string, string | null>();
const EMPTY_REPO_STATUS = new Map<string, boolean | null>();
const EMPTY_ROOT_BRANCHES = new Map<string, string | null>();
const EMPTY_FOLDERS: SessionFoldersMap = {};

const projectSession = (id: string, title: string, overrides: Partial<Session> = {}): Session => ({
  id,
  slug: id,
  projectID: 'project',
  title,
  version: '1',
  directory: PROJECT_ROOT,
  time: { created: 1, updated: 1 },
  ...overrides,
});

const mainGroup = (sections: Sections): SessionGroup | null =>
  sections.visibleProjectSections[0]?.groups.find((group) => group.isMain) ?? null;

const archivedGroup = (sections: Sections): SessionGroup | null =>
  sections.visibleProjectSections[0]?.groups.find((group) => group.isArchivedBucket) ?? null;

const groupNodes = (sections: Sections, group: SessionGroup | null): SessionNode[] =>
  group ? (sections.groupSearchDataByGroup.get(group)?.filteredNodes ?? []) : [];

const nodeIds = (nodes: SessionNode[]): string[] => nodes.map((node) => node.session.id);

const buildProjectSections = ({
  sessions,
  query,
  worktrees = EMPTY_WORKTREE_LIST,
  folders = EMPTY_FOLDERS,
}: {
  sessions: Session[];
  query: string;
  worktrees?: WorktreeMetadata[];
  folders?: SessionFoldersMap;
}): Sections => {
  let captured: Sections | null = null;
  const activeSessions = sessions.filter((session) => !session.time?.archived);
  const archivedSessions = sessions.filter((session) => Boolean(session.time?.archived));
  const Harness = () => {
    const grouping = useSessionGrouping({
      homeDirectory: '/home/user',
      worktreeMetadata: EMPTY_WORKTREE_METADATA,
      pinnedSessionIds: EMPTY_PINNED,
      sessionOrderRanks: EMPTY_RANKS,
      gitBranches: EMPTY_BRANCHES,
      isVSCode: false,
    });
    captured = useSessionSidebarSections({
      normalizedProjects: PROJECTS,
      getSessionsForProject: () => activeSessions,
      getArchivedSessionsForProject: () => archivedSessions,
      availableWorktreesByProject: worktrees.length > 0 ? new Map([[PROJECT_ROOT, worktrees]]) : EMPTY_WORKTREES,
      projectRepoStatus: EMPTY_REPO_STATUS,
      projectRootBranches: EMPTY_ROOT_BRANCHES,
      gitBranches: EMPTY_BRANCHES,
      lastRepoStatus: false,
      buildGroupedSessions: grouping.buildGroupedSessions,
      hasSessionSearchQuery: query.length > 0,
      normalizedSessionSearchQuery: query,
      filterSessionNodesForSearch: grouping.filterSessionNodesForSearch,
      buildGroupSearchText: grouping.buildGroupSearchText,
      foldersMap: folders,
      standaloneGroups: [],
    });
    return null;
  };
  renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(Harness)));
  if (!captured) throw new Error('sections hook was not mounted');
  return captured;
};

type LiveSectionsControls = {
  sections: Sections | null;
  setSessions: React.Dispatch<React.SetStateAction<Session[]>> | null;
  setQuery: React.Dispatch<React.SetStateAction<string>> | null;
  setWorktrees: React.Dispatch<React.SetStateAction<WorktreeMetadata[]>> | null;
};

/**
 * Live counterpart of the static harness: real state and re-renders so an
 * in-place model update (rename, delete, archive, worktree move, object
 * replacement) is applied to a mounted hook while the query stays active.
 */
const mountLiveSections = (initialSessions: Session[], initialQuery: string) => {
  const dom = installHookTestDom();
  const root = createRoot(dom.container);
  const controls: LiveSectionsControls = { sections: null, setSessions: null, setQuery: null, setWorktrees: null };
  const Harness = () => {
    const [sessions, setSessions] = React.useState<Session[]>(initialSessions);
    const [query, setQuery] = React.useState(initialQuery);
    const [worktrees, setWorktrees] = React.useState<WorktreeMetadata[]>(EMPTY_WORKTREE_LIST);
    const grouping = useSessionGrouping({
      homeDirectory: '/home/user',
      worktreeMetadata: EMPTY_WORKTREE_METADATA,
      pinnedSessionIds: EMPTY_PINNED,
      sessionOrderRanks: EMPTY_RANKS,
      gitBranches: EMPTY_BRANCHES,
      isVSCode: false,
    });
    const getSessionsForProject = React.useCallback(
      () => sessions.filter((session) => !session.time?.archived),
      [sessions],
    );
    const getArchivedSessionsForProject = React.useCallback(
      () => sessions.filter((session) => Boolean(session.time?.archived)),
      [sessions],
    );
    const availableWorktreesByProject = React.useMemo(
      () => (worktrees.length > 0 ? new Map([[PROJECT_ROOT, worktrees]]) : EMPTY_WORKTREES),
      [worktrees],
    );
    controls.sections = useSessionSidebarSections({
      normalizedProjects: PROJECTS,
      getSessionsForProject,
      getArchivedSessionsForProject,
      availableWorktreesByProject,
      projectRepoStatus: EMPTY_REPO_STATUS,
      projectRootBranches: EMPTY_ROOT_BRANCHES,
      gitBranches: EMPTY_BRANCHES,
      lastRepoStatus: false,
      buildGroupedSessions: grouping.buildGroupedSessions,
      hasSessionSearchQuery: query.length > 0,
      normalizedSessionSearchQuery: query,
      filterSessionNodesForSearch: grouping.filterSessionNodesForSearch,
      buildGroupSearchText: grouping.buildGroupSearchText,
      foldersMap: EMPTY_FOLDERS,
      standaloneGroups: [],
    });
    controls.setSessions = setSessions;
    controls.setQuery = setQuery;
    controls.setWorktrees = setWorktrees;
    return null;
  };
  return {
    controls,
    render: async () => {
      await act(async () => {
        root.render(React.createElement(I18nProvider, null, React.createElement(Harness)));
      });
    },
    unmount: async () => {
      await act(async () => root.unmount());
      dom.restore();
    },
  };
};

describe('sidebar search live updates while a query is active', () => {
  test('a live title rename changes the match set and the header count', async () => {
    const harness = mountLiveSections([
      projectSession('ses_a', 'Release notes'),
      projectSession('ses_b', 'Grocery list'),
    ], 'release');
    try {
      await harness.render();
      const initial = harness.controls.sections!;
      expect(nodeIds(groupNodes(initial, mainGroup(initial)))).toEqual(['ses_a']);
      expect(initial.searchMatchCount).toBe(1);

      await act(async () => {
        harness.controls.setSessions!([
          projectSession('ses_a', 'Grocery notes'),
          projectSession('ses_b', 'Grocery list'),
        ]);
      });
      const renamedAway = harness.controls.sections!;
      expect(renamedAway.sectionsForRender).toEqual([]);
      expect(renamedAway.searchMatchCount).toBe(0);

      await act(async () => {
        harness.controls.setSessions!([
          projectSession('ses_a', 'Grocery notes'),
          projectSession('ses_b', 'Release list'),
        ]);
      });
      const renamedInto = harness.controls.sections!;
      expect(nodeIds(groupNodes(renamedInto, mainGroup(renamedInto)))).toEqual(['ses_b']);
      expect(renamedInto.searchMatchCount).toBe(1);
    } finally {
      await harness.unmount();
    }
  });

  test('a live deletion removes the result and updates the header count', async () => {
    const harness = mountLiveSections([
      projectSession('ses_a', 'Release notes'),
      projectSession('ses_b', 'Release checklist'),
    ], 'release');
    try {
      await harness.render();
      expect(nodeIds(groupNodes(harness.controls.sections!, mainGroup(harness.controls.sections!))))
        .toEqual(['ses_a', 'ses_b']);
      expect(harness.controls.sections!.searchMatchCount).toBe(2);

      await act(async () => {
        harness.controls.setSessions!([projectSession('ses_b', 'Release checklist')]);
      });
      const oneLeft = harness.controls.sections!;
      expect(nodeIds(groupNodes(oneLeft, mainGroup(oneLeft)))).toEqual(['ses_b']);
      expect(oneLeft.searchMatchCount).toBe(1);

      await act(async () => {
        harness.controls.setSessions!([]);
      });
      const noneLeft = harness.controls.sections!;
      expect(noneLeft.sectionsForRender).toEqual([]);
      expect(noneLeft.searchMatchCount).toBe(0);
    } finally {
      await harness.unmount();
    }
  });

  test('archive and unarchive move a live result between buckets and id queries still exclude archived', async () => {
    const active = projectSession('ses_a', 'Release notes');
    const archived: Session = { ...active, time: { created: 1, updated: 1, archived: 2 } };
    const harness = mountLiveSections([active], 'release');
    try {
      await harness.render();
      expect(nodeIds(groupNodes(harness.controls.sections!, mainGroup(harness.controls.sections!))))
        .toEqual(['ses_a']);

      await act(async () => {
        harness.controls.setSessions!([archived]);
      });
      const archivedState = harness.controls.sections!;
      expect(nodeIds(groupNodes(archivedState, mainGroup(archivedState)))).toEqual([]);
      expect(nodeIds(groupNodes(archivedState, archivedGroup(archivedState)))).toEqual(['ses_a']);
      expect(archivedState.searchMatchCount).toBe(1);

      await act(async () => {
        harness.controls.setQuery!('SES_A');
      });
      const idQuery = harness.controls.sections!;
      expect(idQuery.searchMatchCount).toBe(0);
      expect(nodeIds(groupNodes(idQuery, archivedGroup(idQuery)))).toEqual([]);

      await act(async () => {
        harness.controls.setSessions!([active]);
      });
      const unarchived = harness.controls.sections!;
      expect(nodeIds(groupNodes(unarchived, mainGroup(unarchived)))).toEqual(['ses_a']);
      expect(unarchived.searchMatchCount).toBe(1);
    } finally {
      await harness.unmount();
    }
  });

  test('a live worktree move keeps the session matching and updates the group scope', async () => {
    const worktree: WorktreeMetadata = {
      path: '/repo/perf-wt',
      projectDirectory: PROJECT_ROOT,
      branch: 'feature',
      label: 'feature',
    };
    const session = projectSession('ses_a', 'Release notes');
    const harness = mountLiveSections([session], 'release');
    try {
      await harness.render();
      expect(nodeIds(groupNodes(harness.controls.sections!, mainGroup(harness.controls.sections!))))
        .toEqual(['ses_a']);

      await act(async () => {
        harness.controls.setWorktrees!([worktree]);
        harness.controls.setSessions!([{ ...session, directory: worktree.path }]);
      });
      const moved = harness.controls.sections!;
      const worktreeGroup = moved.visibleProjectSections[0]?.groups.find(
        (group) => group.id === `worktree:${worktree.path}`,
      ) ?? null;
      expect(worktreeGroup).not.toBeNull();
      expect(nodeIds(groupNodes(moved, worktreeGroup))).toEqual(['ses_a']);
      expect(nodeIds(groupNodes(moved, mainGroup(moved)))).toEqual([]);
      expect(moved.searchMatchCount).toBe(1);
      expect(moved.flatSectionsForRender[0]?.groups[0]?.sessions.map((node) => node.session.directory))
        .toEqual([worktree.path]);
    } finally {
      await harness.unmount();
    }
  });

  test('a live session object replacement keeps the result and reflects the new object', async () => {
    const first = projectSession('ses_a', 'Release notes');
    const harness = mountLiveSections([first], 'release');
    try {
      await harness.render();
      expect(groupNodes(harness.controls.sections!, mainGroup(harness.controls.sections!))[0]?.session)
        .toBe(first);

      const replacement = projectSession('ses_a', 'Release notes v2');
      await act(async () => {
        harness.controls.setSessions!([replacement]);
      });
      const updated = harness.controls.sections!;
      const nodes = groupNodes(updated, mainGroup(updated));
      expect(nodeIds(nodes)).toEqual(['ses_a']);
      expect(nodes[0]?.session).toBe(replacement);
      expect(updated.searchMatchCount).toBe(1);
    } finally {
      await harness.unmount();
    }
  });
});

describe('sidebar search parity: groups, folders, and display projections', () => {
  test('matches a worktree group name without a session match and keeps both display projections', () => {
    const worktree: WorktreeMetadata = {
      path: '/repo/perf-wt',
      projectDirectory: PROJECT_ROOT,
      branch: 'feature',
      label: 'Release workspace',
    };
    const sections = buildProjectSections({
      sessions: [projectSession('ses_a', 'Grocery list', { directory: worktree.path })],
      query: 'release',
      worktrees: [worktree],
    });
    const worktreeGroup = sections.visibleProjectSections[0]?.groups.find(
      (group) => group.id === `worktree:${worktree.path}`,
    );
    if (!worktreeGroup) throw new Error('worktree group missing');

    const data = sections.groupSearchDataByGroup.get(worktreeGroup);
    expect(data?.matchedSessionCount).toBe(0);
    expect(data?.groupMatches).toBe(true);
    expect(data?.folderNameMatchCount).toBe(0);
    expect(data?.hasMatch).toBe(true);
    expect(nodeIds(groupNodes(sections, worktreeGroup))).toEqual([]);
    expect(sections.searchMatchCount).toBe(1);

    // Grouped display keeps the matching worktree group; flat display merges
    // the (empty) non-archived result into a single flat group.
    expect(sections.sectionsForRender[0]?.groups.map((group) => group.id)).toEqual([`worktree:${worktree.path}`]);
    expect(sections.flatSectionsForRender[0]?.groups[0]?.id).toBe('flat');
    expect(sections.flatSectionsForRender[0]?.groups[0]?.sessions).toEqual([]);
  });

  test('matches a folder name without a session or group match', () => {
    const folders: SessionFoldersMap = {
      [PROJECT_ROOT]: [{
        id: 'folder-release',
        name: 'Release plans',
        parentId: null,
        sessionIds: ['ses_a'],
        createdAt: 1,
      }],
    };
    const sections = buildProjectSections({
      sessions: [projectSession('ses_a', 'Grocery list')],
      query: 'release',
      folders,
    });
    const rootGroup = mainGroup(sections);
    if (!rootGroup) throw new Error('project root group missing');

    const data = sections.groupSearchDataByGroup.get(rootGroup);
    expect(data?.matchedSessionCount).toBe(0);
    expect(data?.groupMatches).toBe(false);
    expect(data?.folderNameMatchCount).toBe(1);
    expect(data?.hasMatch).toBe(true);
    expect(nodeIds(groupNodes(sections, rootGroup))).toEqual([]);
    expect(sections.searchMatchCount).toBe(1);
  });
});
