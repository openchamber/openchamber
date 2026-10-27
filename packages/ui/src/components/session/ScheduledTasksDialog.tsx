import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { toast } from '@/components/ui';
import { Icon } from "@/components/icon/Icon";
import { Spinner } from "@/components/ui/spinner";
import type { IconName } from "@/components/icon/icons";
import { useUIStore } from '@/stores/useUIStore';
import { formatTimeForPreference } from '@/lib/timeFormat';
import type { TimeFormatPreference } from '@/stores/useUIStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useProjectsInSidebarOrder } from '@/components/session/sidebar/list/useProjectsInSidebarOrder';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { refreshGlobalSessions, useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { openSessionFromRoute } from '@/lib/router/openSessionFromRoute';
import { PROJECT_ICON_MAP, resolveProjectColor, ProjectIconImage } from '@/lib/projectMeta';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { cn, formatDirectoryName } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import type { ProjectEntry } from '@/lib/api/types';
import {
  deleteScheduledTask,
  deleteScheduledTaskLoopFile,
  fetchScheduledTasks,
  runScheduledTaskNow,
  ScheduledTaskBusyError,
  setLoopScheduledTaskEnabled,
  upsertScheduledTask,
  type ScheduledTask,
  type ScheduledTaskStatus,
} from '@/lib/scheduledTasksApi';
import { ScheduledTaskEditorDialog } from './ScheduledTaskEditorDialog';
import { canonicalizeTimezone } from '@/lib/timezones';
import { getModelDisplayName } from '@/lib/modelDisplay';
import { agentLabel } from '@/lib/agentLabel';
import { useAgentColors } from '@/hooks/useAgentColors';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { useConfigStore } from '@/stores/useConfigStore';
import { useFilesViewTabsStore } from '@/stores/useFilesViewTabsStore';
import { CHAT_DRAFT_PROJECT_ID } from '@/lib/chatDirectories';
import { isVSCodeRuntime } from '@/lib/desktop';
import { createTaskRequestGate, mayCommitTaskList, mayEndTaskLoad } from './scheduledTasksRequests';

const scheduleTimes = (task: ScheduledTask): string[] => {
  const raw = Array.isArray(task.schedule.times)
    ? task.schedule.times
    : (task.schedule.time ? [task.schedule.time] : []);
  const valid = raw.filter((value) => typeof value === 'string' && /^([01]\d|2[0-3]):([0-5]\d)$/.test(value));
  return Array.from(new Set(valid)).sort((a, b) => a.localeCompare(b));
};

/**
 * What a task runs with, drawn the way the composer shows it: the provider's
 * logo before the model name, then the variant, then the agent with the
 * composer's agent icon in that agent's colour. Tasks that follow the session
 * defaults say so instead.
 */
const TaskModelLine: React.FC<{ task: ScheduledTask }> = ({ task }) => {
  const { t } = useI18n();
  const getAgentColor = useAgentColors();
  const agents = useConfigStore((state) => state.agents);
  const { providerID, modelID, variant, agent, useDefaults } = task.execution;
  if (useDefaults || !providerID || !modelID) {
    return <span className="truncate">{t('sessions.scheduledTasks.dialog.usesDefaults')}</span>;
  }
  const agentName = agent?.trim();
  const knownAgent = agentName ? agents.find((entry) => entry.name === agentName) : undefined;
  return (
    <>
      <ProviderLogo providerId={providerID} alt={providerID} className="h-3 w-3 shrink-0" />
      <span className="min-w-0 truncate">
        {[getModelDisplayName(null, modelID), variant?.trim()].filter(Boolean).join(' · ')}
      </span>
      {agentName ? (
        <>
          <span aria-hidden="true">·</span>
          <Icon name="ai-agent" className="h-3 w-3 shrink-0" style={{ color: getAgentColor(agentName).color }} />
          <span className="shrink-0 truncate" style={{ color: getAgentColor(agentName).color }}>
            {agentLabel(knownAgent ?? { name: agentName, displayName: '' })}
          </span>
        </>
      ) : null}
    </>
  );
};

