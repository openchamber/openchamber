import React from 'react';
import { useSessionStore } from '@/stores/useSessionStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import type { Session } from '@opencode-ai/sdk/v2';
import type { ProjectEntry } from '@/lib/api/types';
import { cn, formatDirectoryName } from '@/lib/utils';
import { getAgentColor } from '@/lib/agentColors';
import { RiLoader4Line, RiAddLine } from '@remixicon/react';
import type { SessionContextUsage } from '@/stores/types/sessionTypes';
import { PROJECT_ICON_MAP, PROJECT_COLOR_MAP, getProjectIconImageUrl } from '@/lib/projectMeta';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { toast } from '@/components/ui';
import { isTauriShell, isDesktopLocalOriginActive, requestDirectoryAccess } from '@/lib/desktop';
import { sessionEvents } from '@/lib/sessionEvents';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useDrawerSwipe } from '@/hooks/useDrawerSwipe';

interface MobileSessionStatusBarProps {
  onSessionSwitch?: (sessionId: string) => void;
  cornerRadius?: number;
}

interface SessionWithStatus extends Session {
  _statusType?: 'busy' | 'retry' | 'idle';
  _hasRunningChildren?: boolean;
  _runningChildrenCount?: number;
  _childIndicators?: Array<{ session: Session; isRunning: boolean }>;
}

// Normalize path for comparison
const normalize = (value: string): string => {
  if (!value) return '';
  const replaced = value.replace(/\\/g, '/');
  return replaced === '/' ? '/' : replaced.replace(/\/+$/, '');
};

function useSessionGrouping(
  sessions: Session[],
  sessionStatus: Map<string, { type: string }> | undefined,
  sessionAttentionStates: Map<string, { needsAttention: boolean }> | undefined
) {
  const parentChildMap = React.useMemo(() => {
    const map = new Map<string, Session[]>();
    const allIds = new Set(sessions.map((s) => s.id));

    sessions.forEach((session) => {
      const parentID = (session as { parentID?: string }).parentID;
      if (parentID && allIds.has(parentID)) {
        map.set(parentID, [...(map.get(parentID) || []), session]);
      }
    });
    return map;
  }, [sessions]);

  const getStatusType = React.useCallback((sessionId: string): 'busy' | 'retry' | 'idle' => {
    const status = sessionStatus?.get(sessionId);
    if (status?.type === 'busy' || status?.type === 'retry') return status.type;
    return 'idle';
  }, [sessionStatus]);

  const hasRunningChildren = React.useCallback((sessionId: string): boolean => {
    const children = parentChildMap.get(sessionId) || [];
    return children.some((child) => getStatusType(child.id) !== 'idle');
  }, [parentChildMap, getStatusType]);

  const getRunningChildrenCount = React.useCallback((sessionId: string): number => {
    const children = parentChildMap.get(sessionId) || [];
    return children.filter((child) => getStatusType(child.id) !== 'idle').length;
  }, [parentChildMap, getStatusType]);

  const getChildIndicators = React.useCallback((sessionId: string): Array<{ session: Session; isRunning: boolean }> => {
    const children = parentChildMap.get(sessionId) || [];
    return children
      .filter((child) => getStatusType(child.id) !== 'idle')
      .map((child) => ({ session: child, isRunning: true }))
      .slice(0, 3);
  }, [parentChildMap, getStatusType]);

  const processedSessions = React.useMemo(() => {
    const topLevel = sessions.filter((session) => {
      const parentID = (session as { parentID?: string }).parentID;
      return !parentID || !new Set(sessions.map((s) => s.id)).has(parentID);
    });

    const running: SessionWithStatus[] = [];
    const viewed: SessionWithStatus[] = [];

    topLevel.forEach((session) => {
      const statusType = getStatusType(session.id);
      const hasRunning = hasRunningChildren(session.id);
      const attention = sessionAttentionStates?.get(session.id)?.needsAttention ?? false;

      const enriched: SessionWithStatus = {
        ...session,
        _statusType: statusType,
        _hasRunningChildren: hasRunning,
        _runningChildrenCount: getRunningChildrenCount(session.id),
        _childIndicators: getChildIndicators(session.id),
      };

      if (statusType !== 'idle' || hasRunning) {
        running.push(enriched);
      } else if (attention) {
        running.push(enriched);
      } else {
        viewed.push(enriched);
      }
    });

    const sortByUpdated = (a: Session, b: Session) => {
      const aTime = (a as unknown as { time?: { updated?: number } }).time?.updated ?? 0;
      const bTime = (b as unknown as { time?: { updated?: number } }).time?.updated ?? 0;
      return bTime - aTime;
    };

    running.sort(sortByUpdated);
    viewed.sort(sortByUpdated);

    return [...running, ...viewed];
  }, [sessions, getStatusType, hasRunningChildren, getRunningChildrenCount, getChildIndicators, sessionAttentionStates]);

  const totalRunning = processedSessions.reduce((sum, s) => {
    const selfRunning = s._statusType !== 'idle' ? 1 : 0;
    return sum + selfRunning + (s._runningChildrenCount ?? 0);
  }, 0);

  const totalUnread = processedSessions.filter((s) => sessionAttentionStates?.get(s.id)?.needsAttention ?? false).length;

  return { sessions: processedSessions, totalRunning, totalUnread, totalCount: processedSessions.length };
}

