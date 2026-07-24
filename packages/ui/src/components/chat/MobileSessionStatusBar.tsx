import React from 'react';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useAllSessionStatuses, useAllLiveSessions } from '@/sync/sync-context';
import { mergeLiveSessionWithGlobalSession, useGlobalSessionsStore, ensureGlobalSessionsLoaded, refreshGlobalSessions } from '@/stores/useGlobalSessionsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import type { Session } from '@opencode-ai/sdk/v2';
import type { ProjectEntry } from '@/lib/api/types';
import { cn, formatDirectoryName } from '@/lib/utils';
import { PROJECT_ICON_MAP, PROJECT_COLOR_MAP, ProjectIconImage } from '@/lib/projectMeta';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { Icon } from "@/components/icon/Icon";
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useNotificationStore } from '@/sync/notification-store';
import { useSessionPinnedStore } from '@/stores/useSessionPinnedStore';
import { compareSessionsByLifecycleOrder, useSessionOrderingStore } from '@/sync/session-ordering';
import { useI18n } from '@/lib/i18n';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';

interface MobileSessionStatusBarProps {
  onSessionSwitch?: (sessionId: string) => void;
}

interface SessionWithStatus extends Session {
  _statusType?: 'busy' | 'retry' | 'idle';
  _runningChildrenCount?: number;
}

// Cross-project session source. Mirrors the dedicated MobileSessionsSheet:
// global sessions cover all directories (even unbootstrapped ones), while the
// live aggregate (`useAllLiveSessions`) surfaces fresher data and every
// bootstrapped directory. Merging both makes other projects' sessions appear.
function useAllProjectSessions(): Session[] {
  const liveSessions = useAllLiveSessions();
  const globalActiveSessions = useGlobalSessionsStore((state) => state.activeSessions);
  return React.useMemo(() => {
    const liveById = new Map(liveSessions.map((session) => [session.id, session]));
    const merged = globalActiveSessions.map((session) => {
      const liveSession = liveById.get(session.id);
      return liveSession ? mergeLiveSessionWithGlobalSession(liveSession, session) : session;
    });
    const seen = new Set(merged.map((session) => session.id));
    for (const session of liveSessions) {
      if (!seen.has(session.id)) merged.push(session);
    }
    return merged;
  }, [globalActiveSessions, liveSessions]);
}

// Max sessions shown per (filtered) project list - a "recent" cap applied
// after filtering, so each project view shows at most this many.
const MAX_RECENT_SESSIONS = 25;

// Normalize path for comparison
const normalize = (value: string): string => {
  if (!value) return '';
  const replaced = value.replace(/\\/g, '/');
  return replaced === '/' ? '/' : replaced.replace(/\/+$/, '');
};

// A session's directory, mirroring the store's canonical resolution.
const sessionDirectory = (session: Session): string => {
  const record = session as Session & {
    directory?: string | null;
    project?: { worktree?: string | null } | null;
  };
  return normalize(record.directory ?? record.project?.worktree ?? '');
};

// Prefix-match used to group a session under a project root or worktree.
const pathBelongsToRoot = (path: string, root: string): boolean => {
  const p = normalize(path);
  const r = normalize(root);
  return Boolean(p && r && (p === r || p.startsWith(`${r}/`)));
};

