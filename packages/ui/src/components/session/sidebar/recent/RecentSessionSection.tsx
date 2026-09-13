import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2';
import { useI18n } from '@/lib/i18n';
import { formatDirectoryName } from '@/lib/utils';
import type { WorktreeMetadata } from '@/types/worktree';
import { SidebarActivitySections } from './SidebarActivitySections';
import { deriveRecentActivitySections, type RecentSessionLocation } from './activitySections';
import type { ActivityItem } from './SidebarActivitySections';
import type { SessionTreeItemProps } from '../sessions/SessionTreeItem';
import type { SessionNode } from '../types';
import { formatProjectLabel, normalizePath } from '../utils';
import {
  buildWorktreeByPathIndex,
  findPrefixWorktreeEntry,
  resolveBranchLiveFirst,
} from '../worktreeIndex';

type Props = {
  projects: { id: string; label?: string; normalizedPath: string }[];
  availableWorktreesByProject: Map<string, WorktreeMetadata[]>;
  worktreeMetadata?: ReadonlyMap<string, WorktreeMetadata>;
  gitBranches: Map<string, string | null>;
  homeDirectory: string | null;
  hasSessionSearchQuery: boolean;
  normalizedSessionSearchQuery: string;
  isDesktopShellRuntime: boolean;
  sessions: Session[];
  childrenMap: ReadonlyMap<string, readonly Session[]>;
  pinnedSessionIds: Set<string>;
  recentSessions: Session[];
  expandedParents: Set<string>;
  notifyOnSubtasks: boolean;
  editingId: string | null;
  editTitle: string;
  copiedSessionId: string | null;
  openSidebarMenuKey: string | null;
  mobileVariant: boolean;
  alwaysShowActions: boolean;
  chatSessions: Session[];
  renderChatsSection: (items: ActivityItem[]) => React.ReactNode;
  onNewChat: () => void;
  showRecentSection: boolean;
} & Pick<SessionTreeItemProps,
  | 'setEditingId'
  | 'setEditTitle'
  | 'toggleParent'
  | 'setOpenSidebarMenuKey'
  | 'allowReselect'
  | 'onSessionSelected'
  | 'isSessionSearchOpen'
  | 'sessionSearchQuery'
  | 'setSessionSearchQuery'
  | 'setIsSessionSearchOpen'
  | 'deleteSessionConfirm'
  | 'setDeleteSessionConfirm'
  | 'startFolderRename'
  | 'setCopiedSessionId'
  | 'startSessionWorktreeMenuLoad'
>;

type RecentWorktreeResolution = {
  owner: Props['projects'][number] | null;
  worktree: WorktreeMetadata | null;
  worktreePath: string | null;
};