function useSessionHelpers(
  agents: Array<{ name: string }>,
  sessionStatus: Map<string, { type: string }> | undefined,
  sessionAttentionStates: Map<string, { needsAttention: boolean }> | undefined
) {
  const getSessionAgentName = React.useCallback((session: Session): string => {
    const agent = (session as { agent?: string }).agent;
    if (agent) return agent;

    const sessionAgentSelection = useSessionStore.getState().getSessionAgentSelection(session.id);
    if (sessionAgentSelection) return sessionAgentSelection;

    return agents[0]?.name ?? 'agent';
  }, [agents]);

  const getSessionTitle = React.useCallback((session: Session): string => {
    const title = session.title;
    if (title && title.trim()) return title;
    return 'New session';
  }, []);

  const isRunning = React.useCallback((sessionId: string): boolean => {
    const status = sessionStatus?.get(sessionId);
    return status?.type === 'busy' || status?.type === 'retry';
  }, [sessionStatus]);

  // Use server-authoritative attention state instead of local activity state
  const needsAttention = React.useCallback((sessionId: string): boolean => {
    return sessionAttentionStates?.get(sessionId)?.needsAttention ?? false;
  }, [sessionAttentionStates]);

  return { getSessionAgentName, getSessionTitle, isRunning, needsAttention };
}

// Hook to calculate project status indicators
function useProjectStatus(
  sessions: Session[],
  sessionStatus: Map<string, { type: string }> | undefined,
  sessionAttentionStates: Map<string, { needsAttention: boolean }> | undefined,
  currentSessionId: string | null
) {
  const availableWorktreesByProject = useSessionStore((state) => state.availableWorktreesByProject);
  const sessionsByDirectory = useSessionStore((state) => state.sessionsByDirectory);
  const getSessionsByDirectory = useSessionStore((state) => state.getSessionsByDirectory);

  const projectStatusMap = React.useCallback((projectPath: string): { hasRunning: boolean; hasUnread: boolean } => {
    const getStatusType = (sessionId: string): 'busy' | 'retry' | 'idle' => {
      const status = sessionStatus?.get(sessionId);
      if (status?.type === 'busy' || status?.type === 'retry') return status.type;
      return 'idle';
    };

    const projectRoot = normalize(projectPath);
    if (!projectRoot) {
      return { hasRunning: false, hasUnread: false };
    }

    const dirs: string[] = [projectRoot];
    const worktrees = availableWorktreesByProject.get(projectRoot) ?? [];
    for (const meta of worktrees) {
      const p = (meta && typeof meta === 'object' && 'path' in meta) ? (meta as { path?: unknown }).path : null;
      if (typeof p === 'string' && p.trim()) {
        const normalized = normalize(p);
        if (normalized && normalized !== projectRoot) {
          dirs.push(normalized);
        }
      }
    }

    const seen = new Set<string>();
    let hasRunning = false;
    let hasUnread = false;

    for (const dir of dirs) {
      const list = sessionsByDirectory.get(dir) ?? getSessionsByDirectory(dir);
      for (const session of list) {
        if (!session?.id || seen.has(session.id)) {
          continue;
        }
        seen.add(session.id);

        const statusType = getStatusType(session.id);
        if (statusType === 'busy' || statusType === 'retry') {
          hasRunning = true;
        }

        if (session.id !== currentSessionId && sessionAttentionStates?.get(session.id)?.needsAttention === true) {
          hasUnread = true;
        }

        if (hasRunning && hasUnread) {
          break;
        }
      }
      if (hasRunning && hasUnread) {
        break;
      }
    }

    return { hasRunning, hasUnread };
  }, [sessionsByDirectory, getSessionsByDirectory, availableWorktreesByProject, sessionStatus, sessionAttentionStates, currentSessionId]);

  return projectStatusMap;
}

function StatusIndicator({ isRunning, needsAttention }: { isRunning: boolean; needsAttention: boolean }) {
  if (isRunning) {
    return <RiLoader4Line className="h-2.5 w-2.5 animate-spin text-[var(--status-info)]" />;
  }
  if (needsAttention) {
    return <div className="h-1.5 w-1.5 rounded-full bg-[var(--status-error)]" />;
  }
  return <div className="h-1.5 w-1.5 rounded-full border border-[var(--surface-mutedForeground)]" />;
}

function RunningIndicator({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span className="flex items-center gap-1 text-[13px] text-[var(--status-info)]">
      <RiLoader4Line className="h-3.5 w-3.5 animate-spin" />
      {count}
    </span>
  );
}

function UnreadIndicator({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span className="flex items-center gap-1 text-[13px] text-[var(--status-error)]">
      <div className="h-2 w-2 rounded-full bg-[var(--status-error)]" />
      {count}
    </span>
  );
}

