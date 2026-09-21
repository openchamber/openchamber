const asNonEmptyString = (value) => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const parseProjectID = (req) => asNonEmptyString(req?.params?.projectId);
const parseTaskID = (req) => asNonEmptyString(req?.params?.taskId);

export const registerScheduledTaskRoutes = (app, dependencies) => {
  const {
    readSettingsFromDiskMigrated,
    sanitizeProjects,
    projectConfigRuntime,
    scheduledTasksRuntime,
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
      if (error?.statusCode) return res.status(error.statusCode).json({ error: error.message });
      console.error('[ScheduledTasks] failed to load tasks:', error);
      return res.status(500).json({ error: 'Failed to load scheduled tasks' });
    }
  });

  app.put('/api/projects/:projectId/scheduled-tasks', async (req, res) => {
    const projectID = parseProjectID(req);
    if (!projectID) {
      return res.status(400).json({ error: 'projectId is required' });
    }

    const taskInput = req.body && typeof req.body === 'object' ? req.body.task : null;
    if (!taskInput || typeof taskInput !== 'object') {
      return res.status(400).json({ error: 'task payload is required' });
    }

    try {
      return res.json(await scheduledTaskService.upsert(projectID, taskInput));
    } catch (error) {
      if (error?.statusCode) return res.status(error.statusCode).json({ error: error.message });
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
      if (error?.statusCode) return res.status(error.statusCode).json({ error: error.message });
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
      const task = await scheduledTaskService.setLoopEnabled(projectID, taskID, req.body?.enabled);
      return res.json({ task });
    } catch (error) {
      if (error?.statusCode) return res.status(error.statusCode).json({ error: error.message });
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
      if (error?.statusCode) return res.status(error.statusCode).json({ error: error.message });
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
      if (error?.statusCode) return res.status(error.statusCode).json({ error: error.message, ...(error.task ? { task: error.task } : {}) });
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
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    // Whether a client can drive a browser view is a property of that client,
    // not of this server: a desktop shell and a browser tab can be connected to
    // the same server at once. Recording it on the connection keeps the answer
    // current without any enable/disable setting to go stale.
    res.openchamberBrowserCapable = req.query?.browser === '1';

    const clients = getOpenChamberEventClients();
    clients.add(res);

    try {
      writeSseEvent(res, {
        type: 'openchamber:event-stream-ready',
        properties: {
          connectedAt: Date.now(),
        },
      });
    } catch {
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
