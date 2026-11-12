import type { Session } from '@/lib/opencode/model';
import type { ConversationResult } from '@/hooks/useConversationSearch';
import type { SessionSidebarRowModelArgs } from './sessionSidebarRowModel';
import type { ProjectSection } from './projects/sessionProjectRender';

export function searchFixture(count = 2): SessionSidebarRowModelArgs {
  const sections: ProjectSection[] = ['a', 'b'].map((id) => ({
    project: { id, normalizedPath: `/repo/${id}`, label: id },
    groups: [{ id: 'main', label: 'main', branch: null, description: null, isMain: true, worktree: null, directory: `/repo/${id}`, folderScopeKey: `/repo/${id}`,
      sessions: Array.from({ length: Math.floor(count / 2) }, (_, index) => ({
        // SAFETY: projection reads only identity, location, title and lifecycle.
        session: { id: `${id}-${index}`, title: `Needle conversation ${index}`, directory: `/repo/${id}`, time: { created: 1, updated: 1 } } as Session,
        children: [], worktree: null,
      })),
    }],
  }));
  return {
    mode: 'search', sections, authoritativeSections: sections, chatGroup: null, foldersMap: {},
    collapsedProjects: new Set(), collapsedGroups: new Set(), collapsedFolders: new Set(), collapsedActivities: new Set(),
    expandedParents: new Set(), visibleCountByContainer: new Map(), pinnedSessionIds: new Set(), sessionOrderIndex: new Map(), groupStatusByKey: new Map(), folderAuthorityByOwner: new Map(),
    sessionOwnerById: new Map(sections.flatMap((section) => section.groups.flatMap((group) => group.sessions.map(({ session }) => [session.id, { projectId: section.project.id, projectRoot: section.project.normalizedPath, scopeDirectory: group.directory!, kind: 'project' as const }] as const)))),
    activeProjectId: 'a', singleProjectMode: false, singleProjectId: null, showOnlyMainWorkspace: false, hideDirectoryControls: false,
  };
}

export function searchResult(sessionId: string, overrides: Partial<ConversationResult> = {}): ConversationResult {
  return { sessionId, title: 'Needle conversation', titleRanges: [[0, 6]], directory: '/repo/a', archived: false, updatedAt: 1,
    metadata: { sessionId, score: 0, titleRanges: [[0, 6]], matchedField: 'title' }, excerpt: null, moreMatches: 0, ...overrides };
}
