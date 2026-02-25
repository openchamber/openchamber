import React from 'react';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type Modifier,
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  RiFolderAddLine,
  RiSettings3Line,
  RiQuestionLine,
  RiDownloadLine,
  RiInformationLine,
  RiPencilLine,
  RiCloseLine,
  RiMenuFoldLine,
  RiMenuUnfoldLine,
} from '@remixicon/react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { toast } from '@/components/ui';

import { UpdateDialog } from '@/components/ui/UpdateDialog';
import { ProjectEditDialog } from '@/components/layout/ProjectEditDialog';
import { useUIStore } from '@/stores/useUIStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionStore } from '@/stores/useSessionStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useUpdateStore } from '@/stores/useUpdateStore';
import { cn, formatDirectoryName, hasModifier } from '@/lib/utils';
import { PROJECT_ICON_MAP, PROJECT_COLOR_MAP } from '@/lib/projectMeta';
import { isDesktopLocalOriginActive, isDesktopShell, isTauriShell } from '@/lib/desktop';
import { useLongPress } from '@/hooks/useLongPress';
import { formatShortcutForDisplay, getEffectiveShortcutCombo } from '@/lib/shortcuts';
import { sessionEvents } from '@/lib/sessionEvents';
import type { ProjectEntry } from '@/lib/api/types';

const normalize = (value: string): string => {
  if (!value) return '';
  const replaced = value.replace(/\\/g, '/');
  return replaced === '/' ? '/' : replaced.replace(/\/+$/, '');
};

const NAV_RAIL_WIDTH = 56;
const NAV_RAIL_EXPANDED_WIDTH = 200;
const NAV_RAIL_TEXT_FADE_MS = 180;
const PROJECT_TEXT_FADE_IN_DELAY_MS = 24;
const ACTION_TEXT_FADE_IN_DELAY_MS = 60;

/** Tinted background for project tiles — uses project color at low opacity, or neutral fallback */
const TileBackground: React.FC<{ colorVar: string | null; children: React.ReactNode }> = ({
  colorVar,
  children,
}) => (
  <span
    className="relative flex h-full w-full items-center justify-center rounded-lg overflow-hidden"
    style={{ backgroundColor: 'var(--surface-muted)' }}
  >
    {colorVar && (
      <span
        className="absolute inset-0 opacity-15"
        style={{ backgroundColor: colorVar }}
      />
    )}
    <span className="relative z-10 flex items-center justify-center">
      {children}
    </span>
  </span>
);

/** First-letter avatar fallback */
const LetterAvatar: React.FC<{ label: string; color?: string | null }> = ({
  label,
  color,
}) => {
  const letter = label.charAt(0).toUpperCase() || '?';
  const colorVar = color ? (PROJECT_COLOR_MAP[color] ?? null) : null;
  return (
    <span
      className="flex h-4 w-4 items-center justify-center text-[15px] font-medium leading-none select-none"
      style={{ color: colorVar ?? 'var(--surface-foreground)', fontFamily: 'var(--font-mono, monospace)' }}
    >
      {letter}
    </span>
  );
};

const ProjectStatusDots: React.FC<{
  color: string;
  variant?: 'streaming' | 'attention' | 'none';
  size?: 'sm' | 'md';
}> = ({ color, variant = 'none', size = 'md' }) => (
  <span className="inline-flex items-center justify-center gap-px" aria-hidden="true">
    {Array.from({ length: 3 }).map((_, index) => (
      <span key={index} className="inline-flex h-[3px] w-[3px] items-center justify-center">
        <span
          className={cn(
            size === 'sm' ? 'h-[2.5px] w-[2.5px]' : 'h-[3px] w-[3px]',
            'rounded-full',
            variant === 'streaming' && 'animate-grid-pulse',
            variant === 'attention' && 'animate-attention-diamond-pulse'
          )}
          style={{
            backgroundColor: color,
            animationDelay: variant === 'streaming'
              ? `${index * 150}ms`
              : variant === 'attention'
                ? (index === 1 ? '0ms' : '130ms')
                : undefined,
          }}
        />
      </span>
    ))}
  </span>
);

