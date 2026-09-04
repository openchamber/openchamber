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
  const sessionLocationById = React.useMemo(() => {
    const locations = new Map<string, RecentSessionLocation>();
    for (const session of sessions) {
      const directory = normalizePath(session.directory ?? null);
      if (!directory) continue;
      let owner: Props['projects'][number] | null = null;
      let ownerLength = -1;
      for (const project of projects) {
        const projectPath = normalizePath(project.normalizedPath);
        if (projectPath && (directory === projectPath || directory.startsWith(`${projectPath}/`)) && projectPath.length > ownerLength) {
          owner = project;
          ownerLength = projectPath.length;
        }
      }
      if (!owner) continue;
      const worktree = availableWorktreesByProject.get(owner.normalizedPath)?.find((entry) => normalizePath(entry.path) === directory);
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
  }, [availableWorktreesByProject, sessions, gitBranches, homeDirectory, projects]);
  const getSessionLocation = React.useCallback(
    (sessionId: string) => sessionLocationById.get(sessionId) ?? null,
    [sessionLocationById],
  );
  const getSessionNode = React.useCallback(
    (session: Session): SessionNode => ({
      session,
      children: (childrenMap.get(session.id) ?? []).filter((child) => !child.time?.archived).map((child) => ({
        session: child,
        children: [],
        worktree: null,
      })),
      worktree: null,
    }),
    [childrenMap],
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
