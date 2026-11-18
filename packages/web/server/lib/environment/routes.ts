import { EnvironmentPatchError, isProjectId, parseProjectPatch, parseUserPatch } from './store.js';
import type { EnvironmentStore } from './store.js';
import type { EnvironmentRuntime } from './runtime.js';

type ProjectView = ReturnType<EnvironmentStore['describeProject']> & { status: ReturnType<EnvironmentRuntime['projectStatus']> };
type EnvironmentResponseBody = ReturnType<EnvironmentStore['describeUser']> | ProjectView | { error: string };
interface EnvironmentResponse {
  status: (code: number) => EnvironmentResponse;
  json: (body: EnvironmentResponseBody) => EnvironmentResponse;
}
type EnvironmentRequest = { params: { projectId: string }; body: unknown };
type EnvironmentHandler = (req: EnvironmentRequest, res: EnvironmentResponse) =>
  EnvironmentResponse | undefined | Promise<EnvironmentResponse | undefined>;
export interface EnvironmentRouteApp {
  get: (path: string, handler: EnvironmentHandler) => void;
  put: (path: string, handler: EnvironmentHandler) => void;
  post: (path: string, handler: EnvironmentHandler) => void;
}

export const registerEnvironmentRoutes = (app: EnvironmentRouteApp, { store, runtime, listProjects }: {
  store: EnvironmentStore;
  runtime: Pick<EnvironmentRuntime, 'projectStatus' | 'invalidateProject' | 'reloadProject'>;
  listProjects: () => Promise<{ id: string; path: string }[]>;
}) => {
  const respondWithError = (res: EnvironmentResponse, cause: unknown, fallback: string) => {
    if (cause instanceof EnvironmentPatchError) return res.status(400).json({ error: cause.message });
    return res.status(500).json({ error: cause instanceof Error ? cause.message : fallback });
  };

  const projectView = (projectId: string) => ({
    ...store.describeProject(projectId),
    status: runtime.projectStatus(projectId),
  });

  const requireProjectId = (req: EnvironmentRequest, res: EnvironmentResponse) => {
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
      return res.json(await store.updateUser(parseUserPatch(req.body)));
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
      await store.updateProject(projectId, parseProjectPatch(req.body));
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
