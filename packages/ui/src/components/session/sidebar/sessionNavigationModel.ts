import type { Session } from '@opencode-ai/sdk/v2';

import type { SessionFoldersMap } from '@/stores/useSessionFoldersStore';
import { resolveGlobalSessionDirectory } from '@/stores/useGlobalSessionsStore';
import type { SessionNavigationTarget } from '@/sync/session-navigation';

import type { SessionGroup, SessionNode } from './types';
import { compareSessionsByPinnedAndTime, normalizePath } from './utils';

type ProjectSection = {
  project: { id: string };
  groups: SessionGroup[];
};

type BuildProjectNavigationTargetsArgs = {
  sections: ProjectSection[];
  foldersMap: SessionFoldersMap;
  getOrderedGroups: (projectId: string, groups: SessionGroup[]) => SessionGroup[];
  pinnedSessionIds: Set<string>;
  sessionOrderIndex: Map<string, number>;
};

const isSubtaskSession = (session: Session): boolean => {
  return Boolean((session as Session & { parentID?: string | null }).parentID);
};

const resolveNodeDirectory = (node: SessionNode, group: SessionGroup): string | null => {
  return normalizePath(resolveGlobalSessionDirectory(node.session))
    ?? normalizePath(group.directory ?? null);
};

/**
 * Build the project-scope shortcut model from the same section/group/folder
 * model the sidebar renders. Keeping this derivation beside the sidebar avoids
 * a second, subtly different project ordering inside the keyboard handler.
 */
export const buildProjectNavigationTargets = ({
  sections,
  foldersMap,
  getOrderedGroups,
  pinnedSessionIds,
  sessionOrderIndex,
}: BuildProjectNavigationTargetsArgs): SessionNavigationTarget[] => {
  const targets: SessionNavigationTarget[] = [];

  const compareNodes = (a: SessionNode, b: SessionNode): number => {
    const aIndex = sessionOrderIndex.get(a.session.id);
    const bIndex = sessionOrderIndex.get(b.session.id);
    if (aIndex !== undefined || bIndex !== undefined) {
      if (aIndex === undefined) return 1;
      if (bIndex === undefined) return -1;
      if (aIndex !== bIndex) return aIndex - bIndex;
    }
    return compareSessionsByPinnedAndTime(a.session, b.session, pinnedSessionIds);
  };

  sections.forEach((section) => {
    const orderedGroups = getOrderedGroups(section.project.id, section.groups);
    const rootGroup = orderedGroups.find((group) => group.isMain) ?? null;
    const visualGroups = rootGroup
      ? [rootGroup, ...orderedGroups.filter((group) => group.id !== rootGroup.id)]
      : orderedGroups;

    visualGroups.forEach((group) => {
      if (group.isArchivedBucket) return;

      const groupKey = `${section.project.id}:${group.id}`;
      const sourceNodes = [...group.sessions]
        .filter((node) => !node.session.time?.archived && !isSubtaskSession(node.session))
        .sort(compareNodes);
      const nodesById = new Map(sourceNodes.map((node) => [node.session.id, node]));
      const folderScopeKey = group.folderScopeKey ?? normalizePath(group.directory ?? null);
      const folders = folderScopeKey ? (foldersMap[folderScopeKey] ?? []) : [];
      const foldersByParent = new Map<string | null, typeof folders>();
      folders.forEach((folder) => {
        const parentId = folder.parentId ?? null;
        const siblings = foldersByParent.get(parentId) ?? [];
        siblings.push(folder);
        foldersByParent.set(parentId, siblings);
      });
      const assignedSessionIds = new Set(folders.flatMap((folder) => folder.sessionIds));

      const appendNode = (
        node: SessionNode,
        folderAncestorIds: readonly string[] | undefined,
        visibleIndex?: number,
      ): void => {
        targets.push({
          scope: 'project',
          sessionId: node.session.id,
          projectId: section.project.id,
          directory: resolveNodeDirectory(node, group),
          groupKey,
          folderAncestorIds,
          visibleIndex,
        });
      };

      const appendFolder = (folderId: string, ancestors: readonly string[]): void => {
        const folder = folders.find((candidate) => candidate.id === folderId);
        if (!folder) return;
        const nextAncestors = [...ancestors, folder.id];

        // SessionFolderItem renders nested folders before the folder's rows.
        (foldersByParent.get(folder.id) ?? []).forEach((child) => {
          appendFolder(child.id, nextAncestors);
        });

        folder.sessionIds
          .map((sessionId) => nodesById.get(sessionId))
          .filter((node): node is SessionNode => Boolean(node))
          .sort(compareNodes)
          .forEach((node) => appendNode(node, nextAncestors));
      };

      (foldersByParent.get(null) ?? []).forEach((folder) => appendFolder(folder.id, []));

      sourceNodes
        .filter((node) => !assignedSessionIds.has(node.session.id))
        .forEach((node, visibleIndex) => appendNode(node, undefined, visibleIndex));
    });
  });

  return targets;
};
