import React from 'react';
import { createPortal } from 'react-dom';
import {
  RiAddLine,
  RiArchiveLine,
  RiArrowDownSLine,
  RiArrowUpSLine,
  RiCheckLine,
  RiCloseLine,
  RiDeleteBinLine,
  RiDragMove2Line,
  RiEdit2Line,
  RiFolder6Line,
  RiFolderAddLine,
  RiSearchLine,
} from '@remixicon/react';
import type { Session } from '@opencode-ai/sdk/v2/client';
import {
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

import { DirectoryExplorerDialog } from '@/components/session/DirectoryExplorerDialog';
import { Icon } from '@/components/icon/Icon';
import { NewWorktreeDialog } from '@/components/session/NewWorktreeDialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollShadow } from '@/components/ui/ScrollShadow';
import { toast } from '@/components/ui';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { getProjectLabel, normalizePath } from './mobilePaths';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useI18n } from '@/lib/i18n';
import { PROJECT_COLOR_MAP, PROJECT_ICON_MAP, ProjectIconImage } from '@/lib/projectMeta';
import { cn } from '@/lib/utils';
import {
  listProjectWorktrees,
  partitionWorktreesByRegisteredProject,
} from '@/lib/worktrees/worktreeManager';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { mergeLiveSessionWithGlobalSession, refreshGlobalSessions, useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useMobileSessionExpansionStore } from '@/stores/useMobileSessionExpansionStore';
import { useMobileSessionTreeStore } from '@/stores/useMobileSessionTreeStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionPinnedStore } from '@/stores/useSessionPinnedStore';
import { orderWorktrees, useWorktreeOrderStore } from '@/stores/useWorktreeOrderStore';
import {
  EMPTY_SESSION_ORDER_RANKS,
  orderSessionsByLifecycleScopes,
  useSessionOrderingStore,
} from '@/sync/session-ordering';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useAllLiveSessions, useGlobalSessionStatus } from '@/sync/sync-context';
import { useSessionUnseenCount } from '@/sync/notification-store';
import type { WorktreeMetadata } from '@/types/worktree';

import { MobileDeleteWorktreeDialog } from './MobileDeleteWorktreeDialog';
import { MobileProjectEditSurface } from './MobileProjectEditSurface';

type MobileSessionsSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 'drawer' (default) renders a full-width left drawer over the app;
      'sidebar' renders the same content inline for the iPad persistent sidebar. */
  variant?: 'drawer' | 'sidebar';
  /** App-level footer bar (desktop-sidebar-style): current instance on the
      left, settings (and, on hosted web, a pending update) on the right. */
  footer?: {
    /** Connected instance label — Capacitor only; null hides the left slot. */
    instanceLabel: string | null;
    onOpenInstances?: () => void;
    onOpenSettings: () => void;
    /** Present only while a server update is available (hosted web). */
    onOpenUpdate?: () => void;
  };
};

const EMPTY_PINNED_SESSION_IDS = new Set<string>();

// Pseudo-project key for the collapsible "recent" group's persisted expansion.

type ProjectMeta = {
  id: string;
  label: string;
  path: string;
  icon?: string | null;
  color?: string | null;
  iconImage?: { mime: string; updatedAt: number; source: 'custom' | 'auto' } | null;
  iconBackground?: string | null;
  isGitRepo: boolean;
  worktrees: WorktreeMetadata[];
};

type WorktreeBucket = {
  /** Stable key — usually the worktree path (or project root). */
  key: string;
  /** Display label — branch name when available, else folder name. */
  label: string;
  /** Filesystem path used as `directory` for new sessions started here. */
  path: string;
  /** Underlying worktree metadata, null when this bucket represents the project root. */
  worktree: WorktreeMetadata | null;
  /** Sessions matched into this bucket, sorted by recency desc. */
  sessions: Session[];
};

type ProjectNode = {
  project: ProjectMeta;
  buckets: WorktreeBucket[];
  totalSessions: number;
  isActive: boolean;
};

const SESSIONS_PER_BUCKET = 7;

// Left padding for session rows so the title's first letter aligns with its
// parent label. Root/project-level sessions align with the project label;
// worktree sessions sit one level deeper. SessionRow adds 16px (dot + gap) on top.
const PROJECT_SESSION_INDENT = 40;
// Extra left padding applied to each nested subsession level.
const CHILD_INDENT_STEP = 16;

const getParentId = (session: Session): string | null =>
  (session as Session & { parentID?: string | null }).parentID ?? null;

const getSessionDirectory = (session: Session): string => {
  const sessionWithDirectory = session as Session & {
    directory?: string | null;
    project?: { worktree?: string | null } | null;
  };
  return normalizePath(sessionWithDirectory.directory ?? sessionWithDirectory.project?.worktree ?? null);
};

const getSessionTimestamp = (session: Session): number => {
  const raw = session.time?.updated ?? session.time?.created;
  const value = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(value) && value > 0 ? value : 0;
};

const formatRelativeShort = (timestamp: number): string => {
  if (timestamp <= 0) return '';
  const diffMs = Date.now() - timestamp;
  if (diffMs < 60_000) return 'now';
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(timestamp));
};

