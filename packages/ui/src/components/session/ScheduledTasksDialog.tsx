import * as React from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { toast } from '@/components/ui';
import {
  RiLoader4Line,
  RiPlayLine,
  RiEdit2Line,
  RiDeleteBinLine,
  RiAddLine,
  RiFolderLine,
  RiTimerLine,
  RiHistoryLine,
  RiCheckboxCircleLine,
  RiErrorWarningLine,
  RiPulseLine,
} from '@remixicon/react';
import { useUIStore } from '@/stores/useUIStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { refreshGlobalSessions } from '@/stores/useGlobalSessionsStore';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { PROJECT_COLOR_MAP, PROJECT_ICON_MAP, getProjectIconImageUrl } from '@/lib/projectMeta';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { cn, formatDirectoryName } from '@/lib/utils';
import type { ProjectEntry } from '@/lib/api/types';
import {
  deleteScheduledTask,
  fetchScheduledTasks,
  runScheduledTaskNow,
  upsertScheduledTask,
  type ScheduledTask,
  type ScheduledTaskStatus,
} from '@/lib/scheduledTasksApi';
import { ScheduledTaskEditorDialog } from './ScheduledTaskEditorDialog';

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const scheduleTimes = (task: ScheduledTask): string[] => {
  const raw = Array.isArray(task.schedule.times)
    ? task.schedule.times
    : (task.schedule.time ? [task.schedule.time] : []);
  const valid = raw.filter((value) => typeof value === 'string' && /^([01]\d|2[0-3]):([0-5]\d)$/.test(value));
  return Array.from(new Set(valid)).sort((a, b) => a.localeCompare(b));
};

const formatSchedule = (task: ScheduledTask): string => {
  const timesLabel = scheduleTimes(task).join(', ') || '--:--';
  if (task.schedule.kind === 'daily') {
    return `Daily ${timesLabel}${task.schedule.timezone ? ` (${task.schedule.timezone})` : ''}`;
  }
  if (task.schedule.kind === 'weekly') {
    const days = Array.isArray(task.schedule.weekdays)
      ? task.schedule.weekdays.map((value) => WEEKDAY_NAMES[value] || '?').join(', ')
      : '';
    return `Weekly ${days} ${timesLabel}${task.schedule.timezone ? ` (${task.schedule.timezone})` : ''}`;
  }
  if (task.schedule.kind === 'once') {
    const date = typeof task.schedule.date === 'string' && task.schedule.date.trim().length > 0
      ? task.schedule.date
      : 'Unknown date';
    const time = typeof task.schedule.time === 'string' && task.schedule.time.trim().length > 0
      ? task.schedule.time
      : '--:--';
    return `One-time ${date} ${time}${task.schedule.timezone ? ` (${task.schedule.timezone})` : ''}`;
  }
  return `Cron: ${task.schedule.cron || ''}${task.schedule.timezone ? ` (${task.schedule.timezone})` : ''}`;
};

const formatClockTime = (value?: number): string => {
  if (!value || !Number.isFinite(value)) {
    return '';
  }
  return new Date(value).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
};

const formatRelativeTime = (value?: number): string => {
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
    return future ? 'in <1m' : 'just now';
  }
  if (abs < hour) {
    const m = Math.round(abs / minute);
    return future ? `in ${m}m` : `${m}m ago`;
  }
  if (abs < day) {
    const h = Math.floor(abs / hour);
    const m = Math.round((abs % hour) / minute);
    const body = m > 0 ? `${h}h ${m}m` : `${h}h`;
    return future ? `in ${body}` : `${body} ago`;
  }
  const d = Math.floor(abs / day);
  const h = Math.round((abs % day) / hour);
  const body = h > 0 ? `${d}d ${h}h` : `${d}d`;
  return future ? `in ${body}` : `${body} ago`;
};

type StatusTone = 'success' | 'error' | 'warning' | 'muted';

const STATUS_META: Record<
  ScheduledTaskStatus,
  {
    tone: StatusTone;
    label: string;
    Icon: React.ComponentType<{ className?: string }>;
    spin?: boolean;
  }
