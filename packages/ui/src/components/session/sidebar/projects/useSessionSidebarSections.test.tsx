import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Session } from '@opencode-ai/sdk/v2';
import { I18nProvider } from '@/lib/i18n';
import type { ProjectSortOrder } from '@/stores/useSessionDisplayStore';
import { useSessionGrouping } from './useSessionGrouping';
import { useSessionSidebarSections } from './useSessionSidebarSections';
import type { SessionGroup } from '../types';

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

type ProjectFixture = {
  id: string;
  path: string;
  sessions: Session[];
};

type SectionsOptions = {
  projects?: ProjectFixture[];
  projectSortOrder?: ProjectSortOrder;
  activeSessionIds?: ReadonlySet<string>;
  sessionOrderRanks?: ReadonlyMap<string, number>;
};

// The real matcher and the real grouping callbacks run here: the reported bug
// was never about matching, so a stubbed matcher would test nothing.
const renderSections = (
  group: SessionGroup,
  query: string,
  projectSessions?: Session[],
  options: SectionsOptions = {},
): Sections => {
  const projects = options.projects
    ?? (projectSessions ? [{ id: 'project', path: CHATS_ROOT, sessions: projectSessions }] : []);
  const sessionsByProjectId = new Map(projects.map((project) => [project.id, project.sessions]));
  let captured: Sections | null = null;
  const Harness = () => {
    const sessionOrderRanks = options.sessionOrderRanks ?? new Map<string, number>();
    const grouping = useSessionGrouping({
      homeDirectory: '/home/user',
      worktreeMetadata: new Map(),
      pinnedSessionIds: new Set(),
      sessionOrderRanks,
      gitBranches: new Map(),
      isVSCode: false,
    });
    captured = useSessionSidebarSections({
      normalizedProjects: projects.map((project) => ({ id: project.id, path: project.path, normalizedPath: project.path })),
      getSessionsForProject: (projectId) => sessionsByProjectId.get(projectId)?.filter((session) => !session.time.archived) ?? [],
      getArchivedSessionsForProject: (projectId) => sessionsByProjectId.get(projectId)?.filter((session) => Boolean(session.time.archived)) ?? [],
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
      standaloneGroups: projects.length === 0 ? [group] : [],
      projectSortOrder: options.projectSortOrder ?? 'manual',
      activeSessionIds: options.activeSessionIds ?? new Set(),
      sessionOrderRanks,
    });
    return null;
  };

  renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(Harness)));
  if (!captured) throw new Error('sections hook was not mounted');
  return captured;
};

const projectSession = (id: string, directory: string, updated: number): Session => ({
  id,
  slug: id,
  projectID: 'project',
  title: id,
  version: '1',
  directory,
  time: { created: updated, updated },
});

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
});

// Issue #3444: the project zones never rose for a running session. The
// reorder happens here, where each project's owned sessions are already known.
describe('project live-activity ordering', () => {
  const older = projectSession('ses_older', '/repos/older', 10);
  const newer = projectSession('ses_newer', '/repos/newer', 20);
  const projects = [
    { id: 'newer', path: '/repos/newer', sessions: [newer] },
    { id: 'older', path: '/repos/older', sessions: [older] },
  ];
  const ids = (sections: Sections): string[] => sections.projectSections.map((section) => section.project.id);

  test('date-added promotes the project that owns a running session', () => {
    const sections = renderSections(chatsGroup([]), '', undefined, {
      projects,
      projectSortOrder: 'date-added',
      activeSessionIds: new Set([older.id]),
    });

    expect(ids(sections)).toEqual(['older', 'newer']);
  });

  test('recent promotes a running project even when its recency key is lower', () => {
    const sections = renderSections(chatsGroup([]), '', undefined, {
      projects,
      projectSortOrder: 'recent',
      activeSessionIds: new Set([older.id]),
      sessionOrderRanks: new Map([[newer.id, 1000], [older.id, 1]]),
    });

    expect(ids(sections)).toEqual(['older', 'newer']);
  });

  test('recent folds the live lifecycle value into its recency key', () => {
    const sections = renderSections(chatsGroup([]), '', undefined, {
      projects,
      projectSortOrder: 'recent',
      sessionOrderRanks: new Map([[older.id, 100]]),
    });

    expect(ids(sections)).toEqual(['older', 'newer']);
  });

  test('manual, a-z, and z-a keep the incoming order', () => {
    for (const projectSortOrder of ['manual', 'a-z', 'z-a'] as const) {
      const sections = renderSections(chatsGroup([]), '', undefined, {
        projects,
        projectSortOrder,
        activeSessionIds: new Set([older.id]),
      });

      expect(ids(sections)).toEqual(['newer', 'older']);
    }
  });
});