function useSessionGrouping(
  sessions: Session[],
  sessionStatus: Record<string, { type: string }> | undefined
) {
  const unseenCounts = useNotificationStore((s) => s.index.session.unseenCount);
  const pinnedSessionIds = useSessionPinnedStore((state) => state.ids);
  const sessionOrderRanks = useSessionOrderingStore((state) => state.rankById);

  const parentChildMap = React.useMemo(() => {
    const map = new Map<string, Session[]>();
    const allIds = new Set(sessions.map((s) => s.id));

    for (const session of sessions) {
      const parentID = (session as { parentID?: string }).parentID;
      if (parentID && allIds.has(parentID)) {
        const children = map.get(parentID);
        if (children) children.push(session);
        else map.set(parentID, [session]);
      }
    }
    return map;
  }, [sessions]);

  const getStatusType = React.useCallback((sessionId: string): 'busy' | 'retry' | 'idle' => {
    const status = sessionStatus?.[sessionId];
    if (status?.type === 'busy' || status?.type === 'retry') return status.type;
    return 'idle';
  }, [sessionStatus]);

  const processedSessions = React.useMemo(() => {
    const sessionIds = new Set(sessions.map((s) => s.id));
    const topLevel = sessions.filter((session) => {
      const parentID = (session as { parentID?: string }).parentID;
      return !parentID || !sessionIds.has(parentID);
    });

    const ordered = topLevel.map((session): SessionWithStatus => {
      const statusType = getStatusType(session.id);
      const runningChildrenCount = (parentChildMap.get(session.id) ?? [])
        .filter((child) => getStatusType(child.id) !== 'idle')
        .length;
      return {
        ...session,
        _statusType: statusType,
        _runningChildrenCount: runningChildrenCount,
      };
    });

    const compare = (a: Session, b: Session) => (
      compareSessionsByLifecycleOrder(a, b, pinnedSessionIds, sessionOrderRanks)
    );
    return ordered.sort(compare);
  }, [sessions, getStatusType, parentChildMap, pinnedSessionIds, sessionOrderRanks]);

  const totalRunning = processedSessions.reduce((sum, s) => {
    const selfRunning = s._statusType !== 'idle' ? 1 : 0;
    return sum + selfRunning + (s._runningChildrenCount ?? 0);
  }, 0);

  const totalUnread = processedSessions.filter((s) => (unseenCounts[s.id] ?? 0) > 0).length;

  return { sessions: processedSessions, totalRunning, totalUnread, totalCount: processedSessions.length };
}

function useSessionHelpers() {
  const getSessionTitle = React.useCallback((session: Session): string => {
    const title = session.title;
    if (title && title.trim()) return title;
    return 'New session';
  }, []);

  const unseenCounts = useNotificationStore((s) => s.index.session.unseenCount);
  const needsAttention = React.useCallback((sessionId: string): boolean => {
    return (unseenCounts[sessionId] ?? 0) > 0;
  }, [unseenCounts]);

  return { getSessionTitle, needsAttention };
}

// Per-project status indicators (running / unread) for the filter chips.
function useProjectStatus(
  sessionStatus: Record<string, { type: string }> | undefined,
  currentSessionId: string | null
) {
  const availableWorktreesByProject = useSessionUIStore((state) => state.availableWorktreesByProject);
  const getSessionsByDirectory = useSessionUIStore((state) => state.getSessionsByDirectory);
  const notifUnseenCounts = useNotificationStore((s) => s.index.session.unseenCount);

  return React.useCallback((projectPath: string): { hasRunning: boolean; hasUnread: boolean } => {
    const getStatusType = (sessionId: string): 'busy' | 'retry' | 'idle' => {
      const status = sessionStatus?.[sessionId];
      if (status?.type === 'busy' || status?.type === 'retry') return status.type;
      return 'idle';
    };

    const projectRoot = normalize(projectPath);
    if (!projectRoot) return { hasRunning: false, hasUnread: false };

    const dirs: string[] = [projectRoot];
    const worktrees = availableWorktreesByProject.get(projectRoot) ?? [];
    for (const meta of worktrees) {
      const p = (meta && typeof meta === 'object' && 'path' in meta) ? (meta as { path?: unknown }).path : null;
      if (typeof p === 'string' && p.trim()) {
        const normalized = normalize(p);
        if (normalized && normalized !== projectRoot) dirs.push(normalized);
      }
    }

    const seen = new Set<string>();
    let hasRunning = false;
    let hasUnread = false;

    for (const dir of dirs) {
      for (const session of getSessionsByDirectory(dir)) {
        if (!session?.id || seen.has(session.id)) continue;
        seen.add(session.id);

        if (getStatusType(session.id) !== 'idle') hasRunning = true;
        if (session.id !== currentSessionId && (notifUnseenCounts[session.id] ?? 0) > 0) hasUnread = true;
        if (hasRunning && hasUnread) break;
      }
      if (hasRunning && hasUnread) break;
    }

    return { hasRunning, hasUnread };
  }, [getSessionsByDirectory, availableWorktreesByProject, sessionStatus, notifUnseenCounts, currentSessionId]);
}

