import { TunnelCliError, EXIT_CODE } from './cli-errors.js';
import { requestJson } from './cli-http.js';
import {
  intro as clackIntro,
  outro as clackOutro,
  isJsonMode,
  isQuietMode,
  printJson,
  logStatus,
} from '../cli-output.js';

const asNonEmptyString = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const assertRequired = (value, flagName) => {
  const normalized = asNonEmptyString(value);
  if (!normalized) {
    throw new TunnelCliError(`Missing required ${flagName}.`, EXIT_CODE.USAGE_ERROR);
  }
  return normalized;
};

const assertOk = (response, body, fallback) => {
  if (response?.ok) return;
  const message = asNonEmptyString(body?.error) || fallback;
  const exitCode = response?.status === 400 || response?.status === 404
    ? EXIT_CODE.USAGE_ERROR
    : EXIT_CODE.GENERAL_ERROR;
  throw new TunnelCliError(message, exitCode);
};

const parseModel = (value) => {
  const model = assertRequired(value, '--model');
  const slashIndex = model.indexOf('/');
  if (slashIndex <= 0 || slashIndex === model.length - 1) {
    throw new TunnelCliError('--model must be in provider/model format.', EXIT_CODE.USAGE_ERROR);
  }
  return {
    providerID: model.slice(0, slashIndex),
    modelID: model.slice(slashIndex + 1),
  };
};

const parseWeekdays = (value) => {
  const raw = assertRequired(value, '--weekly');
  const weekdays = raw.split(',').map((entry) => Number.parseInt(entry.trim(), 10));
  if (weekdays.length === 0 || weekdays.some((entry) => !Number.isInteger(entry) || entry < 0 || entry > 6)) {
    throw new TunnelCliError('--weekly must be a comma-separated list of weekdays from 0 to 6.', EXIT_CODE.USAGE_ERROR);
  }
  return Array.from(new Set(weekdays)).sort((a, b) => a - b);
};

const buildSchedule = (options) => {
  const selectors = [options.daily, options.weekly, options.once, options.cron]
    .filter((value) => asNonEmptyString(value)).length;
  if (selectors !== 1) {
    throw new TunnelCliError('Provide exactly one of --daily, --weekly, --once, or --cron.', EXIT_CODE.USAGE_ERROR);
  }

  const timezone = asNonEmptyString(options.timezone);
  if (asNonEmptyString(options.daily)) {
    return {
      kind: 'daily',
      times: [assertRequired(options.daily, '--daily')],
      ...(timezone ? { timezone } : {}),
    };
  }

  if (asNonEmptyString(options.weekly)) {
    return {
      kind: 'weekly',
      weekdays: parseWeekdays(options.weekly),
      times: [assertRequired(options.time, '--time')],
      ...(timezone ? { timezone } : {}),
    };
  }

  if (asNonEmptyString(options.once)) {
    return {
      kind: 'once',
      date: assertRequired(options.once, '--once'),
      time: assertRequired(options.time, '--time'),
      ...(timezone ? { timezone } : {}),
    };
  }

  return {
    kind: 'cron',
    cron: assertRequired(options.cron, '--cron'),
    ...(timezone ? { timezone } : {}),
  };
};

const buildTaskPayload = (options) => {
  const { providerID, modelID } = parseModel(options.model);
  const agent = asNonEmptyString(options.agent);
  const variant = asNonEmptyString(options.variant);
  return {
    name: assertRequired(options.name, '--name'),
    enabled: options.disabled !== true,
    schedule: buildSchedule(options),
    execution: {
      prompt: assertRequired(options.prompt, '--prompt'),
      providerID,
      modelID,
      ...(agent ? { agent } : {}),
      ...(variant ? { variant } : {}),
    },
  };
};

const formatSchedule = (schedule) => {
  if (!schedule || typeof schedule !== 'object') return 'unknown';
  if (schedule.kind === 'daily') return `daily ${Array.isArray(schedule.times) ? schedule.times.join(',') : ''}`.trim();
  if (schedule.kind === 'weekly') return `weekly days:${Array.isArray(schedule.weekdays) ? schedule.weekdays.join(',') : ''} time:${Array.isArray(schedule.times) ? schedule.times.join(',') : ''}`;
  if (schedule.kind === 'once') return `once ${schedule.date || ''} ${schedule.time || ''}`.trim();
  if (schedule.kind === 'cron') return `cron ${schedule.cron || ''}`.trim();
  return schedule.kind || 'unknown';
};

