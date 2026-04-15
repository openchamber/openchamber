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
import { toast } from '@/components/ui';
import { RiLoader4Line, RiPlayLine, RiEdit2Line, RiDeleteBinLine, RiAddLine, RiFolderLine } from '@remixicon/react';
import { useUIStore } from '@/stores/useUIStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { refreshGlobalSessions } from '@/stores/useGlobalSessionsStore';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { PROJECT_COLOR_MAP, PROJECT_ICON_MAP, getProjectIconImageUrl } from '@/lib/projectMeta';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { formatDirectoryName } from '@/lib/utils';
import type { ProjectEntry } from '@/lib/api/types';
import {
  deleteScheduledTask,
  fetchScheduledTasks,
  runScheduledTaskNow,
  upsertScheduledTask,
  type ScheduledTask,
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

const formatTimestamp = (value?: number): string => {
  if (!value || !Number.isFinite(value)) {
    return '—';
  }
  return new Date(value).toLocaleString();
};

const statusLabel = (task: ScheduledTask): string => {
  const status = task.state?.lastStatus || 'idle';
  if (status === 'error') {
    return 'Error';
  }
  if (status === 'success') {
    return 'Success';
  }
  if (status === 'running') {
    return 'Running';
  }
  return 'Idle';
};

export function ScheduledTasksDialog() {
  const open = useUIStore((state) => state.isScheduledTasksDialogOpen);
  const setOpen = useUIStore((state) => state.setScheduledTasksDialogOpen);
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

  const reloadTasks = React.useCallback(async (projectID: string) => {
    if (!projectID) {
      setTasks([]);
      return;
    }
    setLoading(true);
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
      setTasks([]);
    } finally {
      setLoading(false);
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
        void reloadTasks(selectedProjectID);
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
    try {
      await upsertScheduledTask(selectedProjectID, {
        ...task,
        enabled,
      });
      await reloadTasks(selectedProjectID);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to update task');
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
      await reloadTasks(selectedProjectID);
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
        reloadTasks(selectedProjectID),
        refreshGlobalSessions(),
      ]);
      toast.success('Task started');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to run task');
    } finally {
      setMutatingTaskID(null);
    }
  }, [selectedProjectID, reloadTasks]);

  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] max-w-4xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Scheduled tasks</DialogTitle>
            <DialogDescription>Server-side tasks that create a new session and send a configured prompt.</DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-[220px] flex-col gap-1">
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
                  <SelectTrigger className="w-full">
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

              <Button
                onClick={() => {
                  setEditorTask(null);
                  setEditorOpen(true);
                }}
                disabled={!selectedProjectID}
              >
                <RiAddLine className="mr-1 h-4 w-4" /> New task
              </Button>
            </div>

            {loading ? (
              <div className="flex items-center gap-2 typography-meta text-muted-foreground">
                <RiLoader4Line className="h-4 w-4 animate-spin" /> Loading tasks...
              </div>
            ) : tasks.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border p-4 typography-meta text-muted-foreground">
                {selectedProjectID ? 'No scheduled tasks yet.' : 'Select a project to manage scheduled tasks.'}
              </div>
            ) : (
              <div className="space-y-2">
                {tasks.map((task) => {
                  const isBusy = mutatingTaskID === task.id;
                  return (
                    <div key={task.id} className="rounded-lg border border-border p-3">
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0">
                          <div className="typography-ui-label font-medium text-foreground">{task.name}</div>
                          <div className="typography-micro text-muted-foreground">{formatSchedule(task)}</div>
                          <div className="mt-1 typography-micro text-muted-foreground">
                            Next: {formatTimestamp(task.state?.nextRunAt)} • Last: {statusLabel(task)}
                          </div>
                        </div>

                        <div className="flex flex-wrap items-center gap-1.5">
                          <label className="mr-1 inline-flex items-center gap-1 typography-micro text-muted-foreground">
                            <Checkbox
                              checked={task.enabled}
                              onChange={(enabled) => void handleToggleEnabled(task, enabled)}
                              ariaLabel={`Enable ${task.name}`}
                              disabled={isBusy}
                            />
                            Enabled
                          </label>

                          <Button variant="outline" size="sm" onClick={() => void handleRunNow(task)} disabled={isBusy}>
                            <RiPlayLine className="mr-1 h-4 w-4" /> Run now
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              setEditorTask(task);
                              setEditorOpen(true);
                            }}
                            disabled={isBusy}
                          >
                            <RiEdit2Line className="mr-1 h-4 w-4" /> Edit
                          </Button>
                          <Button variant="destructive" size="sm" onClick={() => void handleDeleteTask(task)} disabled={isBusy}>
                            <RiDeleteBinLine className="mr-1 h-4 w-4" /> Delete
                          </Button>
                        </div>
                      </div>

                      {task.state?.lastError ? (
                        <div className="mt-2 rounded-md border border-[var(--status-error-border)] bg-[var(--status-error-background)] p-2 typography-micro text-[var(--status-error-foreground)]">
                          {task.state.lastError}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <ScheduledTaskEditorDialog
        open={editorOpen}
        task={editorTask}
        onOpenChange={setEditorOpen}
        onSave={handleSaveTask}
      />
    </>
  );
}
