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

type Props = {
  projects: { id: string; label?: string; normalizedPath: string }[];
  availableWorktreesByProject: Map<string, WorktreeMetadata[]>;
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

export const RecentSessionSection: React.FC<Props> = (props) => {
  const {
    projects,
    availableWorktreesByProject,
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
  // Canonical worktree index: linked worktrees often live outside the project
  // root, so the prefix walk below can never own them. Mirror the project
  // grouping contract — exact directory match, never the project root itself.
  const worktreeByPath = React.useMemo(() => {
    const byPath = new Map<string, { meta: WorktreeMetadata; project: Props['projects'][number] }>();
    const projectByNormalizedPath = new Map<string, Props['projects'][number]>();
    for (const project of projects) {
      const normalized = normalizePath(project.normalizedPath);
      if (normalized && !projectByNormalizedPath.has(normalized)) projectByNormalizedPath.set(normalized, project);
    }
    for (const [projectPath, worktrees] of availableWorktreesByProject) {
      const project = projectByNormalizedPath.get(normalizePath(projectPath) ?? '') ?? null;
      if (!project) continue;
      const projectRoot = normalizePath(project.normalizedPath);
      for (const entry of worktrees) {
        const entryPath = normalizePath(entry.path);
        if (!entryPath || entryPath === projectRoot || byPath.has(entryPath)) continue;
        byPath.set(entryPath, { meta: entry, project });
      }
    }
    return byPath;
  }, [availableWorktreesByProject, projects]);
  const sessionLocationById = React.useMemo(() => {
    const locations = new Map<string, RecentSessionLocation>();
    for (const session of sessions) {
      const directory = normalizePath(session.directory ?? null);
      if (!directory) continue;
      // A worktree session outside its project root never matches the prefix
      // walk; resolve it through the canonical worktree index first.
      const worktreeHit = worktreeByPath.get(directory) ?? null;
      let owner: Props['projects'][number] | null = worktreeHit?.project ?? null;
      if (!owner) {
        let ownerLength = -1;
        for (const project of projects) {
          const projectPath = normalizePath(project.normalizedPath);
          if (projectPath && (directory === projectPath || directory.startsWith(`${projectPath}/`)) && projectPath.length > ownerLength) {
            owner = project;
            ownerLength = projectPath.length;
          }
        }
      }
      if (!owner) continue;
      // Single resolver: the canonical worktree index already excludes the
      // project root and normalizes every key. No per-project find fallback.
      const worktree = worktreeHit?.meta ?? null;
      const projectLabel = formatProjectLabel(owner.label?.trim() || formatDirectoryName(owner.normalizedPath, homeDirectory) || owner.normalizedPath);
      const branch = worktree?.branch?.trim() || gitBranches.get(directory)?.trim() || null;
      locations.set(session.id, {
        projectId: owner.id,
        groupDirectory: directory,
        projectLabel,
        branchLabel: branch && branch !== 'HEAD' && branch !== projectLabel ? branch : null,
      });
    }
    return locations;
  }, [sessions, gitBranches, homeDirectory, projects, worktreeByPath]);
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
        return (targetDirectory ? worktreeByPath.get(targetDirectory)?.meta : undefined) ?? null;
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
    [childrenMap, worktreeByPath],
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
