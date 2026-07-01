import React from 'react';
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
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useI18n } from '@/lib/i18n';
import { PROJECT_COLOR_MAP, PROJECT_ICON_MAP, ProjectIconImage } from '@/lib/projectMeta';
import { cn } from '@/lib/utils';
import { listProjectWorktrees } from '@/lib/worktrees/worktreeManager';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { mergeLiveSessionWithGlobalSession, refreshGlobalSessions, useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useMobileSessionExpansionStore } from '@/stores/useMobileSessionExpansionStore';
import { useMobileSessionTreeStore } from '@/stores/useMobileSessionTreeStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { orderWorktrees, useWorktreeOrderStore } from '@/stores/useWorktreeOrderStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useAllLiveSessions } from '@/sync/sync-context';
import type { WorktreeMetadata } from '@/types/worktree';

import { MobileProjectEditSurface } from './MobileProjectEditSurface';
import { MobileSurfaceShell } from './MobileSurfaceShell';

type MobileSessionsSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

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
const PROJECT_SESSION_INDENT = 36;
const WORKTREE_SESSION_INDENT = 52;
// Extra left padding applied to each nested subsession level.
const CHILD_INDENT_STEP = 18;

const getParentId = (session: Session): string | null =>
  (session as Session & { parentID?: string | null }).parentID ?? null;

const normalizePath = (value?: string | null): string =>
  (value || '').replace(/\\/g, '/').replace(/\/+$/g, '');

const getSessionDirectory = (session: Session): string => {
  const sessionWithDirectory = session as Session & {
    directory?: string | null;
    project?: { worktree?: string | null } | null;
  };
  return normalizePath(sessionWithDirectory.directory ?? sessionWithDirectory.project?.worktree ?? null);
};

const getProjectLabel = (path: string): string => {
  const normalized = normalizePath(path);
  if (!normalized) return '';
  const segments = normalized.split('/').filter(Boolean);
  return segments[segments.length - 1]?.replace(/[-_]/g, ' ') || normalized;
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

const ChevronToggle: React.FC<{ expanded: boolean }> = ({ expanded }) => (
  <span
    aria-hidden
    className={cn(
      'flex size-5 shrink-0 items-center justify-center text-muted-foreground/70 transition-transform duration-150',
      expanded ? 'rotate-0' : '-rotate-90',
    )}
  >
    <RiArrowDownSLine className="size-4" />
  </span>
);

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

const SessionRow: React.FC<{
  session: Session;
  active: boolean;
  indent: number;
  /** When provided, shown as a small second-line subtitle below the title (e.g. "Project · branch"). */
  contextLabel?: string;
  /** When true, the row shows the two-step archive confirmation. */
  confirmingArchive?: boolean;
  /** When true, a chevron is shown in the left gutter to toggle nested subsessions. */
  hasChildren?: boolean;
  expanded?: boolean;
  onToggleChildren?: () => void;
  onSelect: () => void;
  /** When provided, an archive affordance is shown; first tap arms confirm, X cancels. */
  onRequestArchive?: () => void;
  onConfirmArchive?: () => void;
}> = ({
  session,
  active,
  indent,
  contextLabel,
  confirmingArchive = false,
  hasChildren = false,
  expanded = false,
  onToggleChildren,
  onSelect,
  onRequestArchive,
  onConfirmArchive,
}) => {
  const { t } = useI18n();
  const time = formatRelativeShort(getSessionTimestamp(session));
  const title = session.title?.trim() || t('mobile.sessions.untitled');
  return (
    <div
      className={cn(
        'relative flex items-center gap-1 transition-colors',
        active && !confirmingArchive && 'bg-[color-mix(in_srgb,var(--primary)_10%,transparent)]',
        confirmingArchive && 'bg-[color-mix(in_srgb,var(--destructive)_8%,transparent)]',
      )}
    >
      {hasChildren && onToggleChildren ? (
        <button
          type="button"
          className="absolute z-10 flex w-6 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          style={{ left: Math.max(indent - 32, 2), top: 0, bottom: 0, touchAction: 'manipulation' }}
          aria-label={expanded
            ? t('sessions.sidebar.session.subsessions.collapse')
            : t('sessions.sidebar.session.subsessions.expand')}
          onClick={(event) => {
            event.stopPropagation();
            onToggleChildren();
          }}
        >
          <RiArrowDownSLine className={cn('size-[18px] transition-transform duration-150', expanded ? 'rotate-0' : '-rotate-90')} />
        </button>
      ) : null}
      <button
        type="button"
        className={cn(
          'flex min-h-12 min-w-0 flex-1 items-center gap-2.5 py-2 pr-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset',
          confirmingArchive && 'opacity-50',
        )}
        style={{ paddingLeft: indent, touchAction: 'manipulation' }}
        onClick={onSelect}
        disabled={confirmingArchive}
      >
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-center gap-2.5">
            <span
              className={cn(
                'size-1.5 shrink-0 rounded-full',
                active ? 'bg-primary' : 'bg-muted-foreground/30',
              )}
              aria-hidden
            />
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
            <span className="block truncate typography-micro text-muted-foreground pl-4">{contextLabel}</span>
          ) : null}
        </span>
      </button>
      {onRequestArchive ? (
        <>
          {confirmingArchive ? (
            <button
              type="button"
              className="flex h-9 shrink-0 items-center gap-1.5 rounded-xl bg-destructive px-3 text-destructive-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive"
              aria-label={t('mobile.sessions.archiveSessionAria', { title })}
              onClick={onConfirmArchive}
              style={{ touchAction: 'manipulation' }}
            >
              <RiArchiveLine className="size-4" />
              <span className="typography-ui-label">{t('sessions.sidebar.bulkActions.archive')}</span>
            </button>
          ) : null}
          <button
            type="button"
            className="mr-1.5 flex size-9 shrink-0 items-center justify-center rounded-xl text-muted-foreground/70 transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            aria-label={
              confirmingArchive
                ? t('mobile.sessions.cancelArchiveAria', { title })
                : t('mobile.sessions.archiveSessionAria', { title })
            }
            onClick={onRequestArchive}
            style={{ touchAction: 'manipulation' }}
          >
            {confirmingArchive ? <RiCloseLine className="size-4" /> : <RiArchiveLine className="size-4" />}
          </button>
        </>
      ) : null}
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
      className="flex min-h-10 w-full items-center gap-2 py-1.5 pr-3 text-left text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset"
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
      className="flex min-h-10 w-full items-center gap-2 py-1.5 pr-3 text-left text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset"
      style={{ paddingLeft: indent, touchAction: 'manipulation' }}
      onClick={onClick}
    >
      <RiArrowUpSLine className="size-4" />
      <span className="typography-micro">{t('sessions.sidebar.group.showFewer')}</span>
    </button>
  );
};

