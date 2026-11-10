import React from 'react';
import { toast } from '@/components/ui';
import { SessionActionsMenuItems } from '@/components/session/sidebar/sessions/SessionActionsMenuItems';
import type { SessionMenuSlots } from '@/components/session/sidebar/sessions/sessionMenuSlots';
import { toggleSessionWork } from '@/components/session/sidebar/sessions/sessionWorkToggle';
import { collectNestedWorkInWork, resolveSessionMenuPlacement } from '@/components/session/sidebar/sessions/sessionMenuPlacement';
import { useSessionWorktreeMenuLoader } from '@/components/session/sidebar/sessionWorktreeMenuLoader';
import { isChatDirectoryPath } from '@/lib/chatDirectories';
import { isVSCodeRuntime } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import type { Session } from '@/lib/opencode/model';
import { normalizePath } from '@/lib/pathNormalization';
import { isSessionPinnedInMetadata } from '@/lib/sessionPins';
import { useSidebarSpaces } from '@/lib/spaces/spaces-store';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useGlobalSyncStore } from '@/sync/global-sync-store';
import { isRestorableOnItsOwn } from '@/sync/session-restore-rule';
import { useSessionUIStore } from '@/sync/session-ui-store';

type HeaderSessionActionsMenuItemsProps = {
  sessionId: string;
  open: boolean;
  slots: SessionMenuSlots;
  onRename: () => void;
  onExport: (session: Session, directory: string | null) => void;
  onMoveSession: (sessionId: string, directory: string) => void;
  onArchive: () => void;
  onDelete: () => void;
};

/**
 * The sidebar's session menu for a session the header shows (a tab, or the
 * title's menu), with the placement its sidebar row would have: the same
 * project, folders and Track / Done.
 */
export function HeaderSessionActionsMenuItems({
  sessionId,
  open,
  slots,
  onRename,
  onExport,
  onMoveSession,
  onArchive,
  onDelete,
}: HeaderSessionActionsMenuItemsProps): React.ReactNode {
  const { t } = useI18n();
  const isVSCode = React.useMemo(() => isVSCodeRuntime(), []);
  const session = useGlobalSessionsStore((state) => state.entityById.get(sessionId));
  // A subsession under an archived parent comes back only with that parent.
  const restorable = useGlobalSessionsStore((state) => {
    const entry = state.entityById.get(sessionId);
    return !entry || isRestorableOnItsOwn(entry, state.entityById);
  });
  const activeSessions = useGlobalSessionsStore((state) => state.activeSessions);
  const unarchiveSession = useSessionUIStore((state) => state.unarchiveSession);
  const availableWorktreesByProject = useSessionUIStore((state) => state.availableWorktreesByProject);
  const worktreeMetadata = useSessionUIStore((state) => state.worktreeMetadata);
  const sessionWorkEnabled = useUIStore((state) => state.sessionWorkEnabled);
  const projects = useProjectsStore((state) => state.projects);
  const authoritativeProjects = useGlobalSyncStore((state) => state.projects);
  const spaces = useSidebarSpaces(!isVSCode);
  const startWorktreeLoad = useSessionWorktreeMenuLoader((state) => state.load);

  const placement = React.useMemo(() => (session ? resolveSessionMenuPlacement(session, {
    projects,
    availableWorktreesByProject,
    authoritativeProjects,
    spaces,
    isVSCode,
    activeSessions,
    resolveLegacyScope: (entry) => normalizePath(worktreeMetadata.get(entry.id)?.projectDirectory ?? entry.directory ?? null),
    lookup: (id) => useGlobalSessionsStore.getState().entityById.get(id),
  }) : null), [activeSessions, authoritativeProjects, availableWorktreesByProject, isVSCode, projects, session, spaces, worktreeMetadata]);

  if (!session || !placement) return null;

  const archived = Boolean(session.time?.archived);
  const directory = normalizePath(session.directory ?? null);
  const canTrackWork = sessionWorkEnabled && placement.ownsWork && !archived && !session.parentID
    && !isChatDirectoryPath(session.directory);
  const workSessionsInWork = canTrackWork ? collectNestedWorkInWork(session, activeSessions) : [];

  const restore = async () => {
    const success = await unarchiveSession(session.id);
    if (success) toast.success(t('sessions.sidebar.session.restore.success'));
    else toast.error(t('sessions.sidebar.session.restore.error'));
  };

  return (
    <SessionActionsMenuItems
      session={session}
      directory={directory}
      open={open}
      slots={slots}
      archived={archived}
      pinned={isSessionPinnedInMetadata(session)}
      work={canTrackWork ? {
        inWork: workSessionsInWork.length > 0,
        toggle: () => { void toggleSessionWork(session.id, directory, workSessionsInWork, t); },
      } : null}
      projectId={placement.projectId}
      currentWorktree={useSessionUIStore.getState().getWorktreeMetadata(session.id) ?? null}
      descendants={[]}
      startWorktreeLoad={startWorktreeLoad}
      folders={placement.folderOwnerKey ? { ownerKey: placement.folderOwnerKey, projectId: placement.projectId } : null}
      onRename={onRename}
      onExport={() => onExport(session, directory)}
      onMoveSession={() => { if (directory) onMoveSession(session.id, directory); }}
      onArchive={onArchive}
      onRestore={archived && restorable ? () => { void restore(); } : null}
      onDelete={onDelete}
    />
  );
}