const pathBelongsToRoot = (path: string, root: string): boolean => {
  const normalizedPath = normalizePath(path);
  const normalizedRoot = normalizePath(root);
  return Boolean(
    normalizedPath &&
      normalizedRoot &&
      (normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`)),
  );
};

const findExactWorktreeMatch = (project: ProjectMeta, normalizedDirectory: string): WorktreeMetadata | null => (
  project.worktrees.find((worktree) => normalizePath(worktree.path) === normalizedDirectory) ?? null
);

const projectMatchesExactDirectory = (project: ProjectMeta, normalizedDirectory: string): boolean => (
  normalizedDirectory === project.path || Boolean(findExactWorktreeMatch(project, normalizedDirectory))
);

const findExactProjectMatch = (projects: ProjectMeta[], directory: string): ProjectMeta | null => {
  const normalizedDirectory = normalizePath(directory);
  if (!normalizedDirectory) return null;
  return projects.find((project) => projectMatchesExactDirectory(project, normalizedDirectory)) ?? null;
};

const sessionMatchesQuery = (session: Session, projectLabel: string, query: string): boolean => {
  if (!query) return true;
  const haystack = `${session.title ?? ''} ${session.id} ${getSessionDirectory(session)} ${projectLabel}`.toLowerCase();
  return haystack.includes(query);
};

const MobileProjectIcon: React.FC<{
  project: Pick<ProjectMeta, 'id' | 'icon' | 'color' | 'iconImage' | 'iconBackground'>;
  size?: 'sm' | 'md';
}> = ({ project, size = 'md' }) => {
  const { currentTheme } = useThemeSystem();

  const ProjectIcon = project.icon ? PROJECT_ICON_MAP[project.icon] : null;
  const iconColor = project.color ? PROJECT_COLOR_MAP[project.color] ?? null : null;

  const containerClasses = size === 'sm' ? 'size-6 rounded-md' : 'size-8 rounded-lg';
  const innerClasses = size === 'sm' ? 'size-3.5' : 'size-4';
  const fallbackIcon = ProjectIcon ? (
    <Icon name={ProjectIcon} className={innerClasses} style={iconColor ? { color: iconColor } : undefined} />
  ) : (
    <RiFolder6Line className={innerClasses} style={iconColor ? { color: iconColor } : undefined} />
  );

  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center overflow-hidden bg-[var(--surface-muted)] text-muted-foreground',
        containerClasses,
      )}
      style={project.iconBackground ? { backgroundColor: project.iconBackground } : undefined}
    >
      {project.iconImage ? (
        <ProjectIconImage
          project={{ id: project.id, iconImage: project.iconImage ?? null }}
          options={{
            themeVariant: currentTheme.metadata.variant,
            iconColor: currentTheme.colors.surface.foreground,
          }}
          className="size-full object-contain"
          fallback={fallbackIcon}
        />
      ) : fallbackIcon}
    </span>
  );
};

const ActiveDot: React.FC<{ ariaLabel?: string }> = ({ ariaLabel }) => (
  <span
    className="inline-block size-1.5 shrink-0 rounded-full bg-primary"
    aria-label={ariaLabel}
  />
);

const NewWorktreeIconButton: React.FC<{
  onClick: () => void;
  className?: string;
}> = ({ onClick, className }) => {
  const { t } = useI18n();
  const label = t('sessions.sidebar.project.actions.newWorktree');

  return (
    <button
      type="button"
      className={cn(
        'flex size-9 shrink-0 items-center justify-center rounded-full text-[var(--surface-mutedForeground)] transition-colors hover:bg-[var(--interactive-hover)] hover:text-[var(--surface-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]',
        className,
      )}
      aria-label={label}
      title={label}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      style={{ touchAction: 'manipulation' }}
    >
      <Icon name="node-tree" className="size-4" />
    </button>
  );
};

// Width of the swipe-revealed action area (rename + archive + delete buttons).
const ROW_ACTIONS_WIDTH = 144;
const ROW_SWIPE_SNAP_MS = 180;

/** Generic swipe-left-to-reveal wrapper for drawer rows (projects, worktrees).
    Same gesture mechanics as SessionRow's swipe actions: horizontal intent
    detection, imperative transform during the drag, snap on release. */
const MobileSwipeActionsRow: React.FC<{
  actionsWidth: number;
  actions: React.ReactNode;
  revealed: boolean;
  onRevealedChange: (revealed: boolean) => void;
  children: React.ReactNode;
}> = ({ actionsWidth, actions, revealed, onRevealedChange, children }) => {
  const contentRef = React.useRef<HTMLDivElement>(null);
  const startRef = React.useRef<{ x: number; y: number } | null>(null);
  const draggingRef = React.useRef(false);
  const offsetRef = React.useRef(0);
  const revealedRef = React.useRef(revealed);

  const applyOffset = React.useCallback((px: number, animate: boolean) => {
    const el = contentRef.current;
    if (!el) return;
    el.style.transition = animate ? `transform ${ROW_SWIPE_SNAP_MS}ms ease-out` : 'none';
    el.style.transform = px === 0 ? 'none' : `translateX(${px}px)`;
    offsetRef.current = px;
  }, []);

  React.useEffect(() => {
    revealedRef.current = revealed;
    applyOffset(revealed ? -actionsWidth : 0, true);
  }, [actionsWidth, applyOffset, revealed]);

  const handleTouchStart = (event: React.TouchEvent) => {
    if (event.touches.length !== 1) return;
    const touch = event.touches[0];
    startRef.current = { x: touch.clientX, y: touch.clientY };
    draggingRef.current = false;
  };

  const handleTouchMove = (event: React.TouchEvent) => {
    if (!startRef.current) return;
    const touch = event.touches[0];
    const dx = touch.clientX - startRef.current.x;
    const dy = touch.clientY - startRef.current.y;
    if (!draggingRef.current) {
      if (Math.abs(dx) < 8 || Math.abs(dx) <= Math.abs(dy)) return;
      draggingRef.current = true;
    }
    const base = revealedRef.current ? -actionsWidth : 0;
    applyOffset(Math.min(0, Math.max(-actionsWidth, base + dx)), false);
  };

  const handleTouchEnd = () => {
    startRef.current = null;
    if (!draggingRef.current) return;
    draggingRef.current = false;
    const shouldReveal = offsetRef.current < -actionsWidth / 2;
    applyOffset(shouldReveal ? -actionsWidth : 0, true);
    if (shouldReveal !== revealedRef.current) onRevealedChange(shouldReveal);
  };

  return (
    <div
      className="relative overflow-hidden"
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchEnd}
      style={{ touchAction: 'pan-y' }}
    >
      <div className="absolute inset-y-0 right-0 flex items-stretch" style={{ width: actionsWidth }} aria-hidden={!revealed}>
        {actions}
      </div>
      <div ref={contentRef} className="relative flex w-full items-center bg-background">
        {children}
      </div>
    </div>
  );
};

/** Inline title editor shown in place of the row content while renaming.
    Mirrors the desktop sidebar rename: a bare transparent input at the row's
    own typography (no bordered field — the row keeps its exact height) with
    explicit save/cancel icon buttons. */
const SessionRenameForm: React.FC<{
  initialTitle: string;
  indent: number;
  onSubmit: (title: string) => void;
  onCancel: () => void;
}> = ({ initialTitle, indent, onSubmit, onCancel }) => {
  const { t } = useI18n();
  const [value, setValue] = React.useState(initialTitle);

  const commit = () => {
    const next = value.trim();
    if (!next || next === initialTitle.trim()) {
      onCancel();
      return;
    }
    onSubmit(next);
  };

  return (
    <form
      // Fixed 36px: the session row's real height is NOT Tailwind's min-h-10 —
      // mobile.css's global button touch-target rule (min-height: 36px) wins
      // that specificity fight, so single-line rows resolve to 36px. Pin the
      // rename state to the same 36px.
      className="flex h-9 min-w-0 flex-1 items-center gap-2 pr-2"
      style={{ paddingLeft: indent }}
      onSubmit={(event) => {
        event.preventDefault();
        commit();
      }}
    >
      <input
        autoFocus
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Escape') onCancel();
        }}
        aria-label={t('sessions.sidebar.session.rename.save')}
        placeholder={t('sessions.sidebar.session.menu.rename')}
        // 16px prevents the iOS focus zoom; the bare input keeps the row height.
        // The inline min-height overrides mobile.css's global 36px input
        // floor, which otherwise makes the rename row taller than the 40px
        // session row.
        className="min-w-0 flex-1 bg-transparent text-[16px] typography-ui-label text-foreground outline-none placeholder:text-muted-foreground"
        style={{ minHeight: 0 }}
        enterKeyHint="done"
      />
      <button
        type="submit"
        aria-label={t('sessions.sidebar.session.rename.save')}
        className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        // Inline mins beat mobile.css's global 36px button touch-target floor
        // so the controls fit the 40px row.
        style={{ touchAction: 'manipulation', minHeight: 0, minWidth: 0 }}
      >
        <Icon name="check" className="size-4" />
      </button>
      <button
        type="button"
        onClick={onCancel}
        aria-label={t('sessions.sidebar.session.rename.cancel')}
        className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        style={{ touchAction: 'manipulation', minHeight: 0, minWidth: 0 }}
      >
        <Icon name="close" className="size-4" />
      </button>
    </form>
  );
};

const SessionRow: React.FC<{
  session: Session;
  active: boolean;
  indent: number;
  /** When provided, shown as a small second-line subtitle below the title (e.g. "Project · branch"). */
  contextLabel?: string;
  /** When true, a chevron is shown in the left gutter to toggle nested subsessions. */
  hasChildren?: boolean;
  expanded?: boolean;
  onToggleChildren?: () => void;
  onSelect: () => void;
  /** Swipe-left actions. When omitted, the row is a plain non-swipeable row. */
  revealed?: boolean;
  onRevealedChange?: (revealed: boolean) => void;
  confirmingDelete?: boolean;
  onArchive?: () => void;
  onRequestDelete?: () => void;
  onConfirmDelete?: () => void;
  renaming?: boolean;
  onRequestRename?: () => void;
  onSubmitRename?: (title: string) => void;
  onCancelRename?: () => void;
}> = ({
  session,
  active,
  indent,
  contextLabel,
  hasChildren = false,
  expanded = false,
  onToggleChildren,
  onSelect,
  revealed = false,
  onRevealedChange,
  confirmingDelete = false,
  onArchive,
  onRequestDelete,
  onConfirmDelete,
  renaming = false,
  onRequestRename,
  onSubmitRename,
  onCancelRename,
}) => {
  const { t } = useI18n();
  const time = formatRelativeShort(getSessionTimestamp(session));
  const title = session.title?.trim() || t('mobile.sessions.untitled');
  const swipeEnabled = Boolean(onRevealedChange && onArchive);
  // Live indicators, same conventions as the desktop sidebar: busy/retry →
  // spinner; unseen activity on a non-active row → attention dot.
  const liveStatus = useGlobalSessionStatus(session.id);
  const unseenCount = useSessionUnseenCount(session.id);
  const statusType = liveStatus?.type ?? 'idle';
  const isStreaming = statusType === 'busy' || statusType === 'retry';
  const showUnreadDot = !isStreaming && unseenCount > 0 && !active;

  const contentRef = React.useRef<HTMLDivElement>(null);
  const startRef = React.useRef<{ x: number; y: number } | null>(null);
  const draggingRef = React.useRef(false);
  const offsetRef = React.useRef(0);
  const revealedRef = React.useRef(revealed);

  // Imperative transform during the drag (no per-frame re-render); React state
  // only flips at the snap points via onRevealedChange.
  const applyOffset = React.useCallback((px: number, animate: boolean) => {
    const el = contentRef.current;
    if (!el) return;
    el.style.transition = animate ? `transform ${ROW_SWIPE_SNAP_MS}ms ease-out` : 'none';
    el.style.transform = px === 0 ? 'none' : `translateX(${px}px)`;
    offsetRef.current = px;
  }, []);

  React.useEffect(() => {
    revealedRef.current = revealed;
    applyOffset(revealed ? -ROW_ACTIONS_WIDTH : 0, true);
  }, [applyOffset, revealed]);

  const handleTouchStart = (event: React.TouchEvent) => {
    if (!swipeEnabled || event.touches.length !== 1) return;
    const touch = event.touches[0];
    startRef.current = { x: touch.clientX, y: touch.clientY };
    draggingRef.current = false;
  };

  const handleTouchMove = (event: React.TouchEvent) => {
    if (!swipeEnabled || !startRef.current) return;
    const touch = event.touches[0];
    const dx = touch.clientX - startRef.current.x;
    const dy = touch.clientY - startRef.current.y;
    if (!draggingRef.current) {
      if (Math.abs(dx) < 8 || Math.abs(dx) <= Math.abs(dy)) return;
      draggingRef.current = true;
    }
    const base = revealedRef.current ? -ROW_ACTIONS_WIDTH : 0;
    const next = Math.min(0, Math.max(-ROW_ACTIONS_WIDTH, base + dx));
    applyOffset(next, false);
  };

  const handleTouchEnd = () => {
    startRef.current = null;
    if (!draggingRef.current) return;
    draggingRef.current = false;
    const shouldReveal = offsetRef.current < -ROW_ACTIONS_WIDTH / 2;
    applyOffset(shouldReveal ? -ROW_ACTIONS_WIDTH : 0, true);
    if (shouldReveal !== revealedRef.current) onRevealedChange?.(shouldReveal);
  };

  return (
    <div
      data-active-session={active || undefined}
      className="relative overflow-hidden"
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchEnd}
      // Vertical panning stays native; horizontal moves reach the swipe handler.
      style={swipeEnabled ? { touchAction: 'pan-y' } : undefined}
    >
      {swipeEnabled ? (
        <div
          className="absolute inset-y-0 right-0 flex items-stretch"
          style={{ width: ROW_ACTIONS_WIDTH }}
          aria-hidden={!revealed}
        >
          {/* Icon-only actions on the row's own background — they read as the
              row extending to reveal extra controls, not a separate panel. */}
          <button
            type="button"
            tabIndex={revealed ? 0 : -1}
            className="flex flex-1 items-center justify-center text-muted-foreground transition-colors active:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
            aria-label={t('mobile.sessions.renameSessionAria', { title })}
            onClick={onRequestRename}
            style={{ touchAction: 'manipulation' }}
          >
            <RiEdit2Line className="size-[18px]" />
          </button>
          <button
            type="button"
            tabIndex={revealed ? 0 : -1}
            className="flex flex-1 items-center justify-center text-muted-foreground transition-colors active:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
            aria-label={t('mobile.sessions.archiveSessionAria', { title })}
            onClick={onArchive}
            style={{ touchAction: 'manipulation' }}
          >
            <RiArchiveLine className="size-[18px]" />
          </button>
          <button
            type="button"
            tabIndex={revealed ? 0 : -1}
            className={cn(
              'flex flex-1 items-center justify-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-destructive',
              confirmingDelete
                ? 'rounded-lg bg-destructive text-destructive-foreground'
                : 'text-[var(--status-error)] active:opacity-80',
            )}
            aria-label={confirmingDelete
              ? t('mobile.sessions.confirmDeleteSessionAria', { title })
              : t('mobile.sessions.deleteSessionAria', { title })}
            onClick={confirmingDelete ? onConfirmDelete : onRequestDelete}
            style={{ touchAction: 'manipulation' }}
          >
            <RiDeleteBinLine className="size-[18px]" />
          </button>
        </div>
      ) : null}
      <div
        ref={contentRef}
        className={cn(
          'relative flex items-center gap-1 transition-colors',
          // Swipeable rows need an OPAQUE background so the action buttons stay
          // hidden behind the content until it slides; plain rows (search
          // results on an elevated card) keep the translucent treatment.
          swipeEnabled && 'bg-background',
          active && (swipeEnabled
            ? 'bg-[color-mix(in_srgb,var(--primary)_10%,var(--background))]'
            : 'bg-[color-mix(in_srgb,var(--primary)_10%,transparent)]'),
        )}
      >
        {/* Left gutter slot: live activity indicator takes priority over the
            subsession chevron — same position, so rows never shift. When the
            row has children the slot still toggles them either way. */}
        {isStreaming || showUnreadDot || (hasChildren && onToggleChildren) ? (
          <button
            type="button"
            className="absolute z-10 flex w-6 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            style={{ left: Math.max(indent - 32, 2), top: 0, bottom: 0, touchAction: 'manipulation' }}
            aria-label={expanded
              ? t('sessions.sidebar.session.subsessions.collapse')
              : t('sessions.sidebar.session.subsessions.expand')}
            disabled={!hasChildren || !onToggleChildren}
            onClick={(event) => {
              event.stopPropagation();
              onToggleChildren?.();
            }}
          >
            {isStreaming ? (
              <Icon name="loader-4" className="size-3.5 animate-spin text-primary" />
            ) : showUnreadDot ? (
              <span className="size-1.5 rounded-full bg-[var(--status-info)]" aria-hidden />
            ) : (
              <RiArrowDownSLine className={cn('size-[18px] transition-transform duration-150', expanded ? 'rotate-0' : '-rotate-90')} />
            )}
          </button>
        ) : null}
        {renaming && onSubmitRename && onCancelRename ? (
          <SessionRenameForm
            initialTitle={title}
            indent={indent}
            onSubmit={onSubmitRename}
            onCancel={onCancelRename}
          />
        ) : (
        <button
          type="button"
          // Single-line rows: fixed h-9 (36px) to match SessionRenameForm
          // exactly — min-h-* utilities lose the specificity fight against
          // mobile.css's global 36px button floor anyway, so make the real
          // height explicit. Two-line rows (search results with a context
          // subtitle) keep flexible height.
          className={cn(
            'flex min-w-0 flex-1 items-center gap-2.5 pr-3.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset',
            contextLabel ? 'min-h-10 py-1' : 'h-9',
          )}
          style={{ paddingLeft: indent, touchAction: 'manipulation' }}
          onClick={() => {
            // A tap while the actions are out just closes them.
            if (revealedRef.current) {
              onRevealedChange?.(false);
              return;
            }
            onSelect();
          }}
        >
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex items-center gap-2.5">
              <span
                className={cn(
                  'block min-w-0 flex-1 truncate typography-ui-label',
                  active ? 'text-primary' : 'text-foreground',
                )}
              >
                {title}
              </span>
              {time ? (
                <span className="shrink-0 typography-micro text-muted-foreground tabular-nums">{time}</span>
              ) : null}
            </span>
            {contextLabel ? (
              <span className="block truncate typography-micro text-muted-foreground">{contextLabel}</span>
            ) : null}
          </span>
        </button>
        )}
      </div>
    </div>
  );
};

const ShowMoreRow: React.FC<{
  indent: number;
  onClick: () => void;
}> = ({ indent, onClick }) => {
  const { t } = useI18n();
  return (
    <button
      type="button"
      className="flex min-h-9 w-full items-center gap-2 py-1 pr-3 text-left text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset"
      style={{ paddingLeft: indent, touchAction: 'manipulation' }}
      onClick={onClick}
    >
      <RiArrowDownSLine className="size-4" />
      <span className="typography-micro">{t('sessions.sidebar.group.showMore')}</span>
    </button>
  );
};

const ShowFewerRow: React.FC<{
  indent: number;
  onClick: () => void;
}> = ({ indent, onClick }) => {
  const { t } = useI18n();
  return (
    <button
      type="button"
      className="flex min-h-9 w-full items-center gap-2 py-1 pr-3 text-left text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset"
      style={{ paddingLeft: indent, touchAction: 'manipulation' }}
      onClick={onClick}
    >
      <RiArrowUpSLine className="size-4" />
      <span className="typography-micro">{t('sessions.sidebar.group.showFewer')}</span>
    </button>
  );
};

/** One draggable worktree row inside a project's reorder card. */
const SortableWorktreeReorderRow: React.FC<{ worktree: WorktreeMetadata }> = ({ worktree }) => {
  const { t } = useI18n();
  const path = normalizePath(worktree.path);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: path });
  const label = worktree.branch || worktree.label || worktree.path;
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, zIndex: isDragging ? 10 : 1 }}
      className={cn(
        'flex items-center gap-1 rounded-xl bg-background px-1 py-1',
        isDragging && 'shadow-lg shadow-black/20',
      )}
    >
      <button
        type="button"
        className="flex size-8 shrink-0 cursor-grab touch-none items-center justify-center rounded-lg text-muted-foreground/70 transition-colors hover:text-foreground active:cursor-grabbing"
        aria-label={t('mobile.sessions.dragHandleAria', { label })}
        {...attributes}
        {...listeners}
      >
        <RiDragMove2Line className="size-4" />
      </button>
      <Icon name="git-branch" className="size-4 shrink-0 text-muted-foreground" />
      <span className="block min-w-0 flex-1 truncate typography-ui-label font-bold text-muted-foreground">{label}</span>
    </div>
  );
};

/** Reorder-mode project card: drag handle reorders projects globally; tapping
    the rest of the row collapses/expands its worktrees, which reorder within
    the project through their own nested DndContext. */
const SortableProjectRow: React.FC<{
  project: ProjectMeta;
  totalSessions: number;
  expanded: boolean;
  onToggleExpanded: () => void;
  onReorderWorktrees: (orderedPaths: string[]) => void;
}> = ({ project, totalSessions, expanded, onToggleExpanded, onReorderWorktrees }) => {
  const { t } = useI18n();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: project.id });
  const worktreeSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const hasWorktrees = project.worktrees.length > 0;

  const handleWorktreeDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const paths = project.worktrees.map((worktree) => normalizePath(worktree.path));
    const fromIndex = paths.indexOf(String(active.id));
    const toIndex = paths.indexOf(String(over.id));
    if (fromIndex < 0 || toIndex < 0) return;
    const next = [...paths];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    onReorderWorktrees(next);
  };

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, zIndex: isDragging ? 10 : 1 }}
      className={cn(
        'rounded-2xl border border-border/70 bg-[var(--surface-elevated)] px-1.5 py-1.5 transition-colors',
        isDragging && 'shadow-lg shadow-black/20',
      )}
    >
      <div className="flex items-center gap-1">
        <button
          type="button"
          className="flex size-9 shrink-0 cursor-grab touch-none items-center justify-center rounded-xl text-muted-foreground/70 transition-colors hover:text-foreground active:cursor-grabbing"
          aria-label={t('mobile.sessions.dragHandleAria', { label: project.label })}
          {...attributes}
          {...listeners}
        >
          <RiDragMove2Line className="size-4" />
        </button>
        <button
          type="button"
          className="flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-xl px-1 text-left transition-colors hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
          onClick={onToggleExpanded}
          aria-expanded={expanded}
          aria-label={expanded
            ? t('sessions.sidebar.group.collapseAria', { label: project.label })
            : t('sessions.sidebar.group.expandAria', { label: project.label })}
          disabled={!hasWorktrees}
          style={{ touchAction: 'manipulation' }}
        >
          <MobileProjectIcon project={project} />
          <span className="block min-w-0 flex-1 truncate typography-ui-label text-foreground">{project.label}</span>
          <span className="shrink-0 typography-micro text-muted-foreground tabular-nums">{totalSessions}</span>
          {hasWorktrees ? (
            <RiArrowDownSLine
              className={cn('size-4 shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-180')}
            />
          ) : null}
        </button>
      </div>
      {expanded && hasWorktrees ? (
        <DndContext sensors={worktreeSensors} collisionDetection={closestCenter} onDragEnd={handleWorktreeDragEnd}>
          <SortableContext
            items={project.worktrees.map((worktree) => normalizePath(worktree.path))}
            strategy={verticalListSortingStrategy}
          >
            <div className="mt-1 flex flex-col gap-0.5 pl-3">
              {project.worktrees.map((worktree) => (
                <SortableWorktreeReorderRow key={normalizePath(worktree.path)} worktree={worktree} />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      ) : null}
    </div>
  );
};

export const MobileSessionsSheet: React.FC<MobileSessionsSheetProps> = ({ open, onOpenChange, variant = 'drawer', footer }) => {
  const { t } = useI18n();
  const { git } = useRuntimeAPIs();
  const liveSessions = useAllLiveSessions();
  const globalActiveSessions = useGlobalSessionsStore((state) => state.activeSessions);
  const pinnedSessionIds = useSessionPinnedStore(React.useCallback(
    (state) => open || variant === 'sidebar' ? state.ids : EMPTY_PINNED_SESSION_IDS,
    [open, variant],
  ));
  const sessionOrderRanks = useSessionOrderingStore(React.useCallback(
    (state) => open || variant === 'sidebar' ? state.rankById : EMPTY_SESSION_ORDER_RANKS,
    [open, variant],
  ));
  const projects = useProjectsStore((state) => state.projects);
  const activeProjectId = useProjectsStore((state) => state.activeProjectId);
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const setCurrentSession = useSessionUIStore((state) => state.setCurrentSession);
  const archiveSession = useSessionUIStore((state) => state.archiveSession);
  const deleteSession = useSessionUIStore((state) => state.deleteSession);
  const updateSessionTitle = useSessionUIStore((state) => state.updateSessionTitle);
  const openNewSessionDraft = useSessionUIStore((state) => state.openNewSessionDraft);
  const setActiveProject = useProjectsStore((state) => state.setActiveProject);
  const setActiveProjectIdOnly = useProjectsStore((state) => state.setActiveProjectIdOnly);
  const reorderProjects = useProjectsStore((state) => state.reorderProjects);
  const removeProject = useProjectsStore((state) => state.removeProject);
  const projectExpandedMap = useMobileSessionTreeStore((state) => state.projectExpanded);
  const worktreeExpandedMap = useMobileSessionTreeStore((state) => state.worktreeExpanded);
  const setProjectExpanded = useMobileSessionTreeStore((state) => state.setProjectExpanded);
  const setWorktreeExpanded = useMobileSessionTreeStore((state) => state.setWorktreeExpanded);
  const worktreeOrderByProject = useWorktreeOrderStore((state) => state.orderByProject);
  const setWorktreeOrder = useWorktreeOrderStore((state) => state.setWorktreeOrder);
  const expandedParents = useMobileSessionExpansionStore((state) => state.expandedParents);
  const toggleParent = useMobileSessionExpansionStore((state) => state.toggleParent);
  const [query, setQuery] = React.useState('');
  const [editingProjectId, setEditingProjectId] = React.useState<string | null>(null);
  // Swipe-left actions: which row has its actions revealed, and whether its
  // delete button is armed (two-step). One row at a time.
  const [revealedSessionId, setRevealedSessionId] = React.useState<string | null>(null);
  const [confirmingDeleteSessionId, setConfirmingDeleteSessionId] = React.useState<string | null>(null);
  const [renamingSessionId, setRenamingSessionId] = React.useState<string | null>(null);
  // Swipe-left actions on group headers (`project:{id}` / `wt:{bucketKey}`) —
  // separate from session rows, but mutually exclusive with them.
  const [revealedRowId, setRevealedRowId] = React.useState<string | null>(null);
  const [confirmingRemoveProjectId, setConfirmingRemoveProjectId] = React.useState<string | null>(null);
  const [worktreeToDelete, setWorktreeToDelete] = React.useState<{
    project: ProjectMeta;
    worktree: WorktreeMetadata;
  } | null>(null);
  // Bumped to force a re-list of worktrees (e.g. after one is deleted in the editor).
  const [worktreeRefreshKey, setWorktreeRefreshKey] = React.useState(0);
  const [directoryDialogOpen, setDirectoryDialogOpen] = React.useState(false);
  const [newWorktreeDialogOpen, setNewWorktreeDialogOpen] = React.useState(false);
  const [worktreeDialogProjectId, setWorktreeDialogProjectId] = React.useState<string | null>(null);
  // Seeded from the app-level worktree discovery (MobileApp populates
  // availableWorktreesByProject on connect) so the FIRST open already shows
  // worktrees; the per-open refresh below keeps them fresh without ever
  // blanking the list.
  const [worktreesByProject, setWorktreesByProject] = React.useState<Map<string, WorktreeMetadata[]>>(
    () => new Map(useSessionUIStore.getState().availableWorktreesByProject),
  );
  const [gitProjectPaths, setGitProjectPaths] = React.useState<Set<string>>(() => {
    const seeded = new Set<string>();
    for (const [path, worktrees] of useSessionUIStore.getState().availableWorktreesByProject) {
      if (worktrees.length > 0) seeded.add(path);
    }
    return seeded;
  });
  const [editingOrder, setEditingOrder] = React.useState(false);
  // Reorder mode collapses projects by default (dragging past 40 worktrees is
  // painful); tap outside the drag handle to expand one.
  const [reorderExpandedProjects, setReorderExpandedProjects] = React.useState<Set<string>>(new Set());
  // Per-bucket count of sessions revealed past the default page. Ephemeral —
  // resets when the sheet closes or when a group/project is toggled. Expand
  // state itself lives in useMobileSessionTreeStore (persisted).
  // Key: `${projectId}::${bucketKey}`.
  const [visibleCountByBucket, setVisibleCountByBucket] = React.useState<Map<string, number>>(new Map());

  React.useEffect(() => {
    if (!open) {
      setQuery('');
      setEditingOrder(false);
      setReorderExpandedProjects(new Set());
      setVisibleCountByBucket(new Map());
      setEditingProjectId(null);
      setRevealedSessionId(null);
      setConfirmingDeleteSessionId(null);
      setRenamingSessionId(null);
      setRevealedRowId(null);
      setConfirmingRemoveProjectId(null);
      return;
    }
    void refreshGlobalSessions(liveSessions);
    // intentionally only on open transition — live overlay handles updates after that
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  React.useEffect(() => {
    if (!editingOrder) setReorderExpandedProjects(new Set());
  }, [editingOrder]);

  React.useEffect(() => {
    if (!open || projects.length === 0) return;
    let cancelled = false;
    const run = async () => {
      const entries = await Promise.all(
        projects.map(async (project) => {
          const path = normalizePath(project.path);
          if (!path) return null;
          const isGitRepo = await git.checkIsGitRepository(path).catch(() => false);
          const worktrees = isGitRepo
            ? await listProjectWorktrees({ id: project.id, path }).catch(() => [])
            : [];
          return [path, worktrees, isGitRepo] as const;
        }),
      );
      if (cancelled) return;
      const discoveredWorktreesByProject = new Map<string, WorktreeMetadata[]>();
      const nextGitProjectPaths = new Set<string>();
      for (const entry of entries) {
        if (entry) {
          discoveredWorktreesByProject.set(entry[0], entry[1]);
          if (entry[2]) nextGitProjectPaths.add(entry[0]);
        }
      }
      setWorktreesByProject(partitionWorktreesByRegisteredProject(projects, discoveredWorktreesByProject));
      setGitProjectPaths(nextGitProjectPaths);
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [git, open, projects, worktreeRefreshKey]);

  const projectsMeta = React.useMemo<ProjectMeta[]>(
    () =>
      projects.map((project) => ({
        id: project.id,
        label: project.label?.trim() || getProjectLabel(project.path),
        path: normalizePath(project.path),
        icon: project.icon,
        color: project.color,
        iconImage: project.iconImage,
        iconBackground: project.iconBackground,
        isGitRepo: gitProjectPaths.has(normalizePath(project.path)),
        worktrees: orderWorktrees(
          worktreeOrderByProject[project.id],
          worktreesByProject.get(normalizePath(project.path)) ?? [],
        ),
      })),
    [gitProjectPaths, projects, worktreeOrderByProject, worktreesByProject],
  );

  /**
   * Global sessions cover all directories — even unbootstrapped ones — so the tree shows
   * accurate counts even when a worktree's live store hasn't been hydrated yet. Live
   * sessions overlay for fresher data on the active directory.
   */
  const sessions = React.useMemo(() => {
    const liveById = new Map(liveSessions.map((session) => [session.id, session]));
    const merged = globalActiveSessions.map((session) => {
      const liveSession = liveById.get(session.id);
      return liveSession ? mergeLiveSessionWithGlobalSession(liveSession, session) : session;
    });
    const seenIds = new Set(merged.map((session) => session.id));
    for (const session of liveSessions) {
      if (!seenIds.has(session.id)) merged.push(session);
    }
    // Archived sessions never show on mobile (no archived view here): the live
    // overlay can carry them for the active directory, and they'd otherwise
    // surface in search and then "disappear" once the overlay refreshes.
    return merged.filter((session) => !session.time?.archived);
  }, [globalActiveSessions, liveSessions]);

  const normalizedQuery = query.trim().toLowerCase();

  // On open, bring the current session (or at least its project) into view —
  // the list keeps its scroll position between opens, so a long project list
  // otherwise lands wherever it was left. Rows carry data-active-* markers.
  const contentRootRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      const root = contentRootRef.current;
      if (!root) return;
      const target = root.querySelector<HTMLElement>('[data-active-session="true"]')
        ?? root.querySelector<HTMLElement>('[data-active-project="true"]');
      target?.scrollIntoView({ block: 'center' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  const projectNodes = React.useMemo<ProjectNode[]>(() => {
    const nodes: ProjectNode[] = projectsMeta.map((project) => ({
      project,
      buckets: [] as WorktreeBucket[],
      totalSessions: 0,
      isActive: project.id === activeProjectId,
    }));

    const ensureBucket = (node: ProjectNode, path: string, worktree: WorktreeMetadata | null): WorktreeBucket => {
      const normalizedBucketPath = normalizePath(path) || node.project.path;
      const key = normalizedBucketPath || '__root__';
      let bucket = node.buckets.find((entry) => entry.key === key);
      if (!bucket) {
        bucket = {
          key,
          label: worktree?.branch || getProjectLabel(normalizedBucketPath),
          path: normalizedBucketPath,
          worktree,
          sessions: [],
        };
        node.buckets.push(bucket);
      }
      return bucket;
    };

    for (const node of nodes) {
      ensureBucket(node, node.project.path, null);
      for (const worktree of node.project.worktrees) ensureBucket(node, worktree.path, worktree);
    }

    for (const session of sessions) {
      const directory = getSessionDirectory(session);
      if (!directory) continue;
      const normalizedDirectory = normalizePath(directory);
      const node = nodes.find((entry) => projectMatchesExactDirectory(entry.project, normalizedDirectory));
      if (!node) continue;
      const matchedWorktree = findExactWorktreeMatch(node.project, normalizedDirectory);
      const bucket = matchedWorktree
        ? ensureBucket(node, matchedWorktree.path, matchedWorktree)
        : ensureBucket(node, node.project.path, null);
      bucket.sessions.push(session);
    }

    for (const node of nodes) {
      for (const bucket of node.buckets) {
        bucket.sessions = orderSessionsByLifecycleScopes(bucket.sessions, pinnedSessionIds, sessionOrderRanks);
        for (const session of bucket.sessions) {
          if (!getParentId(session)) node.totalSessions += 1;
        }
      }
    }

    return nodes;
  }, [activeProjectId, pinnedSessionIds, projectsMeta, sessionOrderRanks, sessions]);

  const normalizedDirectory = normalizePath(currentDirectory);

  const findActiveWorktreePath = (node: ProjectNode): string | null => {
    if (!node.isActive) return null;
    if (normalizedDirectory === node.project.path) return node.project.path;
    const matched = node.project.worktrees.find((entry) => pathBelongsToRoot(normalizedDirectory, entry.path));
    return matched?.path ?? node.project.path;
  };

  // Expansion is the user's own choice (persisted), independent of the active
  // directory: projects default to expanded, worktree groups to collapsed.
  const isProjectExpanded = (node: ProjectNode): boolean =>
    projectExpandedMap[node.project.id] ?? true;

  // Worktrees default to EXPANDED (desktop parity): their sessions ARE the
  // content; the header still toggles for users who want them tucked away.
  const isWorktreeExpanded = (node: ProjectNode, bucket: WorktreeBucket): boolean =>
    worktreeExpandedMap[`${node.project.id}::${bucket.key}`] ?? true;

  const resetBucketVisibleCount = (bucketKey: string) => {
    setVisibleCountByBucket((previous) => {
      if (!previous.has(bucketKey)) return previous;
      const next = new Map(previous);
      next.delete(bucketKey);
      return next;
    });
  };

  const resetProjectVisibleCounts = (projectId: string) => {
    setVisibleCountByBucket((previous) => {
      let changed = false;
      const next = new Map(previous);
      const prefix = `${projectId}::`;
      for (const key of next.keys()) {
        if (key.startsWith(prefix)) {
          next.delete(key);
          changed = true;
        }
      }
      return changed ? next : previous;
    });
  };

  const showMoreBucketSessions = (bucketKey: string, currentVisibleCount: number) => {
    setVisibleCountByBucket((previous) => {
      const next = new Map(previous);
      next.set(bucketKey, currentVisibleCount + SESSIONS_PER_BUCKET);
      return next;
    });
  };

  // Paginated, tree-aware list of a bucket's sessions: top-level sessions paginate,
  // and a parent with subsessions can be expanded to reveal its children (nested,
  // recursively). Pagination counts only top-level sessions.
  const renderBucketSessions = (node: ProjectNode, bucket: WorktreeBucket, indent: number) => {
    const bucketKey = `${node.project.id}::${bucket.key}`;

    // Group children by parent within this bucket, and treat sessions whose parent
    // is not in this bucket as top-level so nothing is hidden.
    const idsInBucket = new Set(bucket.sessions.map((entry) => entry.id));
    const childrenByParent = new Map<string, Session[]>();
    for (const candidate of bucket.sessions) {
      const parentId = getParentId(candidate);
      if (parentId && idsInBucket.has(parentId)) {
        const list = childrenByParent.get(parentId) ?? [];
        list.push(candidate);
        childrenByParent.set(parentId, list);
      }
    }
    const roots = bucket.sessions.filter((entry) => {
      const parentId = getParentId(entry);
      return !parentId || !idsInBucket.has(parentId);
    });

    const visibleCount = visibleCountByBucket.get(bucketKey) ?? SESSIONS_PER_BUCKET;
    const visibleRoots = roots.slice(0, visibleCount);
    const remaining = roots.length - visibleRoots.length;
    const canShowFewer = roots.length > SESSIONS_PER_BUCKET && remaining === 0;

    const renderNode = (session: Session, rowIndent: number): React.ReactNode => {
      const children = childrenByParent.get(session.id) ?? [];
      const hasChildren = children.length > 0;
      const expanded = Boolean(expandedParents[session.id]);
      return (
        <React.Fragment key={session.id}>
          <SessionRow
            session={session}
            active={currentSessionId === session.id}
            indent={rowIndent}
            hasChildren={hasChildren}
            expanded={expanded}
            onToggleChildren={hasChildren ? () => toggleParent(session.id) : undefined}
            onSelect={() => handleSelectSession(session)}
            revealed={revealedSessionId === session.id}
            onRevealedChange={(nextRevealed) => handleRowRevealedChange(session.id, nextRevealed)}
            confirmingDelete={confirmingDeleteSessionId === session.id}
            onArchive={() => void handleArchive(session)}
            onRequestDelete={() => setConfirmingDeleteSessionId(session.id)}
            onConfirmDelete={() => void handleConfirmDelete(session)}
            renaming={renamingSessionId === session.id}
            onRequestRename={() => handleRequestRename(session.id)}
            onSubmitRename={(nextTitle) => void handleSubmitRename(session.id, nextTitle)}
            onCancelRename={() => setRenamingSessionId(null)}
          />
          {hasChildren && expanded
            ? children.map((child) => renderNode(child, rowIndent + CHILD_INDENT_STEP))
            : null}
        </React.Fragment>
      );
    };

    return (
      <div>
        {visibleRoots.map((session) => renderNode(session, indent))}
        {remaining > 0 ? (
          <ShowMoreRow indent={indent} onClick={() => showMoreBucketSessions(bucketKey, visibleRoots.length)} />
        ) : null}
        {canShowFewer ? (
          <ShowFewerRow indent={indent} onClick={() => resetBucketVisibleCount(bucketKey)} />
        ) : null}
      </div>
    );
  };

  // Toggling resets the visible-session count for the affected buckets so a
  // re-expanded group starts from the default page again.
  const toggleProject = (projectId: string, currentlyExpanded: boolean) => {
    setProjectExpanded(projectId, !currentlyExpanded);
    resetProjectVisibleCounts(projectId);
  };

  const toggleWorktree = (projectId: string, bucketKey: string, currentlyExpanded: boolean) => {
    setWorktreeExpanded(`${projectId}::${bucketKey}`, !currentlyExpanded);
    resetBucketVisibleCount(`${projectId}::${bucketKey}`);
  };

  const handleSelectSession = (session: Session) => {
    const directory = getSessionDirectory(session) || null;
    // Switching session switches the working directory (handled by
    // setCurrentSession) — also move the active project so the rest of the app
    // and the active highlight follow the selected session, not just the draft.
    const project = findExactProjectMatch(projectsMeta, directory ?? '');
    if (project) {
      setActiveProjectIdOnly(project.id);
      // Expand the session's project (and worktree group) in the tree, so a
      // session picked from search is actually visible — and the open-time
      // auto-scroll can land on it — the next time the drawer opens.
      setProjectExpanded(project.id, true);
      const worktree = findExactWorktreeMatch(project, normalizePath(directory ?? ''));
      if (worktree) setWorktreeExpanded(`${project.id}::${normalizePath(worktree.path)}`, true);
    }
    void setCurrentSession(session.id, directory);
    onOpenChange(false);
  };

  // Swipe actions. Revealing a row disarms any pending delete confirm; archive
  // fires immediately (the swipe itself is the intent), delete stays two-step.
  const handleRowRevealedChange = (sessionId: string, nextRevealed: boolean) => {
    setRevealedSessionId(nextRevealed ? sessionId : null);
    setConfirmingDeleteSessionId(null);
    setRevealedRowId(null);
    setConfirmingRemoveProjectId(null);
  };

  // Same contract for group headers (project / worktree rows).
  const handleRowKeyRevealedChange = (rowKey: string, nextRevealed: boolean) => {
    setRevealedRowId(nextRevealed ? rowKey : null);
    setConfirmingRemoveProjectId(null);
    setRevealedSessionId(null);
    setConfirmingDeleteSessionId(null);
  };

  const handleArchive = async (session: Session) => {
    setRevealedSessionId(null);
    setConfirmingDeleteSessionId(null);
    const ok = await archiveSession(session.id);
    if (ok) toast.success(t('sessions.sidebar.session.archive.success'));
    else toast.error(t('sessions.sidebar.session.archive.error'));
  };

  const handleConfirmDelete = async (session: Session) => {
    setRevealedSessionId(null);
    setConfirmingDeleteSessionId(null);
    const ok = await deleteSession(session.id);
    if (ok) toast.success(t('sessions.sidebar.session.delete.success'));
    else toast.error(t('sessions.sidebar.session.delete.error'));
  };

  const handleRequestRename = (sessionId: string) => {
    setRevealedSessionId(null);
    setConfirmingDeleteSessionId(null);
    setRenamingSessionId(sessionId);
  };

  const handleSubmitRename = async (sessionId: string, title: string) => {
    setRenamingSessionId(null);
    try {
      await updateSessionTitle(sessionId, title);
    } catch {
      toast.error(t('mobile.sessions.renameError'));
    }
  };

  const handleStartNewChat = () => {
    openNewSessionDraft();
    onOpenChange(false);
  };

  const handleNewWorktree = (projectId: string) => {
    setWorktreeDialogProjectId(projectId);
    setActiveProjectIdOnly(projectId);
    setNewWorktreeDialogOpen(true);
  };

  const dndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleReorderDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const fromIndex = projectsMeta.findIndex((p) => p.id === active.id);
    const toIndex = projectsMeta.findIndex((p) => p.id === over.id);
    if (fromIndex < 0 || toIndex < 0) return;
    reorderProjects(fromIndex, toIndex);
  };

  const toggleReorderProjectExpanded = (projectId: string) => {
    setReorderExpandedProjects((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  };

  /** Short "Project · branch" string shown under the session title in search results. */
  const buildSessionContextLabel = React.useCallback(
    (session: Session): string => {
      const directory = getSessionDirectory(session);
      const project = findExactProjectMatch(projectsMeta, directory);
      if (!project) return getProjectLabel(directory) || directory;
      const matchedWorktree = findExactWorktreeMatch(project, normalizePath(directory));
      if (matchedWorktree?.branch) return `${project.label} · ${matchedWorktree.branch}`;
      return project.label;
    },
    [projectsMeta],
  );

  const handleSelectProject = (project: ProjectMeta) => {
    setActiveProject(project.id);
    onOpenChange(false);
  };

  const filteredNodes = React.useMemo(() => {
    if (!normalizedQuery) return projectNodes;
    return projectNodes.filter((node) => {
      if (`${node.project.label} ${node.project.path}`.toLowerCase().includes(normalizedQuery)) return true;
      return node.buckets.some((bucket) =>
        bucket.sessions.some((session) => sessionMatchesQuery(session, node.project.label, normalizedQuery)),
      );
    });
  }, [normalizedQuery, projectNodes]);

  // Preserve the store's project order. Reorder mode persists changes via
  // useProjectsStore.reorderProjects, which writes back to the same source we render here.
  const orderedNodes = filteredNodes;

  // Flat lists used only by the dedicated search-results view.
  const searchSessionMatches = React.useMemo(() => {
    if (!normalizedQuery) return [] as Session[];
    return orderSessionsByLifecycleScopes(
      sessions.filter((session) => {
        // Subsessions are implementation noise in a flat search list — only
        // top-level sessions are searchable.
        if (getParentId(session)) return false;
        const directory = getSessionDirectory(session);
        const project = findExactProjectMatch(projectsMeta, directory);
        return sessionMatchesQuery(session, project?.label ?? '', normalizedQuery);
      }),
      pinnedSessionIds,
      sessionOrderRanks,
    );
  }, [normalizedQuery, pinnedSessionIds, projectsMeta, sessionOrderRanks, sessions]);

  const searchProjectMatches = React.useMemo(() => {
    if (!normalizedQuery) return [] as Array<ProjectMeta & { sessionCount: number }>;
    return projectsMeta
      .filter((project) => `${project.label} ${project.path}`.toLowerCase().includes(normalizedQuery))
      .map((project) => ({
        ...project,
        sessionCount: sessions.filter((session) => {
          if (getParentId(session)) return false;
          const directory = normalizePath(getSessionDirectory(session));
          return projectMatchesExactDirectory(project, directory);
        }).length,
      }));
  }, [normalizedQuery, projectsMeta, sessions]);

  const hasNoMatches =
    normalizedQuery && searchSessionMatches.length === 0 && searchProjectMatches.length === 0;
  const canEditOrder = !normalizedQuery && projectsMeta.length > 1;

  const editToggle = canEditOrder ? (
    <Button
      type="button"
      variant="chip"
      size="sm"
      aria-label={editingOrder ? t('mobile.sessions.doneEditing') : t('mobile.sessions.editOrder')}
      aria-pressed={editingOrder}
      onClick={() => setEditingOrder((value) => !value)}
      style={{ touchAction: 'manipulation' }}
    >
      {editingOrder ? <RiCheckLine className="size-4" /> : <RiEdit2Line className="size-4" />}
    </Button>
  ) : null;

  const newChatButton =
    !editingOrder && projectsMeta.length > 0 ? (
      <Button
        type="button"
        variant="default"
        size="sm"
        aria-label={t('mobile.sessions.newChat')}
        onClick={handleStartNewChat}
        style={{ touchAction: 'manipulation' }}
      >
        <RiAddLine className="size-4" />
        {t('mobile.sessions.newChat')}
      </Button>
    ) : null;

  const addProjectButton = !editingOrder ? (
    <Button
      type="button"
      variant="chip"
      size="sm"
      aria-label={t('sessions.sidebar.header.actions.addProject')}
      title={t('sessions.sidebar.header.actions.addProject')}
      onClick={() => setDirectoryDialogOpen(true)}
      style={{ touchAction: 'manipulation' }}
    >
      <RiFolderAddLine className="size-4" />
    </Button>
  ) : null;

  const trailingActions =
    newChatButton || addProjectButton || editToggle ? (
      <>
        {newChatButton}
        {addProjectButton}
        {editToggle}
      </>
    ) : null;

  const surfaceContent = (
      <div ref={contentRootRef} className="flex h-full flex-col">
        <ScrollShadow className="min-h-0 flex-1 overflow-y-auto pb-4">
          {/* The search bar scrolls WITH the list (iOS-style): the open-time
              auto-scroll to the current session naturally tucks it away, and
              scrolling to the very top brings it back. */}
          <div className={cn('px-4 pb-2 pt-1', editingOrder && 'hidden')}>
            <div className="relative">
              <RiSearchLine className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('mobile.sessions.search.placeholder')}
                className={cn('h-11 pl-9', query && 'pr-10')}
              />
              {query ? (
                <button
                  type="button"
                  className="absolute right-1.5 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  aria-label={t('mobile.sessions.clearSearchAria')}
                  onClick={() => setQuery('')}
                  style={{ touchAction: 'manipulation' }}
                >
                  <RiCloseLine className="size-4" />
                </button>
              ) : null}
            </div>
          </div>
          {projectsMeta.length === 0 ? (
            <MobileSessionsEmpty
              title={t('mobile.sessions.empty.noProjectsTitle')}
              description={t('mobile.sessions.empty.noProjectsDescription')}
              action={
                <button
                  type="button"
                  className="flex items-center justify-center gap-2 rounded-2xl bg-primary px-5 py-3 typography-ui-label text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  onClick={() => setDirectoryDialogOpen(true)}
                >
                  <RiFolderAddLine className="size-4" />
                  {t('sessions.sidebar.header.actions.addProject')}
                </button>
              }
            />
          ) : hasNoMatches ? (
            <MobileSessionsEmpty
              title={t('mobile.sessions.empty.searchTitle')}
              description={t('mobile.sessions.empty.searchDescription')}
            />
          ) : normalizedQuery && !editingOrder ? (
            <div className="flex flex-col gap-3 px-3 pt-2">
              {searchSessionMatches.length > 0 ? (
                <section>
                  <div className="flex items-center justify-between px-1 pb-1.5">
                    <span className="typography-micro font-semibold uppercase tracking-wider text-muted-foreground">
                      {t('mobile.sessions.search.section.sessions')}
                    </span>
                    <span className="typography-micro text-muted-foreground tabular-nums">
                      {searchSessionMatches.length}
                    </span>
                  </div>
                  <div className="overflow-hidden rounded-2xl border border-border/70 bg-[var(--surface-elevated)]">
                    {searchSessionMatches.map((session, index) => (
                      <div key={session.id} className={cn(index > 0 && 'border-t border-border/70')}>
                        <SessionRow
                          session={session}
                          active={currentSessionId === session.id}
                          indent={12}
                          contextLabel={buildSessionContextLabel(session)}
                          onSelect={() => handleSelectSession(session)}
                        />
                      </div>
                    ))}
                  </div>
                </section>
              ) : null}

              {searchProjectMatches.length > 0 ? (
                <section>
                  <div className="flex items-center justify-between px-1 pb-1.5">
                    <span className="typography-micro font-semibold uppercase tracking-wider text-muted-foreground">
                      {t('mobile.sessions.search.section.projects')}
                    </span>
                    <span className="typography-micro text-muted-foreground tabular-nums">
                      {searchProjectMatches.length}
                    </span>
                  </div>
                  <div className="overflow-hidden rounded-2xl border border-border/70 bg-[var(--surface-elevated)]">
                    {searchProjectMatches.map((project, index) => (
                      <div
                        key={project.id}
                        className={cn('flex items-center', index > 0 && 'border-t border-border/70')}
                      >
                        <button
                          type="button"
                          className="flex min-h-12 min-w-0 flex-1 items-center gap-3 px-3 py-1.5 text-left transition-colors hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset"
                          onClick={() => handleSelectProject(project)}
                          style={{ touchAction: 'manipulation' }}
                        >
                          <MobileProjectIcon project={project} />
                          <span className="block min-w-0 flex-1 truncate typography-ui-label text-foreground">
                            {project.label}
                          </span>
                          <span className="shrink-0 typography-micro text-muted-foreground tabular-nums">
                            {project.sessionCount}
                          </span>
                        </button>
                        {project.isGitRepo ? (
                          <NewWorktreeIconButton
                            className="mr-2"
                            onClick={() => handleNewWorktree(project.id)}
                          />
                        ) : null}
                      </div>
                    ))}
                  </div>
                </section>
              ) : null}
            </div>
          ) : editingOrder ? (
            <div className="flex flex-col gap-2 px-3 py-2">
              <p className="px-1 typography-micro text-muted-foreground">
                {t('mobile.sessions.editOrderHint')}
              </p>
              <DndContext sensors={dndSensors} collisionDetection={closestCenter} onDragEnd={handleReorderDragEnd}>
                <SortableContext
                  items={projectsMeta.map((p) => p.id)}
                  strategy={verticalListSortingStrategy}
                >
                  <div className="flex flex-col gap-1.5">
                    {projectsMeta.map((project) => {
                      const node = projectNodes.find((n) => n.project.id === project.id);
                      return (
                        <SortableProjectRow
                          key={project.id}
                          project={project}
                          totalSessions={node?.totalSessions ?? 0}
                          expanded={reorderExpandedProjects.has(project.id)}
                          onToggleExpanded={() => toggleReorderProjectExpanded(project.id)}
                          onReorderWorktrees={(orderedPaths) => setWorktreeOrder(project.id, orderedPaths)}
                        />
                      );
                    })}
                  </div>
                </SortableContext>
              </DndContext>
            </div>
          ) : (
            <div className="flex flex-col">
              {orderedNodes.map((node, nodeIndex) => {
                const projectExpanded = isProjectExpanded(node);
                const buckets = normalizedQuery
                  ? node.buckets.filter((bucket) =>
                      bucket.sessions.some((session) =>
                        sessionMatchesQuery(session, node.project.label, normalizedQuery),
                      ),
                    )
                  : node.buckets;
                const activeWorktreePath = findActiveWorktreePath(node);
                return (
                  <section
                    key={node.project.id}
                    className={cn(nodeIndex > 0 && 'border-t border-border/70')}
                  >
                    <MobileSwipeActionsRow
                      actionsWidth={96}
                      revealed={revealedRowId === `project:${node.project.id}`}
                      onRevealedChange={(nextRevealed) => handleRowKeyRevealedChange(`project:${node.project.id}`, nextRevealed)}
                      actions={(
                        <>
                          <button
                            type="button"
                            tabIndex={revealedRowId === `project:${node.project.id}` ? 0 : -1}
                            className="flex flex-1 items-center justify-center text-muted-foreground transition-colors active:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
                            aria-label={t('mobile.sessions.editProjectAria', { label: node.project.label })}
                            onClick={() => {
                              setRevealedRowId(null);
                              setEditingProjectId(node.project.id);
                            }}
                            style={{ touchAction: 'manipulation' }}
                          >
                            <RiEdit2Line className="size-[18px]" />
                          </button>
                          <button
                            type="button"
                            tabIndex={revealedRowId === `project:${node.project.id}` ? 0 : -1}
                            className={cn(
                              'flex flex-1 items-center justify-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-destructive',
                              confirmingRemoveProjectId === node.project.id
                                ? 'rounded-lg bg-destructive text-destructive-foreground'
                                : 'text-[var(--status-error)] active:opacity-80',
                            )}
                            aria-label={confirmingRemoveProjectId === node.project.id
                              ? t('mobile.sessions.confirmRemoveProjectAria', { label: node.project.label })
                              : t('mobile.sessions.removeProjectAria', { label: node.project.label })}
                            onClick={() => {
                              if (confirmingRemoveProjectId === node.project.id) {
                                setRevealedRowId(null);
                                setConfirmingRemoveProjectId(null);
                                removeProject(node.project.id);
                                toast.success(t('mobile.sessions.toast.projectRemoved', { label: node.project.label }));
                                return;
                              }
                              setConfirmingRemoveProjectId(node.project.id);
                            }}
                            style={{ touchAction: 'manipulation' }}
                          >
                            <RiDeleteBinLine className="size-[18px]" />
                          </button>
                        </>
                      )}
                    >
                      <div data-active-project={node.isActive || undefined} className="flex min-h-12 w-full items-center">
                        <button
                          type="button"
                          className="flex min-h-12 min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset"
                          onClick={() => {
                            if (revealedRowId) {
                              handleRowKeyRevealedChange(revealedRowId, false);
                              return;
                            }
                            toggleProject(node.project.id, projectExpanded);
                          }}
                          aria-expanded={projectExpanded}
                          aria-label={
                            projectExpanded
                              ? t('sessions.sidebar.group.collapseAria', { label: node.project.label })
                              : t('sessions.sidebar.group.expandAria', { label: node.project.label })
                          }
                          style={{ touchAction: 'manipulation' }}
                        >
                          <MobileProjectIcon project={node.project} />
                          <span className="block min-w-0 flex-1 truncate typography-ui-label font-semibold text-foreground">
                            {node.project.label}
                          </span>
                          {node.isActive ? <ActiveDot ariaLabel={t('mobile.sessions.activeProjectAria')} /> : null}
                          <span className="shrink-0 typography-micro text-muted-foreground tabular-nums">
                            {node.totalSessions}
                          </span>
                        </button>
                        {node.project.isGitRepo ? (
                          <NewWorktreeIconButton
                            className="mr-2"
                            onClick={() => handleNewWorktree(node.project.id)}
                          />
                        ) : null}
                      </div>
                    </MobileSwipeActionsRow>

                    {projectExpanded ? (
                      <div className="pb-2">
                        {(() => {
                          // Root (project-level) sessions always render as a flat list
                          // at the top — same as a project without worktrees — never
                          // hidden behind a worktree-style group.
                          const rootBucket = buckets.find((bucket) => bucket.worktree === null);
                          const worktreeBuckets = buckets.filter((bucket) => bucket.worktree !== null);
                          return (
                            <>
                              {rootBucket && rootBucket.sessions.length > 0
                                ? renderBucketSessions(node, rootBucket, PROJECT_SESSION_INDENT)
                                : null}
                              {worktreeBuckets.map((bucket) => {
                                const worktreeExpanded = isWorktreeExpanded(node, bucket);
                                const isActiveWt = activeWorktreePath === bucket.path;
                                return (
                                  <div key={bucket.key}>
                                    <MobileSwipeActionsRow
                                      actionsWidth={48}
                                      revealed={revealedRowId === `wt:${bucket.key}`}
                                      onRevealedChange={(nextRevealed) => handleRowKeyRevealedChange(`wt:${bucket.key}`, nextRevealed)}
                                      actions={(
                                        <button
                                          type="button"
                                          tabIndex={revealedRowId === `wt:${bucket.key}` ? 0 : -1}
                                          className="flex flex-1 items-center justify-center text-[var(--status-error)] transition-colors active:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-destructive"
                                          aria-label={t('mobile.projectEdit.deleteWorktreeAria', { label: bucket.label })}
                                          onClick={() => {
                                            setRevealedRowId(null);
                                            if (bucket.worktree) {
                                              setWorktreeToDelete({ project: node.project, worktree: bucket.worktree });
                                            }
                                          }}
                                          style={{ touchAction: 'manipulation' }}
                                        >
                                          <RiDeleteBinLine className="size-[18px]" />
                                        </button>
                                      )}
                                    >
                                    <button
                                      type="button"
                                      className="flex min-h-10 w-full items-center gap-2 px-3 py-1 text-left transition-colors hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset"
                                      onClick={() => {
                                        if (revealedRowId) {
                                          handleRowKeyRevealedChange(revealedRowId, false);
                                          return;
                                        }
                                        toggleWorktree(node.project.id, bucket.key, worktreeExpanded);
                                      }}
                                      aria-expanded={worktreeExpanded}
                                      aria-label={
                                        worktreeExpanded
                                          ? t('sessions.sidebar.group.collapseAria', { label: bucket.label })
                                          : t('sessions.sidebar.group.expandAria', { label: bucket.label })
                                      }
                                      style={{ touchAction: 'manipulation' }}
                                    >
                                      {/* Desktop visual language: muted semibold
                                          branch label + git-branch icon, so
                                          worktree headers recede while plain-
                                          foreground session titles stand out. */}
                                      <Icon
                                        name="git-branch"
                                        className={cn(
                                          'size-4 shrink-0',
                                          isActiveWt ? 'text-primary' : 'text-muted-foreground',
                                        )}
                                      />
                                      <span
                                        className={cn(
                                          'block min-w-0 flex-1 truncate typography-ui-label font-bold',
                                          isActiveWt ? 'text-foreground' : 'text-muted-foreground',
                                        )}
                                      >
                                        {bucket.label}
                                      </span>
                                      {isActiveWt ? (
                                        <ActiveDot ariaLabel={t('mobile.sessions.activeWorktreeAria')} />
                                      ) : null}
                                      <span className="shrink-0 typography-micro text-muted-foreground tabular-nums">
                                        {bucket.sessions.length}
                                      </span>
                                    </button>
                                    </MobileSwipeActionsRow>
                                    {worktreeExpanded
                                      ? renderBucketSessions(node, bucket, PROJECT_SESSION_INDENT)
                                      : null}
                                  </div>
                                );
                              })}
                            </>
                          );
                        })()}
                      </div>
                    ) : null}
                  </section>
                );
              })}
            </div>
          )}
        </ScrollShadow>

        {/* App-level footer: instance on the left (Capacitor), settings —
            plus a pending web update — on the right. Bottom placement keeps
            the header for list actions and stays thumb-reachable. */}
        {footer ? (
          <div
            className="flex shrink-0 items-center justify-between gap-2 border-t border-border/70 px-2 pt-1.5"
            style={{ paddingBottom: 'calc(0.375rem + var(--oc-safe-area-bottom, 0px))' }}
          >
            {footer.instanceLabel && footer.onOpenInstances ? (
              <button
                type="button"
                className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-xl px-2 text-left transition-colors hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
                onClick={footer.onOpenInstances}
                aria-label={t('mobile.menu.instances')}
                style={{ touchAction: 'manipulation' }}
              >
                <Icon name="server" className="size-[18px] shrink-0 text-muted-foreground" />
                <span className="block min-w-0 truncate typography-ui-label text-foreground">
                  {footer.instanceLabel}
                </span>
              </button>
            ) : (
              <div className="min-w-0 flex-1" />
            )}
            <div className="flex shrink-0 items-center gap-1">
              {footer.onOpenUpdate ? (
                <button
                  type="button"
                  className="relative flex size-10 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  onClick={footer.onOpenUpdate}
                  aria-label={t('mobile.menu.update')}
                  title={t('mobile.menu.update')}
                  style={{ touchAction: 'manipulation' }}
                >
                  <Icon name="download" className="size-5" />
                  <span className="absolute right-2 top-2 inline-flex size-2 rounded-full bg-primary" aria-hidden />
                </button>
              ) : null}
              <button
                type="button"
                className="flex size-10 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                onClick={footer.onOpenSettings}
                aria-label={t('mobile.menu.settings')}
                title={t('mobile.menu.settings')}
                style={{ touchAction: 'manipulation' }}
              >
                <Icon name="settings-3" className="size-5" />
              </button>
            </div>
          </div>
        ) : null}

        <DirectoryExplorerDialog open={directoryDialogOpen} onOpenChange={setDirectoryDialogOpen} />
        <NewWorktreeDialog
          open={newWorktreeDialogOpen}
          onOpenChange={(value) => {
            setNewWorktreeDialogOpen(value);
            if (!value) setWorktreeDialogProjectId(null);
          }}
          onWorktreeCreated={(worktreePath, options) => {
            if (options?.sessionId) void setCurrentSession(options.sessionId, worktreePath);
            else
              openNewSessionDraft({
                selectedProjectId: worktreeDialogProjectId,
                directoryOverride: worktreePath,
                preserveDirectoryOverride: true,
              });
            onOpenChange(false);
          }}
        />
        <MobileProjectEditSurface
          open={editingProjectId !== null}
          project={projectsMeta.find((entry) => entry.id === editingProjectId) ?? null}
          onClose={() => setEditingProjectId(null)}
          onWorktreesChanged={() => setWorktreeRefreshKey((value) => value + 1)}
        />
        {worktreeToDelete ? (
          <MobileDeleteWorktreeDialog
            open
            project={{ id: worktreeToDelete.project.id, path: worktreeToDelete.project.path }}
            worktree={worktreeToDelete.worktree}
            onClose={() => setWorktreeToDelete(null)}
            onDeleted={() => setWorktreeRefreshKey((value) => value + 1)}
          />
        ) : null}
      </div>
  );

  if (variant === 'sidebar') {
    if (!open) return null;
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex h-[var(--oc-header-height,56px)] shrink-0 items-center justify-between gap-2 border-b border-border/70 px-4">
          <h2 className="truncate typography-ui-label font-semibold text-foreground">
            {t('mobile.sessions.sheet.title')}
          </h2>
          {trailingActions ? (
            <div className="flex shrink-0 items-center gap-2">{trailingActions}</div>
          ) : null}
        </div>
        {surfaceContent}
      </div>
    );
  }

  return (
    <MobileSessionsDrawerContainer
      open={open}
      onClose={() => onOpenChange(false)}
      ariaLabel={t('mobile.sessions.sheet.title')}
    >
      <div className="flex h-[var(--oc-header-height,56px)] shrink-0 items-center gap-2 px-3">
        <button
          type="button"
          className="-ml-1 flex size-10 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          aria-label={t('mobile.surface.closeAria')}
          onClick={() => onOpenChange(false)}
          style={{ touchAction: 'manipulation' }}
        >
          <Icon name="close" className="size-5" />
        </button>
        <h2 className="min-w-0 flex-1 truncate px-1 typography-ui-label font-semibold text-foreground">
          {t('mobile.sessions.sheet.title')}
        </h2>
        {trailingActions ? (
          <div className="flex shrink-0 items-center gap-2">{trailingActions}</div>
        ) : null}
      </div>
      {surfaceContent}
    </MobileSessionsDrawerContainer>
  );
};

const DRAWER_ROOT_ID = 'mobile-surface-root';
const DRAWER_ENTER_DELAY_MS = 16;
// Slightly long, decelerating slide — matches the workspace drawer so both
// sides feel like the same piece of chrome.
const DRAWER_ENTER_DURATION_MS = 320;
const DRAWER_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)';

/** Full-width left drawer for the phone sessions list: covers the whole app
    and slides in from the left edge. Closes via the header X, Escape, or the
    Android back button (handled by MobileShell).

    Stays MOUNTED while closed (parked off-screen, hidden): the sessions
    sheet's project/worktree state stays warm, so reopening shows the tree
    instantly instead of refetching from scratch — and the close slide can
    actually play instead of the drawer vanishing on unmount. */
const MobileSessionsDrawerContainer: React.FC<{
  open: boolean;
  onClose: () => void;
  ariaLabel: string;
  children: React.ReactNode;
}> = ({ open, onClose, ariaLabel, children }) => {
  const rootRef = React.useRef<HTMLElement | null>(null);
  const [entered, setEntered] = React.useState(false);
  // Kept visible through the exit slide; flipped to hidden once it finishes.
  const [visible, setVisible] = React.useState(open);
  const onCloseRef = React.useRef(onClose);
  React.useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  if (typeof document !== 'undefined' && !rootRef.current) {
    let root = document.getElementById(DRAWER_ROOT_ID);
    if (!root) {
      root = document.createElement('div');
      root.id = DRAWER_ROOT_ID;
      document.body.appendChild(root);
    }
    rootRef.current = root;
  }

  React.useEffect(() => {
    if (open) {
      setVisible(true);
      const id = window.setTimeout(() => setEntered(true), DRAWER_ENTER_DELAY_MS);
      return () => window.clearTimeout(id);
    }
    setEntered(false);
    const id = window.setTimeout(() => setVisible(false), DRAWER_ENTER_DURATION_MS + 40);
    return () => window.clearTimeout(id);
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCloseRef.current();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  if (!rootRef.current) return null;

  return createPortal(
    <section
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      aria-hidden={!open}
      className="oc-keyboard-inset-surface fixed inset-0 z-50 flex flex-col bg-background text-foreground"
      style={{
        paddingTop: 'var(--oc-safe-area-top, 0px)',
        // Settled state drops the transform entirely so the drawer isn't kept
        // on a compositing layer (iOS clips those to the safe-area viewport).
        transform: entered ? 'none' : 'translateX(-100%)',
        transition: `transform ${DRAWER_ENTER_DURATION_MS}ms ${DRAWER_EASING}`,
        visibility: visible ? 'visible' : 'hidden',
        pointerEvents: open ? 'auto' : 'none',
      }}
    >
      <div className="flex h-full min-h-0 flex-col">
        {children}
      </div>
    </section>,
    rootRef.current,
  );
};

const MobileSessionsEmpty: React.FC<{
  title: string;
  description?: string;
  action?: React.ReactNode;
}> = ({ title, description, action }) => (
  <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
    <p className="typography-ui-label text-foreground">{title}</p>
    {description ? <p className="typography-meta text-muted-foreground">{description}</p> : null}
    {action ? <div className="pt-2">{action}</div> : null}
  </div>
);
