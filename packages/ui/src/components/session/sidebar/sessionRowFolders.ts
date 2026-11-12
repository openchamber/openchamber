import type { SessionFoldersMap } from '@/stores/useSessionFoldersStore';
import type { ProjectSection } from './projects/sessionProjectRender';
import type { SessionSidebarWorkEntry } from './sessionSidebarRowModel';
import { getSessionFolderScopes } from './sessions/sessionFolderIdentity';
import type { SessionRowOrderWork } from './sessions/sessionRowOrder';
import { isGroupWork, worktreeFolderMemberId } from './works/sidebarWorks';

export const registerSessionRowWorks = (sections: readonly ProjectSection[], works: Map<string, SessionRowOrderWork>): void => {
  for (const section of sections) {
    for (const group of section.groups) {
      if (isGroupWork(group)) works.set(`${section.project.id}:${group.id}`, Object.freeze({ group, projectId: section.project.id }));
    }
  }
};

export const projectTimelineSessionFolders = (
  sections: readonly ProjectSection[],
  foldersMap: SessionFoldersMap,
  sessionRows: boolean | undefined,
  excluded: ReadonlySet<string> | undefined,
  timeEntries: readonly SessionSidebarWorkEntry[],
  filedWorktrees: (section: ProjectSection) => ReadonlyMap<string, unknown>,
) => {
  const foldered = sections.flatMap((section) => {
    if (excluded?.has(section.project.id)) return [];
    const filed = filedWorktrees(section);
    return section.groups.flatMap((rootGroup) => {
      if (!rootGroup.isMain && (!sessionRows || rootGroup.sessions.length === 0 || !isGroupWork(rootGroup)
        || filed.has(worktreeFolderMemberId(rootGroup.directory) ?? ''))) return [];
      const hasFolders = getSessionFolderScopes(rootGroup).some(({ scopeKey }) => (foldersMap[scopeKey] ?? []).length > 0);
      return hasFolders ? [{ section, rootGroup }] : [];
    });
  });
  const folderMembers = new Set(foldered.flatMap(({ rootGroup }) => getSessionFolderScopes(rootGroup)
    .flatMap(({ scopeKey }) => (foldersMap[scopeKey] ?? []).flatMap((folder) => folder.sessionIds))));
  const entries = timeEntries.filter((entry) => entry.kind !== 'session' || !folderMembers.has(entry.item.node.session.id));
  return { foldered, entries };
};