const formatSchedule = (task: ScheduledTask, t: ReturnType<typeof useI18n>['t']): string => {
  const timesLabel = scheduleTimes(task).join(', ') || '--:--';
  const formatWeekday = (value: number) => {
    if (value === 0) return t('sessions.scheduledTasks.dialog.schedule.weekdayShort.sun');
    if (value === 1) return t('sessions.scheduledTasks.dialog.schedule.weekdayShort.mon');
    if (value === 2) return t('sessions.scheduledTasks.dialog.schedule.weekdayShort.tue');
    if (value === 3) return t('sessions.scheduledTasks.dialog.schedule.weekdayShort.wed');
    if (value === 4) return t('sessions.scheduledTasks.dialog.schedule.weekdayShort.thu');
    if (value === 5) return t('sessions.scheduledTasks.dialog.schedule.weekdayShort.fri');
    if (value === 6) return t('sessions.scheduledTasks.dialog.schedule.weekdayShort.sat');
    return t('sessions.scheduledTasks.dialog.schedule.weekdayShort.unknown');
  };
  if (task.schedule.kind === 'daily') {
    if (task.schedule.timezone) {
      return t('sessions.scheduledTasks.dialog.schedule.dailyWithTimezone', {
        time: timesLabel,
        timezone: canonicalizeTimezone(task.schedule.timezone),
      });
    }
    return t('sessions.scheduledTasks.dialog.schedule.daily', { time: timesLabel });
  }
  if (task.schedule.kind === 'weekly') {
    const days = Array.isArray(task.schedule.weekdays)
      ? task.schedule.weekdays.map((value) => formatWeekday(value)).join(', ')
      : '';
    if (task.schedule.timezone) {
      return t('sessions.scheduledTasks.dialog.schedule.weeklyWithTimezone', {
        days,
        time: timesLabel,
        timezone: canonicalizeTimezone(task.schedule.timezone),
      });
    }
    return t('sessions.scheduledTasks.dialog.schedule.weekly', { days, time: timesLabel });
  }
  if (task.schedule.kind === 'once') {
    const date = typeof task.schedule.date === 'string' && task.schedule.date.trim().length > 0
      ? task.schedule.date
      : t('sessions.scheduledTasks.dialog.schedule.unknownDate');
    const time = typeof task.schedule.time === 'string' && task.schedule.time.trim().length > 0
      ? task.schedule.time
      : '--:--';
    if (task.schedule.timezone) {
      return t('sessions.scheduledTasks.dialog.schedule.onceWithTimezone', {
        date,
        time,
        timezone: canonicalizeTimezone(task.schedule.timezone),
      });
    }
    return t('sessions.scheduledTasks.dialog.schedule.once', { date, time });
  }
  if (task.schedule.timezone) {
    return t('sessions.scheduledTasks.dialog.schedule.cronWithTimezone', {
      cron: task.schedule.cron || '',
      timezone: canonicalizeTimezone(task.schedule.timezone),
    });
  }
  return t('sessions.scheduledTasks.dialog.schedule.cron', { cron: task.schedule.cron || '' });
};

const formatClockTime = (value: number | undefined, timeFormatPreference: TimeFormatPreference): string => {
  if (!value || !Number.isFinite(value)) {
    return '';
  }
  return formatTimeForPreference(value, timeFormatPreference);
};

const formatRelativeTime = (value: number | undefined, t: ReturnType<typeof useI18n>['t']): string => {
  if (!value || !Number.isFinite(value)) {
    return '';
  }
  const diff = value - Date.now();
  const abs = Math.abs(diff);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const future = diff >= 0;
  if (abs < minute) {
    return future ? t('sessions.scheduledTasks.dialog.relativeTime.inLessThanOneMinute') : t('sessions.scheduledTasks.dialog.relativeTime.justNow');
  }
  if (abs < hour) {
    const m = Math.round(abs / minute);
    return future
      ? t('sessions.scheduledTasks.dialog.relativeTime.inMinutes', { count: m })
      : t('sessions.scheduledTasks.dialog.relativeTime.minutesAgo', { count: m });
  }
  if (abs < day) {
    const h = Math.floor(abs / hour);
    const m = Math.round((abs % hour) / minute);
    const body = m > 0 ? `${h}h ${m}m` : `${h}h`;
    return future
      ? t('sessions.scheduledTasks.dialog.relativeTime.inDuration', { duration: body })
      : t('sessions.scheduledTasks.dialog.relativeTime.durationAgo', { duration: body });
  }
  const d = Math.floor(abs / day);
  const h = Math.round((abs % day) / hour);
  const body = h > 0 ? `${d}d ${h}h` : `${d}d`;
  return future
    ? t('sessions.scheduledTasks.dialog.relativeTime.inDuration', { duration: body })
    : t('sessions.scheduledTasks.dialog.relativeTime.durationAgo', { duration: body });
};

type StatusTone = 'success' | 'error' | 'warning' | 'muted';

type TaskStatusMeta = { tone: StatusTone; Icon: IconName; spin?: boolean };
const STATUS_META = {
  success: { tone: 'success', Icon: 'checkbox-circle' },
  error: { tone: 'error', Icon: 'error-warning' },
  running: { tone: 'warning', Icon: 'loader-4', spin: true },
  idle: { tone: 'muted', Icon: 'pulse' },
  queued: { tone: 'warning', Icon: 'pulse' },
  sent: { tone: 'success', Icon: 'checkbox-circle' },
  skipped: { tone: 'muted', Icon: 'pulse' },
  failed: { tone: 'error', Icon: 'error-warning' },
  cancelled: { tone: 'muted', Icon: 'pulse' },
} satisfies Record<ScheduledTaskStatus, TaskStatusMeta>;

