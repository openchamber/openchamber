import { asNonEmptyString } from '../shared/guards.js';
import { randomUUID } from 'node:crypto';
import { controlErrorFields } from '../openchamber-control/error.js';
import type { ControlErrorFields } from '../openchamber-control/error.js';
import type { Application, QueryValue, Request, Response } from '../shared/http-contracts.js';
import type { createScheduledTasksRuntime } from './runtime.js';
import type { createProjectConfigRuntime } from '../projects/project-config.js';
import type { ScheduledTaskServiceDependencies } from './service.js';
import type { createNotificationEmitterRuntime } from '../notifications/emitter-runtime.js';
import type { createScheduledTaskRunHistory } from './run-history.js';
import { isString } from '../shared/object-guards.js';

export interface ScheduledTaskEventClient extends Response {
  openchamberBrowserCapable?: boolean;
  openchamberConnectionId?: string;
}

export interface ScheduledTaskRouteDependencies extends ScheduledTaskServiceDependencies {
  projectConfigRuntime: ReturnType<typeof createProjectConfigRuntime>;
  scheduledTasksRuntime: ReturnType<typeof createScheduledTasksRuntime>;
  getOpenChamberEventClients: () => Set<ScheduledTaskEventClient>;
  writeSseEvent: ReturnType<typeof createNotificationEmitterRuntime>['writeSseEvent'];
  scheduledTaskService?: ReturnType<typeof createScheduledTaskService>;
  scheduledTaskRunHistory?: ReturnType<typeof createScheduledTaskRunHistory> | null;
}

interface TaskRequestBody {
  task?: unknown;
  candidates?: unknown;
  enabled?: unknown;
}

interface ScheduledTaskFailure {
  error: ControlErrorFields['message'];
  task?: ControlErrorFields['task'];
  busy?: ControlErrorFields['busy'];
}

const isStatusCode = (value: unknown): value is number => Number.isInteger(value);
const isTaskBody = (value: unknown): value is TaskRequestBody => Boolean(value) && typeof value === 'object';
const parseProjectID = (req: Request) => asNonEmptyString(req?.params?.projectId);
const parseTaskID = (req: Request) => asNonEmptyString(req?.params?.taskId);