const outputTasks = (options, tasks) => {
  const normalizedTasks = Array.isArray(tasks) ? tasks : [];
  if (isJsonMode(options)) {
    printJson({ tasks: normalizedTasks });
    return;
  }
  if (isQuietMode(options)) {
    for (const task of normalizedTasks) {
      process.stdout.write(`${task.id} enabled:${task.enabled === false ? 'no' : 'yes'} status:${task.state?.lastStatus || 'idle'} ${formatSchedule(task.schedule)} ${task.name || ''}\n`);
    }
    return;
  }

  clackIntro('Scheduled Tasks');
  if (normalizedTasks.length === 0) {
    logStatus('info', 'No scheduled tasks found');
    clackOutro('0 tasks');
    return;
  }
  for (const task of normalizedTasks) {
    const status = task.enabled === false ? 'warning' : 'success';
    const detail = `id: ${task.id}; status: ${task.state?.lastStatus || 'idle'}; ${formatSchedule(task.schedule)}`;
    logStatus(status, task.name || task.id, detail);
  }
  clackOutro(`${normalizedTasks.length} task(s)`);
};

const updateTaskEnabled = async (options, projectID, taskID, enabled) => {
  const listResult = await requestJson(options.port, `/api/projects/${encodeURIComponent(projectID)}/scheduled-tasks`, options);
  assertOk(listResult.response, listResult.body, 'Failed to load scheduled tasks');
  const tasks = Array.isArray(listResult.body?.tasks) ? listResult.body.tasks : [];
  const task = tasks.find((entry) => entry?.id === taskID);
  if (!task) {
    throw new TunnelCliError('Task not found', EXIT_CODE.USAGE_ERROR);
  }

  const saveResult = await requestJson(options.port, `/api/projects/${encodeURIComponent(projectID)}/scheduled-tasks`, {
    ...options,
    method: 'PUT',
    body: JSON.stringify({ task: { ...task, enabled } }),
  });
  assertOk(saveResult.response, saveResult.body, enabled ? 'Failed to enable scheduled task' : 'Failed to disable scheduled task');
  return saveResult.body?.task || { ...task, enabled };
};

