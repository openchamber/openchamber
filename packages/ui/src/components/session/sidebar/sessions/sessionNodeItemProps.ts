import type React from 'react';
import type { Session } from '@/lib/opencode/model';
import type { WorktreeMetadata } from '@/types/worktree';
import type { SessionNode } from '../types';
import type { SessionSidebarRenderContext } from '../sessionSidebarRowModel';
import type { StartSessionWorktreeMenuLoadResult } from '../sessionWorktreeMenu';
import type { BlockingBadgeSessionScope } from './sessionNodeItemUtils';

export type SecondaryMeta = {
  projectLabel?: string | null;
  branchLabel?: string | null;
  /** The branch label is an isolated space's name; the row marks it with the space's container icon. */
  inSpace?: boolean;
};

export type SessionNodeItemProps = {
  node: SessionNode;
  depth?: number;
  /** The row is a work of its own; a row inside one leaves Track / Done to it. */
  ownsWork: boolean;
  groupDirectory?: string | null;
  projectId?: string | null;
  folderOwnerKey?: string | null;
  ownerProjectId?: string | null;
  selectionScopeKey?: string | null;
  archivedBucket?: boolean;
  pinnedSessionIds: Set<string>;
  expandedParents: Set<string>;
  editingId: string | null;
  editingRowKey: string | null;
  setEditingId: (id: string | null) => void;
  setEditingRowKey: (key: string | null) => void;
  editTitle: string;
  setEditTitle: (value: string) => void;
  handleSaveEdit: (titleOverride?: string) => void;
  handleCancelEdit: () => void;
  toggleParent: (expansionKey: string) => void;
  handleSessionSelect: (sessionId: string, sessionDirectory: string | null) => void;
  handleSessionDoubleClick: (sessionId: string, sessionTitle: string) => void;
  openSidebarMenuKey: string | null;
  setOpenSidebarMenuKey: (key: string | null) => void;
  createFolderAndStartRename: (scopeKey: string, parentId?: string | null) => { id: string } | null;
  handleDeleteSession: (session: Session, source?: { archivedBucket?: boolean; hardDelete?: boolean; skipConfirm?: boolean }) => void;
  handleRestoreSession: (session: Session) => void;
  startSessionWorktreeMenuLoad: (args: {
    projectId: string | null;
    sourceDirectory: string | null;
    currentWorktree: WorktreeMetadata | null;
  }) => StartSessionWorktreeMenuLoadResult;
  mobileVariant: boolean;
  alwaysShowActions: boolean;
  secondaryMeta?: SecondaryMeta | null;
  renderContext?: SessionSidebarRenderContext;
  /** A work's row under its project with Detailed rows on: two lines, keeping the tree slot. */
  detailed?: boolean;
  /**
   * The session is listed higher up in the sidebar too. Current, it takes no
   * fill here, only its title at full strength, so the sidebar shows one
   * selected row: the first from the top.
   */
  repeat?: boolean;
  blockingBadgeSessionScopes?: readonly BlockingBadgeSessionScope[];
  rowKey?: string;
  dragKey?: string;
  /**
   * Precomputed set of session IDs whose subtree contains the session
   * currently being edited. Precomputed once per group render.
   */
  subtreeContainsEditing: Set<string>;
  /**
   * Precomputed session ID of the row whose sidebar menu is open, or null
   * if no menu is open. Only one row can have its menu open at a time.
   */
  menuOpenSessionId: string | null;
  /**
   * Bumped once a minute by the Recent list so the compact relative
   * timestamp rendered below recomputes instead of freezing at the value it
   * had when the row first mounted.
   */
  relativeTimeTick?: number;
  /**
   * Precomputed structural key for this node and its badge-only scopes in
   * flat detailed zone rows. Both row memo boundaries use it to notice changes
   * to hidden descendants without adding them to the rendered node.
   */
  nodeStructureKey: string;
  /**
   * Resolves the per-row render extras for each child node. SessionGroupSection
   * walks the whole tree once to precompute the structure key for every
   * descendant; SessionNodeItem's recursive child render uses this lookup
   * to fetch the right key for each child it produces.
   */
  children?: React.ReactNode;
};
