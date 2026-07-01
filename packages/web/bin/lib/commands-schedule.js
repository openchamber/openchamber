import {
  intro as clackIntro,
  outro as clackOutro,
  cancel as clackCancel,
  confirm as clackConfirm,
  isCancel,
  isJsonMode,
  isQuietMode,
  canPrompt,
  createSpinner,
  printJson,
  logStatus,
} from '../cli-output.js';
import { EXIT_CODE, TunnelCliError } from './cli-errors.js';
import {
  apiRequest,
  resolveTargetPort,
  resolveProjectId,
  resolveModel,
} from './cli-api-client.js';
import { truncate, formatSchedule, formatInstant, formatRelativeTime } from './cli-format.js';

const SCHEDULE_ACTIONS = ['list', 'show', 'create', 'run', 'enable', 'disable', 'delete', 'status'];

const WEEKDAY_LOOKUP = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
};

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

function usage(message) {
  return new TunnelCliError(message, EXIT_CODE.USAGE_ERROR);
}

function requireTaskRef(args, options) {
  const ref = (typeof args[0] === 'string' && args[0].trim()) || (typeof options.name === 'string' && options.name.trim());
  if (ref) return ref;
  throw usage('A task id or name is required. Usage: openchamber schedule <action> <task-id|name>');
}

function findTask(tasks, ref) {
  if (!Array.isArray(tasks)) return null;
  return tasks.find((task) => task.id === ref)
    || tasks.find((task) => typeof task.name === 'string' && task.name.toLowerCase() === ref.toLowerCase())
    || null;
}

function parseTimes(value) {
  const raw = typeof value === 'string' ? value : '';
  const parts = raw.split(',').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) {
    throw usage('At least one time is required. Provide --at "HH:mm" (comma-separated for multiple).');
  }
  for (const part of parts) {
    if (!TIME_PATTERN.test(part)) {
      throw usage(`Invalid time "${part}". Use 24h HH:mm (e.g. 09:00, 17:30).`);
    }
  }
  return Array.from(new Set(parts)).sort((a, b) => a.localeCompare(b));
}

function parseWeekdays(value) {
  const raw = typeof value === 'string' ? value : '';
  const parts = raw.split(',').map((part) => part.trim().toLowerCase()).filter(Boolean);
  if (parts.length === 0) {
    throw usage('At least one weekday is required for a weekly schedule. Provide --on "mon,wed,fri" or 0..6.');
  }
  const days = new Set();
  for (const part of parts) {
    if (/^[0-6]$/.test(part)) {
      days.add(Number(part));
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(WEEKDAY_LOOKUP, part)) {
      days.add(WEEKDAY_LOOKUP[part]);
      continue;
    }
    throw usage(`Invalid weekday "${part}". Use mon..sun or 0..6 (0 = Sunday).`);
  }
  return Array.from(days).sort((a, b) => a - b);
}

function inferKind(options) {
  const explicit = typeof options.kind === 'string' ? options.kind.trim().toLowerCase() : '';
  if (explicit) return explicit;
  if (options.cron) return 'cron';
  if (options.date || options.time) return 'once';
  if (options.on) return 'weekly';
  if (options.at) return 'daily';
  return '';
}

function buildScheduleFromOptions(options) {
  const kind = inferKind(options);
  if (!kind) {
    throw usage('Specify a schedule: --kind daily|weekly|once|cron (or use --at / --on / --cron / --date+--time).');
  }
  const timezone = typeof options.timezone === 'string' && options.timezone.trim() ? options.timezone.trim() : undefined;
  const tz = timezone ? { timezone } : {};

  if (kind === 'daily') {
    return { kind, times: parseTimes(options.at), ...tz };
  }
  if (kind === 'weekly') {
    return { kind, times: parseTimes(options.at), weekdays: parseWeekdays(options.on), ...tz };
  }
  if (kind === 'once') {
    const date = typeof options.date === 'string' ? options.date.trim() : '';
    const time = typeof options.time === 'string' ? options.time.trim() : '';
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw usage('A one-time schedule needs --date YYYY-MM-DD.');
    }
    if (!TIME_PATTERN.test(time)) {
      throw usage('A one-time schedule needs --time HH:mm.');
    }
    return { kind, date, time, ...tz };
  }
  if (kind === 'cron') {
    const cron = typeof options.cron === 'string' ? options.cron.trim() : '';
    if (!cron) {
      throw usage('A cron schedule needs --cron "<expression>".');
    }
    return { kind, cron, ...tz };
  }
  throw usage(`Invalid --kind "${kind}". Use daily, weekly, once, or cron.`);
}

