import React from 'react';
import { DropdownMenuContent } from '@/components/ui/dropdown-menu';
import { ContextMenuContent } from '@/components/ui/context-menu';
import { MoveSessionDialog } from '@/components/session/MoveSessionDialog';
import type { Session } from '@/lib/opencode/model';
import { useSessionUIStore } from '@/sync/session-ui-store';
import type { SessionNode } from '../types';
import type { StartSessionWorktreeMenuLoadResult } from '../sessionWorktreeMenu';
import type { WorktreeMetadata } from '@/types/worktree';
import { SessionActionsMenuItems } from './SessionActionsMenuItems';
import { collectNodeDescendantSessions } from './sessionNodeItemUtils';
import { contextSessionMenuSlots, dropdownSessionMenuSlots, type SessionMenuSlots } from './sessionMenuSlots';
import { useSessionMarkdownExport } from './useSessionMarkdownExport';
import { useSessionRowMenuState } from './useSessionRowMenuState';

type SessionRowMenusInput = {
  node: SessionNode;
  sessionDirectory: string | null;
  sessionTitle: string;
  sessionRowKey: string;
  menuInstanceKey: string;
  contextMenuInstanceKey: string | null;
  archivedBucket: boolean;
  isPinnedSession: boolean;
  canTrackWork: boolean;
  pinBlocksWork: boolean;
  isInWork: boolean;
  toggleWork: () => void;
  projectId?: string | null;
  sessionProjectId: string | null | undefined;
  folderOwnerKey?: string | null;
  hasFolderMutationAuthority: boolean;
  isZoneRow: boolean;
  mobileVariant: boolean;
  editingId: string | null;
  openSidebarMenuKey: string | null;
  setOpenSidebarMenuKey: (key: string | null) => void;
  setEditingId: (id: string | null) => void;
  setEditingRowKey: (key: string | null) => void;
  setEditTitle: (value: string) => void;
  createFolderAndStartRename: (scopeKey: string, parentId?: string | null) => { id: string } | null;
  handleDeleteSession: (session: Session, source?: { archivedBucket?: boolean; hardDelete?: boolean; skipConfirm?: boolean }) => void;
  handleRestoreSession: (session: Session) => void;
  startSessionWorktreeMenuLoad: (args: {
    projectId: string | null;
    sourceDirectory: string | null;
    currentWorktree: WorktreeMetadata | null;
  }) => StartSessionWorktreeMenuLoadResult;
};

export function useSessionRowMenus({
  node,
  sessionDirectory,
  sessionTitle,
  sessionRowKey,
  menuInstanceKey,
  contextMenuInstanceKey,
  archivedBucket,
  isPinnedSession,
  canTrackWork,
  pinBlocksWork,
  isInWork,
  toggleWork,
  projectId,
  sessionProjectId,
  folderOwnerKey,
  hasFolderMutationAuthority,
  isZoneRow,
  mobileVariant,
  editingId,
  openSidebarMenuKey,
  setOpenSidebarMenuKey,
  setEditingId,
  setEditingRowKey,
  setEditTitle,
  createFolderAndStartRename,
  handleDeleteSession,
  handleRestoreSession,
  startSessionWorktreeMenuLoad,
}: SessionRowMenusInput) {
  const session = node.session;
  const editingIdRef = React.useRef(editingId);
  editingIdRef.current = editingId;
  const pendingRenameRef = React.useRef<{ id: string; title: string } | null>(null);
  const pendingFolderCreateRef = React.useRef(false);
  const sessionExport = useSessionMarkdownExport();
  const currentWorktreeMetadata = node.worktree ?? useSessionUIStore.getState().getWorktreeMetadata(session.id) ?? null;
  const [moveDialogOpen, setMoveDialogOpen] = React.useState(false);
  const {
    isMenuOpen,
    isContextMenuOpen,
    handleMenuOpenChange,
    handleContextMenuOpenChange,
    handleMenuOpenChangeComplete,
  } = useSessionRowMenuState({
    menuInstanceKey,
    contextMenuInstanceKey,
    openSidebarMenuKey,
    setOpenSidebarMenuKey,
    hasDeferredCloseWork: () => pendingRenameRef.current !== null,
    onCloseComplete: () => {
      if (!pendingRenameRef.current) return;
      const { id, title } = pendingRenameRef.current;
      pendingRenameRef.current = null;
      setEditingId(id);
      setEditingRowKey(sessionRowKey);
      setEditTitle(title);
    },
  });
  const isSessionMenuOpen = isMenuOpen || isContextMenuOpen;

  const renderSessionMenuItems = (slots: SessionMenuSlots) => (
    <SessionActionsMenuItems
      session={session}
      directory={sessionDirectory}
      open={isSessionMenuOpen}
      slots={slots}
      archived={archivedBucket}
      pinned={isPinnedSession}
      work={canTrackWork ? { inWork: isInWork, toggle: toggleWork } : pinBlocksWork ? 'blocked-by-pin' : null}
      projectId={projectId ?? null}
      currentWorktree={currentWorktreeMetadata}
      descendants={collectNodeDescendantSessions(node)}
      startWorktreeLoad={startSessionWorktreeMenuLoad}
      folders={hasFolderMutationAuthority ? {
        ownerKey: folderOwnerKey ?? null,
        projectId: sessionProjectId ?? null,
        createInline: isZoneRow ? undefined : (scope) => {
          const newFolder = createFolderAndStartRename(scope);
          if (newFolder) pendingFolderCreateRef.current = true;
          return newFolder;
        },
      } : null}
      touch={mobileVariant}
      onRename={() => {
        pendingRenameRef.current = { id: session.id, title: sessionTitle };
      }}
      onExport={() => sessionExport.requestExport(session, sessionDirectory, node)}
      onMoveSession={() => setMoveDialogOpen(true)}
      onArchive={() => handleDeleteSession(session, { archivedBucket })}
      onRestore={archivedBucket ? () => handleRestoreSession(session) : null}
      onDelete={() => handleDeleteSession(session, { archivedBucket, hardDelete: true })}
    />
  );

  const sessionMenuContent = (
    <DropdownMenuContent align="end" className="min-w-[180px]" finalFocus={() => {
      if (pendingFolderCreateRef.current) {
        pendingFolderCreateRef.current = false;
        return false;
      }
      return editingIdRef.current ? false : true;
    }}>
      {renderSessionMenuItems(dropdownSessionMenuSlots)}
    </DropdownMenuContent>
  );

  const contextMenuContent = (
    <ContextMenuContent
      finalFocus={() => {
        if (pendingFolderCreateRef.current) {
          pendingFolderCreateRef.current = false;
          return false;
        }
        return editingIdRef.current ? false : true;
      }}
      className="min-w-[180px]"
    >
      {renderSessionMenuItems(contextSessionMenuSlots)}
    </ContextMenuContent>
  );

  const dialogs = (
    <>
      {moveDialogOpen && sessionDirectory ? (
        <MoveSessionDialog open onOpenChange={setMoveDialogOpen} sessionId={session.id} sourceDirectory={sessionDirectory} />
      ) : null}
      {sessionExport.dialog}
    </>
  );

  return {
    isMenuOpen,
    isContextMenuOpen,
    isSessionMenuOpen,
    handleMenuOpenChange,
    handleContextMenuOpenChange,
    handleMenuOpenChangeComplete,
    sessionMenuContent,
    contextMenuContent,
    dialogs,
  };
}