async function scheduleCommand(options = {}, action = 'help') {
  if (action === 'help') {
    process.stdout.write(`OpenChamber Schedule Commands\n\nUSAGE:\n  openchamber schedule status [OPTIONS]\n  openchamber schedule list --project <projectId> [OPTIONS]\n  openchamber schedule create --project <projectId> --name <name> --prompt <prompt> --model <provider/model> (--daily <HH:mm> | --weekly <0,1,2> --time <HH:mm> | --once <YYYY-MM-DD> --time <HH:mm> | --cron <expr>) [OPTIONS]\n  openchamber schedule run --project <projectId> --task <taskId> [OPTIONS]\n  openchamber schedule delete --project <projectId> --task <taskId> [OPTIONS]\n  openchamber schedule enable --project <projectId> --task <taskId> [OPTIONS]\n  openchamber schedule disable --project <projectId> --task <taskId> [OPTIONS]\n\nOPTIONS:\n  -p, --port <port>       OpenChamber server port\n  --timezone <zone>       IANA timezone for created tasks\n  --agent <id>            Agent to use when running task\n  --variant <id>          Model variant to use when running task\n  --disabled              Create task disabled\n  --json                  Output machine-readable JSON\n  -q, --quiet             Print concise output\n`);
    return;
  }

  if (action === 'status') {
    const { response, body } = await requestJson(options.port, '/api/openchamber/scheduled-tasks/status', options);
    assertOk(response, body, 'Failed to load scheduled task status');
    if (isJsonMode(options)) {
      printJson(body || {});
      return;
    }
    if (isQuietMode(options)) {
      process.stdout.write(`enabled:${body?.enabledScheduledTasksCount ?? 0} running:${body?.runningScheduledTasksCount ?? 0}\n`);
      return;
    }
    clackIntro('Scheduled Task Status');
    logStatus(body?.hasEnabledScheduledTasks ? 'success' : 'info', `enabled: ${body?.enabledScheduledTasksCount ?? 0}`);
    logStatus(body?.hasRunningScheduledTasks ? 'success' : 'info', `running: ${body?.runningScheduledTasksCount ?? 0}`);
    clackOutro('status loaded');
    return;
  }

  if (action === 'list') {
    const projectID = assertRequired(options.project, '--project');
    const { response, body } = await requestJson(options.port, `/api/projects/${encodeURIComponent(projectID)}/scheduled-tasks`, options);
    assertOk(response, body, 'Failed to load scheduled tasks');
    outputTasks(options, body?.tasks);
    return;
  }

  if (action === 'create') {
    const projectID = assertRequired(options.project, '--project');
    const task = buildTaskPayload(options);
    const { response, body } = await requestJson(options.port, `/api/projects/${encodeURIComponent(projectID)}/scheduled-tasks`, {
      ...options,
      method: 'PUT',
      body: JSON.stringify({ task }),
    });
    assertOk(response, body, 'Failed to create scheduled task');
    if (isJsonMode(options)) {
      printJson({ task: body?.task, created: body?.created === true });
      return;
    }
    if (isQuietMode(options)) {
      process.stdout.write(`${body?.task?.id || ''}\n`);
      return;
    }
    clackIntro('Scheduled Task Created');
    logStatus('success', body?.task?.name || task.name, `id: ${body?.task?.id || 'unknown'}; ${formatSchedule(body?.task?.schedule || task.schedule)}`);
    clackOutro('created');
    return;
  }

  if (action === 'run') {
    const projectID = assertRequired(options.project, '--project');
    const taskID = assertRequired(options.task, '--task');
    const { response, body } = await requestJson(options.port, `/api/projects/${encodeURIComponent(projectID)}/scheduled-tasks/${encodeURIComponent(taskID)}/run`, {
      ...options,
      method: 'POST',
    });
    assertOk(response, body, 'Failed to run scheduled task');
    if (isJsonMode(options)) {
      printJson({ task: body?.task, sessionId: body?.sessionId });
      return;
    }
    if (isQuietMode(options)) {
      process.stdout.write(`${body?.sessionId || ''}\n`);
      return;
    }
    clackIntro('Scheduled Task Run');
    logStatus('success', body?.task?.name || taskID, `session: ${body?.sessionId || 'unknown'}`);
    clackOutro('started');
    return;
  }

  if (action === 'delete') {
    const projectID = assertRequired(options.project, '--project');
    const taskID = assertRequired(options.task, '--task');
    const { response, body } = await requestJson(options.port, `/api/projects/${encodeURIComponent(projectID)}/scheduled-tasks/${encodeURIComponent(taskID)}`, {
      ...options,
      method: 'DELETE',
    });
    assertOk(response, body, 'Failed to delete scheduled task');
    if (isJsonMode(options)) {
      printJson({ deleted: true, tasks: body?.tasks || [] });
      return;
    }
    if (isQuietMode(options)) {
      process.stdout.write(`deleted ${taskID}\n`);
      return;
    }
    clackIntro('Scheduled Task Deleted');
    logStatus('success', `deleted ${taskID}`);
    clackOutro('deleted');
    return;
  }

  if (action === 'enable' || action === 'disable') {
    const projectID = assertRequired(options.project, '--project');
    const taskID = assertRequired(options.task, '--task');
    const enabled = action === 'enable';
    const task = await updateTaskEnabled(options, projectID, taskID, enabled);
    if (isJsonMode(options)) {
      printJson({ task, enabled });
      return;
    }
    if (isQuietMode(options)) {
      process.stdout.write(`${taskID} enabled:${enabled ? 'yes' : 'no'}\n`);
      return;
    }
    clackIntro(enabled ? 'Scheduled Task Enabled' : 'Scheduled Task Disabled');
    logStatus('success', task?.name || taskID, `enabled: ${enabled ? 'yes' : 'no'}`);
    clackOutro(enabled ? 'enabled' : 'disabled');
    return;
  }

  throw new TunnelCliError(`Unknown schedule command '${action}'.`, EXIT_CODE.USAGE_ERROR);
}

export { scheduleCommand, buildTaskPayload, buildSchedule };