async function confirmDestructive(options, message) {
  if (options.force) return;
  if (canPrompt(options)) {
    const confirmed = await clackConfirm({ message });
    if (isCancel(confirmed) || confirmed !== true) {
      clackCancel('Operation cancelled.');
      throw new TunnelCliError('Cancelled.', 130);
    }
    return;
  }
  throw usage('Refusing to delete without confirmation. Re-run with --force (or --yes) to proceed.');
}

function serializeTask(task) {
  return {
    id: task.id,
    name: task.name,
    enabled: Boolean(task.enabled),
    schedule: task.schedule,
    execution: task.execution,
    state: task.state,
  };
}

function taskStatusLevel(task) {
  if (!task.enabled) return 'warning';
  const status = task?.state?.lastStatus;
  if (status === 'error') return 'error';
  if (status === 'success') return 'success';
  return 'info';
}

function taskDetailLine(task) {
  const parts = [task.enabled ? 'enabled' : 'disabled', formatSchedule(task.schedule)];
  const next = formatInstant(task?.state?.nextRunAt, task?.schedule?.timezone);
  if (task.enabled && next) parts.push(`next ${next}`);
  const status = task?.state?.lastStatus;
  if (status && status !== 'idle') {
    const when = formatRelativeTime(task?.state?.lastRunAt);
    parts.push(`last ${status}${when !== 'unknown' ? ` ${when}` : ''}`);
  }
  return parts.join(' · ');
}

async function handleStatus(port, options) {
  const status = await apiRequest(port, 'GET', '/api/openchamber/scheduled-tasks/status', { options });
  if (isJsonMode(options)) {
    printJson({ scheduledTasks: status });
    return;
  }
  if (isQuietMode(options)) {
    process.stdout.write(`enabled ${status?.enabledScheduledTasksCount ?? 0} running ${status?.runningScheduledTasksCount ?? 0}\n`);
    return;
  }
  clackIntro('Scheduled Tasks Status');
  logStatus('info', 'summary', [
    `enabled: ${status?.enabledScheduledTasksCount ?? 0}`,
    `running: ${status?.runningScheduledTasksCount ?? 0}`,
  ].join('\n'));
  clackOutro('done');
}

async function loadTasks(port, projectId, options) {
  const payload = await apiRequest(port, 'GET', `/api/projects/${encodeURIComponent(projectId)}/scheduled-tasks`, { options });
  return Array.isArray(payload?.tasks) ? payload.tasks : [];
}

async function handleList(port, projectId, options) {
  const tasks = await loadTasks(port, projectId, options);
  tasks.sort((a, b) => Number(b.enabled) - Number(a.enabled) || String(a.name).localeCompare(String(b.name)));

  if (isJsonMode(options)) {
    printJson({ projectId, count: tasks.length, tasks: tasks.map(serializeTask) });
    return;
  }
  if (isQuietMode(options)) {
    for (const task of tasks) {
      process.stdout.write(`${task.id} ${task.enabled ? 'enabled' : 'disabled'} ${task?.state?.lastStatus || 'idle'} ${task.name}\n`);
    }
    return;
  }
  clackIntro('Scheduled Tasks');
  if (tasks.length === 0) {
    logStatus('warning', 'No scheduled tasks', `project: ${projectId}`);
    clackOutro('0 tasks');
    return;
  }
  for (const task of tasks) {
    logStatus(taskStatusLevel(task), `${truncate(task.name, 56)}  ${task.id}`, taskDetailLine(task));
  }
  clackOutro(`${tasks.length} task(s) · ${projectId}`);
}