> = {
  success: { tone: 'success', label: 'Success', Icon: RiCheckboxCircleLine },
  error: { tone: 'error', label: 'Error', Icon: RiErrorWarningLine },
  running: { tone: 'warning', label: 'Running', Icon: RiLoader4Line, spin: true },
  idle: { tone: 'muted', label: 'Idle', Icon: RiPulseLine },
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

export function ScheduledTasksDialog() {
  const open = useUIStore((state) => state.isScheduledTasksDialogOpen);
  const setOpen = useUIStore((state) => state.setScheduledTasksDialogOpen);
  const isMobile = useUIStore((state) => state.isMobile);
  const projects = useProjectsStore((state) => state.projects);
  const activeProject = useProjectsStore((state) => state.getActiveProject());
  const homeDirectory = useDirectoryStore((state) => state.homeDirectory);
  const { currentTheme } = useThemeSystem();

  const [selectedProjectID, setSelectedProjectID] = React.useState<string>('');
  const [tasks, setTasks] = React.useState<ScheduledTask[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [editorOpen, setEditorOpen] = React.useState(false);
  const [editorTask, setEditorTask] = React.useState<ScheduledTask | null>(null);
  const [mutatingTaskID, setMutatingTaskID] = React.useState<string | null>(null);

  const selectedProject = React.useMemo(
    () => projects.find((project) => project.id === selectedProjectID) || null,
    [projects, selectedProjectID],
  );

  const renderProjectLabel = React.useCallback((project: ProjectEntry) => {
    const displayLabel = project.label?.trim() || formatDirectoryName(project.path, homeDirectory || undefined);
    const imageUrl = getProjectIconImageUrl(
      { id: project.id, iconImage: project.iconImage ?? null },
      {
        themeVariant: currentTheme.metadata.variant,
        iconColor: currentTheme.colors.surface.foreground,
      },
    );
    const ProjectIcon = project.icon ? PROJECT_ICON_MAP[project.icon] : null;
    const iconColor = project.color ? PROJECT_COLOR_MAP[project.color] : undefined;

    return (
      <span className="inline-flex min-w-0 items-center gap-1.5">
        {imageUrl ? (
          <span
            className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center overflow-hidden rounded-[3px]"
            style={project.iconBackground ? { backgroundColor: project.iconBackground } : undefined}
          >
            <img src={imageUrl} alt="" className="h-full w-full object-contain" draggable={false} />
          </span>
        ) : ProjectIcon ? (
          <ProjectIcon className="h-3.5 w-3.5 shrink-0" style={iconColor ? { color: iconColor } : undefined} />
        ) : (
          <RiFolderLine className="h-3.5 w-3.5 shrink-0 text-muted-foreground/80" style={iconColor ? { color: iconColor } : undefined} />
        )}
        <span className="truncate">{displayLabel}</span>
      </span>
    );
  }, [homeDirectory, currentTheme.metadata.variant, currentTheme.colors.surface.foreground]);

  const reloadTasks = React.useCallback(async (projectID: string, options?: { silent?: boolean }) => {
    if (!projectID) {
      setTasks([]);
      return;
    }
    if (!options?.silent) {
      setLoading(true);
    }
    try {
      const nextTasks = await fetchScheduledTasks(projectID);
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
      setTasks(nextTasks);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to load scheduled tasks');
      if (!options?.silent) {
        setTasks([]);
      }
    } finally {
      if (!options?.silent) {
        setLoading(false);
      }
    }
  }, []);

  React.useEffect(() => {
    if (!open) {
      return;
    }
    const preferredProjectID = activeProject?.id || projects[0]?.id || '';
    setSelectedProjectID(preferredProjectID);
    if (preferredProjectID) {
      void reloadTasks(preferredProjectID);
    } else {
      setTasks([]);
    }
  }, [open, activeProject, projects, reloadTasks]);

  React.useEffect(() => {
    if (!open) {
      return;
    }
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
  }, [open, selectedProjectID, reloadTasks]);

  const handleSaveTask = React.useCallback(async (taskDraft: Partial<ScheduledTask>) => {
    if (!selectedProjectID) {
      throw new Error('Choose a project first');
    }
    await upsertScheduledTask(selectedProjectID, taskDraft);
    await reloadTasks(selectedProjectID);
    toast.success('Scheduled task saved');
  }, [selectedProjectID, reloadTasks]);

  const handleToggleEnabled = React.useCallback(async (task: ScheduledTask, enabled: boolean) => {
    if (!selectedProjectID) {
      return;
    }
    setMutatingTaskID(task.id);
    setTasks((prev) => prev.map((item) => (item.id === task.id ? { ...item, enabled } : item)));
    try {
      await upsertScheduledTask(selectedProjectID, {
        ...task,
        enabled,
      });
      await reloadTasks(selectedProjectID, { silent: true });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to update task');
      await reloadTasks(selectedProjectID, { silent: true });
    } finally {
      setMutatingTaskID(null);
    }
  }, [selectedProjectID, reloadTasks]);

  const handleDeleteTask = React.useCallback(async (task: ScheduledTask) => {
    if (!selectedProjectID) {
      return;
    }
    const confirmed = window.confirm(`Delete scheduled task "${task.name}"?`);
    if (!confirmed) {
      return;
    }

    setMutatingTaskID(task.id);
    try {
      await deleteScheduledTask(selectedProjectID, task.id);
      await reloadTasks(selectedProjectID, { silent: true });
      toast.success('Scheduled task deleted');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to delete task');
    } finally {
      setMutatingTaskID(null);
    }
  }, [selectedProjectID, reloadTasks]);

  const handleRunNow = React.useCallback(async (task: ScheduledTask) => {
    if (!selectedProjectID) {
      return;
    }
    setMutatingTaskID(task.id);
    try {
      await runScheduledTaskNow(selectedProjectID, task.id);
      await Promise.all([
        reloadTasks(selectedProjectID, { silent: true }),
        refreshGlobalSessions(),
      ]);
      toast.success('Task started');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to run task');
    } finally {
      setMutatingTaskID(null);
    }
  }, [selectedProjectID, reloadTasks]);

  const projectSelector = (
    <div className="flex flex-col items-start gap-1">
      <span className="typography-meta text-muted-foreground">Project</span>
      <Select
        value={selectedProjectID || '__none'}
        onValueChange={(value) => {
          const nextProjectID = value === '__none' ? '' : value;
          setSelectedProjectID(nextProjectID);
          if (nextProjectID) {
            void reloadTasks(nextProjectID);
          } else {
            setTasks([]);
          }
        }}
      >
        <SelectTrigger className={isMobile ? 'w-full' : undefined}>
          {selectedProject ? (
            <SelectValue>{renderProjectLabel(selectedProject)}</SelectValue>
          ) : (
            <SelectValue placeholder="Select project" />
          )}
        </SelectTrigger>
        <SelectContent>
          {projects.length === 0 ? <SelectItem value="__none">No projects</SelectItem> : null}
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
    setEditorOpen(true);
  };

  const tasksContent = (
    <div className="space-y-4">
      {!isMobile ? (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          {projectSelector}
          <Button onClick={openNewTaskEditor} disabled={!selectedProjectID}>
            <RiAddLine className="mr-1 h-4 w-4" /> New task
          </Button>
        </div>
      ) : (
        projectSelector
      )}

      {loading ? (
        <div className="flex items-center gap-2 typography-meta text-muted-foreground">
          <RiLoader4Line className="h-4 w-4 animate-spin" /> Loading tasks...
        </div>
      ) : tasks.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-4 typography-meta text-muted-foreground">
          {selectedProjectID ? 'No scheduled tasks yet.' : 'Select a project to manage scheduled tasks.'}
        </div>
      ) : (
        <div className="space-y-2.5">
          {tasks.map((task) => {
            const isBusy = mutatingTaskID === task.id;
            const status = (task.state?.lastStatus || 'idle') as ScheduledTaskStatus;
            const meta = STATUS_META[status];
            const nextAt = task.state?.nextRunAt;
            const lastAt = task.state?.lastRunAt;

            return (
              <div
                key={task.id}
                className={cn(
                  'rounded-lg border border-border p-4 transition-opacity',
                  !task.enabled && 'opacity-60',
                )}
              >
                <div className="min-w-0">
                  <div className="typography-ui-header truncate font-semibold text-foreground">
                    {task.name}
                  </div>
                  <div className="typography-micro truncate text-muted-foreground">
                    {formatSchedule(task)}
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 typography-micro text-muted-foreground">
                  <span className="inline-flex items-center gap-1.5">
                    <RiTimerLine className="h-3.5 w-3.5" />
                    <span className="font-medium text-foreground">Next</span>
                    {nextAt ? (
                      <>
                        <span className="text-foreground">{formatRelativeTime(nextAt)}</span>
                        <span className="text-muted-foreground/50">·</span>
                        <span>{formatClockTime(nextAt)}</span>
                      </>
                    ) : (
                      <span>—</span>
                    )}
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <RiHistoryLine className="h-3.5 w-3.5" />
                    <span className="font-medium text-foreground">Last run</span>
                    {status === 'running' ? (
                      <span
                        className="inline-flex items-center gap-1"
                        style={{ color: 'var(--status-warning)' }}
                      >
                        <RiLoader4Line className="h-3.5 w-3.5 animate-spin" />
                        running now
                      </span>
                    ) : lastAt ? (
                      <>
                        {meta.tone !== 'muted' ? (
                          <span
                            className="inline-flex items-center gap-1"
                            style={{ color: `var(--status-${meta.tone})` }}
                          >
                            <meta.Icon className="h-3.5 w-3.5" />
                            {meta.label}
                          </span>
                        ) : null}
                        <span className="text-muted-foreground/50">·</span>
                        <span>{formatRelativeTime(lastAt)}</span>
                      </>
                    ) : (
                      <span>never</span>
                    )}
                  </span>
                </div>

                {task.state?.lastError ? (
                  <div
                    className="mt-3 flex items-start gap-2 rounded-md border p-2 typography-micro"
                    style={toneStyle('error')}
                  >
                    <RiErrorWarningLine className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span className="min-w-0 break-words">{task.state.lastError}</span>
                  </div>
                ) : null}

                <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
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
                      ariaLabel={task.enabled ? `Pause ${task.name}` : `Enable ${task.name}`}
                      disabled={isBusy}
                    />
                    {task.enabled ? 'Enabled' : 'Paused'}
                  </label>

                  <div className="flex flex-wrap items-center gap-1.5">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void handleRunNow(task)}
                      disabled={isBusy}
                    >
                      <RiPlayLine className="h-4 w-4" /> run now
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setEditorTask(task);
                        setEditorOpen(true);
                      }}
                      disabled={isBusy}
                      aria-label={`Edit ${task.name}`}
                    >
                      <RiEdit2Line className="h-4 w-4" /> edit
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => void handleDeleteTask(task)}
                      disabled={isBusy}
                      aria-label={`Delete ${task.name}`}
                    >
                      <RiDeleteBinLine className="h-4 w-4" />
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

  return (
    <>
      {isMobile ? (
        <MobileOverlayPanel
          open={open}
          title="Scheduled tasks"
          onClose={() => setOpen(false)}
          contentMaxHeightClassName="max-h-[min(80vh,640px)]"
          renderHeader={(closeButton) => (
            <div className="flex flex-col gap-1 border-b border-border/40 px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <h2 className="typography-ui-label font-semibold text-foreground">Scheduled tasks</h2>
                {closeButton}
              </div>
              <p className="typography-micro text-muted-foreground">
                Server-side tasks that create a new session and send a configured prompt.
              </p>
            </div>
          )}
          footer={(
            <Button
              className="w-full"
              onClick={openNewTaskEditor}
              disabled={!selectedProjectID}
            >
              <RiAddLine className="mr-1 h-4 w-4" /> New task
            </Button>
          )}
        >
          {tasksContent}
        </MobileOverlayPanel>
      ) : (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Scheduled tasks</DialogTitle>
              <DialogDescription>Server-side tasks that create a new session and send a configured prompt.</DialogDescription>
            </DialogHeader>

            {tasksContent}
          </DialogContent>
        </Dialog>
      )}

      <ScheduledTaskEditorDialog
        open={editorOpen}
        task={editorTask}
        onOpenChange={setEditorOpen}
        onSave={handleSaveTask}
      />
    </>
  );
}
