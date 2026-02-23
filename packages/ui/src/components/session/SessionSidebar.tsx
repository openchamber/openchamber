import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2';
import { toast } from '@/components/ui';
import { copyTextToClipboard } from '@/lib/clipboard';
import { isDesktopLocalOriginActive, isDesktopShell, isTauriShell } from '@/lib/desktop';
import {
  DndContext,
  DragOverlay,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
  type Modifier,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';

import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { GridLoader } from '@/components/ui/grid-loader';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import {
  RiAddLine,
  RiArrowDownSLine,
  RiArrowRightSLine,
  RiCheckLine,
  RiCloseLine,
  RiDeleteBinLine,
  RiErrorWarningLine,
  RiFileCopyLine,
  RiFolderAddLine,
  RiFolderLine,
  RiGitBranchLine,
  RiGitPullRequestLine,
  RiGitRepositoryLine,
  RiNodeTree,
  RiStickyNoteLine,
  RiLinkUnlinkM,

  RiGithubLine,

  RiMore2Line,
  RiPencilAiLine,
  RiPushpinLine,
  RiShare2Line,
  RiShieldLine,
  RiUnpinLine,
} from '@remixicon/react';
import { sessionEvents } from '@/lib/sessionEvents';
import { ArrowsMerge } from '@/components/icons/ArrowsMerge';
import { formatDirectoryName, formatPathForDisplay, cn } from '@/lib/utils';
import { useSessionStore } from '@/stores/useSessionStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useConfigStore } from '@/stores/useConfigStore';
import type { WorktreeMetadata } from '@/types/worktree';
import { opencodeClient } from '@/lib/opencode/client';
import { checkIsGitRepository } from '@/lib/gitApi';
import { getSafeStorage } from '@/stores/utils/safeStorage';
import { createWorktreeOnly, createWorktreeSession } from '@/lib/worktreeSessionCreator';
import { getRootBranch } from '@/lib/worktrees/worktreeStatus';
import { useGitStore } from '@/stores/useGitStore';
import { useDeviceInfo } from '@/lib/device';
import { isVSCodeRuntime } from '@/lib/desktop';
import { updateDesktopSettings } from '@/lib/persistence';
import { GitHubIssuePickerDialog } from './GitHubIssuePickerDialog';
import { GitHubPullRequestPickerDialog } from './GitHubPullRequestPickerDialog';
import { ProjectNotesTodoPanel } from './ProjectNotesTodoPanel';
import { BranchPickerDialog } from './BranchPickerDialog';
import { useSessionFoldersStore } from '@/stores/useSessionFoldersStore';
import { SessionFolderItem } from './SessionFolderItem';

const ATTENTION_DIAMOND_INDICES = new Set([1, 3, 4, 5, 7]);

const getAttentionDiamondDelay = (index: number): string => {
  return index === 4 ? '0ms' : '130ms';
};

const PROJECT_COLLAPSE_STORAGE_KEY = 'oc.sessions.projectCollapse';
const GROUP_ORDER_STORAGE_KEY = 'oc.sessions.groupOrder';
const GROUP_COLLAPSE_STORAGE_KEY = 'oc.sessions.groupCollapse';
const PROJECT_ACTIVE_SESSION_STORAGE_KEY = 'oc.sessions.activeSessionByProject';
const SESSION_EXPANDED_STORAGE_KEY = 'oc.sessions.expandedParents';
const SESSION_PINNED_STORAGE_KEY = 'oc.sessions.pinned';

const formatDateLabel = (value: string | number) => {
  const targetDate = new Date(value);
  const today = new Date();
  const isSameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();

  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);

  if (isSameDay(targetDate, today)) {
    return 'Today';
  }
  if (isSameDay(targetDate, yesterday)) {
    return 'Yesterday';
  }
  const formatted = targetDate.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  return formatted.replace(',', '');
};