async function handleShow(port, projectId, options, args) {
  const ref = requireTaskRef(args, options);
  const tasks = await loadTasks(port, projectId, options);
  const task = findTask(tasks, ref);
  if (!task) {
    throw new TunnelCliError(`Scheduled task "${ref}" not found.`, EXIT_CODE.GENERAL_ERROR);
  }

  if (isJsonMode(options)) {
    printJson({ task: serializeTask(task) });
    return;
  }
  if (isQuietMode(options)) {
    process.stdout.write(`${task.id} ${task.enabled ? 'enabled' : 'disabled'} ${task?.state?.lastStatus || 'idle'} ${task.name}\n`);
    return;
  }
  clackIntro('Scheduled Task');
  const lines = [
    `id: ${task.id}`,
    `enabled: ${task.enabled ? 'yes' : 'no'}`,
    `schedule: ${formatSchedule(task.schedule)}`,
    `model: ${task.execution?.providerID}/${task.execution?.modelID}`,
  ];
  if (task.execution?.agent) lines.push(`agent: ${task.execution.agent}`);
  if (task.execution?.variant) lines.push(`variant: ${task.execution.variant}`);
  const next = formatInstant(task?.state?.nextRunAt, task?.schedule?.timezone);
  if (next) lines.push(`next run: ${next}`);
  if (task?.state?.lastStatus && task.state.lastStatus !== 'idle') {
    lines.push(`last run: ${task.state.lastStatus} (${formatRelativeTime(task.state.lastRunAt)})`);
  }
  if (task?.state?.lastError) lines.push(`last error: ${task.state.lastError}`);
  if (task?.state?.lastSessionId) lines.push(`last session: ${task.state.lastSessionId}`);
  if (task.execution?.prompt) lines.push(`prompt:\n${task.execution.prompt}`);
  logStatus('info', task.name, lines.join('\n'));
  clackOutro('done');
}

async function handleCreate(port, projectId, options, args) {
  const name = (typeof args[0] === 'string' && args[0].trim()) || (typeof options.name === 'string' && options.name.trim());
  if (!name) {
    throw usage('A task name is required. Usage: openchamber schedule create <name> --prompt <text> --kind <daily|weekly|once|cron> ...');
  }
  const prompt = typeof options.prompt === 'string' ? options.prompt.trim() : '';
  if (!prompt) {
    throw usage('A prompt is required. Provide --prompt <text> (use "/command args" to run a slash command).');
  }

  const schedule = buildScheduleFromOptions(options);
  const model = await resolveModel(port, options);

  const execution = {
    prompt,
    providerID: model.providerID,
    modelID: model.modelID,
  };
  if (typeof options.agent === 'string' && options.agent.trim()) execution.agent = options.agent.trim();
  if (typeof options.variant === 'string' && options.variant.trim()) execution.variant = options.variant.trim();

  const task = {
    name,
    enabled: !options.disabled,
    schedule,
    execution,
  };

  const spin = createSpinner(options);
  spin?.start('Saving scheduled task…');
  const payload = await apiRequest(port, 'PUT', `/api/projects/${encodeURIComponent(projectId)}/scheduled-tasks`, {
    body: { task },
    options,
  });
  spin?.stop('Scheduled task saved');

  const saved = payload?.task || task;
  if (isJsonMode(options)) {
    printJson({ created: payload?.created !== false, task: serializeTask(saved) });
    return;
  }
  if (isQuietMode(options)) {
    process.stdout.write(`${saved.id}\n`);
    return;
  }
  clackIntro('Create Scheduled Task');
  logStatus('success', `Saved ${saved.name}`, [
    `id: ${saved.id}`,
    `schedule: ${formatSchedule(saved.schedule)}`,
    saved.enabled ? null : 'created disabled',
  ].filter(Boolean).join('\n'));
  clackOutro(saved.id);
}

