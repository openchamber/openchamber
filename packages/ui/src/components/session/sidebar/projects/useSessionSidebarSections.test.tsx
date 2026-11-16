import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Session } from '@/lib/opencode/model';
import type { WorktreeMetadata } from '@/types/worktree';
import { I18nProvider } from '@/lib/i18n';
import { useSessionGrouping } from './useSessionGrouping';
import { useSessionSidebarSections } from './useSessionSidebarSections';

const ROOT = '/repo';
const WORKTREE = '/repo/.wt/topic';

const session = (id: string, directory: string, archived = false): Session => ({
  id,
  projectID: 'project',
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  title: id,
  directory,
  time: archived ? { created: 1, updated: 1, archived: 2 } : { created: 1, updated: 1 },
});

type Sections = ReturnType<typeof useSessionSidebarSections>;

const renderSections = (sessions: Session[]): Sections => {
  let captured: Sections | null = null;
  const worktree: WorktreeMetadata = { source: 'sdk', name: 'topic', path: WORKTREE, projectDirectory: ROOT, branch: 'topic', label: 'topic' };
  const Harness = () => {
    const grouping = useSessionGrouping({
      homeDirectory: '/home/user',
      worktreeMetadata: new Map(),
      pinnedSessionIds: new Set(),
      sessionOrderRanks: new Map(),
      gitBranches: new Map(),
      isVSCode: false,
      sessionById: new Map(sessions.map((entry) => [entry.id, entry])),
      childrenMap: new Map(),
      nestedSessionIds: new Set(),
    });
    captured = useSessionSidebarSections({
      normalizedProjects: [{ id: 'project', path: ROOT, normalizedPath: ROOT }],
      getSessionsForProject: () => sessions.filter((entry) => !entry.time.archived),
      getArchivedSessionsForProject: () => sessions.filter((entry) => Boolean(entry.time.archived)),
      availableWorktreesByProject: new Map([[ROOT, [worktree]]]),
      projectRepoStatus: new Map(),
      projectRootBranches: new Map(),
      gitBranches: new Map(),
      sessionOrderRanks: new Map(),
      lastRepoStatus: true,
      buildGroupedSessions: grouping.buildGroupedSessions,
      getGroupingSessions: grouping.getGroupingSessions,
    });
    return null;
  };

  renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(Harness)));
  if (!captured) throw new Error('sections hook was not mounted');
  return captured;
};

const idsByGroup = (sections: Sections['projectSections']) => sections[0]!.groups.map((group) => [group.id, group.sessions.map((node) => node.session.id)]);

describe('useSessionSidebarSections', () => {
  const sessions = [session('root', ROOT), session('topic', WORKTREE), session('old', ROOT, true)];

  test('a project section groups its active sessions by worktree and keeps its archived ones in a bucket', () => {
    expect(idsByGroup(renderSections(sessions).projectSections)).toEqual([
      ['root', ['root']],
      [`worktree:${WORKTREE}`, ['topic']],
      ['archived', ['old']],
    ]);
  });

  test('the flat section merges the root and worktree groups and keeps the archived bucket apart', () => {
    const flat = renderSections(sessions).flatSectionsForRender;

    expect(idsByGroup(flat)).toEqual([['flat', ['root', 'topic']], ['archived', ['old']]]);
    expect(flat[0]!.groups[0]!.folderScopes).toEqual([{ scopeKey: ROOT, directory: ROOT }, { scopeKey: WORKTREE, directory: WORKTREE }]);
  });
});