function SessionItem({
  session,
  isCurrent,
  getSessionAgentName,
  getSessionTitle,
  onClick,
  onDoubleClick,
  needsAttention
}: {
  session: SessionWithStatus;
  isCurrent: boolean;
  getSessionAgentName: (s: Session) => string;
  getSessionTitle: (s: Session) => string;
  onClick: () => void;
  onDoubleClick?: () => void;
  needsAttention: (sessionId: string) => boolean;
}) {
  const agentName = getSessionAgentName(session);
  const agentColor = getAgentColor(agentName);
  const extraCount = (session._runningChildrenCount || 0) + (session._statusType !== 'idle' ? 1 : 0) - 1 - (session._childIndicators?.length || 0);

  return (
    <button
      type="button"
      onClick={onClick}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onDoubleClick?.();
      }}
      className={cn(
        "flex items-center gap-0.5 px-1.5 py-px text-left transition-colors",
        "hover:bg-[var(--interactive-hover)] active:bg-[var(--interactive-selection)]",
        isCurrent && "bg-[var(--interactive-selection)]/30"
      )}
    >
      <div className="flex-shrink-0 w-3 flex items-center justify-center">
        <StatusIndicator
          isRunning={session._statusType !== 'idle'}
          needsAttention={needsAttention(session.id)}
        />
      </div>

      <div
        className="flex-shrink-0 h-1.5 w-1.5 rounded-full"
        style={{ backgroundColor: `var(${agentColor.var})` }}
      />

      <span className={cn(
        "text-[13px] truncate leading-tight",
        isCurrent ? "text-[var(--interactive-selection-foreground)] font-medium" : "text-[var(--surface-foreground)]"
      )}>
        {getSessionTitle(session)}
      </span>

      {(session._childIndicators?.length || 0) > 0 && (
        <div className="flex items-center gap-0.5 text-[var(--surface-mutedForeground)]">
          <span className="text-[10px]">[</span>
          <div className="flex items-center gap-0.5">
            {session._childIndicators!.map(({ session: child }) => {
              const childColor = getAgentColor(getSessionAgentName(child));
              return (
                <div
                  key={child.id}
                  className="flex-shrink-0"
                  title={`Sub-session: ${getSessionTitle(child)}`}
                >
                  <RiLoader4Line
                    className="h-2.5 w-2.5 animate-spin"
                    style={{ color: `var(${childColor.var})` }}
                  />
                </div>
              );
            })}
            {extraCount > 0 && (
              <span className="text-[10px] text-[var(--surface-mutedForeground)]">
                +{extraCount}
              </span>
            )}
          </div>
          <span className="text-[10px]">]</span>
        </div>
      )}
    </button>
  );
}

function TokenUsageIndicator({ contextUsage }: { contextUsage: SessionContextUsage | null }) {
  if (!contextUsage || contextUsage.totalTokens === 0) return null;

  const percentage = Math.min(contextUsage.percentage, 999);
  const colorClass =
    percentage >= 90 ? 'text-[var(--status-error)]' :
    percentage >= 75 ? 'text-[var(--status-warning)]' : 'text-[var(--status-success)]';

  return (
    <span className={cn("text-[12px] tabular-nums font-medium", colorClass)}>
      {percentage.toFixed(1)}%
    </span>
  );
}

interface SessionStatusHeaderProps {
  currentSessionTitle: string;
  currentProjectLabel?: string;
  currentProjectIcon?: string | null;
  currentProjectIconImageUrl?: string | null;
  currentProjectIconBackground?: string | null;
  currentProjectColor?: string | null;
  onToggle: () => void;
  isExpanded?: boolean;
  childIndicators?: Array<{ session: Session; isRunning: boolean }>;
}

function SessionStatusHeader({
  currentSessionTitle,
  currentProjectLabel,
  currentProjectIcon,
  currentProjectIconImageUrl,
  currentProjectIconBackground,
  currentProjectColor,
  onToggle,
  isExpanded = false,
  childIndicators = []
}: SessionStatusHeaderProps) {
  const [imageFailed, setImageFailed] = React.useState(false);
  const ProjectIcon = currentProjectIcon ? PROJECT_ICON_MAP[currentProjectIcon] : null;
  const imageUrl = !imageFailed ? currentProjectIconImageUrl : null;
  const projectColorVar = currentProjectColor ? (PROJECT_COLOR_MAP[currentProjectColor] ?? null) : null;
  const extraCount = childIndicators.length > 3 ? childIndicators.length - 3 : 0;

  React.useEffect(() => {
    setImageFailed(false);
  }, [currentProjectIconImageUrl]);

  return (
    <button
      type="button"
      onClick={onToggle}
      className="w-full flex flex-col px-2 py-0.5 text-left transition-colors hover:bg-[var(--interactive-hover)]"
    >
      {!isExpanded && currentProjectLabel && (
        <div className="flex flex-col items-start">
          <div className="flex items-center gap-1 leading-none">
            {imageUrl ? (
              <span
                className="inline-flex h-2.5 w-2.5 items-center justify-center overflow-hidden rounded-[1px]"
                style={currentProjectIconBackground ? { backgroundColor: currentProjectIconBackground } : undefined}
              >
                <img
                  src={imageUrl}
                  alt=""
                  className="h-full w-full object-contain"
                  draggable={false}
                  onError={() => setImageFailed(true)}
                />
              </span>
            ) : ProjectIcon && (
              <ProjectIcon
                className="h-2.5 w-2.5"
                style={projectColorVar ? { color: projectColorVar } : undefined}
              />
            )}
            <span
              className="text-[11px] leading-none text-[var(--surface-mutedForeground)] truncate max-w-[120px]"
              style={projectColorVar ? { color: projectColorVar } : undefined}
            >
              {currentProjectLabel}
              </span>
          </div>
          <div className="w-full h-px bg-[var(--interactive-border)] my-1" />
        </div>
      )}
      <div className="flex items-center gap-1.5 min-w-0">
        <span className="flex-1 min-w-0 text-[13px] text-[var(--surface-foreground)] truncate leading-none">
          {currentSessionTitle}
        </span>
        {childIndicators.length > 0 && (
          <div className="flex items-center gap-0.5 text-[var(--surface-mutedForeground)]">
            <span className="text-[10px]">[</span>
            <div className="flex items-center gap-0.5">
              {childIndicators.slice(0, 3).map((child) => {
                const childAgent = (child.session as { agent?: string }).agent || 'agent';
                const childColor = getAgentColor(childAgent);
                return (
                  <div
                    key={child.session.id}
                    className="flex-shrink-0"
                    title={`Sub-session: ${child.session.title || 'Untitled'}`}
                  >
                    <RiLoader4Line
                      className="h-2.5 w-2.5 animate-spin"
                      style={{ color: `var(${childColor.var})` }}
                    />
                  </div>
                );
              })}
              {extraCount > 0 && (
                <span className="text-[10px] text-[var(--surface-mutedForeground)]">
                  +{extraCount}
                </span>
              )}
            </div>
            <span className="text-[10px]">]</span>
          </div>
        )}
      </div>
    </button>
  );
}