// Resolves the project's root directories (root + known worktrees) for
// prefix-matching sessions, mirroring the dedicated MobileSessionsSheet.
function useProjectRootsResolver() {
  const availableWorktreesByProject = useSessionUIStore((state) => state.availableWorktreesByProject);

  return React.useCallback((project: ProjectEntry): string[] => {
    const projectRoot = normalize(project.path);
    const roots = [projectRoot];
    const worktrees = availableWorktreesByProject.get(projectRoot) ?? [];
    for (const meta of worktrees) {
      const p = (meta && typeof meta === 'object' && 'path' in meta) ? (meta as { path?: unknown }).path : null;
      if (typeof p === 'string' && p.trim()) {
        const normalized = normalize(p);
        if (normalized) roots.push(normalized);
      }
    }
    return roots;
  }, [availableWorktreesByProject]);
}

function StatusIndicator({ isRunning, needsAttention }: { isRunning: boolean; needsAttention: boolean }) {
  if (isRunning) {
    return <Icon name="loader-4" className="h-3.5 w-3.5 animate-spin text-[var(--status-info)]" />;
  }
  if (needsAttention) {
    return <div className="h-2 w-2 rounded-full bg-[var(--status-error)]" />;
  }
  return <div className="h-2 w-2 rounded-full border border-[var(--surface-mutedForeground)]" />;
}

function RunningIndicator({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span className="flex items-center gap-1 text-[13px] text-[var(--status-info)]">
      <Icon name="loader-4" className="h-3.5 w-3.5 animate-spin" />
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

// A single session row sized for comfortable touch.
function SessionItem({
  session,
  isCurrent,
  getSessionTitle,
  onClick,
  needsAttention,
}: {
  session: SessionWithStatus;
  isCurrent: boolean;
  getSessionTitle: (s: Session) => string;
  onClick: () => void;
  needsAttention: (sessionId: string) => boolean;
}) {
  const attention = needsAttention(session.id);

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left transition-colors min-h-[56px]",
        "active:bg-[var(--interactive-selection)]",
        isCurrent ? "bg-[color-mix(in_srgb,var(--interactive-selection)_40%,transparent)]" : "hover:bg-[var(--interactive-hover)]"
      )}
    >
      <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center">
        <StatusIndicator isRunning={session._statusType !== 'idle'} needsAttention={attention} />
      </span>

      <span className={cn(
        "flex-1 truncate text-[15px] leading-tight",
        isCurrent ? "font-semibold text-[var(--surface-foreground)]" : "text-[var(--surface-foreground)]"
      )}>
        {getSessionTitle(session)}
      </span>

      {(session._runningChildrenCount ?? 0) > 0 && (
        <span className="flex flex-shrink-0 items-center gap-1 text-[12px] text-[var(--status-info)]">
          <Icon name="loader-4" className="h-3 w-3 animate-spin" />
          {session._runningChildrenCount}
        </span>
      )}

      {isCurrent && (
        <Icon name="check" className="h-4 w-4 flex-shrink-0 text-[var(--primary-base)]" />
      )}
    </button>
  );
}

