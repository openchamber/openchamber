import { z } from 'zod';
import { TaskError, createTask, inspectTask, listRepositories, removeTask } from './tasks.js';
import type { Application, Response } from '../shared/http-contracts.js';

const createSchema = z.object({
  reposDir: z.string().trim().min(1),
  tasksDir: z.string().trim().min(1),
  name: z.string().trim().min(1),
  branchPrefix: z.string().trim().optional(),
  repositories: z.array(z.string().min(1)),
});

const removeSchema = z.object({ path: z.string().trim().min(1) });
const repositoriesQuerySchema = z.object({ reposDir: z.string().trim().min(1) });
const inspectQuerySchema = z.object({ path: z.string().trim().min(1) });

const sendFailure = (res: Response, cause: unknown, operation: string) => {
  if (cause instanceof TaskError) {
    return res.status(cause.status).json({ error: cause.message, problems: cause.problems });
  }
  console.error(`[multi-repo-tasks] ${operation} failed:`, cause);
  return res.status(500).json({ error: cause instanceof Error ? cause.message : `${operation} failed`, problems: [] });
};

export const registerMultiRepoTaskRoutes = (app: Application) => {
  app.get('/api/projects/multi-repo-tasks/repositories', async (req, res) => {
    const query = repositoriesQuerySchema.safeParse(req.query);
    if (!query.success) return res.status(400).json({ error: 'reposDir is required', problems: [] });
    try {
      return res.json(await listRepositories(query.data.reposDir));
    } catch (cause) {
      return sendFailure(res, cause, 'Listing repositories');
    }
  });

  app.post('/api/projects/multi-repo-tasks', async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'reposDir, tasksDir, name and repositories are required', problems: [] });
    try {
      return res.json(await createTask(parsed.data));
    } catch (cause) {
      return sendFailure(res, cause, 'Creating the task');
    }
  });

  app.get('/api/projects/multi-repo-tasks/inspect', async (req, res) => {
    const query = inspectQuerySchema.safeParse(req.query);
    if (!query.success) return res.status(400).json({ error: 'path is required', problems: [] });
    try {
      return res.json({ task: await inspectTask(query.data.path) });
    } catch (cause) {
      return sendFailure(res, cause, 'Inspecting the task');
    }
  });

  app.post('/api/projects/multi-repo-tasks/remove', async (req, res) => {
    const parsed = removeSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'path is required', problems: [] });
    try {
      return res.json(await removeTask(parsed.data.path));
    } catch (cause) {
      return sendFailure(res, cause, 'Removing the task');
    }
  });
};