// Hook for long press
function useLongPress(
  onLongPress: () => void,
  onClick: () => void,
  ms = 500
) {
  const timerRef = React.useRef<NodeJS.Timeout | null>(null);
  const isLongPress = React.useRef(false);

  const start = React.useCallback(() => {
    isLongPress.current = false;
    timerRef.current = setTimeout(() => {
      isLongPress.current = true;
      onLongPress();
    }, ms);
  }, [onLongPress, ms]);

  const end = React.useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const handleClick = React.useCallback(() => {
    if (!isLongPress.current) {
      onClick();
    }
  }, [onClick]);

  return {
    onMouseDown: start,
    onMouseUp: end,
    onMouseLeave: end,
    onTouchStart: start,
    onTouchEnd: end,
    onClick: handleClick,
  };
}

// Project button component with long press support
interface ProjectButtonProps {
  project: ProjectEntry;
  isActive: boolean;
  status: { hasRunning: boolean; hasUnread: boolean };
  projectColorVar: string | null;
  onProjectSwitch: () => void;
  onRemoveProject?: () => void;
  formatProjectLabel: (project: ProjectEntry) => string;
}

function ProjectButton({
  project,
  isActive,
  status,
  projectColorVar,
  onProjectSwitch,
  onRemoveProject,
  formatProjectLabel,
}: ProjectButtonProps) {
  const [imageFailed, setImageFailed] = React.useState(false);
  const ProjectIcon = project.icon ? PROJECT_ICON_MAP[project.icon] : null;
  const projectIconImageUrl = !imageFailed ? getProjectIconImageUrl(project) : null;

  React.useEffect(() => {
    setImageFailed(false);
  }, [project.id, project.iconImage?.updatedAt]);

  const longPressHandlers = useLongPress(
    () => {
      if (onRemoveProject) {
        onRemoveProject();
      }
    },
    onProjectSwitch,
    600
  );

  return (
    <button
      type="button"
      data-project-id={project.id}
      className={cn(
        "flex items-center gap-1 px-2.5 !py-1.5 rounded-md text-[12px] whitespace-nowrap transition-colors shrink-0 border !min-h-0 leading-none select-none",
        isActive
          ? "border-[var(--primary-base)]/60 text-[var(--primary-base)]/80 bg-[var(--primary-base)]/5 hover:text-[var(--primary-base)] hover:bg-[var(--primary-base)]/10"
          : "border-[var(--interactive-border)] text-[var(--surface-foreground)] bg-[var(--surface-elevated)] hover:bg-[var(--interactive-hover)]"
      )}
      {...longPressHandlers}
    >
      {/* Status indicators */}
      <div className="flex items-center gap-0.5">
        {status.hasRunning && (
          <RiLoader4Line className="h-2.5 w-2.5 animate-spin text-[var(--status-info)]" />
        )}
        {!status.hasRunning && status.hasUnread && (
          <div className="h-1.5 w-1.5 rounded-full bg-[var(--status-error)]" />
        )}
      </div>

      {/* Icon */}
      {projectIconImageUrl ? (
        <span
          className="inline-flex h-3.5 w-3.5 items-center justify-center overflow-hidden rounded-[2px]"
          style={project.iconBackground ? { backgroundColor: project.iconBackground } : undefined}
        >
          <img
            src={projectIconImageUrl}
            alt=""
            className="h-full w-full object-contain"
            draggable={false}
            onError={() => setImageFailed(true)}
          />
        </span>
      ) : ProjectIcon && (
        <ProjectIcon
          className="h-3.5 w-3.5"
          style={projectColorVar ? { color: projectColorVar } : undefined}
        />
      )}

      {/* Label */}
      <span
        className="truncate max-w-[100px]"
        style={isActive && projectColorVar ? { color: projectColorVar } : undefined}
      >
        {formatProjectLabel(project)}
      </span>
    </button>
  );
}