async function handleToggle(port, projectId, options, args, enabled) {
  const ref = requireTaskRef(args, options);
  const tasks = await loadTasks(port, projectId, options);
  const task = findTask(tasks, ref);
  if (!task) {
    throw new TunnelCliError(`Scheduled task "${ref}" not found.`, EXIT_CODE.GENERAL_ERROR);
  }
  if (Boolean(task.enabled) === enabled) {
    if (!isJsonMode(options) && !isQuietMode(options)) {
      clackIntro(enabled ? 'Enable Scheduled Task' : 'Disable Scheduled Task');
      logStatus('info', `${task.name} is already ${enabled ? 'enabled' : 'disabled'}`);
      clackOutro('no change');
      return;
    }
  }

  const payload = await apiRequest(port, 'PUT', `/api/projects/${encodeURIComponent(projectId)}/scheduled-tasks`, {
    body: { task: { ...task, enabled } },
    options,
  });
  const saved = payload?.task || { ...task, enabled };

  if (isJsonMode(options)) {
    printJson({ updated: true, task: serializeTask(saved) });
    return;
  }
  if (isQuietMode(options)) {
    process.stdout.write(`${saved.id} ${enabled ? 'enabled' : 'disabled'}\n`);
    return;
  }
  clackIntro(enabled ? 'Enable Scheduled Task' : 'Disable Scheduled Task');
  const next = formatInstant(saved?.state?.nextRunAt, saved?.schedule?.timezone);
  logStatus('success', `${enabled ? 'Enabled' : 'Disabled'} ${saved.name}`, enabled && next ? `next run: ${next}` : undefined);
  clackOutro('done');
}

async function handleRun(port, projectId, options, args) {
  const ref = requireTaskRef(args, options);
  const tasks = await loadTasks(port, projectId, options);
  const task = findTask(tasks, ref);
  if (!task) {
    throw new TunnelCliError(`Scheduled task "${ref}" not found.`, EXIT_CODE.GENERAL_ERROR);
  }

  const spin = createSpinner(options);
  spin?.start('Running scheduled task…');
  let payload;
  try {
    payload = await apiRequest(port, 'POST', `/api/projects/${encodeURIComponent(projectId)}/scheduled-tasks/${encodeURIComponent(task.id)}/run`, {
      options,
      timeoutMs: 600000,
    });
  } finally {
    spin?.stop('Done');
  }

  const sessionId = payload?.sessionId || null;
  if (isJsonMode(options)) {
    printJson({ ran: true, id: task.id, sessionId });
    return;
  }
  if (isQuietMode(options)) {
    process.stdout.write(`${task.id} ran${sessionId ? ` ${sessionId}` : ''}\n`);
    return;
  }
  clackIntro('Run Scheduled Task');
  logStatus('success', `Ran ${task.name}`, sessionId ? `session: ${sessionId}` : undefined);
  clackOutro('done');
}

async function handleDelete(port, projectId, options, args) {
  const ref = requireTaskRef(args, options);
  const tasks = await loadTasks(port, projectId, options);
  const task = findTask(tasks, ref);
  if (!task) {
    throw new TunnelCliError(`Scheduled task "${ref}" not found.`, EXIT_CODE.GENERAL_ERROR);
  }

  await confirmDestructive(options, `Delete scheduled task "${task.name}" (${task.id})?`);
  await apiRequest(port, 'DELETE', `/api/projects/${encodeURIComponent(projectId)}/scheduled-tasks/${encodeURIComponent(task.id)}`, { options });

  if (isJsonMode(options)) {
    printJson({ deleted: true, id: task.id });
    return;
  }
  if (isQuietMode(options)) {
    process.stdout.write(`${task.id} deleted\n`);
    return;
  }
  clackIntro('Delete Scheduled Task');
  logStatus('success', `Deleted ${task.name}`);
  clackOutro('done');
}

async function scheduleCommand(options = {}, action = 'list', args = []) {
  const normalizedAction = typeof action === 'string' && action.trim().length > 0 ? action.trim() : 'list';
  if (!SCHEDULE_ACTIONS.includes(normalizedAction)) {
    throw usage(`Unknown schedule action '${normalizedAction}'. Valid actions: ${SCHEDULE_ACTIONS.join(', ')}.`);
  }

  const port = await resolveTargetPort(options);

  if (normalizedAction === 'status') {
    return handleStatus(port, options);
  }

  const projectId = await resolveProjectId(port, options);

  switch (normalizedAction) {
    case 'list':
      return handleList(port, projectId, options);
    case 'show':
      return handleShow(port, projectId, options, args);
    case 'create':
      return handleCreate(port, projectId, options, args);
    case 'run':
      return handleRun(port, projectId, options, args);
    case 'enable':
      return handleToggle(port, projectId, options, args, true);
    case 'disable':
      return handleToggle(port, projectId, options, args, false);
    case 'delete':
      return handleDelete(port, projectId, options, args);
    default:
      return undefined;
  }
}

export { scheduleCommand };
