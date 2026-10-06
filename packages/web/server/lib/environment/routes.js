import { EnvironmentPatchError, isProjectId } from './store.js';

/**
 * Environment variables for what OpenChamber starts. Every answer names the
 * variables and never carries a value: anyone signed in to the UI, over a
 * tunnel or from a paired phone too, can manage them but not read them back.
 *
 * GET  /api/environment                          -> { names }
 * PUT  /api/environment                          { variables: { NAME: "value" | null } } -> { names }
 * GET  /api/environment/projects/:id             -> { names, command, status }
 * PUT  /api/environment/projects/:id             { variables?, command? } -> { names, command, status }
 * POST /api/environment/projects/:id/reload      -> { names, command, status }
 *
 * `status` is the last outcome of the project's environment command:
 * null before it ran, `{ state: "applied", count }`, or
 * `{ state: "failed", reason, exitCode? }`.
 *
 * `/api/environment` is on the JSON-body allowlist in `opencode/core-routes.js`.
 */
export const registerEnvironmentRoutes = (app, { store, runtime, listProjects }) => {
  const respondWithError = (res, error, fallback) => {
    if (error instanceof EnvironmentPatchError) return res.status(400).json({ error: error.message });
    return res.status(500).json({ error: error instanceof Error ? error.message : fallback });
  };

  const projectView = (projectId) => ({
    ...store.describeProject(projectId),
    status: runtime.projectStatus(projectId),
  });

  const requireProjectId = (req, res) => {
    const { projectId } = req.params;
    if (isProjectId(projectId)) return projectId;
    res.status(400).json({ error: 'Invalid project id' });
    return null;
  };

  app.get('/api/environment', (_req, res) => {
    try {
      return res.json(store.describeUser());
    } catch (error) {
      return respondWithError(res, error, 'Failed to read environment variables');
    }
  });

  app.put('/api/environment', async (req, res) => {
    try {
      return res.json(await store.updateUser(req.body));
    } catch (error) {
      return respondWithError(res, error, 'Failed to save environment variables');
    }
  });

  app.get('/api/environment/projects/:projectId', (req, res) => {
    const projectId = requireProjectId(req, res);
    if (!projectId) return undefined;
    try {
      return res.json(projectView(projectId));
    } catch (error) {
      return respondWithError(res, error, 'Failed to read project environment');
    }
  });

  app.put('/api/environment/projects/:projectId', async (req, res) => {
    const projectId = requireProjectId(req, res);
    if (!projectId) return undefined;
    try {
      await store.updateProject(projectId, req.body);
      runtime.invalidateProject(projectId);
      return res.json(projectView(projectId));
    } catch (error) {
      return respondWithError(res, error, 'Failed to save project environment');
    }
  });

  app.post('/api/environment/projects/:projectId/reload', async (req, res) => {
    const projectId = requireProjectId(req, res);
    if (!projectId) return undefined;
    try {
      const project = (await listProjects()).find((entry) => entry.id === projectId);
      if (!project) return res.status(404).json({ error: 'Project not found' });
      await runtime.reloadProject(projectId, project.path);
      return res.json(projectView(projectId));
    } catch (error) {
      return respondWithError(res, error, 'Failed to run the environment command');
    }
  });
};