// Project bar component for expanded view
interface ProjectBarProps {
  projects: ProjectEntry[];
  activeProjectId: string | null;
  getProjectStatus: (path: string) => { hasRunning: boolean; hasUnread: boolean };
  onProjectSwitch: (projectId: string) => void;
  onAddProject: () => void;
  onRemoveProject?: (projectId: string) => void;
  homeDirectory: string | null;
}

function ProjectBar({
  projects,
  activeProjectId,
  getProjectStatus,
  onProjectSwitch,
  onAddProject,
  onRemoveProject,
  homeDirectory
}: ProjectBarProps) {
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = React.useState(false);
  const [projectToDelete, setProjectToDelete] = React.useState<ProjectEntry | null>(null);

  // Scroll active project into view
  React.useEffect(() => {
    if (scrollRef.current && activeProjectId) {
      const activeElement = scrollRef.current.querySelector(`[data-project-id="${activeProjectId}"]`);
      if (activeElement) {
        activeElement.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
      }
    }
  }, [activeProjectId]);

  const handleLongPress = (project: ProjectEntry) => {
    setProjectToDelete(project);
    setDeleteDialogOpen(true);
  };

  const handleConfirmDelete = () => {
    if (projectToDelete && onRemoveProject) {
      onRemoveProject(projectToDelete.id);
    }
    setDeleteDialogOpen(false);
    setProjectToDelete(null);
  };

  if (projects.length === 0) {
    return (
      <div className="flex items-center gap-2 px-2 py-1 border-b border-[var(--interactive-border)] bg-transparent">
        <span className="text-[11px] text-[var(--surface-mutedForeground)]">No projects</span>
        <button
          type="button"
          onClick={onAddProject}
          className="flex items-center justify-center !py-1.5 px-2 rounded-md border border-[var(--primary-base)]/60 bg-[var(--primary-base)]/5 text-[var(--primary-base)]/80 hover:text-[var(--primary-base)] hover:bg-[var(--primary-base)]/10 !min-h-0"
          aria-label="Add project"
        >
          <RiAddLine className="h-3 w-3" />
        </button>
      </div>
    );
  }

  const formatProjectLabel = (project: ProjectEntry): string => {
    return project.label?.trim()
      || formatDirectoryName(project.path, homeDirectory)
      || project.path;
  };

  // Handle touch events to prevent drawer swipe when scrolling project bar
  const handleTouchStart = (e: React.TouchEvent) => {
    // Store initial touch position for this component
    (e.currentTarget as HTMLElement).dataset.touchStartX = String(e.touches[0].clientX);
    (e.currentTarget as HTMLElement).dataset.touchStartY = String(e.touches[0].clientY);
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    const target = e.currentTarget as HTMLElement;
    const startX = Number(target.dataset.touchStartX || 0);
    const startY = Number(target.dataset.touchStartY || 0);
    const deltaX = e.touches[0].clientX - startX;
    const deltaY = e.touches[0].clientY - startY;

    // If horizontal scroll dominates, prevent default to stop drawer gesture
    if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > 5) {
      e.stopPropagation();
    }
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    // Clean up
    const target = e.currentTarget as HTMLElement;
    delete target.dataset.touchStartX;
    delete target.dataset.touchStartY;
  };

  return (
    <div className="flex items-center gap-1.5 px-2 py-1.5 bg-transparent">
      <div
        ref={scrollRef}
        className="flex-1 flex items-center gap-1.5 overflow-x-auto scrollbar-none touch-pan-x"
        style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        {projects.map((project) => {
          const isActive = project.id === activeProjectId;
          const status = getProjectStatus(project.path);
          const projectColorVar = project.color ? (PROJECT_COLOR_MAP[project.color] ?? null) : null;

          return (
            <ProjectButton
              key={project.id}
              project={project}
              isActive={isActive}
              status={status}
              projectColorVar={projectColorVar}
              onProjectSwitch={() => onProjectSwitch(project.id)}
              onRemoveProject={onRemoveProject ? () => handleLongPress(project) : undefined}
              formatProjectLabel={formatProjectLabel}
            />
          );
        })}
      </div>

      {/* Add project button */}
      <button
        type="button"
        onClick={onAddProject}
        className="flex items-center justify-center !py-1.5 px-2 rounded-md border border-[var(--primary-base)]/60 bg-[var(--primary-base)]/5 text-[var(--primary-base)]/80 hover:text-[var(--primary-base)] hover:bg-[var(--primary-base)]/10 shrink-0 !min-h-0"
        aria-label="Add project"
      >
        <RiAddLine className="h-3.5 w-3.5" />
      </button>

      {/* Delete confirmation dialog */}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Remove Project</DialogTitle>
            <DialogDescription>
              Are you sure you want to remove <span className="font-medium text-foreground">{projectToDelete?.label || formatDirectoryName(projectToDelete?.path || '', homeDirectory)}</span>?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex gap-2">
            <Button variant="outline" onClick={() => setDeleteDialogOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleConfirmDelete}>
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function CollapsedView({
  runningCount,
  unreadCount,
  currentSessionTitle,
  currentProjectLabel,
  currentProjectIcon,
  currentProjectIconImageUrl,
  currentProjectIconBackground,
  currentProjectColor,
  onToggle,
  onNewSession,
  cornerRadius,
  contextUsage,
  childIndicators = [],
}: {
  runningCount: number;
  unreadCount: number;
  currentSessionTitle: string;
  currentProjectLabel?: string;
  currentProjectIcon?: string | null;
  currentProjectIconImageUrl?: string | null;
  currentProjectIconBackground?: string | null;
  currentProjectColor?: string | null;
  onToggle: () => void;
  onNewSession: () => void;
  cornerRadius?: number;
  contextUsage: SessionContextUsage | null;
  childIndicators?: Array<{ session: Session; isRunning: boolean }>;
}) {
  const { handleTouchStart, handleTouchMove, handleTouchEnd } = useDrawerSwipe();

  return (
    <div
      className="w-full flex items-center justify-between px-2 py-1 border-b border-[var(--interactive-border)] bg-[var(--surface-muted)] order-first text-left overflow-hidden"
      style={{
        borderTopLeftRadius: cornerRadius,
        borderTopRightRadius: cornerRadius,
      }}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      <div className="flex-1 min-w-0 mr-1">
        <SessionStatusHeader
          currentSessionTitle={currentSessionTitle}
          currentProjectLabel={currentProjectLabel}
          currentProjectIcon={currentProjectIcon}
          currentProjectIconImageUrl={currentProjectIconImageUrl}
          currentProjectIconBackground={currentProjectIconBackground}
          currentProjectColor={currentProjectColor}
          onToggle={onToggle}
          childIndicators={childIndicators}
        />
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        <button
          type="button"
          className="flex items-center gap-2"
          onClick={onToggle}
        >
          <RunningIndicator count={runningCount} />
          <UnreadIndicator count={unreadCount} />
          <TokenUsageIndicator contextUsage={contextUsage} />
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onNewSession();
          }}
          className="flex items-center gap-0.5 px-2 py-1 text-[12px] leading-tight !min-h-0 rounded border border-[var(--primary-base)]/60 bg-[var(--primary-base)]/5 text-[var(--primary-base)]/80 hover:text-[var(--primary-base)] hover:bg-[var(--primary-base)]/10 self-center"
        >
          New
        </button>
      </div>
    </div>
  );
}