// A project filter pill sized for touch. Selecting it filters
// the session list; it does NOT switch the active project.
interface ProjectFilterChipProps {
  label: string;
  icon?: string | null;
  project?: Pick<ProjectEntry, 'id' | 'iconImage'> | null;
  iconOptions?: React.ComponentProps<typeof ProjectIconImage>['options'];
  iconBackground?: string | null;
  colorVar?: string | null;
  isActive: boolean;
  status?: { hasRunning: boolean; hasUnread: boolean };
  onClick: () => void;
}

function ProjectFilterChip({
  label,
  icon,
  project,
  iconOptions,
  iconBackground,
  colorVar,
  isActive,
  status,
  onClick,
}: ProjectFilterChipProps) {
  const projectIconName = icon ? PROJECT_ICON_MAP[icon] : null;
  const fallbackIcon = projectIconName ? (
    <Icon name={projectIconName} className="h-4 w-4" style={!isActive && colorVar ? { color: colorVar } : undefined} />
  ) : null;

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex min-h-[40px] shrink-0 select-none items-center gap-1.5 rounded-full border px-3.5 text-[13px] leading-none whitespace-nowrap transition-colors",
        isActive
          ? "border-transparent bg-[var(--primary-base)] text-[var(--primary-foreground)] font-medium"
          : "border-[var(--interactive-border)] bg-[var(--surface-subtle)] text-[var(--surface-foreground)] active:bg-[var(--interactive-hover)]"
      )}
    >
      {status && (status.hasRunning || status.hasUnread) && !isActive && (
        status.hasRunning
          ? <Icon name="loader-4" className="h-2.5 w-2.5 animate-spin text-[var(--status-info)]" />
          : <span className="h-1.5 w-1.5 rounded-full bg-[var(--status-error)]" />
      )}

      {project?.iconImage ? (
        <span
          className="inline-flex h-4 w-4 items-center justify-center overflow-hidden rounded-[2px]"
          style={iconBackground ? { backgroundColor: iconBackground } : undefined}
        >
          <ProjectIconImage
            project={project}
            options={iconOptions}
            className="h-full w-full object-contain"
            fallback={fallbackIcon}
          />
        </span>
      ) : fallbackIcon}

      <span className="max-w-[140px] truncate">{label}</span>
    </button>
  );
}

// The chip that lives in the composer footer and toggles the slide-up sheet.
// This is the only persistent affordance; there is no longer a permanent bar.
interface MobileSessionPanelTriggerProps {
  footerIconButtonClass: string;
  iconSizeClass: string;
}

export const MobileSessionPanelTrigger: React.FC<MobileSessionPanelTriggerProps> = ({
  footerIconButtonClass,
  iconSizeClass,
}) => {
  const { t } = useI18n();
  const isMobile = useUIStore((state) => state.isMobile);
  const open = useUIStore((state) => state.mobileSessionPanelOpen);
  const setOpen = useUIStore((state) => state.setMobileSessionPanelOpen);

  // Ensure the cross-project session list is loaded once, so the panel reflects
  // every project, not just the active directory.
  React.useEffect(() => {
    if (isMobile) {
      void ensureGlobalSessionsLoaded();
    }
  }, [isMobile]);

  if (!isMobile) {
    return null;
  }

  return (
    <button
      type="button"
      className={cn(
        footerIconButtonClass,
        'rounded-md relative hover:bg-[var(--interactive-hover)]',
        open && 'text-[var(--primary-base)]'
      )}
      style={{ touchAction: 'manipulation' }}
      onClick={() => setOpen(!open)}
      title={t('mobile.sessions.search.section.sessions')}
      aria-label={t('mobile.sessions.search.section.sessions')}
      aria-expanded={open}
    >
      <Icon name="stack" className={cn(iconSizeClass)} />
    </button>
  );
};