export const RecentSessionSection: React.FC<Props> = (props) => {
  const {
    projects,
    availableWorktreesByProject,
    worktreeMetadata,
    gitBranches,
    homeDirectory,
    hasSessionSearchQuery,
    normalizedSessionSearchQuery,
    isDesktopShellRuntime,
    sessions,
    childrenMap,
    pinnedSessionIds,
    recentSessions,
    chatSessions,
    showRecentSection,
  } = props;
  const { t } = useI18n();
  // Canonical worktree index shared with project grouping and the switcher
  // (normalization, project-root exclusion, first-wins dedupe).
  const worktreeByPath = React.useMemo(
    () => buildWorktreeByPathIndex(availableWorktreesByProject, projects),
    [availableWorktreesByProject, projects],
  );
  const findOwnerProject = React.useCallback(
    (directory: string): Props['projects'][number] | null => {
      let owner: Props['projects'][number] | null = null;
      let ownerLength = -1;
      for (const project of projects) {
        const projectPath = normalizePath(project.normalizedPath);
        if (projectPath && (directory === projectPath || directory.startsWith(`${projectPath}/`)) && projectPath.length > ownerLength) {
          owner = project;
          ownerLength = projectPath.length;
        }
      }
      return owner;
    },
    [projects],
  );
  // Resolution order mirrors project grouping parity: session-keyed metadata
  // first (trusted only inside its own worktree), then longest-prefix worktree
  // match for `<worktree>/sub`, then the existing project prefix walk.
  // The project root itself never resolves to a worktree.
  const resolveOwnerAndWorktree = React.useCallback(
    (sessionId: string, directory: string): RecentWorktreeResolution => {
      const sessionMeta = worktreeMetadata?.get(sessionId) ?? null;
      if (sessionMeta) {
        const metaPath = normalizePath(sessionMeta.path);
        if (metaPath && (directory === metaPath || directory.startsWith(`${metaPath}/`))) {
          const indexed = worktreeByPath.get(metaPath) ?? null;
          if (indexed) {
            if (directory !== normalizePath(indexed.project.normalizedPath)) {
              return { owner: indexed.project, worktree: sessionMeta, worktreePath: metaPath };
            }
          } else {
            const owner = findOwnerProject(metaPath) ?? findOwnerProject(directory);
            if (owner && directory !== normalizePath(owner.normalizedPath)) {
              return { owner, worktree: sessionMeta, worktreePath: metaPath };
            }
          }
        }
      }
      const prefixHit = findPrefixWorktreeEntry(directory, worktreeByPath);
      if (prefixHit) {
        if (directory !== normalizePath(prefixHit.project.normalizedPath)) {
          return {
            owner: prefixHit.project,
            worktree: prefixHit.meta,
            worktreePath: normalizePath(prefixHit.meta.path) ?? directory,
          };
        }
      }
      return { owner: findOwnerProject(directory), worktree: null, worktreePath: null };
    },
    [findOwnerProject, worktreeByPath, worktreeMetadata],
  );
  const sessionLocationById = React.useMemo(() => {
    const locations = new Map<string, RecentSessionLocation>();
    for (const session of sessions) {
      const directory = normalizePath(session.directory ?? null);
      if (!directory) continue;
      const { owner, worktree, worktreePath } = resolveOwnerAndWorktree(session.id, directory);
      if (!owner) continue;
      const projectLabel = formatProjectLabel(owner.label?.trim() || formatDirectoryName(owner.normalizedPath, homeDirectory) || owner.normalizedPath);
      // Live-first: live git status wins over discovered worktree metadata.
      const branch = resolveBranchLiveFirst(directory, worktreePath, worktree?.branch, gitBranches);
      locations.set(session.id, {
        projectId: owner.id,
        groupDirectory: directory,
        projectLabel,
        branchLabel: branch && branch !== 'HEAD' && branch !== projectLabel ? branch : null,
      });
    }
    return locations;
  }, [sessions, gitBranches, homeDirectory, resolveOwnerAndWorktree]);
  const getSessionLocation = React.useCallback(
    (sessionId: string) => sessionLocationById.get(sessionId) ?? null,
    [sessionLocationById],
  );
  const getSessionNode = React.useCallback(
    (session: Session): SessionNode => {
      // Attach the canonical worktree per session (root and children alike),
      // mirroring the project grouping contract. The row derives its branch
      // line fallback and PR lookup key from node.worktree; leaving it null
      // is what reduced worktree rows to title+date.
      const resolveWorktree = (target: Session): WorktreeMetadata | null => {
        const targetDirectory = normalizePath(target.directory ?? null);
        if (!targetDirectory) return null;
        return resolveOwnerAndWorktree(target.id, targetDirectory).worktree;
      };
      return {
        session,
        children: (childrenMap.get(session.id) ?? []).filter((child) => !child.time?.archived).map((child) => ({
          session: child,
          children: [],
          worktree: resolveWorktree(child),
        })),
        worktree: resolveWorktree(session),
      };
    },
    [childrenMap, resolveOwnerAndWorktree],
  );
  const recentSections = React.useMemo(() => deriveRecentActivitySections({
    sessions: recentSessions,
    getSessionLocation,
    getSessionNode,
    query: hasSessionSearchQuery ? normalizedSessionSearchQuery : '',
  }), [getSessionLocation, getSessionNode, hasSessionSearchQuery, normalizedSessionSearchQuery, recentSessions]);
  const sections = React.useMemo(() => [
    {
      key: 'chats' as const,
      title: t('sessions.sidebar.activity.chatsTitle'),
      items: chatSessions.map((session) => ({
        node: getSessionNode(session),
        projectId: null,
        groupDirectory: session.directory ?? null,
        secondaryMeta: null,
      })),
    },
    ...(showRecentSection ? recentSections.map((section) => ({ ...section, title: t('sessions.sidebar.activity.recentTitle') })) : []),
  ], [chatSessions, getSessionNode, recentSections, showRecentSection, t]);
  return (
    <SidebarActivitySections
      sections={sections}
      variant="section"
      isDesktopShellRuntime={isDesktopShellRuntime}
      pinnedSessionIds={pinnedSessionIds}
      expandedParents={props.expandedParents}
      hasSessionSearchQuery={props.hasSessionSearchQuery}
      normalizedSessionSearchQuery={props.normalizedSessionSearchQuery}
      notifyOnSubtasks={props.notifyOnSubtasks}
      editingId={props.editingId}
      editTitle={props.editTitle}
      copiedSessionId={props.copiedSessionId}
      openSidebarMenuKey={props.openSidebarMenuKey}
      mobileVariant={props.mobileVariant}
      alwaysShowActions={props.alwaysShowActions}
      onNewChat={props.onNewChat}
      renderChatsSection={props.renderChatsSection}
      setEditingId={props.setEditingId}
      setEditTitle={props.setEditTitle}
      toggleParent={props.toggleParent}
      setOpenSidebarMenuKey={props.setOpenSidebarMenuKey}
      allowReselect={props.allowReselect}
      onSessionSelected={props.onSessionSelected}
      isSessionSearchOpen={props.isSessionSearchOpen}
      sessionSearchQuery={props.sessionSearchQuery}
      setSessionSearchQuery={props.setSessionSearchQuery}
      setIsSessionSearchOpen={props.setIsSessionSearchOpen}
      deleteSessionConfirm={props.deleteSessionConfirm}
      setDeleteSessionConfirm={props.setDeleteSessionConfirm}
      startFolderRename={props.startFolderRename}
      setCopiedSessionId={props.setCopiedSessionId}
      startSessionWorktreeMenuLoad={props.startSessionWorktreeMenuLoad}
    />
  );
};