const TaskTargetLine: React.FC<{ sessionId: string }> = ({ sessionId }) => {
  const { t } = useI18n();
  const session = useGlobalSessionsStore((state) => state.entityById.get(sessionId));
  return <p className="truncate typography-meta text-muted-foreground">{t('sessions.scheduledTasks.editor.targetSession')}: {session?.title || sessionId}</p>;
};

// Next to "Paused" on a repository loop that waits for the user: the icon
// says why, the sentence is its title. A loop the user paused has none.
const LoopApprovalMark: React.FC<{ reason: NonNullable<ScheduledTask['loopApproval']> }> = ({ reason }) => {
  const { t } = useI18n();
  const label = reason === 'outdated'
    ? t('sessions.scheduledTasks.dialog.loopFile.changedSinceEnabled')
    : t('sessions.scheduledTasks.dialog.loopFile.enableOnThisComputer');
  return (
    <span role="img" aria-label={label} title={label} className="inline-flex text-muted-foreground">
      <Icon name={reason === 'outdated' ? 'file-edit' : 'git-branch'} className="h-3.5 w-3.5" />
    </span>
  );
};

const toneStyle = (tone: StatusTone): React.CSSProperties => {
  if (tone === 'muted') {
    return {};
  }
  return {
    color: `var(--status-${tone})`,
    backgroundColor: `var(--status-${tone}-background)`,
    borderColor: `var(--status-${tone}-border)`,
  };
};

/** Why the page is being left: a started session or a loop file to edit
 *  takes over the screen, and each shell decides how to get there. */
export type ScheduledTasksLeaveReason = 'session' | 'file';

/**
 * The scheduled tasks page. `page` is the desktop surface that replaces the
 * chat area (scope list at the left, tasks at the right); `mobile` is the
 * single-column body of the mobile shell's fullscreen surface.
 */