/** Single project tile in the nav rail — right-click for context menu (no visible 3-dot) */
const ProjectTile: React.FC<{
  project: ProjectEntry;
  isActive: boolean;
  hasStreaming: boolean;
  hasUnread: boolean;
  label: string;
  expanded: boolean;
  projectTextVisible: boolean;
  onClick: () => void;
  onEdit: () => void;
  onClose: () => void;
}> = ({ project, isActive, hasStreaming, hasUnread, label, expanded, projectTextVisible, onClick, onEdit, onClose }) => {
  const [menuOpen, setMenuOpen] = React.useState(false);
  const ProjectIcon = project.icon ? PROJECT_ICON_MAP[project.icon] : null;
  const projectColorVar = project.color ? (PROJECT_COLOR_MAP[project.color] ?? null) : null;
  const showStreamingDots = hasStreaming;
  const showAttentionDots = !hasStreaming && hasUnread;

  const longPressHandlers = useLongPress({
    onLongPress: () => setMenuOpen(true),
    onTap: onClick,
  });

  const iconElement = (
    <TileBackground colorVar={projectColorVar}>
      <span className="relative h-full w-full leading-none">
        <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
          {ProjectIcon ? (
            <ProjectIcon
              className="h-4 w-4 shrink-0"
              style={projectColorVar ? { color: projectColorVar } : { color: 'var(--surface-foreground)' }}
            />
          ) : (
            <LetterAvatar label={label} color={project.color} />
          )}
        </span>
        {showStreamingDots && (
          <span className="pointer-events-none absolute inset-x-0 top-[calc(50%+9px)] flex justify-center">
            <ProjectStatusDots color="var(--primary)" variant="streaming" />
          </span>
        )}
        {showAttentionDots && (
          <span className="pointer-events-none absolute inset-x-0 top-[calc(50%+9px)] flex justify-center">
            <ProjectStatusDots color="var(--status-info)" variant="attention" />
          </span>
        )}
      </span>
    </TileBackground>
  );

  const tileButton = (
    <button
      type="button"
      {...longPressHandlers}
      className={cn(
        'group relative flex items-center rounded-lg overflow-hidden cursor-default',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]',
        expanded ? 'h-9 w-full gap-2.5 pr-1.5 pl-[7px]' : 'h-9 w-9 justify-center',
        !expanded && (
          isActive
            ? 'bg-transparent border border-[var(--surface-foreground)]'
            : 'bg-transparent border border-transparent hover:bg-[var(--interactive-hover)]/50 hover:border-[var(--interactive-border)]'
        ),
        !expanded && menuOpen && !isActive && 'bg-[var(--interactive-hover)]/50 border-[var(--interactive-border)]',
      )}
    >
      {expanded && (
        <span
          aria-hidden="true"
          className={cn(
            'pointer-events-none absolute inset-y-0 left-[6px] right-[5px] rounded-lg border transition-colors',
            isActive
              ? 'bg-[var(--interactive-selection)] border-[var(--interactive-border)]'
              : 'bg-transparent border-transparent group-hover:bg-[var(--interactive-hover)]/50 group-hover:border-[var(--interactive-border)]',
            menuOpen && !isActive && 'bg-[var(--interactive-hover)]/50 border-[var(--interactive-border)]',
          )}
        />
      )}
      <span className="flex size-[34px] basis-[34px] shrink-0 grow-0 items-center justify-center">
        {iconElement}
      </span>
      <span
        aria-hidden={!projectTextVisible}
        className={cn(
          'min-w-0 truncate text-left text-[13px] leading-tight transition-opacity duration-[180ms] ease-in-out',
          expanded ? 'flex-1' : 'w-0 flex-none',
          projectTextVisible ? 'opacity-100' : 'opacity-0',
          isActive && expanded ? 'font-medium text-[var(--interactive-selection-foreground)]' : 'text-[var(--surface-foreground)]',
        )}
      >
        {label}
      </span>
    </button>
  );

  return (
    <>
    {expanded ? (
      <div
        className="relative w-full"
        onContextMenu={(e) => {
          if (e.nativeEvent instanceof MouseEvent && e.nativeEvent.button === 2) {
            e.preventDefault();
            setMenuOpen(true);
          }
        }}
      >
        {tileButton}
      </div>
    ) : (
      <Tooltip delayDuration={400}>
        <TooltipTrigger asChild>
          <div
            className="relative"
            onContextMenu={(e) => {
              if (e.nativeEvent instanceof MouseEvent && e.nativeEvent.button === 2) {
                e.preventDefault();
                setMenuOpen(true);
              }
            }}
          >
            {tileButton}
          </div>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={8}>
          {label}
        </TooltipContent>
      </Tooltip>
    )}
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <DropdownMenuTrigger asChild>
        <span className="sr-only">Project options</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="right" sideOffset={4} className="min-w-[160px]">
        <DropdownMenuItem onClick={onEdit} className="gap-2">
          <RiPencilLine className="h-4 w-4" />
          Edit project
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={onClose}
          className="text-destructive focus:text-destructive gap-2"
        >
          <RiCloseLine className="h-4 w-4" />
          Close project
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    </>
  );
};