/** Returns relative time if updated today, otherwise falls back to formatDateLabel using updated time. */
const formatSessionDateLabel = (updatedMs: number): string => {
  const today = new Date();
  const updatedDate = new Date(updatedMs);
  const isSameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();

  if (isSameDay(updatedDate, today)) {
    const diff = Date.now() - updatedMs;
    if (diff < 60_000) return 'Just now';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}min ago`;
    return `${Math.floor(diff / 3_600_000)}h ago`;
  }

  return formatDateLabel(updatedMs);
};

const normalizePath = (value?: string | null) => {
  if (!value) {
    return null;
  }
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '');
  return normalized.length === 0 ? '/' : normalized;
};

const normalizeForBranchComparison = (value: string): string => {
  return value
    .toLowerCase()
    .replace(/^opencode[/-]?/i, '')
    .replace(/[-_]/g, '')
    .trim();
};

const isBranchDifferentFromLabel = (branch: string | null, label: string): boolean => {
  if (!branch) return false;
  return normalizeForBranchComparison(branch) !== normalizeForBranchComparison(label);
};

const toFiniteNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
};

const getSessionCreatedAt = (session: Session): number => {
  return toFiniteNumber(session.time?.created) ?? 0;
};

const getSessionUpdatedAt = (session: Session, attentionStates?: Map<string, { lastUserMessageAt: number | null; lastStatusChangeAt: number }>): number => {
  const baseUpdated = toFiniteNumber(session.time?.updated) ?? 0;
  if (!attentionStates) return baseUpdated;

  const attention = attentionStates.get(session.id);
  if (!attention) return baseUpdated;

  return Math.max(
    baseUpdated,
    attention.lastUserMessageAt ?? 0,
    attention.lastStatusChangeAt ?? 0
  );
};

const compareSessionsByPinnedAndTime = (
  a: Session,
  b: Session,
  pinnedSessionIds: Set<string>,
  attentionStates?: Map<string, { lastUserMessageAt: number | null; lastStatusChangeAt: number }>
): number => {
  const aPinned = pinnedSessionIds.has(a.id);
  const bPinned = pinnedSessionIds.has(b.id);
  if (aPinned !== bPinned) {
    return aPinned ? -1 : 1;
  }

  if (aPinned && bPinned) {
    return getSessionCreatedAt(b) - getSessionCreatedAt(a);
  }

  return getSessionUpdatedAt(b, attentionStates) - getSessionUpdatedAt(a, attentionStates);
};

const centerDragOverlayUnderPointer: Modifier = ({ transform, activeNodeRect, activatorEvent }) => {
  if (!(activatorEvent instanceof MouseEvent) || !activeNodeRect) {
    return transform;
  }
  const overlayHeight = 32;
  const pointerLiftY = 16;
  return {
    ...transform,
    x: transform.x,
    y: transform.y - overlayHeight / 2 - pointerLiftY,
  };
};

// Format project label: kebab-case/snake_case → Title Case
const formatProjectLabel = (label: string): string => {
  return label
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
};

type SessionNode = {
  session: Session;
  children: SessionNode[];
  worktree: WorktreeMetadata | null;
};

type SessionGroup = {
  id: string;
  label: string;
  branch: string | null;
  description: string | null;
  isMain: boolean;
  worktree: WorktreeMetadata | null;
  directory: string | null;
  sessions: SessionNode[];
};

// --- Session Folder DnD helpers ---

/**
 * Wraps a session row so the entire row is draggable onto folder drop zones.
 * Stops pointer propagation so the outer group-reorder DndContext does not
 * capture the drag (otherwise dragging a session moves the whole workspace group).
 */
const DraggableSessionRow: React.FC<{
  sessionId: string;
  sessionDirectory: string | null;
  sessionTitle: string;
  children: React.ReactNode;
}> = ({ sessionId, sessionDirectory, sessionTitle, children }) => {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `session-drag:${sessionId}`,
    data: { type: 'session', sessionId, sessionDirectory, sessionTitle },
  });

  const handlePointerDown = React.useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // Stop event from bubbling to the outer group-reorder DndContext
      e.stopPropagation();
      if (listeners?.onPointerDown) {
        (listeners.onPointerDown as (event: React.PointerEvent) => void)(e);
      }
    },
    [listeners],
  );

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      onPointerDown={handlePointerDown}
      className={isDragging ? 'opacity-40' : undefined}
    >
      {children}
    </div>
  );
};

/**
 * Wraps a <SessionFolderItem> and makes it a droppable target.
 * Uses a render-prop pattern so the ref/isOver state can be passed
 * down as props (avoids hooks-in-callbacks restrictions).
 */
const DroppableFolderWrapper: React.FC<{
  folderId: string;
  children: (
    droppableRef: (node: HTMLElement | null) => void,
    isOver: boolean,
  ) => React.ReactNode;
}> = ({ folderId, children }) => {
  const { setNodeRef, isOver } = useDroppable({
    id: `folder-drop:${folderId}`,
    data: { type: 'folder', folderId },
  });
  return <>{children(setNodeRef, isOver)}</>;
};

/**
 * Provides an inner DndContext scoped to one group, allowing sessions to be
 * dragged onto folder headers within that group.
 */
const SessionFolderDndScope: React.FC<{
  scopeKey: string | null;
  hasFolders: boolean;
  onSessionDroppedOnFolder: (sessionId: string, folderId: string) => void;
  children: React.ReactNode;
}> = ({ scopeKey, hasFolders, onSessionDroppedOnFolder, children }) => {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );
  const [activeDragId, setActiveDragId] = React.useState<string | null>(null);
  const [activeDragTitle, setActiveDragTitle] = React.useState<string>('Session');
  const [activeDragWidth, setActiveDragWidth] = React.useState<number | null>(null);
  const [activeDragHeight, setActiveDragHeight] = React.useState<number | null>(null);

  // Always need DndContext when scopeKey exists (DraggableSessionRow requires it).
  // When there are no folders the drag just has nowhere to land – that's fine.
  if (!scopeKey) {
    return <>{children}</>;
  }

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveDragId(null);
    setActiveDragWidth(null);
    setActiveDragHeight(null);
    const { active, over } = event;
    if (!over) return;
    const activeData = active.data.current as { type?: string; sessionId?: string } | undefined;
    const overData = over.data.current as { type?: string; folderId?: string } | undefined;
    if (activeData?.type === 'session' && activeData.sessionId && overData?.type === 'folder' && overData.folderId) {
      onSessionDroppedOnFolder(activeData.sessionId, overData.folderId);
    }
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={(event) => {
        const data = event.active.data.current as { type?: string; sessionId?: string; sessionTitle?: string } | undefined;
        if (data?.type === 'session' && data.sessionId) {
          setActiveDragId(data.sessionId);
          setActiveDragTitle(data.sessionTitle ?? 'Session');
          const width = event.active.rect.current.initial?.width;
          const height = event.active.rect.current.initial?.height;
          setActiveDragWidth(typeof width === 'number' ? width : null);
          setActiveDragHeight(typeof height === 'number' ? height : null);
        }
      }}
      onDragCancel={() => {
        setActiveDragId(null);
        setActiveDragWidth(null);
        setActiveDragHeight(null);
      }}
      onDragEnd={handleDragEnd}
    >
      {children}
      <DragOverlay dropAnimation={null}>
        {activeDragId && hasFolders ? (
          <div 
            style={{ 
              width: activeDragWidth ? `${activeDragWidth}px` : 'auto',
              height: activeDragHeight ? `${activeDragHeight}px` : 'auto'
            }}
            className="flex items-center rounded-md border border-border bg-sidebar px-1.5 py-1 shadow-lg opacity-90 pointer-events-none"
          >
            <RiStickyNoteLine className="h-4 w-4 text-muted-foreground mr-2 flex-shrink-0" />
            <div className="min-w-0 flex-1 truncate typography-ui-label font-normal text-foreground">
              {activeDragTitle}
            </div>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
};

// --- End Session Folder DnD helpers ---

interface SortableProjectItemProps {
  id: string;
  projectLabel: string;
  projectDescription: string;
  isCollapsed: boolean;
  isActiveProject: boolean;
  isRepo: boolean;
  isHovered: boolean;
  isDesktopShell: boolean;
  isStuck: boolean;
  hideDirectoryControls: boolean;
  mobileVariant: boolean;
  onToggle: () => void;
  onHoverChange: (hovered: boolean) => void;
  onNewSession: () => void;
  onNewWorktreeSession?: () => void;
  onNewSessionFromGitHubIssue?: () => void;
  onNewSessionFromGitHubPR?: () => void;
  onOpenMultiRunLauncher: () => void;
  onRenameStart: () => void;
  onRenameSave: () => void;
  onRenameCancel: () => void;
  onRenameValueChange: (value: string) => void;
  renameValue: string;
  isRenaming: boolean;
  onClose: () => void;
  sentinelRef: (el: HTMLDivElement | null) => void;
  children?: React.ReactNode;
  settingsAutoCreateWorktree: boolean;
  showCreateButtons?: boolean;
  hideHeader?: boolean;
}

const SortableProjectItem: React.FC<SortableProjectItemProps> = ({
  id,
  projectLabel,
  projectDescription,
  isCollapsed,
  isActiveProject,
  isRepo,
  isHovered,
  isDesktopShell,
  isStuck,
  hideDirectoryControls,
  mobileVariant,
  onToggle,
  onHoverChange,
  onNewSession,
  onNewWorktreeSession,
  onNewSessionFromGitHubIssue,
  onNewSessionFromGitHubPR,
  onOpenMultiRunLauncher,
  onRenameStart,
  onRenameSave,
  onRenameCancel,
  onRenameValueChange,
  renameValue,
  isRenaming,
  onClose,
  sentinelRef,
  children,
  settingsAutoCreateWorktree,
  showCreateButtons = true,
  hideHeader = false,
}) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    isDragging,
  } = useSortable({ id });

  const [isMenuOpen, setIsMenuOpen] = React.useState(false);

  return (
    <div ref={setNodeRef} className={cn('relative', isDragging && 'opacity-40')}>
      {!hideHeader ? (
        <>
          {/* Sentinel for sticky detection */}
          {isDesktopShell && (
            <div
              ref={sentinelRef}
              data-project-id={id}
              className="absolute top-0 h-px w-full pointer-events-none"
              aria-hidden="true"
            />
          )}

          {/* Project header - sticky like workspace groups */}
          <div
            className={cn(
              'sticky top-0 z-10 pt-2 pb-1.5 w-full text-left cursor-pointer group/project border-b select-none',
              !isDesktopShell && 'bg-sidebar',
            )}
            style={{
              backgroundColor: isDesktopShell
                ? isStuck ? 'var(--sidebar-stuck-bg)' : 'transparent'
                : undefined,
              borderColor: isHovered
                ? 'var(--color-border-hover)'
                : isCollapsed
                  ? 'color-mix(in srgb, var(--color-border) 35%, transparent)'
                  : 'var(--color-border)'
            }}
            onMouseEnter={() => onHoverChange(true)}
            onMouseLeave={() => onHoverChange(false)}
            onContextMenu={(event) => {
              event.preventDefault();
              if (!isRenaming) {
                setIsMenuOpen(true);
              }
            }}
          >
        <div className="relative flex items-center gap-1 px-1" {...attributes}>
          {isRenaming ? (
            <form
              className="flex min-w-0 flex-1 items-center gap-2"
              data-keyboard-avoid="true"
              onSubmit={(event) => {
                event.preventDefault();
                onRenameSave();
              }}
            >
              <input
                value={renameValue}
                onChange={(event) => onRenameValueChange(event.target.value)}
                className="flex-1 min-w-0 bg-transparent typography-ui-label outline-none placeholder:text-muted-foreground"
                autoFocus
                placeholder="Rename project"
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.stopPropagation();
                    onRenameCancel();
                    return;
                  }
                  if (event.key === ' ' || event.key === 'Enter') {
                    event.stopPropagation();
                  }
                }}
              />
              <button
                type="submit"
                className="shrink-0 text-muted-foreground hover:text-foreground"
              >
                <RiCheckLine className="size-4" />
              </button>
              <button
                type="button"
                onClick={onRenameCancel}
                className="shrink-0 text-muted-foreground hover:text-foreground"
              >
                <RiCloseLine className="size-4" />
              </button>
            </form>
          ) : (
            <Tooltip delayDuration={1500}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={onToggle}
                  {...listeners}
                  className="flex-1 min-w-0 flex items-center gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 rounded-sm cursor-grab active:cursor-grabbing"
                >
                  <span className={cn(
                    "typography-ui font-semibold truncate",
                    isActiveProject ? "text-primary" : "text-foreground group-hover/project:text-foreground"
                  )}>
                    {projectLabel}
                  </span>
                </button>
              </TooltipTrigger>
              <TooltipContent side="right" sideOffset={8}>
                {projectDescription}
              </TooltipContent>
            </Tooltip>
          )}

          {!isRenaming ? (
            <DropdownMenu
              open={isMenuOpen}
              onOpenChange={setIsMenuOpen}
            >
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className={cn(
                    'inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 hover:text-foreground',
                    mobileVariant ? 'opacity-70' : 'opacity-0 group-hover/project:opacity-100',
                  )}
                  aria-label="Project menu"
                  onClick={(e) => e.stopPropagation()}
                >
                  <RiMore2Line className="h-3.5 w-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[180px]">
                {showCreateButtons && isRepo && !hideDirectoryControls && settingsAutoCreateWorktree && onNewSession && (
                  <DropdownMenuItem onClick={onNewSession}>
                    <RiAddLine className="mr-1.5 h-4 w-4" />
                    New Session
                  </DropdownMenuItem>
                )}
                {showCreateButtons && isRepo && !hideDirectoryControls && !settingsAutoCreateWorktree && onNewWorktreeSession && (
                  <DropdownMenuItem onClick={onNewWorktreeSession}>
                    <RiGitBranchLine className="mr-1.5 h-4 w-4" />
                    New Session in Worktree
                  </DropdownMenuItem>
                )}
                {showCreateButtons && isRepo && !hideDirectoryControls && onNewSessionFromGitHubIssue && (
                  <DropdownMenuItem onClick={onNewSessionFromGitHubIssue}>
                    <RiGithubLine className="mr-1.5 h-4 w-4" />
                    New session from GitHub issue
                  </DropdownMenuItem>
                )}
                {showCreateButtons && isRepo && !hideDirectoryControls && onNewSessionFromGitHubPR && (
                  <DropdownMenuItem onClick={onNewSessionFromGitHubPR}>
                    <RiGitPullRequestLine className="mr-1.5 h-4 w-4" />
                    New session from GitHub PR
                  </DropdownMenuItem>
                )}
                {showCreateButtons && isRepo && !hideDirectoryControls && (
                  <DropdownMenuItem onClick={onOpenMultiRunLauncher}>
                    <ArrowsMerge className="mr-1.5 h-4 w-4" />
                    New Multi-Run
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onClick={onRenameStart}>
                  <RiPencilAiLine className="mr-1.5 h-4 w-4" />
                  Rename
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={onClose}
                  className="text-destructive focus:text-destructive"
                >
                  <RiCloseLine className="mr-1.5 h-4 w-4" />
                  Close Project
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}

          {showCreateButtons && isRepo && !hideDirectoryControls && onNewWorktreeSession && settingsAutoCreateWorktree && !isRenaming && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onNewWorktreeSession();
                  }}
                  className={cn(
                    'inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 hover:text-foreground hover:bg-interactive-hover/50 flex-shrink-0',
                    mobileVariant ? 'opacity-70' : 'opacity-100',
                  )}
                  aria-label="New session in worktree"
                >
                  <RiGitBranchLine className="h-4 w-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={4}>
                <p>New session in worktree</p>
              </TooltipContent>
            </Tooltip>
          )}
          {showCreateButtons && (!settingsAutoCreateWorktree || !isRepo) && !isRenaming && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onNewSession();
                  }}
                  className="inline-flex h-6 w-6 items-center justify-center text-muted-foreground hover:text-foreground hover:bg-interactive-hover/50 flex-shrink-0 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                  aria-label="New session"
                >
                  <RiAddLine className="h-4 w-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={4}>
                <p>New session</p>
              </TooltipContent>
            </Tooltip>
          )}
        </div>
          </div>
        </>
      ) : null}

      {/* Children (workspace groups and sessions) */}
      {children}
    </div>
  );
};

const SortableGroupItemBase: React.FC<{
  id: string;
  children: React.ReactNode;
}> = ({ id, children }) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, willChange: 'transform' }}
      className={cn(
        'space-y-0.5 rounded-md',
        isDragging && 'opacity-0',
      )}
      {...attributes}
      {...listeners}
    >
      {children}
    </div>
  );
};

const SortableGroupItem = React.memo(SortableGroupItemBase);

const GroupDragOverlayBase: React.FC<{ label: string; showBranchIcon: boolean; width?: number }> = ({ label, showBranchIcon, width }) => {
  return (
    <div style={width ? { width: `${width}px` } : undefined} className="h-8 min-w-[180px] max-w-[320px] rounded-sm border border-border bg-sidebar px-2 shadow-lg flex items-center gap-1.5">
      {showBranchIcon ? <RiGitBranchLine className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" /> : null}
      <p className="text-[15px] font-semibold truncate text-foreground">{label}</p>
    </div>
  );
};

const GroupDragOverlay = React.memo(GroupDragOverlayBase);

interface SessionSidebarProps {
  mobileVariant?: boolean;
  onSessionSelected?: (sessionId: string) => void;
  allowReselect?: boolean;
  hideDirectoryControls?: boolean;
  hideProjectSelector?: boolean;
  showOnlyMainWorkspace?: boolean;
}

export const SessionSidebar: React.FC<SessionSidebarProps> = ({
  mobileVariant = false,
  onSessionSelected,
  allowReselect = false,
  hideDirectoryControls = false,
  hideProjectSelector = false,
  showOnlyMainWorkspace = false,
}) => {
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [editTitle, setEditTitle] = React.useState('');
  const [editingProjectId, setEditingProjectId] = React.useState<string | null>(null);
  const [editProjectTitle, setEditProjectTitle] = React.useState('');
  const [copiedSessionId, setCopiedSessionId] = React.useState<string | null>(null);
  const copyTimeout = React.useRef<number | null>(null);
  const [expandedParents, setExpandedParents] = React.useState<Set<string>>(new Set());
  const [directoryStatus, setDirectoryStatus] = React.useState<Map<string, 'unknown' | 'exists' | 'missing'>>(
    () => new Map(),
  );
  const checkingDirectories = React.useRef<Set<string>>(new Set());
  const safeStorage = React.useMemo(() => getSafeStorage(), []);
  const [collapsedProjects, setCollapsedProjects] = React.useState<Set<string>>(new Set());

  const [projectRepoStatus, setProjectRepoStatus] = React.useState<Map<string, boolean | null>>(new Map());
  const [expandedSessionGroups, setExpandedSessionGroups] = React.useState<Set<string>>(new Set());
  const [hoveredProjectId, setHoveredProjectId] = React.useState<string | null>(null);
  const [issuePickerOpen, setIssuePickerOpen] = React.useState(false);
  const [pullRequestPickerOpen, setPullRequestPickerOpen] = React.useState(false);
  const [isBranchPickerOpen, setIsBranchPickerOpen] = React.useState(false);
  const [projectNotesPanelOpen, setProjectNotesPanelOpen] = React.useState(false);
  const [stuckProjectHeaders, setStuckProjectHeaders] = React.useState<Set<string>>(new Set());
  const [openMenuSessionId, setOpenMenuSessionId] = React.useState<string | null>(null);
  const [renamingFolderId, setRenamingFolderId] = React.useState<string | null>(null);
  const [renameFolderDraft, setRenameFolderDraft] = React.useState('');
  const [deleteSessionConfirm, setDeleteSessionConfirm] = React.useState<{
    session: Session;
    descendantCount: number;
  } | null>(null);
  const [deleteFolderConfirm, setDeleteFolderConfirm] = React.useState<{
    scopeKey: string;
    folderId: string;
    folderName: string;
    subFolderCount: number;
    sessionCount: number;
  } | null>(null);
  const [pinnedSessionIds, setPinnedSessionIds] = React.useState<Set<string>>(() => {
    try {
      const raw = getSafeStorage().getItem(SESSION_PINNED_STORAGE_KEY);
      if (!raw) {
        return new Set();
      }
      const parsed = JSON.parse(raw) as string[];
      return new Set(Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : []);
    } catch {
      return new Set();
    }
  });
  const [collapsedGroups, setCollapsedGroups] = React.useState<Set<string>>(() => {
    try {
      const raw = getSafeStorage().getItem(GROUP_COLLAPSE_STORAGE_KEY);
      if (!raw) {
        return new Set();
      }
      const parsed = JSON.parse(raw) as string[];
      return new Set(Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : []);
    } catch {
      return new Set();
    }
  });
  const [groupOrderByProject, setGroupOrderByProject] = React.useState<Map<string, string[]>>(() => {
    try {
      const raw = getSafeStorage().getItem(GROUP_ORDER_STORAGE_KEY);
      if (!raw) {
        return new Map();
      }
      const parsed = JSON.parse(raw) as Record<string, string[]>;
      const next = new Map<string, string[]>();
      Object.entries(parsed).forEach(([projectId, order]) => {
        if (Array.isArray(order)) {
          next.set(projectId, order.filter((item) => typeof item === 'string'));
        }
      });
      return next;
    } catch {
      return new Map();
    }
  });
  const [activeSessionByProject, setActiveSessionByProject] = React.useState<Map<string, string>>(() => {
    try {
      const raw = getSafeStorage().getItem(PROJECT_ACTIVE_SESSION_STORAGE_KEY);
      if (!raw) {
        return new Map();
      }
      const parsed = JSON.parse(raw) as Record<string, string>;
      const next = new Map<string, string>();
      Object.entries(parsed).forEach(([projectId, sessionId]) => {
        if (typeof sessionId === 'string' && sessionId.length > 0) {
          next.set(projectId, sessionId);
        }
      });
      return next;
    } catch {
      return new Map();
    }
  });
  const [activeDraggedGroupId, setActiveDraggedGroupId] = React.useState<string | null>(null);
  const [activeDraggedGroupWidth, setActiveDraggedGroupWidth] = React.useState<number | null>(null);
  const [isProjectRenameInline, setIsProjectRenameInline] = React.useState(false);
  const [projectRenameDraft, setProjectRenameDraft] = React.useState('');
  const [projectRootBranches, setProjectRootBranches] = React.useState<Map<string, string>>(new Map());
  const projectHeaderSentinelRefs = React.useRef<Map<string, HTMLDivElement | null>>(new Map());
  const ignoreIntersectionUntil = React.useRef<number>(0);
  const persistCollapsedProjectsTimer = React.useRef<number | null>(null);
  const pendingCollapsedProjects = React.useRef<Set<string> | null>(null);

  const homeDirectory = useDirectoryStore((state) => state.homeDirectory);
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const setDirectory = useDirectoryStore((state) => state.setDirectory);

  const projects = useProjectsStore((state) => state.projects);
  const activeProjectId = useProjectsStore((state) => state.activeProjectId);
  const addProject = useProjectsStore((state) => state.addProject);
  const removeProject = useProjectsStore((state) => state.removeProject);
  const setActiveProject = useProjectsStore((state) => state.setActiveProject);
  const setActiveProjectIdOnly = useProjectsStore((state) => state.setActiveProjectIdOnly);
  const renameProject = useProjectsStore((state) => state.renameProject);

  const setActiveMainTab = useUIStore((state) => state.setActiveMainTab);
  const deviceInfo = useDeviceInfo();
  const setSessionSwitcherOpen = useUIStore((state) => state.setSessionSwitcherOpen);
  const openMultiRunLauncher = useUIStore((state) => state.openMultiRunLauncher);
  const notifyOnSubtasks = useUIStore((state) => state.notifyOnSubtasks);
  const settingsAutoCreateWorktree = useConfigStore((state) => state.settingsAutoCreateWorktree);

  // Session Folders store
  // Subscribe to foldersMap so renderSessionNode/renderGroupSessions re-run when any folder changes.
  // getFoldersForScope is a stable function selector and does not trigger re-renders on its own.
  const foldersMap = useSessionFoldersStore((state) => state.foldersMap);
  const collapsedFolderIds = useSessionFoldersStore((state) => state.collapsedFolderIds);
  const getFoldersForScope = useSessionFoldersStore((state) => state.getFoldersForScope);
  const createFolder = useSessionFoldersStore((state) => state.createFolder);
  const renameFolder = useSessionFoldersStore((state) => state.renameFolder);
  const deleteFolder = useSessionFoldersStore((state) => state.deleteFolder);
  const addSessionToFolder = useSessionFoldersStore((state) => state.addSessionToFolder);
  const removeSessionFromFolder = useSessionFoldersStore((state) => state.removeSessionFromFolder);
  const toggleFolderCollapse = useSessionFoldersStore((state) => state.toggleFolderCollapse);
  const cleanupSessions = useSessionFoldersStore((state) => state.cleanupSessions);
  const getSessionFolderId = useSessionFoldersStore((state) => state.getSessionFolderId);

  const gitDirectories = useGitStore((state) => state.directories);

  const sessions = useSessionStore((state) => state.sessions);
  const sessionsByDirectory = useSessionStore((state) => state.sessionsByDirectory);
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const newSessionDraftOpen = useSessionStore((state) => Boolean(state.newSessionDraft?.open));
  const setCurrentSession = useSessionStore((state) => state.setCurrentSession);
  const updateSessionTitle = useSessionStore((state) => state.updateSessionTitle);
  const shareSession = useSessionStore((state) => state.shareSession);
  const unshareSession = useSessionStore((state) => state.unshareSession);
  const sessionMemoryState = useSessionStore((state) => state.sessionMemoryState);
  const sessionStatus = useSessionStore((state) => state.sessionStatus);
  const sessionAttentionStates = useSessionStore((state) => state.sessionAttentionStates);
  const permissions = useSessionStore((state) => state.permissions);
  const worktreeMetadata = useSessionStore((state) => state.worktreeMetadata);
  const availableWorktreesByProject = useSessionStore((state) => state.availableWorktreesByProject);
  const getSessionsByDirectory = useSessionStore((state) => state.getSessionsByDirectory);
  const openNewSessionDraft = useSessionStore((state) => state.openNewSessionDraft);

  const tauriIpcAvailable = React.useMemo(() => isTauriShell(), []);
  const isDesktopShellRuntime = React.useMemo(() => isDesktopShell(), []);

  const isVSCode = React.useMemo(() => isVSCodeRuntime(), []);

  const flushCollapsedProjectsPersist = React.useCallback(() => {
    if (isVSCode) {
      return;
    }
    const collapsed = pendingCollapsedProjects.current;
    pendingCollapsedProjects.current = null;
    persistCollapsedProjectsTimer.current = null;
    if (!collapsed) {
      return;
    }

    const { projects } = useProjectsStore.getState();
    const updatedProjects = projects.map((project) => ({
      ...project,
      sidebarCollapsed: collapsed.has(project.id),
    }));
    void updateDesktopSettings({ projects: updatedProjects }).catch(() => {});
  }, [isVSCode]);

  const scheduleCollapsedProjectsPersist = React.useCallback((collapsed: Set<string>) => {
    if (typeof window === 'undefined') {
      return;
    }
    if (isVSCode) {
      return;
    }

    pendingCollapsedProjects.current = collapsed;
    if (persistCollapsedProjectsTimer.current !== null) {
      window.clearTimeout(persistCollapsedProjectsTimer.current);
    }
    persistCollapsedProjectsTimer.current = window.setTimeout(() => {
      flushCollapsedProjectsPersist();
    }, 700);
  }, [flushCollapsedProjectsPersist, isVSCode]);

  React.useEffect(() => {
    return () => {
      if (typeof window !== 'undefined' && persistCollapsedProjectsTimer.current !== null) {
        window.clearTimeout(persistCollapsedProjectsTimer.current);
      }
      persistCollapsedProjectsTimer.current = null;
      pendingCollapsedProjects.current = null;
    };
  }, []);

  React.useEffect(() => {
    try {
      const storedParents = safeStorage.getItem(SESSION_EXPANDED_STORAGE_KEY);
      if (storedParents) {
        const parsed = JSON.parse(storedParents);
        if (Array.isArray(parsed)) {
          setExpandedParents(new Set(parsed.filter((item) => typeof item === 'string')));
        }
      }
      const storedProjects = safeStorage.getItem(PROJECT_COLLAPSE_STORAGE_KEY);
      if (storedProjects) {
        const parsed = JSON.parse(storedProjects);
        if (Array.isArray(parsed)) {
          setCollapsedProjects(new Set(parsed.filter((item) => typeof item === 'string')));
        }
      }
    } catch { /* ignored */ }
  }, [safeStorage]);

  React.useEffect(() => {
    const existingSessionIds = new Set(sessions.map((session) => session.id));
    setPinnedSessionIds((prev) => {
      let changed = false;
      const next = new Set<string>();
      prev.forEach((id) => {
        if (existingSessionIds.has(id)) {
          next.add(id);
        } else {
          changed = true;
        }
      });
      return changed ? next : prev;
    });
  }, [sessions]);

  React.useEffect(() => {
    try {
      safeStorage.setItem(SESSION_PINNED_STORAGE_KEY, JSON.stringify(Array.from(pinnedSessionIds)));
    } catch {
      // ignored
    }
  }, [pinnedSessionIds, safeStorage]);

  const togglePinnedSession = React.useCallback((sessionId: string) => {
    setPinnedSessionIds((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        next.add(sessionId);
      }
      return next;
    });
  }, []);

  const sortedSessions = React.useMemo(() => {
    return [...sessions].sort((a, b) => compareSessionsByPinnedAndTime(a, b, pinnedSessionIds, sessionAttentionStates));
  }, [sessions, pinnedSessionIds, sessionAttentionStates]);

  React.useEffect(() => {
    let cancelled = false;
    const normalizedProjects = projects
      .map((project) => ({ id: project.id, path: normalizePath(project.path) }))
      .filter((project): project is { id: string; path: string } => Boolean(project.path));

    setProjectRepoStatus(new Map());

    if (normalizedProjects.length === 0) {
      return () => {
        cancelled = true;
      };
    }

    normalizedProjects.forEach((project) => {
      checkIsGitRepository(project.path)
        .then((result) => {
          if (!cancelled) {
            setProjectRepoStatus((prev) => {
              const next = new Map(prev);
              next.set(project.id, result);
              return next;
            });
          }
        })
        .catch(() => {
          if (!cancelled) {
            setProjectRepoStatus((prev) => {
              const next = new Map(prev);
              next.set(project.id, null);
              return next;
            });
          }
        });
    });

    return () => {
      cancelled = true;
    };
  }, [projects]);

  const childrenMap = React.useMemo(() => {
    const map = new Map<string, Session[]>();
    sortedSessions.forEach((session) => {
      const parentID = (session as Session & { parentID?: string | null }).parentID;
      if (!parentID) {
        return;
      }
      const collection = map.get(parentID) ?? [];
      collection.push(session);
      map.set(parentID, collection);
    });
    map.forEach((list) => list.sort((a, b) => compareSessionsByPinnedAndTime(a, b, pinnedSessionIds, sessionAttentionStates)));
    return map;
  }, [sortedSessions, pinnedSessionIds, sessionAttentionStates]);

  React.useEffect(() => {
    const directories = new Set<string>();
    sortedSessions.forEach((session) => {
      const dir = normalizePath((session as Session & { directory?: string | null }).directory ?? null);
      if (dir) {
        directories.add(dir);
      }
    });
    projects.forEach((project) => {
      const normalized = normalizePath(project.path);
      if (normalized) {
        directories.add(normalized);
      }
    });

    directories.forEach((directory) => {
      const known = directoryStatus.get(directory);
      if ((known && known !== 'unknown') || checkingDirectories.current.has(directory)) {
        return;
      }
      checkingDirectories.current.add(directory);
      opencodeClient
        .listLocalDirectory(directory)
        .then(() => {
          setDirectoryStatus((prev) => {
            const next = new Map(prev);
            if (next.get(directory) === 'exists') {
              return prev;
            }
            next.set(directory, 'exists');
            return next;
          });
        })
        .catch(async () => {
          // SDK worktrees can be outside UI runtime FS permissions.
          // Probe via OpenCode API instead of local FS.
          const looksLikeSdkWorktree =
            directory.includes('/opencode/worktree/') ||
            directory.includes('/.opencode/data/worktree/') ||
            directory.includes('/.local/share/opencode/worktree/');

          if (looksLikeSdkWorktree) {
            const ok = await opencodeClient.probeDirectory(directory).catch(() => false);
            if (ok) {
              setDirectoryStatus((prev) => {
                const next = new Map(prev);
                if (next.get(directory) === 'exists') {
                  return prev;
                }
                next.set(directory, 'exists');
                return next;
              });
              return;
            }
          }

          setDirectoryStatus((prev) => {
            const next = new Map(prev);
            if (next.get(directory) === 'missing') {
              return prev;
            }
            next.set(directory, 'missing');
            return next;
          });
        })
        .finally(() => {
          checkingDirectories.current.delete(directory);
        });
    });
  }, [sortedSessions, projects, directoryStatus]);

  React.useEffect(() => {
    return () => {
      if (copyTimeout.current) {
        clearTimeout(copyTimeout.current);
      }
    };
  }, []);


  const emptyState = (
    <div className="py-6 text-center text-muted-foreground">
      <p className="typography-ui-label font-semibold">No sessions yet</p>
      <p className="typography-meta mt-1">Create your first session to start coding.</p>
    </div>
  );

  const handleSessionSelect = React.useCallback(
    (sessionId: string, sessionDirectory?: string | null, disabled?: boolean, projectId?: string | null) => {
      if (disabled) {
        return;
      }

      if (projectId && projectId !== activeProjectId) {
        // Important: avoid switching to the project root first (that can select the wrong session).
        setActiveProjectIdOnly(projectId);
      }

      if (sessionDirectory && sessionDirectory !== currentDirectory) {
        setDirectory(sessionDirectory, { showOverlay: false });
      }

      if (mobileVariant) {
        setActiveMainTab('chat');
        setSessionSwitcherOpen(false);
      }

      // Always return early if same session is selected to avoid unnecessary store operations
      if (sessionId === currentSessionId) {
        if (!allowReselect) {
          onSessionSelected?.(sessionId);
        }
        return;
      }
      setCurrentSession(sessionId);
      onSessionSelected?.(sessionId);
    },
    [
      activeProjectId,
      allowReselect,
      currentDirectory,
      currentSessionId,
      mobileVariant,
      onSessionSelected,
      setActiveMainTab,
      setActiveProjectIdOnly,
      setCurrentSession,
      setDirectory,
      setSessionSwitcherOpen,
    ],
  );

  const handleSessionDoubleClick = React.useCallback(() => {
    // On double-click/tap, switch to the Chat tab
    setActiveMainTab('chat');
  }, [setActiveMainTab]);

  const handleSaveEdit = React.useCallback(async () => {
    if (editingId && editTitle.trim()) {
      await updateSessionTitle(editingId, editTitle.trim());
      setEditingId(null);
      setEditTitle('');
    }
  }, [editingId, editTitle, updateSessionTitle]);

  const handleCancelEdit = React.useCallback(() => {
    setEditingId(null);
    setEditTitle('');
  }, []);

  const handleSaveProjectEdit = React.useCallback(() => {
    if (editingProjectId && editProjectTitle.trim()) {
      renameProject(editingProjectId, editProjectTitle.trim());
      setEditingProjectId(null);
      setEditProjectTitle('');
    }
  }, [editingProjectId, editProjectTitle, renameProject]);

  const handleCancelProjectEdit = React.useCallback(() => {
    setEditingProjectId(null);
    setEditProjectTitle('');
  }, []);

  const handleShareSession = React.useCallback(
    async (session: Session) => {
      const result = await shareSession(session.id);
      if (result && result.share?.url) {
        toast.success('Session shared', {
          description: 'You can copy the link from the menu.',
        });
      } else {
        toast.error('Unable to share session');
      }
    },
    [shareSession],
  );

  const handleCopyShareUrl = React.useCallback((url: string, sessionId: string) => {
    void copyTextToClipboard(url)
      .then((result) => {
        if (!result.ok) {
          toast.error('Failed to copy URL');
          return;
        }
        setCopiedSessionId(sessionId);
        if (copyTimeout.current) {
          clearTimeout(copyTimeout.current);
        }
        copyTimeout.current = window.setTimeout(() => {
          setCopiedSessionId(null);
          copyTimeout.current = null;
        }, 2000);
      })
      .catch(() => {
        toast.error('Failed to copy URL');
      });
  }, []);

  const handleUnshareSession = React.useCallback(
    async (sessionId: string) => {
      const result = await unshareSession(sessionId);
      if (result) {
        toast.success('Session unshared');
      } else {
        toast.error('Unable to unshare session');
      }
    },
    [unshareSession],
  );

  const collectDescendants = React.useCallback(
    (sessionId: string): Session[] => {
      const collected: Session[] = [];
      const visit = (id: string) => {
        const children = childrenMap.get(id) ?? [];
        children.forEach((child) => {
          collected.push(child);
          visit(child.id);
        });
      };
      visit(sessionId);
      return collected;
    },
    [childrenMap],
  );

  const deleteSession = useSessionStore((state) => state.deleteSession);
  const deleteSessions = useSessionStore((state) => state.deleteSessions);

  const handleDeleteSession = React.useCallback(
    (session: Session) => {
      const descendants = collectDescendants(session.id);
      setDeleteSessionConfirm({ session, descendantCount: descendants.length });
    },
    [collectDescendants],
  );

  const confirmDeleteSession = React.useCallback(async () => {
    if (!deleteSessionConfirm) return;
    const { session } = deleteSessionConfirm;
    setDeleteSessionConfirm(null);
    const descendants = collectDescendants(session.id);
    if (descendants.length === 0) {
      const success = await deleteSession(session.id);
      if (success) {
        toast.success('Session deleted');
      } else {
        toast.error('Failed to delete session');
      }
    } else {
      const ids = [session.id, ...descendants.map((s) => s.id)];
      const { deletedIds, failedIds } = await deleteSessions(ids);
      if (deletedIds.length > 0) {
        toast.success(`Deleted ${deletedIds.length} session${deletedIds.length === 1 ? '' : 's'}`);
      }
      if (failedIds.length > 0) {
        toast.error(`Failed to delete ${failedIds.length} session${failedIds.length === 1 ? '' : 's'}`);
      }
    }
  }, [deleteSessionConfirm, collectDescendants, deleteSession, deleteSessions]);

  const confirmDeleteFolder = React.useCallback(() => {
    if (!deleteFolderConfirm) return;
    const { scopeKey, folderId } = deleteFolderConfirm;
    setDeleteFolderConfirm(null);
    deleteFolder(scopeKey, folderId);
  }, [deleteFolderConfirm, deleteFolder]);

  const handleOpenDirectoryDialog = React.useCallback(() => {
    if (!tauriIpcAvailable || !isDesktopLocalOriginActive()) {
      sessionEvents.requestDirectoryDialog();
      return;
    }

    import('@/lib/desktop')
      .then(({ requestDirectoryAccess }) => requestDirectoryAccess(''))
      .then((result) => {
        if (result.success && result.path) {
          const added = addProject(result.path, { id: result.projectId });
          if (!added) {
            toast.error('Failed to add project', {
              description: 'Please select a valid directory.',
            });
          }
        } else if (result.error && result.error !== 'Directory selection cancelled') {
          toast.error('Failed to select directory', {
            description: result.error,
          });
        }
      })
      .catch((error) => {
        console.error('Desktop: Error selecting directory:', error);
        toast.error('Failed to select directory');
      });
  }, [addProject, tauriIpcAvailable]);

  const toggleParent = React.useCallback((sessionId: string) => {
    setExpandedParents((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        next.add(sessionId);
      }
      try {
        safeStorage.setItem(SESSION_EXPANDED_STORAGE_KEY, JSON.stringify(Array.from(next)));
      } catch { /* ignored */ }
      return next;
    });
  }, [safeStorage]);

  const buildNode = React.useCallback(
    (session: Session): SessionNode => {
      const children = childrenMap.get(session.id) ?? [];
      return {
        session,
        children: children.map((child) => buildNode(child)),
        worktree: worktreeMetadata.get(session.id) ?? null,
      };
    },
    [childrenMap, worktreeMetadata],
  );


  const buildGroupedSessions = React.useCallback(
    (
      projectSessions: Session[],
      projectRoot: string | null,
      availableWorktrees: WorktreeMetadata[],
      projectRootBranch: string | null,
      projectIsRepo: boolean,
    ) => {
      const normalizedProjectRoot = normalizePath(projectRoot ?? null);
      const sortedProjectSessions = [...projectSessions].sort((a, b) => compareSessionsByPinnedAndTime(a, b, pinnedSessionIds, sessionAttentionStates));

      const sessionMap = new Map(sortedProjectSessions.map((session) => [session.id, session]));
      const childrenMap = new Map<string, Session[]>();
      sortedProjectSessions.forEach((session) => {
        const parentID = (session as Session & { parentID?: string | null }).parentID;
        if (!parentID) {
          return;
        }
        const collection = childrenMap.get(parentID) ?? [];
        collection.push(session);
        childrenMap.set(parentID, collection);
      });
      childrenMap.forEach((list) => list.sort((a, b) => compareSessionsByPinnedAndTime(a, b, pinnedSessionIds, sessionAttentionStates)));

      // Build worktree lookup map
      const worktreeByPath = new Map<string, WorktreeMetadata>();
      availableWorktrees.forEach((meta) => {
        if (meta.path) {
          const normalized = normalizePath(meta.path) ?? meta.path;
          worktreeByPath.set(normalized, meta);
        }
      });

      // Helper to get worktree metadata for a session
      const getSessionWorktree = (session: Session): WorktreeMetadata | null => {
        const sessionDirectory = normalizePath((session as Session & { directory?: string | null }).directory ?? null);
        const sessionWorktreeMeta = worktreeMetadata.get(session.id) ?? null;
        if (sessionWorktreeMeta) return sessionWorktreeMeta;
        if (sessionDirectory) {
          const worktree = worktreeByPath.get(sessionDirectory) ?? null;
          // Only count as worktree if it's not the main project root
          if (worktree && sessionDirectory !== normalizedProjectRoot) {
            return worktree;
          }
        }
        return null;
      };

      const buildProjectNode = (session: Session): SessionNode => {
        const children = childrenMap.get(session.id) ?? [];
        return {
          session,
          children: children.map((child) => buildProjectNode(child)),
          worktree: getSessionWorktree(session),
        };
      };

      // Find root sessions (no parent or parent not in current project)
      const roots = sortedProjectSessions.filter((session) => {
        const parentID = (session as Session & { parentID?: string | null }).parentID;
        if (!parentID) {
          return true;
        }
        return !sessionMap.has(parentID);
      });

      const groupedNodes = new Map<string, SessionNode[]>();
      const groupOrder = new Map<string, number>();

      const getGroupKey = (session: Session) => {
        const metadataPath = normalizePath(worktreeMetadata.get(session.id)?.path ?? null);
        const sessionDirectory = normalizePath((session as Session & { directory?: string | null }).directory ?? null);
        const normalizedDir = metadataPath ?? sessionDirectory;
        if (normalizedDir && normalizedDir !== normalizedProjectRoot && worktreeByPath.has(normalizedDir)) {
          return normalizedDir;
        }
        return normalizedProjectRoot ?? '__project_root__';
      };

      roots.forEach((session, index) => {
        const node = buildProjectNode(session);
        const groupKey = getGroupKey(session);
        if (!groupedNodes.has(groupKey)) {
          groupedNodes.set(groupKey, []);
          groupOrder.set(groupKey, index);
        }
        groupedNodes.get(groupKey)?.push(node);
      });

      const rootKey = normalizedProjectRoot ?? '__project_root__';
      const groups: SessionGroup[] = [{
        id: 'root',
        label: (projectIsRepo && projectRootBranch && projectRootBranch !== 'HEAD')
          ? `project root: ${projectRootBranch}`
          : 'project root',
        branch: projectRootBranch ?? null,
        description: normalizedProjectRoot ? formatPathForDisplay(normalizedProjectRoot, homeDirectory) : null,
        isMain: true,
        worktree: null,
        directory: normalizedProjectRoot,
        sessions: groupedNodes.get(rootKey) ?? [],
      }];

      const sortedWorktrees = [...availableWorktrees].sort((a, b) => {
        const aLabel = (a.label || a.branch || a.name || a.path || '').toLowerCase();
        const bLabel = (b.label || b.branch || b.name || b.path || '').toLowerCase();
        return aLabel.localeCompare(bLabel);
      });

      sortedWorktrees.forEach((meta) => {
        const directory = normalizePath(meta.path) ?? meta.path;
        const currentBranch = gitDirectories.get(directory)?.status?.current?.trim() || null;
        const metadataBranch = meta.branch?.trim() || null;
        const shouldSyncLabelWithBranch = Boolean(
          currentBranch
          && metadataBranch
          && meta.label
          && normalizeForBranchComparison(meta.label) === normalizeForBranchComparison(metadataBranch),
        );
        const label = shouldSyncLabelWithBranch
          ? currentBranch!
          : (meta.label || meta.name || formatDirectoryName(directory, homeDirectory) || directory);
        groups.push({
          id: `worktree:${directory}`,
          label,
          branch: currentBranch || metadataBranch,
          description: formatPathForDisplay(directory, homeDirectory),
          isMain: false,
          worktree: meta,
          directory,
          sessions: groupedNodes.get(directory) ?? [],
        });
      });

      const represented = new Set(groups.map((group) => group.directory).filter((value): value is string => Boolean(value)));
      const orphanKeys = Array.from(groupedNodes.keys())
        .filter((key) => !represented.has(key) && key !== rootKey)
        .sort((a, b) => (groupOrder.get(a) ?? 0) - (groupOrder.get(b) ?? 0));

      orphanKeys.forEach((directory) => {
        const currentBranch = gitDirectories.get(directory)?.status?.current?.trim() || null;
        groups.push({
          id: `worktree:orphan:${directory}`,
          label: formatDirectoryName(directory, homeDirectory) || directory,
          branch: currentBranch,
          description: formatPathForDisplay(directory, homeDirectory),
          isMain: false,
          worktree: null,
          directory,
          sessions: groupedNodes.get(directory) ?? [],
        });
      });

      return groups;
    },
    [homeDirectory, worktreeMetadata, pinnedSessionIds, gitDirectories, sessionAttentionStates]
  );

  const toggleGroupSessionLimit = React.useCallback((groupId: string) => {
    setExpandedSessionGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  }, []);

  const toggleProject = React.useCallback((projectId: string) => {
    // Ignore intersection events for a short period after toggling
    ignoreIntersectionUntil.current = Date.now() + 150;
    setCollapsedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) {
        next.delete(projectId);
      } else {
        next.add(projectId);
      }
      try {
        safeStorage.setItem(PROJECT_COLLAPSE_STORAGE_KEY, JSON.stringify(Array.from(next)));
      } catch { /* ignored */ }

      // Persist collapse state to server settings (web + desktop local/remote).
      if (!isVSCode) {
        scheduleCollapsedProjectsPersist(next);
      }
      return next;
    });
  }, [isVSCode, safeStorage, scheduleCollapsedProjectsPersist]);

  React.useEffect(() => {
    try {
      const serialized = Object.fromEntries(groupOrderByProject.entries());
      safeStorage.setItem(GROUP_ORDER_STORAGE_KEY, JSON.stringify(serialized));
    } catch {
      // ignored
    }
  }, [groupOrderByProject, safeStorage]);

  React.useEffect(() => {
    try {
      const serialized = Object.fromEntries(activeSessionByProject.entries());
      safeStorage.setItem(PROJECT_ACTIVE_SESSION_STORAGE_KEY, JSON.stringify(serialized));
    } catch {
      // ignored
    }
  }, [activeSessionByProject, safeStorage]);

  React.useEffect(() => {
    try {
      safeStorage.setItem(GROUP_COLLAPSE_STORAGE_KEY, JSON.stringify(Array.from(collapsedGroups)));
    } catch {
      // ignored
    }
  }, [collapsedGroups, safeStorage]);

  const normalizedProjects = React.useMemo(() => {
    return projects
      .map((project) => ({
        ...project,
        normalizedPath: normalizePath(project.path),
      }))
      .filter((project) => Boolean(project.normalizedPath)) as Array<{
        id: string;
        path: string;
        label?: string;
        normalizedPath: string;
      }>;
  }, [projects]);

  // Compute a dependency that changes when any project's git branch changes
  const projectGitBranchesKey = React.useMemo(() => {
    return normalizedProjects
      .map((project) => {
        const dirState = gitDirectories.get(project.normalizedPath);
        return `${project.id}:${dirState?.status?.current ?? ''}`;
      })
      .join('|');
  }, [normalizedProjects, gitDirectories]);

  React.useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const entries = await Promise.all(
        normalizedProjects.map(async (project) => {
          const branch = await getRootBranch(project.normalizedPath).catch(() => null);
          return { id: project.id, branch };
        }),
      );
      if (cancelled) {
        return;
      }
      setProjectRootBranches((prev) => {
        const next = new Map(prev);
        entries.forEach(({ id, branch }) => {
          if (branch) {
            next.set(id, branch);
          }
        });
        return next;
      });
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [normalizedProjects, projectGitBranchesKey]);

  // Session Folders: cleanup stale session IDs when sessions are removed.
  // Guard: skip cleanup while sessions are still loading to avoid wiping folder
  // assignments before the server has returned its full session list.
  const isSessionsLoading = useSessionStore((state) => state.isLoading);
  React.useEffect(() => {
    if (isSessionsLoading) return;
    const idsByScope = new Map<string, Set<string>>();
    sessions.forEach((session) => {
      const directory = normalizePath((session as Session & { directory?: string | null }).directory ?? null);
      if (!directory) return;
      const existing = idsByScope.get(directory);
      if (existing) {
        existing.add(session.id);
        return;
      }
      idsByScope.set(directory, new Set([session.id]));
    });

    const currentFoldersMap = useSessionFoldersStore.getState().foldersMap;
    const allScopeKeys = new Set([...Object.keys(currentFoldersMap), ...idsByScope.keys()]);
    allScopeKeys.forEach((scopeKey) => {
      cleanupSessions(scopeKey, idsByScope.get(scopeKey) ?? new Set<string>());
    });
  }, [sessions, isSessionsLoading, cleanupSessions]); // removed foldersMap from deps to prevent cascade re-renders

  const getSessionsForProject = React.useCallback(
    (project: { normalizedPath: string }) => {
      // In VS Code, only show sessions from the main project directory (skip worktrees)
      const worktreesForProject = isVSCode ? [] : (availableWorktreesByProject.get(project.normalizedPath) ?? []);
      const directories = [
        project.normalizedPath,
        ...worktreesForProject
          .map((meta) => normalizePath(meta.path) ?? meta.path)
          .filter((value): value is string => Boolean(value)),
      ];

      const seen = new Set<string>();
      const collected: Session[] = [];

      directories.forEach((directory) => {
        const sessionsForDirectory = sessionsByDirectory.get(directory) ?? getSessionsByDirectory(directory);
        sessionsForDirectory.forEach((session) => {
          if (seen.has(session.id)) {
            return;
          }
          seen.add(session.id);
          collected.push(session);
        });
      });

      return collected;
    },
    [availableWorktreesByProject, getSessionsByDirectory, sessionsByDirectory, isVSCode],
  );

  // Keep last-known repo status to avoid UI jiggling during project switch
  const lastRepoStatusRef = React.useRef(false);
  if (activeProjectId && projectRepoStatus.has(activeProjectId)) {
    lastRepoStatusRef.current = Boolean(projectRepoStatus.get(activeProjectId));
  }

  const projectSections = React.useMemo(() => {
    return normalizedProjects.map((project) => {
      const projectSessions = getSessionsForProject(project);
      const worktreesForProject = availableWorktreesByProject.get(project.normalizedPath) ?? [];
      const isRepo = projectRepoStatus.has(project.id)
        ? Boolean(projectRepoStatus.get(project.id))
        : lastRepoStatusRef.current;
      const groups = buildGroupedSessions(
        projectSessions,
        project.normalizedPath,
        worktreesForProject,
        projectRootBranches.get(project.id) ?? null,
        isRepo,
      );
      return {
        project,
        groups,
      };
    });
  }, [normalizedProjects, getSessionsForProject, buildGroupedSessions, availableWorktreesByProject, projectRootBranches, projectRepoStatus]);

  const visibleProjectSections = React.useMemo(() => {
    if (projectSections.length === 0) {
      return projectSections;
    }
    const active = projectSections.find((section) => section.project.id === activeProjectId);
    return active ? [active] : [projectSections[0]];
  }, [projectSections, activeProjectId]);

  const activeProjectForHeader = React.useMemo(
    () => normalizedProjects.find((project) => project.id === activeProjectId) ?? normalizedProjects[0] ?? null,
    [normalizedProjects, activeProjectId],
  );
  const activeProjectRefForHeader = React.useMemo(
    () => (activeProjectForHeader
      ? {
        id: activeProjectForHeader.id,
        path: activeProjectForHeader.normalizedPath,
      }
      : null),
    [activeProjectForHeader],
  );
  const branchPickerProject = React.useMemo(() => {
    if (!activeProjectForHeader) {
      return null;
    }
    return {
      id: activeProjectForHeader.id,
      path: activeProjectForHeader.path,
      normalizedPath: activeProjectForHeader.normalizedPath,
      label: activeProjectForHeader.label,
    };
  }, [activeProjectForHeader]);

  const activeProjectIsRepo = React.useMemo(
    () => (activeProjectForHeader ? Boolean(projectRepoStatus.get(activeProjectForHeader.id)) : false),
    [activeProjectForHeader, projectRepoStatus],
  );
  // Only flip to false once the new project's status is actually resolved (present in map)
  const stableActiveProjectIsRepo = activeProjectForHeader && projectRepoStatus.has(activeProjectForHeader.id)
    ? activeProjectIsRepo
    : lastRepoStatusRef.current;
  const reserveHeaderActionsSpace = Boolean(activeProjectForHeader);
  const useMobileNotesPanel = mobileVariant || deviceInfo.isMobile;

  React.useEffect(() => {
    if (!activeProjectForHeader) {
      setProjectNotesPanelOpen(false);
    }
  }, [activeProjectForHeader]);

  const projectSessionMeta = React.useMemo(() => {
    const metaByProject = new Map<string, Map<string, { directory: string | null }>>();
    const firstSessionByProject = new Map<string, { id: string; directory: string | null }>();

    const visitNodes = (
      projectId: string,
      projectRoot: string,
      fallbackDirectory: string | null,
      nodes: SessionNode[],
    ) => {
      if (!metaByProject.has(projectId)) {
        metaByProject.set(projectId, new Map());
      }
      const projectMap = metaByProject.get(projectId)!;
      nodes.forEach((node) => {
        const sessionDirectory = normalizePath(
          node.worktree?.path
          ?? (node.session as Session & { directory?: string | null }).directory
          ?? fallbackDirectory
          ?? projectRoot,
        );
        projectMap.set(node.session.id, { directory: sessionDirectory });
        if (!firstSessionByProject.has(projectId)) {
          firstSessionByProject.set(projectId, { id: node.session.id, directory: sessionDirectory });
        }
        if (node.children.length > 0) {
          visitNodes(projectId, projectRoot, sessionDirectory, node.children);
        }
      });
    };

    projectSections.forEach((section) => {
      section.groups.forEach((group) => {
        visitNodes(section.project.id, section.project.normalizedPath, group.directory, group.sessions);
      });
    });

    return { metaByProject, firstSessionByProject };
  }, [projectSections]);

  const previousActiveProjectRef = React.useRef<string | null>(null);
  const lastSeenActiveProjectRef = React.useRef<string | null>(null);
  React.useLayoutEffect(() => {
    if (!activeProjectId) {
      return;
    }

    const previousSeenProjectId = lastSeenActiveProjectRef.current;
    const isProjectSwitch = Boolean(previousSeenProjectId && previousSeenProjectId !== activeProjectId);
    // Always record the active project so we can detect real project switches even if we early-return.
    lastSeenActiveProjectRef.current = activeProjectId;

    // While a new session draft is open, keep the sidebar from auto-selecting remembered/fallback sessions.
    // Exception (web/desktop only): when the user switches projects, prefer the last selected session
    // for the target project instead of carrying the draft across.
    // In VS Code, keep existing behavior (sidebar frequently mounts/unmounts and draft should stay put).
    if (newSessionDraftOpen && (isVSCode || !isProjectSwitch)) {
      return;
    }

    if (previousActiveProjectRef.current === activeProjectId) {
      return;
    }
    const section = projectSections.find((item) => item.project.id === activeProjectId);
    if (!section) {
      return;
    }
    previousActiveProjectRef.current = activeProjectId;
    const projectMap = projectSessionMeta.metaByProject.get(activeProjectId);

    // If we already have an active session that belongs to this project (eg user just selected it,
    // or sidebar remounted after "back"), do NOT override it with remembered/fallback session.
    if (currentSessionId && projectMap && projectMap.has(currentSessionId)) {
      setActiveSessionByProject((prev) => {
        if (prev.get(activeProjectId) === currentSessionId) {
          return prev;
        }
        const next = new Map(prev);
        next.set(activeProjectId, currentSessionId);
        return next;
      });
      return;
    }

    if (!projectMap || projectMap.size === 0) {
      setActiveMainTab('chat');
      if (mobileVariant) {
        setSessionSwitcherOpen(false);
      }
      openNewSessionDraft({ directoryOverride: section.project.normalizedPath });
      return;
    }

    const rememberedSessionId = activeSessionByProject.get(activeProjectId);
    const remembered = rememberedSessionId && projectMap.has(rememberedSessionId)
      ? rememberedSessionId
      : null;
    const fallback = projectSessionMeta.firstSessionByProject.get(activeProjectId)?.id ?? null;
    const targetSessionId = remembered ?? fallback;
    if (!targetSessionId || targetSessionId === currentSessionId) {
      return;
    }
    const targetDirectory = projectMap.get(targetSessionId)?.directory ?? null;
    handleSessionSelect(targetSessionId, targetDirectory, false, activeProjectId);
  }, [
    activeProjectId,
    activeSessionByProject,
    currentSessionId,
    handleSessionSelect,
    isVSCode,
    newSessionDraftOpen,
    mobileVariant,
    openNewSessionDraft,
    projectSections,
    projectSessionMeta,
    setActiveMainTab,
    setSessionSwitcherOpen,
  ]);

  React.useEffect(() => {
    if (!activeProjectId || !currentSessionId) {
      return;
    }
    const projectMap = projectSessionMeta.metaByProject.get(activeProjectId);
    if (!projectMap || !projectMap.has(currentSessionId)) {
      return;
    }
    setActiveSessionByProject((prev) => {
      if (prev.get(activeProjectId) === currentSessionId) {
        return prev;
      }
      const next = new Map(prev);
      next.set(activeProjectId, currentSessionId);
      return next;
    });
  }, [activeProjectId, currentSessionId, projectSessionMeta]);

  const currentSessionDirectory = React.useMemo(() => {
    if (!currentSessionId) {
      return null;
    }
    const metadataPath = worktreeMetadata.get(currentSessionId)?.path;
    if (metadataPath) {
      return normalizePath(metadataPath) ?? metadataPath;
    }
    const activeSession = sessions.find((session) => session.id === currentSessionId);
    if (!activeSession) {
      return null;
    }
    return normalizePath((activeSession as Session & { directory?: string | null }).directory ?? null);
  }, [currentSessionId, sessions, worktreeMetadata]);

  const getOrderedGroups = React.useCallback(
    (projectId: string, groups: SessionGroup[]) => {
      const preferredOrder = groupOrderByProject.get(projectId);
      if (!preferredOrder || preferredOrder.length === 0) {
        return groups;
      }
      const groupById = new Map(groups.map((group) => [group.id, group]));
      const ordered: SessionGroup[] = [];
      preferredOrder.forEach((id) => {
        const group = groupById.get(id);
        if (group) {
          ordered.push(group);
          groupById.delete(id);
        }
      });
      groups.forEach((group) => {
        if (groupById.has(group.id)) {
          ordered.push(group);
        }
      });
      return ordered;
    },
    [groupOrderByProject],
  );

  const handleStartInlineProjectRename = React.useCallback(() => {
    if (!activeProjectForHeader) {
      return;
    }
    setProjectRenameDraft(formatProjectLabel(
      activeProjectForHeader.label?.trim()
      || formatDirectoryName(activeProjectForHeader.normalizedPath, homeDirectory)
      || activeProjectForHeader.normalizedPath,
    ));
    setIsProjectRenameInline(true);
  }, [activeProjectForHeader, homeDirectory]);

  const handleSaveInlineProjectRename = React.useCallback(() => {
    if (!activeProjectForHeader) {
      return;
    }
    const trimmed = projectRenameDraft.trim();
    if (!trimmed) {
      return;
    }
    renameProject(activeProjectForHeader.id, trimmed);
    setIsProjectRenameInline(false);
  }, [activeProjectForHeader, projectRenameDraft, renameProject]);

  const headerActionButtonClass =
    'inline-flex h-6 w-6 items-center justify-center rounded-md leading-none text-muted-foreground hover:text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50';

  // Track when project sticky headers become "stuck"
  React.useEffect(() => {
    if (!isDesktopShellRuntime) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          const projectId = (entry.target as HTMLElement).dataset.projectId;
          if (!projectId) return;
          
          setStuckProjectHeaders((prev) => {
            const next = new Set(prev);
            if (!entry.isIntersecting) {
              next.add(projectId);
            } else {
              next.delete(projectId);
            }
            return next;
          });
        });
      },
      { threshold: 0 }
    );

    projectHeaderSentinelRefs.current.forEach((el) => {
      if (el) observer.observe(el);
    });

    return () => observer.disconnect();
  }, [isDesktopShellRuntime, projectSections]);

  const renderSessionNode = React.useCallback(
    (node: SessionNode, depth = 0, groupDirectory?: string | null, projectId?: string | null): React.ReactNode => {
      const session = node.session;
      const sessionDirectory =
        normalizePath((session as Session & { directory?: string | null }).directory ?? null) ??
        normalizePath(groupDirectory ?? null);
      const directoryState = sessionDirectory ? directoryStatus.get(sessionDirectory) : null;
      const isMissingDirectory = directoryState === 'missing';
      const memoryState = sessionMemoryState.get(session.id);
      const isActive = currentSessionId === session.id;
      const sessionTitle = session.title || 'Untitled Session';
      const hasChildren = node.children.length > 0;
      const isPinnedSession = pinnedSessionIds.has(session.id);
      const isExpanded = expandedParents.has(session.id);
      const isSubtaskSession = Boolean((session as Session & { parentID?: string | null }).parentID);
      const rawNeedsAttention = sessionAttentionStates.get(session.id)?.needsAttention === true;
      // When notifyOnSubtasks is disabled, suppress attention dots for child sessions.
      const needsAttention = rawNeedsAttention && (!isSubtaskSession || notifyOnSubtasks);
      const sessionSummary = session.summary as
        | {
          additions?: number | string | null;
          deletions?: number | string | null;
          files?: number | null;
          diffs?: Array<{ additions?: number | string | null; deletions?: number | string | null }>;
        }
        | undefined;

      if (editingId === session.id) {
        return (
          <div
            key={session.id}
            className={cn(
              'group relative flex items-center rounded-md px-1.5 py-1',
              'bg-interactive-selection',
              depth > 0 && 'pl-[20px]',
            )}
          >
            <div className="flex min-w-0 flex-1 flex-col gap-0">
              <form
                className="flex w-full items-center gap-2"
                data-keyboard-avoid="true"
                onSubmit={(event) => {
                  event.preventDefault();
                  handleSaveEdit();
                }}
              >
                <input
                  value={editTitle}
                  onChange={(event) => setEditTitle(event.target.value)}
                  className="flex-1 min-w-0 bg-transparent typography-ui-label outline-none placeholder:text-muted-foreground"
                  autoFocus
                  placeholder="Rename session"
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      event.stopPropagation();
                      handleCancelEdit();
                      return;
                    }
                    if (event.key === ' ' || event.key === 'Enter') {
                      event.stopPropagation();
                    }
                  }}
                />
                <button
                  type="submit"
                  className="shrink-0 text-muted-foreground hover:text-foreground"
                >
                  <RiCheckLine className="size-4" />
                </button>
                <button
                  type="button"
                  onClick={handleCancelEdit}
                  className="shrink-0 text-muted-foreground hover:text-foreground"
                >
                  <RiCloseLine className="size-4" />
                </button>
              </form>
              <div className="flex items-center gap-2 typography-micro text-muted-foreground/60 min-w-0 overflow-hidden leading-tight">
                {hasChildren ? (
                  <span className="inline-flex items-center justify-center flex-shrink-0">
                    {isExpanded ? (
                      <RiArrowDownSLine className="h-3 w-3" />
                    ) : (
                      <RiArrowRightSLine className="h-3 w-3" />
                    )}
                  </span>
                ) : null}
                <span className="flex-shrink-0">{formatSessionDateLabel(session.time?.updated || session.time?.created || Date.now())}</span>
                {session.share ? (
                  <RiShare2Line className="h-3 w-3 text-[color:var(--status-info)] flex-shrink-0" />
                ) : null}
                {(sessionSummary?.files ?? 0) > 0 ? (
                  <span className="flex-shrink-0">
                    · {sessionSummary!.files} {sessionSummary!.files === 1 ? 'file' : 'files'} changed
                  </span>
                ) : null}
                {hasChildren ? (
                  <span className="truncate">
                    {node.children.length} {node.children.length === 1 ? 'task' : 'tasks'}
                  </span>
                ) : null}
              </div>
            </div>
          </div>
        );
      }

      const statusType = sessionStatus?.get(session.id)?.type ?? 'idle';
      const isStreaming = statusType === 'busy' || statusType === 'retry';
      const pendingPermissionCount = permissions.get(session.id)?.length ?? 0;
      const showUnreadStatus = !isStreaming && needsAttention && !isActive;
      const showStatusMarker = isStreaming || showUnreadStatus;

      const streamingIndicator = (() => {
        if (!memoryState) return null;
        if (memoryState.isZombie) {
          return <RiErrorWarningLine className="h-4 w-4 text-status-warning" />;
        }
        return null;
      })();

      return (
        <React.Fragment key={session.id}>
          <DraggableSessionRow sessionId={session.id} sessionDirectory={sessionDirectory ?? null} sessionTitle={sessionTitle}>
          <div
            className={cn(
              'group relative flex items-center rounded-md px-1.5 py-1',
              isActive ? 'bg-interactive-selection' : 'hover:bg-interactive-hover',
              isMissingDirectory ? 'opacity-75' : '',
              depth > 0 && 'pl-[20px]',
            )}
            onContextMenu={(e) => {
              e.preventDefault();
              setOpenMenuSessionId(session.id);
            }}
          >
            <div className="flex min-w-0 flex-1 items-center">
              <button
                type="button"
                disabled={isMissingDirectory}
                onClick={() => handleSessionSelect(session.id, sessionDirectory, isMissingDirectory, projectId)}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  handleSessionDoubleClick();
                }}
                className={cn(
                  'flex min-w-0 flex-1 flex-col gap-0 overflow-hidden rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 text-foreground select-none',
                )}
              >
                {}
                  <div className="flex w-full items-center gap-2 min-w-0 flex-1 overflow-hidden">
                    {showStatusMarker ? (
                    <span className="inline-flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center">
                      {isStreaming ? (
                        <GridLoader size="xs" className="text-primary" />
                      ) : (
                        <span className="grid grid-cols-3 gap-[1px] text-[var(--status-info)]" aria-label="Unread updates" title="Unread updates">
                          {Array.from({ length: 9 }, (_, i) => (
                            ATTENTION_DIAMOND_INDICES.has(i) ? (
                              <span
                                key={i}
                                className="h-[3px] w-[3px] rounded-full bg-current animate-attention-diamond-pulse"
                                style={{ animationDelay: getAttentionDiamondDelay(i) }}
                              />
                            ) : (
                              <span key={i} className="h-[3px] w-[3px]" />
                            )
                          ))}
                        </span>
                      )}
                    </span>
                  ) : null}
                  {isPinnedSession ? (
                    <RiPushpinLine className="h-3 w-3 flex-shrink-0 text-primary" aria-label="Pinned session" />
                  ) : null}
                  <div className="block min-w-0 flex-1 truncate typography-ui-label font-normal text-foreground">
                    {sessionTitle}
                  </div>

                  {pendingPermissionCount > 0 ? (
                    <span
                      className="inline-flex items-center gap-1 rounded bg-destructive/10 px-1 py-0.5 text-[0.7rem] text-destructive flex-shrink-0"
                      title="Permission required"
                      aria-label="Permission required"
                    >
                      <RiShieldLine className="h-3 w-3" />
                      <span className="leading-none">{pendingPermissionCount}</span>
                    </span>
                  ) : null}
                </div>

                {}
                <div className="flex items-center gap-2 typography-micro text-muted-foreground/60 min-w-0 overflow-hidden leading-tight">
                  {hasChildren ? (
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleParent(session.id);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          event.stopPropagation();
                          toggleParent(session.id);
                        }
                      }}
                      className="inline-flex items-center justify-center text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 flex-shrink-0 rounded-sm"
                      aria-label={isExpanded ? 'Collapse subsessions' : 'Expand subsessions'}
                    >
                      {isExpanded ? (
                        <RiArrowDownSLine className="h-3 w-3" />
                      ) : (
                        <RiArrowRightSLine className="h-3 w-3" />
                      )}
                    </span>
                  ) : null}
                  <span className="flex-shrink-0">{formatSessionDateLabel(session.time?.updated || session.time?.created || Date.now())}</span>
                  {session.share ? (
                    <RiShare2Line className="h-3 w-3 text-[color:var(--status-info)] flex-shrink-0" />
                  ) : null}
                  {(sessionSummary?.files ?? 0) > 0 ? (
                    <span className="flex-shrink-0">
                      · {sessionSummary!.files} {sessionSummary!.files === 1 ? 'file' : 'files'} changed
                    </span>
                  ) : null}
                  {hasChildren ? (
                    <span className="truncate">
                      {node.children.length} {node.children.length === 1 ? 'task' : 'tasks'}
                    </span>
                  ) : null}
                  {isMissingDirectory ? (
                    <span className="inline-flex items-center gap-0.5 text-status-warning flex-shrink-0">
                      <RiErrorWarningLine className="h-3 w-3" />
                      Missing
                    </span>
                  ) : null}
                </div>
              </button>

              <div className="flex items-center gap-1.5 self-stretch">
                {streamingIndicator}
                <DropdownMenu
                  open={openMenuSessionId === session.id}
                  onOpenChange={(open) => setOpenMenuSessionId(open ? session.id : null)}
                >
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      className={cn(
                        'inline-flex h-3.5 w-[18px] items-center justify-center rounded-md text-muted-foreground transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
                        mobileVariant ? 'opacity-70' : 'opacity-0 group-hover:opacity-100',
                      )}
                      aria-label="Session menu"
                      onClick={(event) => event.stopPropagation()}
                      onKeyDown={(event) => event.stopPropagation()}
                    >
                      <RiMore2Line className={mobileVariant ? 'h-4 w-4' : 'h-3.5 w-3.5'} />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="end"
                    className="min-w-[180px]"
                    onCloseAutoFocus={(event) => {
                      if (renamingFolderId) {
                        event.preventDefault();
                      }
                    }}
                  >
                    <DropdownMenuItem
                      onClick={() => {
                        setEditingId(session.id);
                        setEditTitle(sessionTitle);
                      }}
                      className="[&>svg]:mr-1"
                    >
                      <RiPencilAiLine className="mr-1 h-4 w-4" />
                      Rename
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => togglePinnedSession(session.id)} className="[&>svg]:mr-1">
                      {isPinnedSession ? (
                        <RiUnpinLine className="mr-1 h-4 w-4" />
                      ) : (
                        <RiPushpinLine className="mr-1 h-4 w-4" />
                      )}
                      {isPinnedSession ? 'Unpin session' : 'Pin session'}
                    </DropdownMenuItem>
                    {!session.share ? (
                      <DropdownMenuItem onClick={() => handleShareSession(session)} className="[&>svg]:mr-1">
                        <RiShare2Line className="mr-1 h-4 w-4" />
                        Share
                      </DropdownMenuItem>
                    ) : (
                      <>
                        <DropdownMenuItem
                          onClick={() => {
                            if (session.share?.url) {
                              handleCopyShareUrl(session.share.url, session.id);
                            }
                          }}
                          className="[&>svg]:mr-1"
                        >
                          {copiedSessionId === session.id ? (
                            <>
                              <RiCheckLine className="mr-1 h-4 w-4" style={{ color: 'var(--status-success)' }} />
                              Copied
                            </>
                          ) : (
                            <>
                              <RiFileCopyLine className="mr-1 h-4 w-4" />
                              Copy link
                            </>
                          )}
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => handleUnshareSession(session.id)} className="[&>svg]:mr-1">
                          <RiLinkUnlinkM className="mr-1 h-4 w-4" />
                          Unshare
                        </DropdownMenuItem>
                      </>
                    )}
                    {/* Move to folder submenu */}
                    {sessionDirectory ? (() => {
                      const scopeFolders = getFoldersForScope(sessionDirectory);
                      const currentFolderId = getSessionFolderId(sessionDirectory, session.id);
                      return (
                        <>
                          <DropdownMenuSeparator />
                          <DropdownMenuSub>
                            <DropdownMenuSubTrigger className="[&>svg]:mr-1">
                              <RiFolderLine className="h-4 w-4" />
                              Move to folder
                            </DropdownMenuSubTrigger>
                            <DropdownMenuSubContent className="min-w-[180px]">
                              {scopeFolders.length === 0 ? (
                                <DropdownMenuItem disabled className="text-muted-foreground">
                                  No folders yet
                                </DropdownMenuItem>
                              ) : (
                                scopeFolders.map((folder) => (
                                  <DropdownMenuItem
                                    key={folder.id}
                                    onClick={() => {
                                      if (currentFolderId === folder.id) {
                                        removeSessionFromFolder(sessionDirectory, session.id);
                                      } else {
                                        addSessionToFolder(sessionDirectory, folder.id, session.id);
                                      }
                                    }}
                                  >
                                    <span className="flex-1 truncate">{folder.name}</span>
                                    {currentFolderId === folder.id ? (
                                      <RiCheckLine className="ml-2 h-3.5 w-3.5 text-primary flex-shrink-0" />
                                    ) : null}
                                  </DropdownMenuItem>
                                ))
                              )}
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                 onClick={() => {
                                   const newFolder = createFolder(sessionDirectory, 'New folder');
                                   addSessionToFolder(sessionDirectory, newFolder.id, session.id);
                                 }}
                              >
                                <RiAddLine className="mr-1 h-4 w-4" />
                                New folder...
                              </DropdownMenuItem>
                              {currentFolderId ? (
                                <DropdownMenuItem
                                  onClick={() => {
                                    removeSessionFromFolder(sessionDirectory, session.id);
                                  }}
                                  className="text-destructive focus:text-destructive"
                                >
                                  <RiCloseLine className="mr-1 h-4 w-4" />
                                  Remove from folder
                                </DropdownMenuItem>
                              ) : null}
                            </DropdownMenuSubContent>
                          </DropdownMenuSub>
                        </>
                      );
                    })() : null}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="text-destructive focus:text-destructive [&>svg]:mr-1"
                      onClick={() => handleDeleteSession(session)}
                    >
                      <RiDeleteBinLine className="mr-1 h-4 w-4" />
                      Remove
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          </div>
          </DraggableSessionRow>
          {hasChildren && isExpanded
            ? node.children.map((child) =>
                renderSessionNode(child, depth + 1, sessionDirectory ?? groupDirectory, projectId),
              )
            : null}
        </React.Fragment>
      );
    },
    [
      directoryStatus,
      sessionMemoryState,
      sessionStatus,
      sessionAttentionStates,
      permissions,
      currentSessionId,
      expandedParents,
      editingId,
      editTitle,
      handleSaveEdit,
      handleCancelEdit,
      toggleParent,
      handleSessionSelect,
      handleSessionDoubleClick,
      pinnedSessionIds,
      togglePinnedSession,
      handleShareSession,
      handleCopyShareUrl,
      handleUnshareSession,
      handleDeleteSession,
      copiedSessionId,
      mobileVariant,
      openMenuSessionId,
      renamingFolderId,
      getFoldersForScope,
      getSessionFolderId,
      addSessionToFolder,
      removeSessionFromFolder,
      createFolder,
      notifyOnSubtasks,
      foldersMap, // trigger re-render when folder data changes (getFoldersForScope is a stable fn selector)
    ],
  );

  const renderGroupSessions = React.useCallback(
    (group: SessionGroup, groupKey: string, projectId?: string | null, hideGroupLabel?: boolean) => {
      const isExpanded = expandedSessionGroups.has(groupKey);
      const isCollapsed = collapsedGroups.has(groupKey);
      const maxVisible = hideDirectoryControls ? 10 : 5;

      // --- Session Folders: split into foldered vs ungrouped ---
      const folderScopeKey = normalizePath(group.directory ?? null);
      const scopeFolders = folderScopeKey ? getFoldersForScope(folderScopeKey) : [];
      const sessionIdsInFolders = new Set(scopeFolders.flatMap((f) => f.sessionIds));
      const ungroupedSessions = group.sessions.filter((node) => !sessionIdsInFolders.has(node.session.id));

      // ALL folders for this scope – including empty ones (so newly created folders show up)
      // Build enriched list: { folder, nodes } for every folder in scope
      const allFoldersForGroup = scopeFolders.map((folder) => {
        const nodes = folder.sessionIds
          .map((sid) => group.sessions.find((node) => node.session.id === sid))
          .filter((n): n is SessionNode => Boolean(n))
          .sort((a, b) => compareSessionsByPinnedAndTime(a.session, b.session, pinnedSessionIds, sessionAttentionStates));
        return { folder, nodes };
      });

      // Root-level folders (no parentId) — sub-folders are rendered inside their parent
      const rootFolders = allFoldersForGroup.filter(({ folder }) => !folder.parentId);

      const totalSessions = ungroupedSessions.length;
      const visibleSessions = isExpanded ? ungroupedSessions : ungroupedSessions.slice(0, maxVisible);
      const remainingCount = totalSessions - visibleSessions.length;
      const collectGroupSessions = (nodes: SessionNode[]): Session[] => {
        const collected: Session[] = [];
        const visit = (list: SessionNode[]) => {
          list.forEach((node) => {
            collected.push(node.session);
            if (node.children.length > 0) {
              visit(node.children);
            }
          });
        };
        visit(nodes);
        return collected;
      };
      const allGroupSessions = collectGroupSessions(group.sessions);
      const normalizedGroupDirectory = normalizePath(group.directory ?? null);
      const isGitProject = projectId && projectRepoStatus.has(projectId)
        ? Boolean(projectRepoStatus.get(projectId))
        : lastRepoStatusRef.current;
      const showBranchSubtitle = !group.isMain && isBranchDifferentFromLabel(group.branch, group.label);
      const isActiveGroup = Boolean(
        normalizedGroupDirectory
          && currentSessionDirectory
          && normalizedGroupDirectory === currentSessionDirectory,
      );

      // Helper: render a single folder item (root or sub) wrapped in DroppableFolderWrapper
      const renderOneFolderItem = (folder: (typeof allFoldersForGroup)[number]['folder'], nodes: SessionNode[], depth: number) => {
        // Find direct sub-folders of this folder
        const directSubFolders = allFoldersForGroup.filter(({ folder: f }) => f.parentId === folder.id);
        const subFolderItems = directSubFolders.length > 0 ? (
          <>{directSubFolders.map(({ folder: sf, nodes: sn }) => renderOneFolderItem(sf, sn, depth + 1))}</>
        ) : undefined;

        return (
          <DroppableFolderWrapper key={folder.id} folderId={folder.id}>
            {(droppableRef, isDropTarget) => (
              <SessionFolderItem
                folder={folder}
                sessions={nodes}
                subFolderItems={subFolderItems}
                isCollapsed={collapsedFolderIds.has(folder.id)}
                onToggle={() => toggleFolderCollapse(folder.id)}
                onRename={(name) => {
                  if (folderScopeKey) renameFolder(folderScopeKey, folder.id, name);
                }}
                 onDelete={() => {
                   if (!folderScopeKey) return;
                   // Count affected sub-folders and sessions for the confirm dialog
                   const subFolderCount = allFoldersForGroup.filter(({ folder: f }) => f.parentId === folder.id).length;
                   const sessionCount = nodes.length;
                   setDeleteFolderConfirm({
                     scopeKey: folderScopeKey,
                     folderId: folder.id,
                     folderName: folder.name,
                     subFolderCount,
                     sessionCount,
                   });
                 }}
                renderSessionNode={renderSessionNode}
                groupDirectory={group.directory}
                projectId={projectId}
                mobileVariant={mobileVariant}
                isRenaming={renamingFolderId === folder.id}
                renameDraft={renamingFolderId === folder.id ? renameFolderDraft : undefined}
                onRenameDraftChange={(value) => setRenameFolderDraft(value)}
                onRenameSave={() => {
                  const trimmed = renameFolderDraft.trim();
                  if (trimmed && folderScopeKey) {
                    renameFolder(folderScopeKey, folder.id, trimmed);
                  }
                  setRenamingFolderId(null);
                  setRenameFolderDraft('');
                }}
                onRenameCancel={() => {
                  setRenamingFolderId(null);
                  setRenameFolderDraft('');
                }}
                droppableRef={droppableRef}
                isDropTarget={isDropTarget}
                depth={depth}
                onNewSession={() => {
                  if (projectId && projectId !== activeProjectId) {
                    setActiveProject(projectId);
                  }
                  setActiveMainTab('chat');
                  if (mobileVariant) {
                    setSessionSwitcherOpen(false);
                  }
                  openNewSessionDraft({ directoryOverride: group.directory, targetFolderId: folder.id });
                }}
                 onNewSubFolder={depth === 0 ? () => {
                   if (!folderScopeKey) return;
                   createFolder(folderScopeKey, 'New folder', folder.id);
                 } : undefined}
              />
            )}
          </DroppableFolderWrapper>
        );
      };

      // VS Code sessions list uses a separate header (Agent Manager / New Session).
      // When the caller requests a flat list (hideGroupLabel), omit the per-group header entirely.
      // Shared folder rendering helper (used in both branches).
      // Uses DroppableFolderWrapper so each folder header becomes a DnD drop zone.
      const renderFolderItems = () =>
        rootFolders.map(({ folder, nodes }) => renderOneFolderItem(folder, nodes, 0));

      if (hideGroupLabel) {
        return (
          <div className="oc-group">
            <div className="oc-group-body pb-3">
              <SessionFolderDndScope
                scopeKey={folderScopeKey}
                hasFolders={allFoldersForGroup.length > 0}
                onSessionDroppedOnFolder={(sessionId, folderId) => {
                  if (folderScopeKey) addSessionToFolder(folderScopeKey, folderId, sessionId);
                }}
              >
              {renderFolderItems()}
              {visibleSessions.map((node) => renderSessionNode(node, 0, group.directory, projectId))}
              {totalSessions === 0 && scopeFolders.length === 0 ? (
                <div className="py-1 text-left typography-micro text-muted-foreground">
                  No sessions in this workspace yet.
                </div>
              ) : null}
              {remainingCount > 0 && !isExpanded ? (
                <button
                  type="button"
                  onClick={() => toggleGroupSessionLimit(groupKey)}
                  className="mt-0.5 flex items-center justify-start rounded-md px-1.5 py-0.5 text-left text-xs text-muted-foreground/70 leading-tight hover:text-foreground hover:underline"
                >
                  Show {remainingCount} more {remainingCount === 1 ? 'session' : 'sessions'}
                </button>
              ) : null}
              {isExpanded && totalSessions > maxVisible ? (
                <button
                  type="button"
                  onClick={() => toggleGroupSessionLimit(groupKey)}
                  className="mt-0.5 flex items-center justify-start rounded-md px-1.5 py-0.5 text-left text-xs text-muted-foreground/70 leading-tight hover:text-foreground hover:underline"
                >
                  Show fewer sessions
                </button>
              ) : null}
              </SessionFolderDndScope>
            </div>
          </div>
        );
      }

      return (
        <div className="oc-group">
          <div
            className={cn(
              "group/gh flex items-center justify-between gap-2 py-1 min-w-0 rounded-sm",
              !hideGroupLabel && "hover:bg-interactive-hover/50 cursor-pointer"
            )}
            onClick={!hideGroupLabel ? () => {
              setCollapsedGroups((prev) => {
                const next = new Set(prev);
                if (next.has(groupKey)) {
                  next.delete(groupKey);
                } else {
                  next.add(groupKey);
                }
                return next;
              });
            } : undefined}
            role={!hideGroupLabel ? "button" : undefined}
            tabIndex={!hideGroupLabel ? 0 : undefined}
            onKeyDown={!hideGroupLabel ? (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                setCollapsedGroups((prev) => {
                  const next = new Set(prev);
                  if (next.has(groupKey)) {
                    next.delete(groupKey);
                  } else {
                    next.add(groupKey);
                  }
                  return next;
                });
              }
            } : undefined}
            aria-label={!hideGroupLabel ? (isCollapsed ? `Expand ${group.label}` : `Collapse ${group.label}`) : undefined}
          >
            {!hideGroupLabel ? (
              <div className="min-w-0 flex items-center gap-1.5 pl-1.5">
                {!group.isMain || isGitProject ? (
                  <RiGitBranchLine className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                ) : null}
                <div className="min-w-0 flex flex-col justify-center">
                  <p className={cn('text-[15px] font-semibold truncate', isActiveGroup ? 'text-primary' : 'text-muted-foreground')}>
                    {group.label}
                  </p>
                  {showBranchSubtitle ? (
                    <span className="text-[10px] sm:text-[11px] text-muted-foreground/80 truncate leading-tight">
                      {group.branch}
                    </span>
                  ) : null}
                </div>
                {isCollapsed ? (
                  <RiArrowRightSLine className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                ) : (
                  <RiArrowDownSLine className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                )}
              </div>
            ) : <div />}
            {group.directory ? (
              <div className="flex items-center gap-1 px-0.5">
                {!group.isMain && group.worktree ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          sessionEvents.requestDelete({
                            sessions: allGroupSessions,
                            mode: 'worktree',
                            worktree: group.worktree,
                          });
                        }}
                        className={cn(
                          'inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:text-destructive hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 transition-opacity',
                          mobileVariant ? 'opacity-100' : 'opacity-0 group-hover/gh:opacity-100 group-focus-within/gh:opacity-100',
                        )}
                        aria-label={`Delete ${group.label}`}
                      >
                        <RiDeleteBinLine className="h-4 w-4" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" sideOffset={4}>
                      <p>Delete worktree</p>
                    </TooltipContent>
                  </Tooltip>
                ) : null}
                <DropdownMenu>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          onClick={(e) => e.stopPropagation()}
                          className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                          aria-label={`New session or folder in ${group.label}`}
                        >
                          <RiAddLine className="h-4 w-4" />
                        </button>
                      </DropdownMenuTrigger>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" sideOffset={4}>
                      <p>New session or folder</p>
                    </TooltipContent>
                  </Tooltip>
                  <DropdownMenuContent align="end" className="min-w-[160px]">
                    <DropdownMenuItem
                      onClick={() => {
                        if (projectId && projectId !== activeProjectId) {
                          setActiveProject(projectId);
                        }
                        setActiveMainTab('chat');
                        if (mobileVariant) {
                          setSessionSwitcherOpen(false);
                        }
                        openNewSessionDraft({ directoryOverride: group.directory });
                      }}
                    >
                      <RiAddLine className="mr-1.5 h-4 w-4" />
                      New session
                    </DropdownMenuItem>
                    {folderScopeKey ? (
                      <DropdownMenuItem
                        onClick={() => {
                           createFolder(folderScopeKey, 'New folder');
                         }}
                      >
                        <RiFolderAddLine className="mr-1.5 h-4 w-4" />
                        New folder
                      </DropdownMenuItem>
                    ) : null}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            ) : null}
          </div>
          {!isCollapsed ? (
            <div className="oc-group-body pb-3">
              <SessionFolderDndScope
                scopeKey={folderScopeKey}
                hasFolders={allFoldersForGroup.length > 0}
                onSessionDroppedOnFolder={(sessionId, folderId) => {
                  if (folderScopeKey) addSessionToFolder(folderScopeKey, folderId, sessionId);
                }}
              >
                {renderFolderItems()}
                {visibleSessions.map((node) => renderSessionNode(node, 0, group.directory, projectId))}
                {totalSessions === 0 && scopeFolders.length === 0 ? (
                  <div className="py-1 text-left typography-micro text-muted-foreground">
                    No sessions in this workspace yet.
                  </div>
                ) : null}
                {remainingCount > 0 && !isExpanded ? (
                  <button
                    type="button"
                    onClick={() => toggleGroupSessionLimit(groupKey)}
                    className="mt-0.5 flex items-center justify-start rounded-md px-1.5 py-0.5 text-left text-xs text-muted-foreground/70 leading-tight hover:text-foreground hover:underline"
                  >
                    Show {remainingCount} more {remainingCount === 1 ? 'session' : 'sessions'}
                  </button>
                ) : null}
                {isExpanded && totalSessions > maxVisible ? (
                  <button
                    type="button"
                    onClick={() => toggleGroupSessionLimit(groupKey)}
                    className="mt-0.5 flex items-center justify-start rounded-md px-1.5 py-0.5 text-left text-xs text-muted-foreground/70 leading-tight hover:text-foreground hover:underline"
                  >
                    Show fewer sessions
                  </button>
                ) : null}
              </SessionFolderDndScope>
            </div>
          ) : null}
        </div>
      );
    },
    [
      expandedSessionGroups,
      collapsedGroups,
      hideDirectoryControls,
      currentSessionDirectory,
      projectRepoStatus,
      renderSessionNode,
      toggleGroupSessionLimit,
      activeProjectId,
      setActiveProject,
      setActiveMainTab,
      mobileVariant,
      setSessionSwitcherOpen,
      openNewSessionDraft,
      getFoldersForScope,
      collapsedFolderIds,
      toggleFolderCollapse,
      createFolder,
      renameFolder,
      deleteFolder,
      addSessionToFolder,
      renamingFolderId,
      renameFolderDraft,
      pinnedSessionIds,
      sessionAttentionStates,
      foldersMap, // trigger re-render when folder data changes (getFoldersForScope is a stable fn selector)
    ]
  );

  // DnD sensors for project reordering
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  return (
    <div
      className={cn(
        'flex h-full flex-col text-foreground overflow-x-hidden',
        mobileVariant ? '' : 'bg-sidebar',
      )}
    >
      {!hideDirectoryControls && (
        <div className={cn('select-none pl-3.5 pr-2 flex-shrink-0 border-b border-border/60', hideProjectSelector ? 'py-1' : 'py-1.5')}>
          {!hideProjectSelector && (
          <div className="flex h-8 items-center justify-between gap-2">
            <DropdownMenu
              onOpenChange={(open) => {
                if (!open) {
                  setIsProjectRenameInline(false);
                }
              }}
            >
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="flex h-8 min-w-0 max-w-[calc(100%-2.5rem)] items-center gap-1 rounded-md px-2 text-left text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                >
                  <span className="text-base font-semibold truncate">
                    {activeProjectForHeader
                      ? formatProjectLabel(
                        activeProjectForHeader.label?.trim()
                        || formatDirectoryName(activeProjectForHeader.normalizedPath, homeDirectory)
                        || activeProjectForHeader.normalizedPath,
                      )
                      : 'Projects'}
                  </span>
                  <RiArrowDownSLine className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="min-w-[220px] max-w-[320px]">
                {normalizedProjects.map((project) => {
                  const label = formatProjectLabel(
                    project.label?.trim()
                    || formatDirectoryName(project.normalizedPath, homeDirectory)
                    || project.normalizedPath
                  );
                  return (
                    <DropdownMenuItem
                      key={project.id}
                      onClick={() => setActiveProject(project.id)}
                      className={cn('truncate', project.id === activeProjectId && 'text-primary')}
                    >
                      <span className="truncate">{label}</span>
                    </DropdownMenuItem>
                  );
                })}
                <div className="my-1 h-px bg-border/70" />
                {!isProjectRenameInline ? (
                  <DropdownMenuItem
                    onClick={(event) => {
                      event.preventDefault();
                      handleStartInlineProjectRename();
                    }}
                    className="gap-2"
                  >
                    <RiPencilAiLine className="h-4 w-4" />
                    Rename project
                  </DropdownMenuItem>
                ) : (
                  <div className="px-2 py-1.5">
                    <form
                      className="flex items-center gap-1"
                      onSubmit={(event) => {
                        event.preventDefault();
                        handleSaveInlineProjectRename();
                      }}
                    >
                      <input
                        value={projectRenameDraft}
                        onChange={(event) => setProjectRenameDraft(event.target.value)}
                        className="h-7 flex-1 rounded border border-border bg-transparent px-2 typography-ui-label text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                        placeholder="Rename project"
                        autoFocus
                        onKeyDown={(event) => {
                          if (event.key === 'Escape') {
                            event.stopPropagation();
                            setIsProjectRenameInline(false);
                            return;
                          }
                          if (event.key === ' ' || event.key === 'Enter') {
                            event.stopPropagation();
                          }
                        }}
                      />
                      <button type="submit" className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:text-foreground">
                        <RiCheckLine className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setIsProjectRenameInline(false)}
                        className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:text-foreground"
                      >
                        <RiCloseLine className="h-4 w-4" />
                      </button>
                    </form>
                  </div>
                )}
                <DropdownMenuItem
                  onClick={() => {
                    if (!activeProjectForHeader) {
                      return;
                    }
                    removeProject(activeProjectForHeader.id);
                  }}
                  className="text-destructive focus:text-destructive gap-2"
                >
                  <RiCloseLine className="h-4 w-4" />
                  Close project
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <button
              type="button"
              onClick={handleOpenDirectoryDialog}
              className={cn(
                'inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
                    !isDesktopShellRuntime && 'bg-sidebar/60 hover:bg-sidebar',
              )}
              aria-label="Add project"
              title="Add project"
            >
              <RiFolderAddLine className="h-4.5 w-4.5" />
            </button>
          </div>
          )}
          {reserveHeaderActionsSpace ? (
            <div className="-ml-1 flex h-8 items-center">
              {activeProjectForHeader ? (
              <div className="flex h-8 -translate-y-px items-center gap-1.5 rounded-md pl-0 pr-1">
              {stableActiveProjectIsRepo ? (
                <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={async () => {
                      if (!activeProjectForHeader) {
                        return;
                      }
                      if (activeProjectForHeader.id !== activeProjectId) {
                        setActiveProject(activeProjectForHeader.id);
                      }
                      const newWorktreePath = await createWorktreeOnly();
                      if (!newWorktreePath) {
                        return;
                      }
                      setActiveMainTab('chat');
                      if (mobileVariant) {
                        setSessionSwitcherOpen(false);
                      }
                      openNewSessionDraft({ directoryOverride: newWorktreePath });
                    }}
                    className={headerActionButtonClass}
                    aria-label="New worktree"
                  >
                    <RiNodeTree className="h-4.5 w-4.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={4}><p>New worktree</p></TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => setIssuePickerOpen(true)}
                    className={headerActionButtonClass}
                    aria-label="New from issue"
                  >
                    <RiGithubLine className="h-4.5 w-4.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={4}><p>New from issue</p></TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => setPullRequestPickerOpen(true)}
                    className={headerActionButtonClass}
                    aria-label="New from PR"
                  >
                    <RiGitPullRequestLine className="h-4.5 w-4.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={4}><p>New from PR</p></TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={openMultiRunLauncher}
                    className={headerActionButtonClass}
                    aria-label="New multi-run"
                  >
                    <ArrowsMerge className="h-4.5 w-4.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={4}><p>New multi-run</p></TooltipContent>
              </Tooltip>
                </>
              ) : null}
              {stableActiveProjectIsRepo && branchPickerProject ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => setIsBranchPickerOpen(true)}
                      className={headerActionButtonClass}
                      aria-label="Manage branches"
                    >
                      <RiGitRepositoryLine className="h-4.5 w-4.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" sideOffset={4}><p>Manage branches</p></TooltipContent>
                </Tooltip>
              ) : null}
              {useMobileNotesPanel ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => setProjectNotesPanelOpen(true)}
                      className={headerActionButtonClass}
                      aria-label="Project notes and todos"
                    >
                      <RiStickyNoteLine className="h-4.5 w-4.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" sideOffset={4}><p>Project notes</p></TooltipContent>
                </Tooltip>
              ) : (
                <DropdownMenu open={projectNotesPanelOpen} onOpenChange={setProjectNotesPanelOpen} modal={false}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          className={headerActionButtonClass}
                          aria-label="Project notes and todos"
                        >
                          <RiStickyNoteLine className="h-4.5 w-4.5" />
                        </button>
                      </DropdownMenuTrigger>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" sideOffset={4}><p>Project notes</p></TooltipContent>
                  </Tooltip>
                  <DropdownMenuContent align="start" className="w-[340px] p-0">
                    <ProjectNotesTodoPanel
                      projectRef={activeProjectRefForHeader}
                      canCreateWorktree={stableActiveProjectIsRepo}
                      onActionComplete={() => setProjectNotesPanelOpen(false)}
                    />
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
              </div>
              ) : null}
            </div>
          ) : null}
        </div>
      )}

      <ScrollableOverlay
        outerClassName="flex-1 min-h-0"
        className={cn('space-y-1 pb-1 pl-2.5 pr-1', mobileVariant ? '' : '')}
      >
        {projectSections.length === 0 ? (
          emptyState
        ) : showOnlyMainWorkspace ? (
          <div className="space-y-[0.6rem] py-1">
            {(() => {
              const activeSection = projectSections.find((section) => section.project.id === activeProjectId) ?? projectSections[0];
              if (!activeSection) {
                return emptyState;
              }
              // VS Code sessions view typically only shows one workspace, but sessions may live in worktrees or
              // canonicalized paths. Prefer the main group if it has sessions; otherwise fall back to any group
              // that contains sessions so we don't show an empty list when sessions exist.
              const group =
                activeSection.groups.find((candidate) => candidate.isMain && candidate.sessions.length > 0)
                ?? activeSection.groups.find((candidate) => candidate.sessions.length > 0)
                ?? activeSection.groups.find((candidate) => candidate.isMain)
                ?? activeSection.groups[0];
              if (!group) {
                return (
                  <div className="py-1 text-left typography-micro text-muted-foreground">
                    No sessions yet.
                  </div>
                );
              }
              const groupKey = `${activeSection.project.id}:${group.id}`;
              // In VS Code mode with showOnlyMainWorkspace, hide the group header to show a flat session list
              return renderGroupSessions(group, groupKey, activeSection.project.id, showOnlyMainWorkspace);
            })()}
          </div>
        ) : (
          <>
            {visibleProjectSections.map((section) => {
                const project = section.project;
                const projectKey = project.id;
                const projectLabel = formatProjectLabel(
                  project.label?.trim()
                    || formatDirectoryName(project.normalizedPath, homeDirectory)
                    || project.normalizedPath
                );
                const projectDescription = formatPathForDisplay(project.normalizedPath, homeDirectory);
                const isCollapsed = collapsedProjects.has(projectKey) && hideDirectoryControls;
                const isActiveProject = projectKey === activeProjectId;
                const isRepo = projectRepoStatus.get(projectKey);
                const isHovered = hoveredProjectId === projectKey;
                const orderedGroups = getOrderedGroups(projectKey, section.groups);

                return (
                  <SortableProjectItem
                    key={projectKey}
                    id={projectKey}
                    projectLabel={projectLabel}
                    projectDescription={projectDescription}
                    isCollapsed={isCollapsed}
                    isActiveProject={isActiveProject}
                    isRepo={Boolean(isRepo)}
                    isHovered={isHovered}
                    isDesktopShell={isDesktopShellRuntime}
                    isStuck={stuckProjectHeaders.has(projectKey)}
                    hideDirectoryControls={hideDirectoryControls}
                    mobileVariant={mobileVariant}
                    onToggle={() => toggleProject(projectKey)}
                    onHoverChange={(hovered) => setHoveredProjectId(hovered ? projectKey : null)}
                    onNewSession={() => {
                      if (projectKey !== activeProjectId) {
                        setActiveProject(projectKey);
                      }
                      setActiveMainTab('chat');
                      if (mobileVariant) {
                        setSessionSwitcherOpen(false);
                      }
                      openNewSessionDraft({ directoryOverride: project.normalizedPath });
                    }}
                    onNewWorktreeSession={() => {
                      if (projectKey !== activeProjectId) {
                        setActiveProject(projectKey);
                      }
                      setActiveMainTab('chat');
                      if (mobileVariant) {
                        setSessionSwitcherOpen(false);
                      }
                      createWorktreeSession();
                    }}
                    onNewSessionFromGitHubIssue={() => {
                      if (projectKey !== activeProjectId) {
                        setActiveProject(projectKey);
                      }
                      setIssuePickerOpen(true);
                    }}
                    onNewSessionFromGitHubPR={() => {
                      if (projectKey !== activeProjectId) {
                        setActiveProject(projectKey);
                      }
                      setPullRequestPickerOpen(true);
                    }}
                    onOpenMultiRunLauncher={() => {
                      if (projectKey !== activeProjectId) {
                        setActiveProject(projectKey);
                      }
                      openMultiRunLauncher();
                    }}
                    onRenameStart={() => {
                      setEditingProjectId(projectKey);
                      setEditProjectTitle(project.label?.trim() || formatDirectoryName(project.normalizedPath, homeDirectory) || project.normalizedPath);
                    }}
                    onRenameSave={handleSaveProjectEdit}
                    onRenameCancel={handleCancelProjectEdit}
                    onRenameValueChange={setEditProjectTitle}
                    renameValue={editingProjectId === projectKey ? editProjectTitle : ''}
                    isRenaming={editingProjectId === projectKey}
                    onClose={() => removeProject(projectKey)}
                    sentinelRef={(el) => { projectHeaderSentinelRefs.current.set(projectKey, el); }}
                    settingsAutoCreateWorktree={settingsAutoCreateWorktree}
                    showCreateButtons={false}
                    hideHeader
                  >
                    {!isCollapsed ? (
                      <div className="space-y-[0.6rem] py-1">
                        {section.groups.length > 0 ? (
                          <DndContext
                            sensors={sensors}
                            collisionDetection={closestCenter}
                            onDragStart={(event) => {
                              setActiveDraggedGroupId(String(event.active.id));
                              const width = (event.active.rect.current.initial?.width ?? null);
                              setActiveDraggedGroupWidth(typeof width === 'number' ? width : null);
                            }}
                            onDragCancel={() => {
                              setActiveDraggedGroupId(null);
                              setActiveDraggedGroupWidth(null);
                            }}
                            onDragEnd={(event) => {
                              const { active, over } = event;
                              setActiveDraggedGroupId(null);
                              setActiveDraggedGroupWidth(null);
                              if (!over || active.id === over.id) {
                                return;
                              }
                              const oldIndex = orderedGroups.findIndex((item) => item.id === active.id);
                              const newIndex = orderedGroups.findIndex((item) => item.id === over.id);
                              if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) {
                                return;
                              }
                              const next = arrayMove(orderedGroups, oldIndex, newIndex).map((item) => item.id);
                              setGroupOrderByProject((prev) => {
                                const map = new Map(prev);
                                map.set(projectKey, next);
                                return map;
                              });
                            }}
                          >
                            <SortableContext
                              items={orderedGroups.map((group) => group.id)}
                              strategy={verticalListSortingStrategy}
                            >
                              {orderedGroups.map((group) => {
                                const groupKey = `${projectKey}:${group.id}`;
                                return (
                                  <SortableGroupItem key={group.id} id={group.id}>
                                    {renderGroupSessions(group, groupKey, projectKey)}
                                  </SortableGroupItem>
                                );
                              })}
                            </SortableContext>
                            <DragOverlay modifiers={[centerDragOverlayUnderPointer]} dropAnimation={null}>
                              {activeDraggedGroupId ? (
                                (() => {
                                  const dragGroup = orderedGroups.find((group) => group.id === activeDraggedGroupId);
                                  if (!dragGroup) {
                                    return null;
                                  }
                                  const showBranchIcon = !dragGroup.isMain || Boolean(isRepo);
                                  return <GroupDragOverlay label={dragGroup.label} showBranchIcon={showBranchIcon} width={activeDraggedGroupWidth ?? undefined} />;
                                })()
                              ) : null}
                            </DragOverlay>
                          </DndContext>
                        ) : (
                          <div className="py-1 text-left typography-micro text-muted-foreground">
                            No sessions yet.
                          </div>
                        )}
                      </div>
                    ) : null}
                  </SortableProjectItem>
                );
              })}
          </>
        )}
      </ScrollableOverlay>

      <GitHubIssuePickerDialog
        open={issuePickerOpen}
        onOpenChange={(open) => {
          setIssuePickerOpen(open);
          if (!open && mobileVariant) {
            setActiveMainTab('chat');
            setSessionSwitcherOpen(false);
          }
        }}
      />

      <GitHubPullRequestPickerDialog
        open={pullRequestPickerOpen}
        onOpenChange={(open) => {
          setPullRequestPickerOpen(open);
          if (!open && mobileVariant) {
            setActiveMainTab('chat');
            setSessionSwitcherOpen(false);
          }
        }}
      />

      <BranchPickerDialog
        open={isBranchPickerOpen}
        onOpenChange={setIsBranchPickerOpen}
        project={branchPickerProject}
      />

      {useMobileNotesPanel ? (
        <MobileOverlayPanel
          open={projectNotesPanelOpen}
          onClose={() => setProjectNotesPanelOpen(false)}
          title="Project notes"
        >
          <ProjectNotesTodoPanel
            projectRef={activeProjectRefForHeader}
            canCreateWorktree={stableActiveProjectIsRepo}
            onActionComplete={() => setProjectNotesPanelOpen(false)}
            className="p-0"
          />
        </MobileOverlayPanel>
      ) : null}

      {/* Confirm delete session dialog */}
      <Dialog open={Boolean(deleteSessionConfirm)} onOpenChange={(open) => { if (!open) setDeleteSessionConfirm(null); }}>
        <DialogContent showCloseButton={false} className="max-w-sm gap-5">
          <DialogHeader>
            <DialogTitle>Delete session?</DialogTitle>
            <DialogDescription>
              {deleteSessionConfirm && deleteSessionConfirm.descendantCount > 0
                ? `"${deleteSessionConfirm.session.title || 'Untitled Session'}" and its ${deleteSessionConfirm.descendantCount} sub-task${deleteSessionConfirm.descendantCount === 1 ? '' : 's'} will be permanently deleted.`
                : `"${deleteSessionConfirm?.session.title || 'Untitled Session'}" will be permanently deleted.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button
              type="button"
              onClick={() => setDeleteSessionConfirm(null)}
              className="inline-flex h-8 items-center justify-center rounded-md border border-border px-3 typography-ui-label text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void confirmDeleteSession()}
              className="inline-flex h-8 items-center justify-center rounded-md bg-destructive px-3 typography-ui-label text-destructive-foreground hover:bg-destructive/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/50"
            >
              Delete
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirm delete folder dialog */}
      <Dialog open={Boolean(deleteFolderConfirm)} onOpenChange={(open) => { if (!open) setDeleteFolderConfirm(null); }}>
        <DialogContent showCloseButton={false} className="max-w-sm gap-5">
          <DialogHeader>
            <DialogTitle>Delete folder?</DialogTitle>
            <DialogDescription>
              {deleteFolderConfirm && (deleteFolderConfirm.subFolderCount > 0 || deleteFolderConfirm.sessionCount > 0)
                ? `"${deleteFolderConfirm.folderName}" will be deleted${deleteFolderConfirm.subFolderCount > 0 ? ` along with ${deleteFolderConfirm.subFolderCount} sub-folder${deleteFolderConfirm.subFolderCount === 1 ? '' : 's'}` : ''}. Sessions inside will not be deleted.`
                : `"${deleteFolderConfirm?.folderName}" will be permanently deleted.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button
              type="button"
              onClick={() => setDeleteFolderConfirm(null)}
              className="inline-flex h-8 items-center justify-center rounded-md border border-border px-3 typography-ui-label text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={confirmDeleteFolder}
              className="inline-flex h-8 items-center justify-center rounded-md bg-destructive px-3 typography-ui-label text-destructive-foreground hover:bg-destructive/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/50"
            >
              Delete
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