export function ScheduledTasksView({ layout, onLeave }: {
  layout: 'page' | 'mobile';
  onLeave: (reason: ScheduledTasksLeaveReason) => void;
}) {
  const { t } = useI18n();
  const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);
  const storedProjects = useProjectsStore((state) => state.projects);
  const projects = useProjectsInSidebarOrder(storedProjects);
  const activeProject = useProjectsStore((state) => state.getActiveProject());
  const homeDirectory = useDirectoryStore((state) => state.homeDirectory);
  const { currentTheme } = useThemeSystem();

  const [selectedProjectID, setSelectedProjectID] = React.useState<string>('');
  // Ownership of the task flow lives in refs, decided in one place:
  // - `selectedProjectRef` mirrors the selection the moment it changes, so an
  //   async continuation can compare against it without waiting for a render;
  // - `listOwnerRef` is the project whose tasks the visible list holds — task
  //   actions name it instead of re-deriving the project from the selection;
  // - `taskRequestGate` numbers fetches per project, so a slow older response
  //   cannot overwrite a newer one (`scheduledTasksRequests.ts`).
  const selectedProjectRef = React.useRef<string>('');
  const listOwnerRef = React.useRef<string>('');
  const [taskRequestGate] = React.useState(createTaskRequestGate);
  const editorOwnerRef = React.useRef<string>('');
  const [tasks, setTasks] = React.useState<ScheduledTask[]>([]);
  // Start in loading state so the first frame after open shows the spinner,
  // not an empty/select-project flash before the fetch effect runs.
  const [loading, setLoading] = React.useState(true);
  const [editorOpen, setEditorOpen] = React.useState(false);
  const [editorTask, setEditorTask] = React.useState<ScheduledTask | null>(null);
  const [mutatingTaskID, setMutatingTaskID] = React.useState<string | null>(null);
  // Chats are scheduled like a project; each run starts a new chat. VS Code
  // has no chats, so the entry exists everywhere else.
  const chatsAvailable = !isVSCodeRuntime();

  const selectedProject = React.useMemo(
    () => projects.find((project) => project.id === selectedProjectID) || null,
    [projects, selectedProjectID],
  );

  const renderProjectLabel = React.useCallback((project: ProjectEntry) => {
    const displayLabel = project.label?.trim() || formatDirectoryName(project.path, homeDirectory || undefined);
    const projectIconName = project.icon ? PROJECT_ICON_MAP[project.icon] : null;
    const iconColor = resolveProjectColor(project.color) ?? undefined;
    const fallbackIcon = projectIconName ? (
      <Icon name={projectIconName} className="h-3.5 w-3.5 shrink-0" style={iconColor ? { color: iconColor } : undefined} />
    ) : (
      <Icon name="folder" className="h-3.5 w-3.5 shrink-0 text-muted-foreground"  style={iconColor ? { color: iconColor } : undefined}/>
    );

    return (
      <span className="inline-flex min-w-0 items-center gap-1.5">
        {project.iconImage ? (
          <span
            className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center overflow-hidden rounded-[3px]"
            style={project.iconBackground ? { backgroundColor: project.iconBackground } : undefined}
          >
            <ProjectIconImage
              project={{ id: project.id, iconImage: project.iconImage ?? null }}
              options={{
                themeVariant: currentTheme.metadata.variant,
                iconColor: currentTheme.colors.surface.foreground,
              }}
              className="h-full w-full object-contain"
              fallback={fallbackIcon}
            />
          </span>
        ) : fallbackIcon}
        <span className="truncate">{displayLabel}</span>
      </span>
    );
  }, [homeDirectory, currentTheme.metadata.variant, currentTheme.colors.surface.foreground]);

  // Every selection change routes through here once, so the mirror ref and
  // the state can never disagree about which scope is on screen.
  const selectProjectScope = React.useCallback((nextProjectID: string) => {
    selectedProjectRef.current = nextProjectID;
    setSelectedProjectID(nextProjectID);
  }, []);

  // The only writer of the task list. It refuses a list that does not belong
  // to the scope on screen: a project change is the selection's to answer,
  // and a slow fetch for an earlier project has no say over this view.
  const commitTaskList = React.useCallback((projectID: string, nextTasks: ScheduledTask[]) => {
    if (!mayCommitTaskList(projectID, selectedProjectRef.current)) {
      return;
    }
    listOwnerRef.current = projectID;
    setTasks(nextTasks);
  }, []);

  const reloadTasks = React.useCallback(async (projectID: string, options?: { silent?: boolean }) => {
    // A newer request for the same project supersedes an older one; a
    // request for another project is answered by the selection, since
    // commitTaskList refuses anything that is not on screen.
    if (!projectID) {
      commitTaskList('', []);
      setLoading(false);
      return;
    }
    const request = taskRequestGate.begin(projectID);
    if (!options?.silent) {
      setLoading(true);
    }
    try {
      const nextTasks = await fetchScheduledTasks(projectID);
      if (!taskRequestGate.isLatest(projectID, request)) {
        return; // A newer fetch for this project owns the list; drop this one.
      }
      nextTasks.sort((a, b) => {
        if (a.enabled !== b.enabled) {
          return a.enabled ? -1 : 1;
        }
        const byName = a.name.localeCompare(b.name);
        if (byName !== 0) {
          return byName;
        }
        return (a.state?.nextRunAt || Number.MAX_SAFE_INTEGER) - (b.state?.nextRunAt || Number.MAX_SAFE_INTEGER);
      });
      commitTaskList(projectID, nextTasks);
    } catch (error) {
      if (!taskRequestGate.isLatest(projectID, request)) {
        return;
      }
      toast.error(error instanceof Error ? error.message : t('sessions.scheduledTasks.dialog.toast.loadFailed'));
      if (!options?.silent) {
        commitTaskList(projectID, []);
      }
    } finally {
      // The latest load for the scope on screen decides the spinner, silent
      // or not. A response for another scope is refused by commitTaskList
      // and must not clear the new selection's pending load either.
      if (mayEndTaskLoad(taskRequestGate, projectID, request, selectedProjectRef.current)) {
        setLoading(false);
      }
    }
  }, [commitTaskList, taskRequestGate, t]);

  // Keyed on the stored list: a "Recent" reorder must not reset the chosen scope.
  React.useEffect(() => {
    const preferredProjectID = activeProject?.id || storedProjects[0]?.id || (chatsAvailable ? CHAT_DRAFT_PROJECT_ID : '');
    selectProjectScope(preferredProjectID);
    if (preferredProjectID) {
      void reloadTasks(preferredProjectID);
    } else {
      commitTaskList('', []);
      setLoading(false);
    }
  }, [activeProject, storedProjects, chatsAvailable, reloadTasks, selectProjectScope, commitTaskList]);

  React.useEffect(() => {
    let timeoutID: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = subscribeOpenchamberEvents((event) => {
      if (event.type !== 'scheduled-task-ran') {
        return;
      }
      if (event.projectId !== selectedProjectID) {
        return;
      }
      if (timeoutID) {
        clearTimeout(timeoutID);
      }
      timeoutID = setTimeout(() => {
        void reloadTasks(selectedProjectID, { silent: true });
      }, 400);
    });
    return () => {
      if (timeoutID) {
        clearTimeout(timeoutID);
      }
      unsubscribe();
    };
  }, [selectedProjectID, reloadTasks]);

  const handleSaveTask = React.useCallback(async (taskDraft: Partial<ScheduledTask>) => {
    // An existing task belongs to the scope whose list displayed it; a draft
    // without an id is created in the selected scope. Acting on the owner
    // keeps a scope switch made while the editor was open from misfiling a
    // task into the other project.
    const projectID = (taskDraft.id ? editorOwnerRef.current : '') || selectedProjectID;
    if (!projectID) {
      throw new Error(t('sessions.scheduledTasks.dialog.error.chooseProjectFirst'));
    }
    await upsertScheduledTask(projectID, taskDraft);
    // Refresh what is on screen: normally the scope that was just saved; if
    // the user switched while the editor was open, the newer scope's list is
    // what the view belongs to and it must stay consistent.
    if (selectedProjectID) {
      await reloadTasks(selectedProjectID);
    }
    toast.success(t('sessions.scheduledTasks.dialog.toast.saved'));
  }, [selectedProjectID, reloadTasks, t]);

  const handleToggleEnabled = React.useCallback(async (task: ScheduledTask, enabled: boolean) => {
    // The row's own project decides where the mutation lands: a task shown
    // under a scope belongs to that scope, even if the user has already
    // switched and the selection now names another project.
    const projectID = listOwnerRef.current;
    if (!projectID) {
      return;
    }
    setMutatingTaskID(task.id);
    // The reload brings the reason back if the server keeps the loop paused.
    setTasks((prev) => prev.map((item) => (item.id === task.id ? { ...item, enabled, loopApproval: undefined } : item)));
    try {
      if (task.loopFile) {
        await setLoopScheduledTaskEnabled(projectID, task.id, enabled);
      } else {
        await upsertScheduledTask(projectID, { ...task, enabled });
      }
      await reloadTasks(projectID, { silent: true });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('sessions.scheduledTasks.dialog.toast.updateFailed'));
      await reloadTasks(projectID, { silent: true });
    } finally {
      setMutatingTaskID(null);
    }
  }, [reloadTasks, t]);

  const handleDeleteTask = React.useCallback(async (task: ScheduledTask) => {
    const projectID = listOwnerRef.current;
    if (!projectID) {
      return;
    }
    const confirmed = window.confirm(task.loopFile
      ? t('sessions.scheduledTasks.dialog.confirm.deleteLoopFile', { taskName: task.name })
      : t('sessions.scheduledTasks.dialog.confirm.deleteTask', { taskName: task.name }));
    if (!confirmed) {
      return;
    }

    setMutatingTaskID(task.id);
    try {
      if (task.loopFile) {
        await deleteScheduledTaskLoopFile(projectID, task.id);
      } else {
        await deleteScheduledTask(projectID, task.id);
      }
      await reloadTasks(projectID, { silent: true });
      toast.success(t('sessions.scheduledTasks.dialog.toast.deleted'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('sessions.scheduledTasks.dialog.toast.deleteFailed'));
    } finally {
      setMutatingTaskID(null);
    }
  }, [reloadTasks, t]);

  const handleEditTask = React.useCallback((task: ScheduledTask) => {
    if (!task.loopFile) {
      setEditorTask(task);
      // The editor saves into the task's own project, captured now, later
      // switches of the selected scope must not redirect the save.
      editorOwnerRef.current = listOwnerRef.current;
      setEditorOpen(true);
      return;
    }
    const ownerProject = projects.find((project) => project.id === listOwnerRef.current);
    if (!ownerProject?.path) {
      return;
    }
    useFilesViewTabsStore.getState().setSelectedPath(ownerProject.path, task.loopFile, { allowOutsideRoot: true });
    useUIStore.getState().openContextFile(ownerProject.path, task.loopFile);
    onLeave('file');
  }, [projects, onLeave]);

  // The session of the task's latest run; a run records it as soon as it
  // creates the session, so a running or failed run has one too. The session
  // owns its directory: one in a linked worktree must not open on the
  // project root, so the session's own record decides, not the selection.
  const openLastRunSession = React.useCallback((task: ScheduledTask) => {
    const sessionId = task.state?.lastSessionId;
    if (!sessionId) return;
    void openSessionFromRoute(sessionId);
    // A run can create its session after the global list last loaded; that
    // list cannot name the folder until it is fetched again.
    if (!useGlobalSessionsStore.getState().entityById.has(sessionId)) {
      void refreshGlobalSessions().then(() => openSessionFromRoute(sessionId));
    }
    onLeave('session');
  }, [onLeave]);

  const handleRunNow = React.useCallback(async (task: ScheduledTask) => {
    // Like every mutation here, the run belongs to the task's own project,
    // not to whatever the selection has become since the list was rendered.
    const projectID = listOwnerRef.current;
    if (!projectID) {
      return;
    }
    setMutatingTaskID(task.id);
    try {
      const { sessionId, directory, persistError } = await runScheduledTaskNow(projectID, task.id);
      await Promise.all([
        reloadTasks(projectID, { silent: true }),
        refreshGlobalSessions(),
      ]);
      if (persistError) {
        toast.warning(t('sessions.scheduledTasks.dialog.toast.startedPersistWarning'));
      } else {
        toast.success(t('sessions.scheduledTasks.dialog.toast.started'));
      }
      if (sessionId) {
        // Jump straight into the started session.
        const project = projects.find((entry) => entry.id === projectID);
        useSessionUIStore.getState().setCurrentSession(sessionId, directory ?? project?.path ?? null);
        onLeave('session');
      }
    } catch (error) {
      if (error instanceof ScheduledTaskBusyError) {
        const startedAt = task.state?.lastRunAt;
        const message = error.busy === 'queued'
          ? t('sessions.scheduledTasks.dialog.toast.alreadyQueued')
          : startedAt
            ? t('sessions.scheduledTasks.dialog.toast.alreadyRunningSince', { time: formatClockTime(startedAt, timeFormatPreference) })
            : t('sessions.scheduledTasks.dialog.toast.alreadyRunning');
        toast.info(message, error.busy === 'running' && task.state?.lastSessionId
          ? { action: { label: t('sessions.scheduledTasks.dialog.actions.openSession'), onClick: () => openLastRunSession(task) } }
          : undefined);
        return;
      }
      toast.error(error instanceof Error ? error.message : t('sessions.scheduledTasks.dialog.toast.runFailed'));
    } finally {
      setMutatingTaskID(null);
    }
  }, [projects, reloadTasks, onLeave, t, timeFormatPreference, openLastRunSession]);

  const chatsLabel = (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <Icon name="chat-4" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate">{t('sessions.scheduledTasks.dialog.project.chats')}</span>
    </span>
  );
  const hasScopes = chatsAvailable || projects.length > 0;

  const projectSelector = (
    <div className="flex flex-col items-start gap-1">
      <span className="typography-meta text-muted-foreground">{t('sessions.scheduledTasks.dialog.project.label')}</span>
      <Select
        value={selectedProjectID || '__none'}
        onValueChange={(value) => {
          const nextProjectID = value === '__none' ? '' : value;
          selectProjectScope(nextProjectID);
          if (nextProjectID) {
            void reloadTasks(nextProjectID);
          } else {
            commitTaskList('', []);
            setLoading(false);
          }
        }}
      >
        <SelectTrigger className="w-full">
          {selectedProjectID === CHAT_DRAFT_PROJECT_ID ? (
            <SelectValue>{chatsLabel}</SelectValue>
          ) : selectedProject ? (
            <SelectValue>{renderProjectLabel(selectedProject)}</SelectValue>
          ) : (
            <SelectValue placeholder={t('sessions.scheduledTasks.dialog.project.placeholder')} />
          )}
        </SelectTrigger>
        <SelectContent>
          {!hasScopes ? <SelectItem value="__none">{t('sessions.scheduledTasks.dialog.project.empty')}</SelectItem> : null}
          {chatsAvailable ? <SelectItem value={CHAT_DRAFT_PROJECT_ID}>{chatsLabel}</SelectItem> : null}
          {projects.map((project) => (
            <SelectItem key={project.id} value={project.id}>
              {renderProjectLabel(project)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );

  const openNewTaskEditor = () => {
    setEditorTask(null);
    editorOwnerRef.current = '';
    setEditorOpen(true);
  };

  const selectProject = (nextProjectID: string) => {
    selectProjectScope(nextProjectID);
    if (nextProjectID) {
      void reloadTasks(nextProjectID);
    } else {
      commitTaskList('', []);
      setLoading(false);
    }
  };

  const renderScopeButton = (scopeID: string, label: React.ReactNode) => (
    <button
      key={scopeID}
      type="button"
      onClick={() => selectProject(scopeID)}
      className={cn(
        'flex w-full min-w-0 items-center rounded-md px-2 py-1.5 text-start typography-ui-label focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        selectedProjectID === scopeID
          ? 'bg-interactive-selection text-foreground'
          : 'text-muted-foreground hover:bg-interactive-hover/50 hover:text-foreground',
      )}
    >
      {label}
    </button>
  );

  const tasksList = (
      <div className="min-h-[280px]">
      {loading ? (
        <div className="flex items-center gap-2 typography-meta text-muted-foreground">
          <Icon name="loader-4" className="h-4 w-4 animate-spin" /> {t('sessions.scheduledTasks.dialog.loading')}
        </div>
      ) : tasks.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-4 typography-meta text-muted-foreground">
          {selectedProjectID ? t('sessions.scheduledTasks.dialog.empty.noTasks') : t('sessions.scheduledTasks.dialog.empty.selectProject')}
        </div>
      ) : (
        <div className="space-y-2.5">
          {tasks.map((task) => {
            const isBusy = mutatingTaskID === task.id;
            const status = task.state?.lastStatus || 'idle';
            const meta: TaskStatusMeta = STATUS_META[status];
            const statusLabel = status === 'queued' ? t('sessions.scheduledTasks.dialog.status.queued')
              : status === 'sent' ? t('sessions.scheduledTasks.dialog.status.sent')
              : status === 'skipped' ? t('sessions.scheduledTasks.dialog.status.skipped')
              : status === 'failed' ? t('sessions.scheduledTasks.dialog.status.error')
              : status === 'cancelled' ? t('sessions.scheduledTasks.dialog.status.cancelled')
              : status === 'success'
              ? t('sessions.scheduledTasks.dialog.status.success')
              : status === 'error'
                ? t('sessions.scheduledTasks.dialog.status.error')
                : status === 'running'
                  ? t('sessions.scheduledTasks.dialog.status.running')
                  : t('sessions.scheduledTasks.dialog.status.idle');
            const nextAt = task.state?.nextRunAt;
            const lastAt = task.state?.lastRunAt;

            return (
              <div
                key={task.id}
                className={cn(
                  'rounded-lg border border-border p-4 transition-opacity',
                )}
              >
                <div className={cn('min-w-0', !task.enabled && 'opacity-60')}>
                  <div className="typography-ui-header truncate font-semibold text-foreground">
                    {task.name}
                  </div>
                  <div className="typography-micro truncate text-muted-foreground">
                    {formatSchedule(task, t)}
                  </div>
                  <div className="typography-micro flex min-w-0 items-center gap-1 text-muted-foreground" title={task.execution.useDefaults ? undefined : `${task.execution.providerID ?? ''}/${task.execution.modelID ?? ''}`}>
                    <TaskModelLine task={task} />
                  </div>
                  {task.targetSessionId ? <TaskTargetLine sessionId={task.targetSessionId} /> : null}
                  {task.loopFile ? (
                    <div
                      className="typography-micro truncate text-muted-foreground"
                      title={task.loopFile}
                    >
                      {t('sessions.scheduledTasks.dialog.loopFile.note', { file: task.loopFile })}
                    </div>
                  ) : null}
                </div>

                <div className={cn('mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 typography-micro text-muted-foreground', !task.enabled && 'opacity-60')}>
                  <span className="inline-flex items-center gap-1.5">
                    <Icon name="timer" className="h-3.5 w-3.5" />
                    <span className="font-medium text-foreground">{t('sessions.scheduledTasks.dialog.nextRun.label')}</span>
                    {nextAt ? (
                      <>
                        <span className="text-foreground">{formatRelativeTime(nextAt, t)}</span>
                        <span className="text-muted-foreground/50">·</span>
                        <span>{formatClockTime(nextAt, timeFormatPreference)}</span>
                      </>
                    ) : (
                      <span>—</span>
                    )}
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <Icon name="history" className="h-3.5 w-3.5" />
                    <span className="font-medium text-foreground">{t('sessions.scheduledTasks.dialog.lastRun.label')}</span>
                    {status === 'running' ? (
                      <span
                        className="inline-flex items-center gap-1"
                        style={{ color: 'var(--status-warning)' }}
                      >
                        <Icon name="loader-4" className="h-3.5 w-3.5 animate-spin" />
                        {t('sessions.scheduledTasks.dialog.lastRun.runningNow')}
                      </span>
                    ) : lastAt ? (
                      <>
                        {meta.tone !== 'muted' ? (
                          <span
                            className="inline-flex items-center gap-1"
                            style={{ color: `var(--status-${meta.tone})` }}
                          >
                            {meta.spin ? <Spinner className="h-3.5 w-3.5" /> : <Icon name={meta.Icon} className="h-3.5 w-3.5" />}
                            {statusLabel}
                          </span>
                        ) : null}
                        <span className="text-muted-foreground/50">·</span>
                        <span>{formatRelativeTime(lastAt, t)}</span>
                      </>
                    ) : (
                      <span>{t('sessions.scheduledTasks.dialog.lastRun.never')}</span>
                    )}
                  </span>
                </div>

                {task.state?.lastError ? (
                  <div
                    className={cn('mt-3 flex items-start gap-2 rounded-md border p-2 typography-micro', !task.enabled && 'opacity-60')}
                    style={toneStyle('error')}
                  >
                    <Icon name="error-warning" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span className="min-w-0 break-words">{task.state.lastError}</span>
                  </div>
                ) : null}

                <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
                  <div className="inline-flex items-center gap-1">
                    <label
                      className={cn(
                        'inline-flex cursor-pointer items-center gap-2 typography-micro font-medium',
                        task.enabled ? 'text-foreground' : 'text-muted-foreground',
                        isBusy && 'cursor-not-allowed opacity-50',
                      )}
                    >
                      <Checkbox
                        checked={task.enabled}
                        onChange={(enabled) => void handleToggleEnabled(task, enabled)}
                        ariaLabel={task.enabled
                          ? t('sessions.scheduledTasks.dialog.taskToggle.pauseAria', { taskName: task.name })
                          : t('sessions.scheduledTasks.dialog.taskToggle.enableAria', { taskName: task.name })}
                        disabled={isBusy}
                      />
                      {task.enabled ? t('sessions.scheduledTasks.dialog.taskToggle.enabled') : t('sessions.scheduledTasks.dialog.taskToggle.paused')}
                    </label>
                    {task.loopApproval ? <LoopApprovalMark reason={task.loopApproval} /> : null}
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5">
                    {task.state?.lastSessionId ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openLastRunSession(task)}
                        aria-label={t('sessions.scheduledTasks.dialog.actions.openSessionAria', { taskName: task.name })}
                      >
                        <Icon name="chat-1" className="h-4 w-4" /> {t('sessions.scheduledTasks.dialog.actions.openSession')}
                      </Button>
                    ) : null}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void handleRunNow(task)}
                      disabled={isBusy}
                    >
                      <Icon name="play" className="h-4 w-4" /> {t('sessions.scheduledTasks.dialog.actions.runNow')}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleEditTask(task)}
                      disabled={isBusy}
                      aria-label={t('sessions.scheduledTasks.dialog.actions.editAria', { taskName: task.name })}
                    >
                      <Icon name="edit-2" className="h-4 w-4" /> {t('sessions.scheduledTasks.dialog.actions.edit')}
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => void handleDeleteTask(task)}
                      disabled={isBusy}
                      aria-label={t('sessions.scheduledTasks.dialog.actions.deleteAria', { taskName: task.name })}
                    >
                      <Icon name="delete-bin" className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
      </div>
  );

  const newTaskButton = (className?: string) => (
    <Button className={className} size={layout === 'page' ? 'sm' : 'default'} onClick={openNewTaskEditor} disabled={!selectedProjectID}>
      <Icon name="add" className="me-1 h-4 w-4" /> {t('sessions.scheduledTasks.dialog.actions.newTask')}
    </Button>
  );

  return (
    <>
      {layout === 'mobile' ? (
        <div className="flex h-full min-h-0 flex-col">
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
            <p className="typography-meta text-muted-foreground">{t('sessions.scheduledTasks.dialog.description')}</p>
            {projectSelector}
            {tasksList}
          </div>
          <div
            className="shrink-0 border-t border-border/70 px-4 pt-2"
            style={{ paddingBottom: 'calc(0.5rem + var(--oc-safe-area-bottom, 0px))' }}
          >
            {newTaskButton('w-full')}
          </div>
        </div>
      ) : (
        // Full-page surface replacing the chat area (mounted inside <main>).
        // Master-detail: a scrollable scope list at the left, the selected
        // scope's tasks at the right. The app Header shows the surface title,
        // so the page itself only carries the close affordance.
        <div className="absolute inset-0 z-10 flex flex-col bg-background">
          <div className="flex min-h-0 flex-1">
            <div className="flex w-60 flex-shrink-0 flex-col border-e border-border/50">
              <div className="flex-1 space-y-0.5 overflow-y-auto p-2">
                {!hasScopes ? (
                  <div className="px-2 py-2 typography-meta text-muted-foreground">
                    {t('sessions.scheduledTasks.dialog.project.empty')}
                  </div>
                ) : null}
                {chatsAvailable ? renderScopeButton(CHAT_DRAFT_PROJECT_ID, chatsLabel) : null}
                {projects.map((project) => renderScopeButton(project.id, renderProjectLabel(project)))}
              </div>
            </div>
            <div className="flex min-w-0 flex-1 flex-col">
              {/* Pages have no close button: you leave by picking a session,
                  a draft, or another surface in the sidebar. */}
              <div className="flex items-center px-6 pt-3">
                {newTaskButton()}
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
                <div className="mx-auto w-full max-w-3xl">
                  {tasksList}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      <ScheduledTaskEditorDialog
        open={editorOpen}
        task={editorTask}
        // The editor works in the task's own scope: an existing task keeps
        // the project it was captured with even if the selection has moved.
        projectId={editorOwnerRef.current || selectedProjectID}
        onOpenChange={setEditorOpen}
        onSave={handleSaveTask}
      />
    </>
  );
}

/** The desktop page, open while the UI store says so. The mobile shell mounts
 *  ScheduledTasksView in its own fullscreen surface instead. */
export function ScheduledTasksDialog() {
  const open = useUIStore((state) => state.isScheduledTasksDialogOpen);
  const setOpen = useUIStore((state) => state.setScheduledTasksDialogOpen);
  const leave = React.useCallback(() => setOpen(false), [setOpen]);
  return open ? <ScheduledTasksView layout="page" onLeave={leave} /> : null;
}
