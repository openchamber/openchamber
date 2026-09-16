import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2';
import { useI18n } from '@/lib/i18n';
import type { WorktreeMetadata } from '@/types/worktree';
import { SidebarActivitySections } from './SidebarActivitySections';
import { deriveRecentActivitySections } from './activitySections';
import { buildRecentSessionLocations } from './recentSessionLocations';
import type { ActivityItem } from './SidebarActivitySections';
import { buildActiveSessionNode } from '../list/sessionCollection';
import type { SessionTreeItemProps } from '../sessions/SessionTreeItem';
import type { SessionNode } from '../types';
import { getSessionSelectionScopeKey } from '../sessions/sessionFolderIdentity';

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
  chatSelectionScopeKey?: string | null;
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
  | 'resetSessionSearch'
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
  const sessionLocationById = React.useMemo(() => buildRecentSessionLocations({
    sessions,
    projects,
    availableWorktreesByProject,
    gitBranches,
    homeDirectory,
  }), [availableWorktreesByProject, gitBranches, homeDirectory, projects, sessions]);
  const getSessionLocation = React.useCallback(
    (sessionId: string) => sessionLocationById.get(sessionId) ?? null,
    [sessionLocationById],
  );
  const getSessionNode = React.useCallback(
    (session: Session): SessionNode => buildActiveSessionNode(childrenMap, session),
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
        selectionScopeKey: props.chatSelectionScopeKey ?? getSessionSelectionScopeKey(null, session.directory ?? null),
        secondaryMeta: null,
      })),
    },
    ...(showRecentSection ? recentSections.map((section) => ({ ...section, title: t('sessions.sidebar.activity.recentTitle') })) : []),
  ], [chatSessions, getSessionNode, props.chatSelectionScopeKey, recentSections, showRecentSection, t]);
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
      resetSessionSearch={props.resetSessionSearch}
      deleteSessionConfirm={props.deleteSessionConfirm}
      setDeleteSessionConfirm={props.setDeleteSessionConfirm}
      startFolderRename={props.startFolderRename}
      setCopiedSessionId={props.setCopiedSessionId}
      startSessionWorktreeMenuLoad={props.startSessionWorktreeMenuLoad}
    />
  );
};