/** Constrain drag to Y axis only */
const restrictToYAxis: Modifier = ({ transform }) => ({
  ...transform,
  x: 0,
});

/** Sortable wrapper for ProjectTile */
const SortableProjectTile: React.FC<{
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
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
      }}
      className={cn(isDragging && 'opacity-30 z-50')}
      {...attributes}
      {...listeners}
    >
      {children}
    </div>
  );
};

interface NavRailProps {
  className?: string;
  mobile?: boolean;
}

export const NavRail: React.FC<NavRailProps> = ({ className, mobile }) => {
  const projects = useProjectsStore((s) => s.projects);
  const activeProjectId = useProjectsStore((s) => s.activeProjectId);
  const setActiveProjectIdOnly = useProjectsStore((s) => s.setActiveProjectIdOnly);
  const addProject = useProjectsStore((s) => s.addProject);
  const removeProject = useProjectsStore((s) => s.removeProject);
  const reorderProjects = useProjectsStore((s) => s.reorderProjects);
  const updateProjectMeta = useProjectsStore((s) => s.updateProjectMeta);
  const homeDirectory = useDirectoryStore((s) => s.homeDirectory);
  const setSettingsDialogOpen = useUIStore((s) => s.setSettingsDialogOpen);
  const setAboutDialogOpen = useUIStore((s) => s.setAboutDialogOpen);
  const toggleHelpDialog = useUIStore((s) => s.toggleHelpDialog);
  const isNavRailExpanded = useUIStore((s) => s.isNavRailExpanded);
  const toggleNavRail = useUIStore((s) => s.toggleNavRail);
  const shortcutOverrides = useUIStore((s) => s.shortcutOverrides);
  const expanded = !mobile && isNavRailExpanded;
  const [showExpandedContent, setShowExpandedContent] = React.useState(expanded);
  const [projectTextVisible, setProjectTextVisible] = React.useState(expanded);
  const [actionTextVisible, setActionTextVisible] = React.useState(expanded);

  React.useEffect(() => {
    if (expanded) {
      setShowExpandedContent(true);
      setProjectTextVisible(false);
      setActionTextVisible(false);
      const projectTimer = window.setTimeout(() => {
        setProjectTextVisible(true);
      }, PROJECT_TEXT_FADE_IN_DELAY_MS);
      const actionTimer = window.setTimeout(() => {
        setActionTextVisible(true);
      }, ACTION_TEXT_FADE_IN_DELAY_MS);
      return () => {
        window.clearTimeout(projectTimer);
        window.clearTimeout(actionTimer);
      };
    }

    setProjectTextVisible(false);
    setActionTextVisible(false);
    const timer = window.setTimeout(() => {
      setShowExpandedContent(false);
    }, NAV_RAIL_TEXT_FADE_MS);

    return () => {
      window.clearTimeout(timer);
    };
  }, [expanded]);

  const shortcutLabel = React.useCallback((actionId: string) => {
    return formatShortcutForDisplay(getEffectiveShortcutCombo(actionId, shortcutOverrides));
  }, [shortcutOverrides]);

  const sessionStatus = useSessionStore((s) => s.sessionStatus);
  const sessionAttentionStates = useSessionStore((s) => s.sessionAttentionStates);
  const sessionsByDirectory = useSessionStore((s) => s.sessionsByDirectory);
  const getSessionsByDirectory = useSessionStore((s) => s.getSessionsByDirectory);
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const availableWorktreesByProject = useSessionStore((s) => s.availableWorktreesByProject);

  const updateStore = useUpdateStore();
  const { available: updateAvailable, downloaded: updateDownloaded } = updateStore;
  const [updateDialogOpen, setUpdateDialogOpen] = React.useState(false);

  const [editingProject, setEditingProject] = React.useState<{
    id: string;
    name: string;
    path: string;
    icon?: string | null;
    color?: string | null;
  } | null>(null);

  const isDesktopApp = React.useMemo(() => isDesktopShell(), []);
  const tauriIpcAvailable = React.useMemo(() => isTauriShell(), []);

  const formatLabel = React.useCallback(
    (project: ProjectEntry): string => {
      return (
        project.label?.trim() ||
        formatDirectoryName(project.path, homeDirectory) ||
        project.path
      );
    },
    [homeDirectory],
  );

  const projectIndicators = React.useMemo(() => {
    const result = new Map<string, { hasStreaming: boolean; hasUnread: boolean }>();
    for (const project of projects) {
      const projectRoot = normalize(project.path);
      if (!projectRoot) {
        result.set(project.id, { hasStreaming: false, hasUnread: false });
        continue;
      }

      const dirs: string[] = [projectRoot];
      const worktrees = availableWorktreesByProject.get(projectRoot) ?? [];
      for (const meta of worktrees) {
        const p =
          meta && typeof meta === 'object' && 'path' in meta
            ? (meta as { path?: unknown }).path
            : null;
        if (typeof p === 'string' && p.trim()) {
          const normalized = normalize(p);
          if (normalized && normalized !== projectRoot) {
            dirs.push(normalized);
          }
        }
      }

      const seen = new Set<string>();
      let hasStreaming = false;
      let hasUnread = false;

      for (const dir of dirs) {
        const list = sessionsByDirectory.get(dir) ?? getSessionsByDirectory(dir);
        for (const session of list) {
          if (!session?.id || seen.has(session.id)) continue;
          seen.add(session.id);

          const statusType = sessionStatus?.get(session.id)?.type ?? 'idle';
          if (statusType === 'busy' || statusType === 'retry') {
            hasStreaming = true;
          }

          const isCurrentVisible =
            session.id === currentSessionId && project.id === activeProjectId;
          if (
            !isCurrentVisible &&
            sessionAttentionStates.get(session.id)?.needsAttention === true
          ) {
            hasUnread = true;
          }

          if (hasStreaming && hasUnread) break;
        }
        if (hasStreaming && hasUnread) break;
      }

      result.set(project.id, { hasStreaming, hasUnread });
    }
    return result;
  }, [
    activeProjectId,
    availableWorktreesByProject,
    currentSessionId,
    getSessionsByDirectory,
    projects,
    sessionAttentionStates,
    sessionStatus,
    sessionsByDirectory,
  ]);

  const handleAddProject = React.useCallback(() => {
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
          toast.error('Failed to select directory', { description: result.error });
        }
      })
      .catch((error) => {
        console.error('Failed to select directory:', error);
        toast.error('Failed to select directory');
      });
  }, [addProject, tauriIpcAvailable]);

  const handleEditProject = React.useCallback(
    (projectId: string) => {
      const project = projects.find((p) => p.id === projectId);
      if (!project) return;
      setEditingProject({
        id: project.id,
        name: formatLabel(project),
        path: project.path,
        icon: project.icon,
        color: project.color,
      });
    },
    [projects, formatLabel],
  );

  const handleSaveProjectEdit = React.useCallback(
    (data: { label: string; icon: string | null; color: string | null }) => {
      if (!editingProject) return;
      updateProjectMeta(editingProject.id, data);
      setEditingProject(null);
    },
    [editingProject, updateProjectMeta],
  );

  const handleCloseProject = React.useCallback(
    (projectId: string) => {
      removeProject(projectId);
    },
    [removeProject],
  );

  // Cmd/Ctrl+number to switch projects
  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (hasModifier(e) && !e.shiftKey && !e.altKey) {
        const num = parseInt(e.key, 10);
        if (num >= 1 && num <= projects.length) {
          e.preventDefault();
          const target = projects[num - 1];
          if (target && target.id !== activeProjectId) {
            setActiveProjectIdOnly(target.id);
          }
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [projects, activeProjectId, setActiveProjectIdOnly]);

  // Drag-to-reorder
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  const projectIds = React.useMemo(() => projects.map((p) => p.id), [projects]);

  const handleDragEnd = React.useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const fromIndex = projects.findIndex((p) => p.id === active.id);
      const toIndex = projects.findIndex((p) => p.id === over.id);
      if (fromIndex !== -1 && toIndex !== -1) {
        reorderProjects(fromIndex, toIndex);
      }
    },
    [projects, reorderProjects],
  );

  const navRailActionButtonClass = cn(
    'group relative flex h-8 items-center rounded-lg',
    showExpandedContent ? 'w-full justify-start gap-2.5 pr-2 pl-2' : 'w-8 justify-center',
    showExpandedContent
      ? 'text-[var(--surface-mutedForeground)] hover:text-[var(--surface-foreground)]'
      : 'text-[var(--surface-mutedForeground)] hover:bg-[var(--interactive-hover)]/50 hover:text-[var(--surface-foreground)]',
    'transition-colors',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]',
  );

  const navRailActionIconClass = 'h-4.5 w-4.5 shrink-0';

  const ActionButton: React.FC<{
    onClick: () => void;
    ariaLabel: string;
    icon: React.ReactNode;
    tooltipLabel: string;
    shortcutHint?: string;
    showExpandedShortcutHint?: boolean;
  }> = ({ onClick, ariaLabel, icon, tooltipLabel, shortcutHint, showExpandedShortcutHint = true }) => {
    const btn = (
      <button
        type="button"
        onClick={onClick}
        className={navRailActionButtonClass}
        aria-label={ariaLabel}
      >
        {showExpandedContent && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 left-[6px] right-[5px] rounded-lg bg-transparent transition-colors group-hover:bg-[var(--interactive-hover)]/50"
          />
        )}
        <span className="relative z-10 flex size-8 basis-8 shrink-0 grow-0 items-center justify-center">
          {icon}
        </span>
        <span
          aria-hidden={!actionTextVisible}
          className={cn(
            'relative z-10 min-w-0 flex items-center justify-between gap-1 overflow-hidden transition-opacity duration-[180ms] ease-in-out',
            showExpandedContent ? 'flex-1' : 'w-0 flex-none',
            actionTextVisible ? 'opacity-100' : 'opacity-0',
          )}
        >
          <span className="truncate text-left text-[13px]">{tooltipLabel}</span>
          {shortcutHint && showExpandedShortcutHint && (
              <span className="shrink-0 text-[10px] text-[var(--surface-mutedForeground)] opacity-70">
                {shortcutHint}
              </span>
          )}
        </span>
      </button>
    );

    return (
      <Tooltip delayDuration={400}>
        <TooltipTrigger asChild>{btn}</TooltipTrigger>
        {!showExpandedContent && (
          <TooltipContent side="right" sideOffset={8}>
            <p>{shortcutHint ? `${tooltipLabel} (${shortcutHint})` : tooltipLabel}</p>
          </TooltipContent>
        )}
      </Tooltip>
    );
  };

  return (
    <>
      <nav
        className={cn(
          'flex h-full shrink-0 flex-col bg-[var(--surface-background)] overflow-hidden',
          showExpandedContent ? 'items-stretch' : 'items-center',
          className,
        )}
        style={{ width: expanded ? NAV_RAIL_EXPANDED_WIDTH : NAV_RAIL_WIDTH }}
        aria-label="Project navigation"
      >
        {/* Projects list */}
        <div className="flex-1 min-h-0 w-full overflow-y-auto overflow-x-hidden scrollbar-none">
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
            modifiers={[restrictToYAxis]}
          >
          <SortableContext items={projectIds} strategy={verticalListSortingStrategy}>
          <div className={cn('flex flex-col gap-3 pt-1 pb-3', showExpandedContent ? 'items-stretch px-1' : 'items-center px-1')}>
            {projects.map((project) => {
              const isActive = project.id === activeProjectId;
              const indicators = projectIndicators.get(project.id);
              return (
                <SortableProjectTile key={project.id} id={project.id}>
                  <ProjectTile
                    project={project}
                    isActive={isActive}
                    hasStreaming={indicators?.hasStreaming ?? false}
                    hasUnread={indicators?.hasUnread ?? false}
                    label={formatLabel(project)}
                    expanded={showExpandedContent}
                    projectTextVisible={projectTextVisible}
                    onClick={() => {
                      if (project.id !== activeProjectId) {
                        setActiveProjectIdOnly(project.id);
                      }
                    }}
                    onEdit={() => handleEditProject(project.id)}
                    onClose={() => handleCloseProject(project.id)}
                  />
                </SortableProjectTile>
              );
            })}

          </div>
          </SortableContext>
          </DndContext>

            {/* Add project button */}
            <div className={cn('flex flex-col pb-3', showExpandedContent ? 'items-stretch px-1' : 'items-center px-1')}>
              <ActionButton
                onClick={handleAddProject}
                ariaLabel="Add project"
                icon={<RiFolderAddLine className={navRailActionIconClass} />}
                tooltipLabel="Add project"
              />
            </div>
        </div>

        {/* Bottom actions */}
        <div className={cn(
          'shrink-0 w-full pt-3 pb-4 flex flex-col gap-1',
          showExpandedContent ? 'items-stretch px-1' : 'items-center',
        )}>
          {(updateAvailable || updateDownloaded) && (
            <ActionButton
              onClick={() => setUpdateDialogOpen(true)}
              ariaLabel="Update available"
              icon={<RiDownloadLine className={navRailActionIconClass} />}
              tooltipLabel="Update available"
            />
          )}

          {!isDesktopApp && !(updateAvailable || updateDownloaded) && (
            <ActionButton
              onClick={() => setAboutDialogOpen(true)}
              ariaLabel="About"
              icon={<RiInformationLine className={navRailActionIconClass} />}
              tooltipLabel="About OpenChamber"
            />
          )}

          {!mobile && (
            <ActionButton
              onClick={toggleHelpDialog}
              ariaLabel="Keyboard shortcuts"
              icon={<RiQuestionLine className={navRailActionIconClass} />}
              tooltipLabel="Shortcuts"
              shortcutHint={shortcutLabel('open_help')}
              showExpandedShortcutHint={false}
            />
          )}

          <ActionButton
            onClick={() => setSettingsDialogOpen(true)}
            ariaLabel="Settings"
            icon={<RiSettings3Line className={navRailActionIconClass} />}
            tooltipLabel="Settings"
            shortcutHint={shortcutLabel('open_settings')}
            showExpandedShortcutHint={false}
          />

          {/* Toggle expand/collapse (desktop only) */}
          {!mobile && (
            <ActionButton
              onClick={toggleNavRail}
              ariaLabel={expanded ? 'Collapse sidebar' : 'Expand sidebar'}
              icon={expanded
                ? <RiMenuFoldLine className={navRailActionIconClass} />
                : <RiMenuUnfoldLine className={navRailActionIconClass} />
              }
              tooltipLabel={expanded ? 'Collapse' : 'Expand'}
              shortcutHint={shortcutLabel('toggle_nav_rail')}
              showExpandedShortcutHint={false}
            />
          )}
        </div>
      </nav>

      {/* Dialogs */}
      {editingProject && (
        <ProjectEditDialog
          open={!!editingProject}
          onOpenChange={(open) => {
            if (!open) setEditingProject(null);
          }}
          projectName={editingProject.name}
          projectPath={editingProject.path}
          initialIcon={editingProject.icon}
          initialColor={editingProject.color}
          onSave={handleSaveProjectEdit}
        />
      )}

      <UpdateDialog
        open={updateDialogOpen}
        onOpenChange={setUpdateDialogOpen}
        info={updateStore.info}
        downloading={updateStore.downloading}
        downloaded={updateStore.downloaded}
        progress={updateStore.progress}
        error={updateStore.error}
        onDownload={updateStore.downloadUpdate}
        onRestart={updateStore.restartToUpdate}
        runtimeType={updateStore.runtimeType}
      />
    </>
  );
};

export { NAV_RAIL_WIDTH, NAV_RAIL_EXPANDED_WIDTH };