const SortableProjectRow: React.FC<{
  project: ProjectMeta;
  totalSessions: number;
  confirmingDelete: boolean;
  onEdit: () => void;
  onRequestRemove: () => void;
  onConfirmRemove: () => void;
}> = ({
  project,
  totalSessions,
  confirmingDelete,
  onEdit,
  onRequestRemove,
  onConfirmRemove,
}) => {
  const { t } = useI18n();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: project.id });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 10 : 1,
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        'flex items-center gap-1 rounded-2xl border border-border/40 bg-[var(--surface-elevated)] px-1.5 py-1.5 transition-colors',
        isDragging && 'shadow-lg shadow-black/20',
        confirmingDelete && 'border-destructive/50 bg-[color-mix(in_srgb,var(--destructive)_8%,var(--surface-elevated))]',
      )}
    >
      <button
        type="button"
        className="flex size-9 shrink-0 cursor-grab touch-none items-center justify-center rounded-xl text-muted-foreground/70 transition-colors hover:text-foreground active:cursor-grabbing"
        aria-label={t('mobile.sessions.dragHandleAria', { label: project.label })}
        {...attributes}
        {...listeners}
      >
        <RiDragMove2Line className="size-4" />
      </button>
      <MobileProjectIcon project={project} />
      <span className="block min-w-0 flex-1 truncate typography-ui-label text-foreground">{project.label}</span>
      {confirmingDelete ? (
        <button
          type="button"
          className="flex h-9 shrink-0 items-center gap-1.5 rounded-xl bg-destructive px-3 text-destructive-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive"
          aria-label={t('mobile.sessions.confirmRemoveProjectAria', { label: project.label })}
          onClick={onConfirmRemove}
          style={{ touchAction: 'manipulation' }}
        >
          <RiDeleteBinLine className="size-4" />
          <span className="typography-ui-label">{t('mobile.sessions.confirmRemoveProject')}</span>
        </button>
      ) : (
        <>
          <span className="shrink-0 typography-micro text-muted-foreground tabular-nums">{totalSessions}</span>
          <button
            type="button"
            className="flex size-9 shrink-0 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            aria-label={t('mobile.sessions.editProjectAria', { label: project.label })}
            onClick={onEdit}
            style={{ touchAction: 'manipulation' }}
          >
            <RiEdit2Line className="size-4" />
          </button>
        </>
      )}
      <button
        type="button"
        className={cn(
          'flex size-9 shrink-0 items-center justify-center rounded-xl transition-colors focus-visible:outline-none focus-visible:ring-2',
          confirmingDelete
            ? 'text-muted-foreground hover:bg-interactive-hover hover:text-foreground focus-visible:ring-primary'
            : 'text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:ring-destructive',
        )}
        aria-label={
          confirmingDelete
            ? t('mobile.sessions.cancelRemoveProjectAria', { label: project.label })
            : t('mobile.sessions.removeProjectAria', { label: project.label })
        }
        onClick={onRequestRemove}
        style={{ touchAction: 'manipulation' }}
      >
        {confirmingDelete ? <RiCloseLine className="size-4" /> : <RiDeleteBinLine className="size-4" />}
      </button>
    </div>
  );
};