export const registerScheduledTaskRoutes = (app: Application, dependencies: ScheduledTaskRouteDependencies) => {
  const {
    scheduledTasksRuntime,
    scheduledTaskRunHistory = null,
    getOpenChamberEventClients,
    writeSseEvent,
    scheduledTaskService = createScheduledTaskService(dependencies),
  } = dependencies;

  app.get('/api/projects/:projectId/scheduled-tasks', async (req, res) => {
    const projectID = parseProjectID(req);
    if (!projectID) {
      return res.status(400).json({ error: 'projectId is required' });
    }

    try {
      const tasks = await scheduledTaskService.list(projectID);
      return res.json({ tasks });
    } catch (error) {
      const fields = controlErrorFields(error);
      if (isStatusCode(fields?.statusCode)) return res.status(fields.statusCode).json({ error: fields.message });
      console.error('[ScheduledTasks] failed to load tasks:', error);
      return res.status(500).json({ error: 'Failed to load scheduled tasks' });
    }
  });

  // Per-run history (#2174 Gap 1): one durable row per completed run,
  // newest first. since/until accept epoch milliseconds or any
  // Date.parse-able string; limit defaults to 200 (max 1000). A supplied
  // non-empty bound that parses as neither, or a repeated bound (array), is
  // rejected with 400 (#2155, #2371): forwarding it as undefined would
  // silently widen the request into an unfiltered one. An absent or empty
  // bound stays "no filter". A repeated taskId is rejected the same way
  // (#2418).
  app.get('/api/projects/:projectId/scheduled-tasks/run-history', async (req, res) => {
    const projectID = parseProjectID(req);
    if (!projectID) {
      return res.status(400).json({ error: 'projectId is required' });
    }
    if (!scheduledTaskRunHistory) {
      return res.status(503).json({ error: 'scheduled task run history is unavailable' });
    }
    const parseTime = (value: QueryValue | undefined) => {
      if (!isString(value) || value.length === 0) return undefined;
      const asNumber = Number(value);
      if (Number.isFinite(asNumber)) return asNumber;
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) ? parsed : undefined;
    };
    const parseTimeFilter = (name: string, value: QueryValue | undefined) => {
      if (value !== undefined && !isString(value)) {
        return { error: `${name} must be a single value` };
      }
      const parsed = parseTime(value);
      if (isString(value) && value.length > 0 && parsed === undefined) {
        return { error: `${name} must be epoch milliseconds or a parseable date string` };
      }
      return { value: parsed };
    };
    const since = parseTimeFilter('since', req.query?.since);
    if (since.error) {
      return res.status(400).json({ error: since.error });
    }
    const until = parseTimeFilter('until', req.query?.until);
    if (until.error) {
      return res.status(400).json({ error: until.error });
    }
    // #2156: an omitted limit stays undefined so listRuns applies the
    // documented default; a supplied limit must be a single plain-decimal
    // integer spelling (the shared parse-int judgement in
    // shared/parse-int.js). A malformed, empty, or repeated limit is a
    // 400, never a silent fallback to the default — a caller's typo must
    // not page at 200 rows without saying so. A valid integer keeps the
    // downstream 1-1000 clamp (so 0 still clamps to 1).
    const limitParam = req.query?.limit;
    let limit;
    if (limitParam !== undefined) {
      const text = isString(limitParam) ? limitParam.trim() : '';
      if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text))) {
        return res.status(400).json({ error: 'limit must be a single integer' });
      }
      limit = Number(text);
    }
    // #2418: a repeated taskId arrives as an array, which asNonEmptyString
    // would drop to undefined, silently widening the request into an
    // unfiltered project history. Reject a present non-string taskId with
    // 400, like the repeated since/until bounds above; an absent or empty
    // taskId stays "no filter", and a single value keeps its trim/empty
    // handling in asNonEmptyString.
    const taskIdParam = req.query?.taskId;
    if (taskIdParam !== undefined && !isString(taskIdParam)) {
      return res.status(400).json({ error: 'taskId must be a single value' });
    }
    const runs = scheduledTaskRunHistory.listRuns({
      projectID,
      taskID: asNonEmptyString(taskIdParam) ?? undefined,
      since: since.value,
      until: until.value,
      limit,
    });
    return res.json({ runs });
  });

  app.put('/api/projects/:projectId/scheduled-tasks', async (req, res) => {
    const projectID = parseProjectID(req);
    if (!projectID) {
      return res.status(400).json({ error: 'projectId is required' });
    }

    const taskInput = isTaskBody(req.body) ? req.body.task : null;
    if (!isTaskBody(taskInput)) {
      return res.status(400).json({ error: 'task payload is required' });
    }

    try {
      return res.json(await scheduledTaskService.upsert(projectID, taskInput));
    } catch (error) {
      const fields = controlErrorFields(error);
      if (isStatusCode(fields?.statusCode)) return res.status(fields.statusCode).json({ error: fields.message });
      const message = error instanceof Error ? error.message : 'Failed to save scheduled task';
      const statusCode = message.toLowerCase().includes('required') || message.toLowerCase().includes('invalid')
        ? 400
        : 500;
      if (statusCode === 500) {
        console.error('[ScheduledTasks] failed to save task:', error);
      }
      return res.status(statusCode).json({ error: message });
    }
  });

  app.post('/api/projects/:projectId/scheduled-tasks/targets/eligible', async (req, res) => {
    const projectID = parseProjectID(req);
    if (!projectID) {
      return res.status(400).json({ error: 'projectId is required' });
    }
    const body: TaskRequestBody | undefined = req.body == null ? undefined : Object(req.body);
    const candidates = req.body && Array.isArray(body?.candidates) ? body.candidates : null;
    if (!candidates || candidates.length > 500) {
      return res.status(400).json({ error: 'candidates must be an array of at most 500 entries' });
    }
    if (!scheduledTasksRuntime?.listEligibleTargets) {
      return res.status(503).json({ error: 'Eligible target resolution is unavailable' });
    }

    try {
      const eligible = await scheduledTasksRuntime.listEligibleTargets(projectID, candidates);
      return res.json({ eligible });
    } catch (error) {
      const fields = controlErrorFields(error);
      if (isStatusCode(fields?.statusCode)) return res.status(fields.statusCode).json({ error: fields.message });
      console.error('[ScheduledTasks] failed to resolve eligible targets:', error);
      return res.status(500).json({ error: 'Failed to resolve eligible targets' });
    }
  });

  app.delete('/api/projects/:projectId/scheduled-tasks/:taskId', async (req, res) => {
    const projectID = parseProjectID(req);
    const taskID = parseTaskID(req);
    if (!projectID) {
      return res.status(400).json({ error: 'projectId is required' });
    }
    if (!taskID) {
      return res.status(400).json({ error: 'taskId is required' });
    }

    try {
      return res.json({ tasks: await scheduledTaskService.remove(projectID, taskID) });
    } catch (error) {
      const fields = controlErrorFields(error);
      if (isStatusCode(fields?.statusCode)) return res.status(fields.statusCode).json({ error: fields.message });
      console.error('[ScheduledTasks] failed to delete task:', error);
      return res.status(500).json({ error: 'Failed to delete scheduled task' });
    }
  });

  app.patch('/api/projects/:projectId/scheduled-tasks/:taskId/loop-file', async (req, res) => {
    const projectID = parseProjectID(req);
    const taskID = parseTaskID(req);
    if (!projectID) return res.status(400).json({ error: 'projectId is required' });
    if (!taskID) return res.status(400).json({ error: 'taskId is required' });
    try {
      const body: TaskRequestBody | undefined = req.body == null ? undefined : Object(req.body);
      const task = await scheduledTaskService.setLoopEnabled(projectID, taskID, body?.enabled);
      return res.json({ task });
    } catch (error) {
      const fields = controlErrorFields(error);
      if (isStatusCode(fields?.statusCode)) return res.status(fields.statusCode).json({ error: fields.message });
      console.error('[ScheduledTasks] failed to update loop file:', error);
      return res.status(500).json({ error: 'Failed to update loop file' });
    }
  });

  app.delete('/api/projects/:projectId/scheduled-tasks/:taskId/loop-file', async (req, res) => {
    const projectID = parseProjectID(req);
    const taskID = parseTaskID(req);
    if (!projectID) return res.status(400).json({ error: 'projectId is required' });
    if (!taskID) return res.status(400).json({ error: 'taskId is required' });
    try {
      return res.json({ tasks: await scheduledTaskService.removeLoopFile(projectID, taskID) });
    } catch (error) {
      const fields = controlErrorFields(error);
      if (isStatusCode(fields?.statusCode)) return res.status(fields.statusCode).json({ error: fields.message });
      console.error('[ScheduledTasks] failed to delete loop file:', error);
      return res.status(500).json({ error: 'Failed to delete loop file' });
    }
  });

  app.post('/api/projects/:projectId/scheduled-tasks/:taskId/run', async (req, res) => {
    const projectID = parseProjectID(req);
    const taskID = parseTaskID(req);
    if (!projectID) {
      return res.status(400).json({ error: 'projectId is required' });
    }
    if (!taskID) {
      return res.status(400).json({ error: 'taskId is required' });
    }

    try {
      return res.json({ ok: true, ...await scheduledTaskService.run(projectID, taskID) });
    } catch (error) {
      const fields = controlErrorFields(error);
      if (isStatusCode(fields?.statusCode)) {
        const response = res.status(fields.statusCode);
        const failure: ScheduledTaskFailure = {
          error: fields.message,
        };
        if (fields.task) failure.task = fields.task;
        if (fields.busy) failure.busy = fields.busy;
        return response.json(failure);
      }
      console.error('[ScheduledTasks] failed to run task:', error);
      return res.status(500).json({ error: 'Failed to run scheduled task' });
    }
  });

  app.get('/api/openchamber/scheduled-tasks/status', async (_req, res) => {
    try {
      return res.json(await scheduledTaskService.status());
    } catch (error) {
      console.error('[ScheduledTasks] failed to resolve scheduled task status:', error);
      return res.status(500).json({ error: 'Failed to resolve scheduled task status' });
    }
  });

  app.get('/api/openchamber/events', (req, res) => {
    const client: ScheduledTaskEventClient = res;
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    client.openchamberBrowserCapable = req.query?.browser === '1';
    client.openchamberConnectionId = randomUUID();

    const clients = getOpenChamberEventClients();
    clients.add(res);

    try {
      writeSseEvent(res, {
        type: 'openchamber:event-stream-ready',
        properties: {
          connectedAt: Date.now(),
          connectionId: client.openchamberConnectionId,
        },
      });
    } catch {
      void 0;
    }

    const heartbeat = setInterval(() => {
      try {
        writeSseEvent(res, {
          type: 'openchamber:heartbeat',
          properties: {
            timestamp: Date.now(),
          },
        });
      } catch {
        clearInterval(heartbeat);
        clients.delete(res);
      }
    }, 25_000);

    req.on('close', () => {
      clearInterval(heartbeat);
      clients.delete(res);
    });
  });
};
import { createScheduledTaskService } from './service.js';