const MobileSessionStatusOpenPanel: React.FC<MobileSessionStatusBarProps> = ({
  onSessionSwitch,
}) => {
  const { t } = useI18n();
  const { currentTheme } = useThemeSystem();
  const sessions = useAllProjectSessions();
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const sessionStatus = useAllSessionStatuses();
  const setCurrentSession = useSessionUIStore((state) => state.setCurrentSession);
  const openNewSessionDraft = useSessionUIStore((state) => state.openNewSessionDraft);
  const open = useUIStore((state) => state.mobileSessionPanelOpen);
  const setOpen = useUIStore((state) => state.setMobileSessionPanelOpen);

  const projects = useProjectsStore((state) => state.projects);
  const homeDirectory = useDirectoryStore((state) => state.homeDirectory);

  const { sessions: sortedSessions, totalRunning, totalUnread } = useSessionGrouping(sessions, sessionStatus);
  const { getSessionTitle, needsAttention } = useSessionHelpers();
  const getProjectStatus = useProjectStatus(sessionStatus, currentSessionId);
  const resolveProjectRoots = useProjectRootsResolver();

  // Project filter, persisted in the UI store so the choice survives closing and
  // reopening the sheet. Defaults to "All" so sessions from every project are
  // visible regardless of which session is currently selected.
  const filterProjectId = useUIStore((state) => state.mobileSessionFilterProjectId);
  const setFilterProjectId = useUIStore((state) => state.setMobileSessionFilterProjectId);

  // Refresh the cross-project session list when the panel opens (mirrors the
  // dedicated MobileSessionsSheet). The active-directory sync only upserts the
  // current project's sessions, so other projects need this global load.
  React.useEffect(() => {
    if (open) {
      void refreshGlobalSessions(sessions);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const formatProjectLabel = React.useCallback((project: ProjectEntry): string => {
    return project.label?.trim()
      || formatDirectoryName(project.path, homeDirectory)
      || project.path;
  }, [homeDirectory]);

  // Filter sessions by the selected project (root + worktrees), using the
  // store's canonical directory keying.
  const filteredSessions = React.useMemo(() => {
    if (!filterProjectId) return sortedSessions;
    const project = projects.find((p) => p.id === filterProjectId);
    if (!project) return sortedSessions;
    const roots = resolveProjectRoots(project);
    return sortedSessions.filter((session) => {
      const dir = sessionDirectory(session);
      return roots.some((root) => pathBelongsToRoot(dir, root));
    });
  }, [sortedSessions, filterProjectId, projects, resolveProjectRoots]);

  // Cap to the most recent N (already sorted running-first, then by updated).
  const visibleSessions = React.useMemo(
    () => filteredSessions.slice(0, MAX_RECENT_SESSIONS),
    [filteredSessions],
  );

  const handleSessionClick = (session: SessionWithStatus) => {
    setCurrentSession(session.id, sessionDirectory(session) || null);
    onSessionSwitch?.(session.id);
    setOpen(false);
  };

  // "+" — start a new session draft. Target the project selected in the filter;
  // for "All", use the most recently active session's directory, falling back to
  // the store's own default target when there are no sessions.
  const handleNewChat = React.useCallback(() => {
    setOpen(false);
    if (filterProjectId) {
      const project = projects.find((p) => p.id === filterProjectId);
      if (project) {
        openNewSessionDraft({ selectedProjectId: project.id, directoryOverride: project.path });
        return;
      }
    }
    const mostRecent = [...sessions].sort((a, b) => compareSessionsByLifecycleOrder(
      a,
      b,
      useSessionPinnedStore.getState().ids,
      useSessionOrderingStore.getState().rankById,
    ))[0];
    const directory = mostRecent ? sessionDirectory(mostRecent) : '';
    openNewSessionDraft(directory ? { directoryOverride: directory } : undefined);
  }, [filterProjectId, projects, sessions, openNewSessionDraft, setOpen]);

  const renderHeader = React.useCallback(() => (
    <div className="shrink-0">
      <div className="flex justify-center pt-2.5 pb-1">
        <div className="h-1 w-9 rounded-full bg-[color-mix(in_srgb,var(--surface-mutedForeground)_40%,transparent)]" />
      </div>

      <div className="flex items-center justify-between gap-2 px-4 pb-2">
        <h2 className="text-[16px] font-semibold text-[var(--surface-foreground)]">
          {t('mobile.sessions.search.section.sessions')}
        </h2>
        <div className="flex items-center gap-3">
          <RunningIndicator count={totalRunning} />
          <UnreadIndicator count={totalUnread} />
          <button
            type="button"
            onClick={handleNewChat}
            aria-label={t('mobile.sessions.newChat')}
            className="flex size-8 items-center justify-center rounded-full text-[var(--surface-mutedForeground)] transition-colors hover:bg-[var(--interactive-hover)] hover:text-[var(--surface-foreground)]"
            style={{ touchAction: 'manipulation' }}
          >
            <Icon name="add" className="h-5 w-5" />
          </button>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="flex size-8 items-center justify-center rounded-full text-[var(--surface-mutedForeground)] transition-colors hover:bg-[var(--interactive-hover)] hover:text-[var(--surface-foreground)]"
            style={{ touchAction: 'manipulation' }}
          >
            <Icon name="close" className="h-5 w-5" />
          </button>
        </div>
      </div>

      {projects.length > 1 && (
        <div
          className="flex items-center gap-2 overflow-x-auto border-t border-[color-mix(in_srgb,var(--interactive-border)_40%,transparent)] px-4 py-2.5 scrollbar-none"
          style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
        >
          <ProjectFilterChip
            label={t('chat.modelControls.modeValue.all')}
            isActive={filterProjectId === null}
            onClick={() => setFilterProjectId(null)}
          />
          {projects.map((project) => (
            <ProjectFilterChip
              key={project.id}
              label={formatProjectLabel(project)}
              icon={project.icon}
              project={{ id: project.id, iconImage: project.iconImage ?? null }}
              iconOptions={{
                themeVariant: currentTheme.metadata.variant,
                iconColor: currentTheme.colors.surface.foreground,
              }}
              iconBackground={project.iconBackground ?? null}
              colorVar={project.color ? (PROJECT_COLOR_MAP[project.color] ?? null) : null}
              isActive={filterProjectId === project.id}
              status={getProjectStatus(project.path)}
              onClick={() => setFilterProjectId(project.id)}
            />
          ))}
        </div>
      )}
    </div>
  ), [t, totalRunning, totalUnread, projects, filterProjectId, setFilterProjectId, formatProjectLabel, currentTheme, getProjectStatus, handleNewChat, setOpen]);

  return (
    <MobileOverlayPanel
      open={open}
      onClose={() => setOpen(false)}
      title={t('mobile.sessions.search.section.sessions')}
      renderHeader={renderHeader}
      className="h-[72vh]"
      contentMaxHeightClassName="max-h-full"
    >
      <div className="flex min-h-full flex-col gap-0.5">
        {visibleSessions.length === 0 ? (
          <div className="flex flex-1 items-center justify-center py-10 text-[13px] text-[var(--surface-mutedForeground)]">
            <span>{t('chat.mobileStatus.noSessionsInProject')}</span>
          </div>
        ) : (
          visibleSessions.map((session) => (
            <SessionItem
              key={session.id}
              session={session}
              isCurrent={session.id === currentSessionId}
              getSessionTitle={getSessionTitle}
              onClick={() => handleSessionClick(session)}
              needsAttention={needsAttention}
            />
          ))
        )}
      </div>
    </MobileOverlayPanel>
  );
};

export const MobileSessionStatusBar: React.FC<MobileSessionStatusBarProps> = (props) => {
  const isMobile = useUIStore((state) => state.isMobile);
  const open = useUIStore((state) => state.mobileSessionPanelOpen);

  if (!isMobile || !open) return null;
  return <MobileSessionStatusOpenPanel {...props} />;
};