export const MobileSessionsSheet: React.FC<MobileSessionsSheetProps> = ({ open, onOpenChange }) => {
  const { t } = useI18n();
  const { git } = useRuntimeAPIs();
  const liveSessions = useAllLiveSessions();
  const globalActiveSessions = useGlobalSessionsStore((state) => state.activeSessions);
  const projects = useProjectsStore((state) => state.projects);
  const activeProjectId = useProjectsStore((state) => state.activeProjectId);
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const setCurrentSession = useSessionUIStore((state) => state.setCurrentSession);
  const archiveSession = useSessionUIStore((state) => state.archiveSession);
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
  const expandedParents = useMobileSessionExpansionStore((state) => state.expandedParents);
  const toggleParent = useMobileSessionExpansionStore((state) => state.toggleParent);
  const [query, setQuery] = React.useState('');
  const [editingProjectId, setEditingProjectId] = React.useState<string | null>(null);
  const [confirmingArchiveSessionId, setConfirmingArchiveSessionId] = React.useState<string | null>(null);
  // Bumped to force a re-list of worktrees (e.g. after one is deleted in the editor).
  const [worktreeRefreshKey, setWorktreeRefreshKey] = React.useState(0);
  const [directoryDialogOpen, setDirectoryDialogOpen] = React.useState(false);
  const [newWorktreeDialogOpen, setNewWorktreeDialogOpen] = React.useState(false);
  const [worktreeDialogProjectId, setWorktreeDialogProjectId] = React.useState<string | null>(null);
  const [worktreesByProject, setWorktreesByProject] = React.useState<Map<string, WorktreeMetadata[]>>(new Map());
  const [gitProjectPaths, setGitProjectPaths] = React.useState<Set<string>>(new Set());
  const [editingOrder, setEditingOrder] = React.useState(false);
  const [confirmingDeleteId, setConfirmingDeleteId] = React.useState<string | null>(null);
  // Per-bucket count of sessions revealed past the default page. Ephemeral —
  // resets when the sheet closes or when a group/project is toggled. Expand
  // state itself lives in useMobileSessionTreeStore (persisted).
  // Key: `${projectId}::${bucketKey}`.
  const [visibleCountByBucket, setVisibleCountByBucket] = React.useState<Map<string, number>>(new Map());

  React.useEffect(() => {
    if (!open) {
      setQuery('');
      setEditingOrder(false);
      setConfirmingDeleteId(null);
      setVisibleCountByBucket(new Map());
      setEditingProjectId(null);
      setConfirmingArchiveSessionId(null);
      return;
    }
    void refreshGlobalSessions(liveSessions);
    // intentionally only on open transition — live overlay handles updates after that
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  React.useEffect(() => {
    if (!editingOrder) setConfirmingDeleteId(null);
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
      const next = new Map<string, WorktreeMetadata[]>();
      const nextGitProjectPaths = new Set<string>();
      for (const entry of entries) {
        if (entry) {
          next.set(entry[0], entry[1]);
          if (entry[2]) nextGitProjectPaths.add(entry[0]);
        }
      }
      setWorktreesByProject(next);
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
    return merged;
  }, [globalActiveSessions, liveSessions]);

  const normalizedQuery = query.trim().toLowerCase();

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
        bucket.sessions.sort((a, b) => getSessionTimestamp(b) - getSessionTimestamp(a));
        for (const session of bucket.sessions) {
          if (!getParentId(session)) node.totalSessions += 1;
        }
      }
    }

    return nodes;
  }, [activeProjectId, projectsMeta, sessions]);

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

  const isWorktreeExpanded = (node: ProjectNode, bucket: WorktreeBucket): boolean =>
    worktreeExpandedMap[`${node.project.id}::${bucket.key}`] ?? false;

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
            confirmingArchive={confirmingArchiveSessionId === session.id}
            onSelect={() => handleSelectSession(session)}
            onRequestArchive={() => handleRequestArchive(session.id)}
            onConfirmArchive={() => void handleConfirmArchive(session)}
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
    if (project) setActiveProjectIdOnly(project.id);
    void setCurrentSession(session.id, directory);
    onOpenChange(false);
  };

  // Two-step archive: first tap arms the confirm on that row, second confirms.
  // Only one row can be in the confirming state at a time.
  const handleRequestArchive = (sessionId: string) => {
    setConfirmingArchiveSessionId((current) => (current === sessionId ? null : sessionId));
  };

  const handleConfirmArchive = async (session: Session) => {
    setConfirmingArchiveSessionId(null);
    const ok = await archiveSession(session.id);
    if (ok) toast.success(t('sessions.sidebar.session.archive.success'));
    else toast.error(t('sessions.sidebar.session.archive.error'));
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
    setConfirmingDeleteId(null);
    if (!over || active.id === over.id) return;
    const fromIndex = projectsMeta.findIndex((p) => p.id === active.id);
    const toIndex = projectsMeta.findIndex((p) => p.id === over.id);
    if (fromIndex < 0 || toIndex < 0) return;
    reorderProjects(fromIndex, toIndex);
  };

  const handleRequestRemoveProject = (projectId: string) => {
    setConfirmingDeleteId((current) => (current === projectId ? null : projectId));
  };

  const handleConfirmRemoveProject = (project: ProjectMeta) => {
    removeProject(project.id);
    setConfirmingDeleteId(null);
    toast.success(t('mobile.sessions.toast.projectRemoved', { label: project.label }));
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
    return sessions
      .filter((session) => {
        const directory = getSessionDirectory(session);
        const project = findExactProjectMatch(projectsMeta, directory);
        return sessionMatchesQuery(session, project?.label ?? '', normalizedQuery);
      })
      .sort((a, b) => getSessionTimestamp(b) - getSessionTimestamp(a));
  }, [normalizedQuery, projectsMeta, sessions]);

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

  return (
    <MobileSurfaceShell
      open={open}
      onClose={() => onOpenChange(false)}
      ariaLabel={t('mobile.sessions.sheet.title')}
      title={t('mobile.sessions.sheet.title')}
      trailing={trailingActions}
    >
      <div className="flex h-full flex-col">
        <div className={cn('shrink-0 px-4 pb-2 pt-1', editingOrder && 'hidden')}>
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

        <ScrollShadow className="min-h-0 flex-1 overflow-y-auto pb-4">
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
                  <div className="overflow-hidden rounded-2xl border border-border/40 bg-[var(--surface-elevated)]">
                    {searchSessionMatches.map((session, index) => (
                      <div key={session.id} className={cn(index > 0 && 'border-t border-border/30')}>
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
                  <div className="overflow-hidden rounded-2xl border border-border/40 bg-[var(--surface-elevated)]">
                    {searchProjectMatches.map((project, index) => (
                      <div
                        key={project.id}
                        className={cn('flex items-center', index > 0 && 'border-t border-border/30')}
                      >
                        <button
                          type="button"
                          className="flex min-h-14 min-w-0 flex-1 items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset"
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
                          confirmingDelete={confirmingDeleteId === project.id}
                          onEdit={() => setEditingProjectId(project.id)}
                          onRequestRemove={() => handleRequestRemoveProject(project.id)}
                          onConfirmRemove={() => handleConfirmRemoveProject(project)}
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
                    className={cn(nodeIndex > 0 && 'border-t border-border/30')}
                  >
                    <div className="flex min-h-14 w-full items-center">
                      <button
                        type="button"
                        className="flex min-h-14 min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset"
                        onClick={() => toggleProject(node.project.id, projectExpanded)}
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
                                    <button
                                      type="button"
                                      className="flex min-h-11 w-full items-center gap-2 py-1.5 pl-4 pr-3 text-left transition-colors hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset"
                                      onClick={() => toggleWorktree(node.project.id, bucket.key, worktreeExpanded)}
                                      aria-expanded={worktreeExpanded}
                                      aria-label={
                                        worktreeExpanded
                                          ? t('sessions.sidebar.group.collapseAria', { label: bucket.label })
                                          : t('sessions.sidebar.group.expandAria', { label: bucket.label })
                                      }
                                      style={{ touchAction: 'manipulation' }}
                                    >
                                      <ChevronToggle expanded={worktreeExpanded} />
                                      <Icon
                                        name="node-tree"
                                        className={cn(
                                          'size-4 shrink-0',
                                          isActiveWt ? 'text-primary' : 'text-muted-foreground',
                                        )}
                                      />
                                      <span
                                        className={cn(
                                          'block min-w-0 flex-1 truncate typography-ui-label font-semibold',
                                          isActiveWt ? 'text-foreground' : 'text-foreground/90',
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
                                    {worktreeExpanded
                                      ? renderBucketSessions(node, bucket, WORKTREE_SESSION_INDENT)
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
      </div>
    </MobileSurfaceShell>
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