function ExpandedView({
  sessions,
  currentSessionId,
  runningCount,
  unreadCount,
  currentSessionTitle,
  currentProjectLabel,
  currentProjectIcon,
  currentProjectIconImageUrl,
  currentProjectIconBackground,
  currentProjectColor,
  isExpanded,
  onToggleCollapse,
  onNewSession,
  onSessionClick,
  onSessionDoubleClick,
  onProjectSwitch,
  onAddProject,
  onRemoveProject,
  getSessionAgentName,
  getSessionTitle,
  needsAttention,
  cornerRadius,
  contextUsage,
  projects,
  activeProjectId,
  getProjectStatus,
  homeDirectory,
  childIndicators = [],
}: {
  sessions: SessionWithStatus[];
  currentSessionId: string;
  runningCount: number;
  unreadCount: number;
  currentSessionTitle: string;
  currentProjectLabel?: string;
  currentProjectIcon?: string | null;
  currentProjectIconImageUrl?: string | null;
  currentProjectIconBackground?: string | null;
  currentProjectColor?: string | null;
  isExpanded: boolean;
  onToggleCollapse: () => void;
  onNewSession: () => void;
  onSessionClick: (id: string) => void;
  onSessionDoubleClick?: () => void;
  onProjectSwitch: (projectId: string) => void;
  onAddProject: () => void;
  onRemoveProject?: (projectId: string) => void;
  getSessionAgentName: (s: Session) => string;
  getSessionTitle: (s: Session) => string;
  needsAttention: (sessionId: string) => boolean;
  cornerRadius?: number;
  contextUsage: SessionContextUsage | null;
  projects: ProjectEntry[];
  activeProjectId: string | null;
  getProjectStatus: (path: string) => { hasRunning: boolean; hasUnread: boolean };
  homeDirectory: string | null;
  childIndicators?: Array<{ session: Session; isRunning: boolean }>;
}) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [collapsedHeight, setCollapsedHeight] = React.useState<number | null>(null);
  const [hasMeasured, setHasMeasured] = React.useState(false);
  const { handleTouchStart, handleTouchMove, handleTouchEnd } = useDrawerSwipe();
  const availableWorktreesByProject = useSessionStore((state) => state.availableWorktreesByProject);

  React.useEffect(() => {
    if (containerRef.current && !hasMeasured && !isExpanded) {
      setCollapsedHeight(containerRef.current.offsetHeight);
      setHasMeasured(true);
    }
  }, [hasMeasured, isExpanded]);

  // Filter sessions by active project
  const filteredSessions = React.useMemo(() => {
    if (!activeProjectId) return sessions;
    
    const activeProject = projects.find(p => p.id === activeProjectId);
    if (!activeProject) return sessions;

    const projectRoot = normalize(activeProject.path);
    const projectDirs = new Set<string>([projectRoot]);
    
    // Add worktrees
    const worktrees = availableWorktreesByProject.get(projectRoot) ?? [];
    for (const meta of worktrees) {
      const p = (meta && typeof meta === 'object' && 'path' in meta) ? (meta as { path?: unknown }).path : null;
      if (typeof p === 'string' && p.trim()) {
        const normalized = normalize(p);
        if (normalized) projectDirs.add(normalized);
      }
    }

    return sessions.filter(session => {
      const sessionDir = normalize((session as { directory?: string | null }).directory ?? '');
      return projectDirs.has(sessionDir);
    });
  }, [sessions, activeProjectId, projects, availableWorktreesByProject]);

  const previewHeight = collapsedHeight ?? undefined;
  const displaySessions = hasMeasured || isExpanded
    ? filteredSessions.filter(s => s.id !== currentSessionId)
    : filteredSessions.slice(0, 3);

  return (
    <div
      className="w-full border-b border-[var(--interactive-border)] bg-[var(--surface-muted)] order-first overflow-hidden"
      style={{
        borderTopLeftRadius: cornerRadius,
        borderTopRightRadius: cornerRadius,
      }}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      {/* Header row */}
      <div className="flex items-center justify-between px-2 py-1.5 border-b border-[var(--interactive-border)]">
        <div className="flex-1 min-w-0 mr-1">
          <SessionStatusHeader
            currentSessionTitle={currentSessionTitle}
            currentProjectLabel={currentProjectLabel}
            currentProjectIcon={currentProjectIcon}
            currentProjectIconImageUrl={currentProjectIconImageUrl}
            currentProjectIconBackground={currentProjectIconBackground}
            currentProjectColor={currentProjectColor}
            onToggle={onToggleCollapse}
            isExpanded={true}
            childIndicators={childIndicators}
          />
        </div>
        <div
          className="flex items-center gap-2 flex-shrink-0 cursor-pointer !min-h-0"
          onClick={onToggleCollapse}
          tabIndex={0}
          role="button"
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onToggleCollapse();
            }
          }}
        >
          <RunningIndicator count={runningCount} />
          <UnreadIndicator count={unreadCount} />
          <TokenUsageIndicator contextUsage={contextUsage} />
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onNewSession();
            }}
            className="flex items-center gap-0.5 px-2 py-1 text-[12px] leading-tight !min-h-0 rounded border border-[var(--primary-base)]/60 bg-[var(--primary-base)]/5 text-[var(--primary-base)]/80 hover:text-[var(--primary-base)] hover:bg-[var(--primary-base)]/10 self-start"
          >
            New
          </button>
        </div>
      </div>

      {/* Project switcher bar */}
      <ProjectBar
        projects={projects}
        activeProjectId={activeProjectId}
        getProjectStatus={getProjectStatus}
        onProjectSwitch={onProjectSwitch}
        onAddProject={onAddProject}
        onRemoveProject={onRemoveProject}
        homeDirectory={homeDirectory}
      />

      {/* Sessions list */}
      <div
        ref={containerRef}
        className="flex flex-col overflow-y-auto"
        style={{ maxHeight: isExpanded ? '60vh' : previewHeight }}
      >
        {displaySessions.length === 0 ? (
          <div className="flex items-center justify-center py-3 text-[11px] text-[var(--surface-mutedForeground)]">
            <span>No sessions in this project</span>
          </div>
        ) : (
          displaySessions.map((session) => (
            <SessionItem
              key={session.id}
              session={session}
              isCurrent={session.id === currentSessionId}
              getSessionAgentName={getSessionAgentName}
              getSessionTitle={getSessionTitle}
              onClick={() => onSessionClick(session.id)}
              onDoubleClick={onSessionDoubleClick}
              needsAttention={needsAttention}
            />
          ))
        )}
      </div>
    </div>
  );
}

export const MobileSessionStatusBar: React.FC<MobileSessionStatusBarProps> = ({
  onSessionSwitch,
  cornerRadius,
}) => {
  const sessions = useSessionStore((state) => state.sessions);
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const sessionStatus = useSessionStore((state) => state.sessionStatus);
  const sessionAttentionStates = useSessionStore((state) => state.sessionAttentionStates);
  const setCurrentSession = useSessionStore((state) => state.setCurrentSession);
  const openNewSessionDraft = useSessionStore((state) => state.openNewSessionDraft);
  const getContextUsage = useSessionStore((state) => state.getContextUsage);
  const agents = useConfigStore((state) => state.agents);
  const { getCurrentModel } = useConfigStore();
  const { isMobile, showMobileSessionStatusBar, isMobileSessionStatusBarCollapsed, setIsMobileSessionStatusBarCollapsed } = useUIStore();
  const setActiveMainTab = useUIStore((state) => state.setActiveMainTab);

  // Project store
  const projects = useProjectsStore((state) => state.projects);
  const activeProjectId = useProjectsStore((state) => state.activeProjectId);
  const setActiveProject = useProjectsStore((state) => state.setActiveProject);
  const addProject = useProjectsStore((state) => state.addProject);
  const removeProject = useProjectsStore((state) => state.removeProject);
  const getActiveProject = useProjectsStore((state) => state.getActiveProject);

  // Directory store
  const homeDirectory = useDirectoryStore((state) => state.homeDirectory);

  const { sessions: sortedSessions, totalRunning, totalUnread, totalCount } = useSessionGrouping(sessions, sessionStatus, sessionAttentionStates);
  const { getSessionAgentName, getSessionTitle, needsAttention } = useSessionHelpers(agents, sessionStatus, sessionAttentionStates);
  const getProjectStatus = useProjectStatus(sessions, sessionStatus, sessionAttentionStates, currentSessionId);

  const currentSession = sessions.find((s) => s.id === currentSessionId);
  const currentSessionTitle = currentSession
    ? getSessionTitle(currentSession)
    : '← Swipe here to open sidebars →';

  // Calculate current session's child indicators
  const currentSessionWithStatus = sortedSessions.find((s) => s.id === currentSessionId);
  const currentSessionChildIndicators = currentSessionWithStatus?._childIndicators ?? [];

  const activeProject = getActiveProject();
  const currentProjectLabel = activeProject?.label || formatDirectoryName(activeProject?.path || '', homeDirectory);
  const currentProjectIcon = activeProject?.icon;
  const currentProjectIconImageUrl = activeProject ? getProjectIconImageUrl(activeProject) : null;
  const currentProjectIconBackground = activeProject?.iconBackground ?? null;
  const currentProjectColor = activeProject?.color;

  // Calculate token usage for current session
  const currentModel = getCurrentModel();
  const limit = currentModel && typeof currentModel.limit === 'object' && currentModel.limit !== null
    ? (currentModel.limit as Record<string, unknown>)
    : null;
  const contextLimit = (limit && typeof limit.context === 'number' ? limit.context : 0);
  const outputLimit = (limit && typeof limit.output === 'number' ? limit.output : 0);
  const contextUsage = getContextUsage(contextLimit, outputLimit);

  const [isExpanded, setIsExpanded] = React.useState(false);
  const tauriIpcAvailable = React.useMemo(() => isTauriShell(), []);

  if (!isMobile || !showMobileSessionStatusBar || totalCount === 0) {
    return null;
  }

  const handleSessionClick = (sessionId: string) => {
    setCurrentSession(sessionId);
    onSessionSwitch?.(sessionId);
    setIsExpanded(false);
  };

  const handleSessionDoubleClick = () => {
    // On double-tap, switch to the Chat tab
    setActiveMainTab('chat');
  };

  const handleCreateSession = () => {
    openNewSessionDraft();
  };

  const handleProjectSwitch = (projectId: string) => {
    if (projectId !== activeProjectId) {
      setActiveProject(projectId);
    }
  };

  const handleAddProject = () => {
    if (!tauriIpcAvailable || !isDesktopLocalOriginActive()) {
      sessionEvents.requestDirectoryDialog();
      return;
    }
    requestDirectoryAccess('')
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
        console.error('Failed to select directory:', error);
        toast.error('Failed to select directory');
      });
  };

  if (isMobileSessionStatusBarCollapsed) {
    return (
      <CollapsedView
        runningCount={totalRunning}
        unreadCount={totalUnread}
        currentSessionTitle={currentSessionTitle}
        currentProjectLabel={currentProjectLabel}
        currentProjectIcon={currentProjectIcon}
        currentProjectIconImageUrl={currentProjectIconImageUrl}
        currentProjectIconBackground={currentProjectIconBackground}
        currentProjectColor={currentProjectColor}
        onToggle={() => setIsMobileSessionStatusBarCollapsed(false)}
        onNewSession={handleCreateSession}
        cornerRadius={cornerRadius}
        contextUsage={contextUsage}
        childIndicators={currentSessionChildIndicators}
      />
    );
  }

  return (
    <ExpandedView
      sessions={sortedSessions}
      currentSessionId={currentSessionId ?? ''}
      runningCount={totalRunning}
      unreadCount={totalUnread}
      currentSessionTitle={currentSessionTitle}
      currentProjectLabel={currentProjectLabel}
      currentProjectIcon={currentProjectIcon}
      currentProjectIconImageUrl={currentProjectIconImageUrl}
      currentProjectIconBackground={currentProjectIconBackground}
      currentProjectColor={currentProjectColor}
      isExpanded={isExpanded}
      onToggleCollapse={() => {
        setIsMobileSessionStatusBarCollapsed(true);
        setIsExpanded(false);
      }}
      onNewSession={handleCreateSession}
      onSessionClick={handleSessionClick}
      onSessionDoubleClick={handleSessionDoubleClick}
      onProjectSwitch={handleProjectSwitch}
      onAddProject={handleAddProject}
      onRemoveProject={removeProject}
      getSessionAgentName={getSessionAgentName}
      getSessionTitle={getSessionTitle}
      needsAttention={needsAttention}
      cornerRadius={cornerRadius}
      contextUsage={contextUsage}
      projects={projects}
      activeProjectId={activeProjectId}
      getProjectStatus={getProjectStatus}
      homeDirectory={homeDirectory}
      childIndicators={currentSessionChildIndicators}
    />
  );
};
