import { EnvironmentPatchError, isProjectId, parseProjectPatch, parseUserPatch } from './store.js';
import type { EnvironmentStore } from './store.js';
import type { EnvironmentRuntime } from './runtime.js';
import type { EnvironmentVariables } from './variables.js';
import type { Response } from '../shared/http-contracts.js';
import { isVaultReference } from './vault.js';

type ProjectView = ReturnType<EnvironmentStore['describeProject']> & { status: ReturnType<EnvironmentRuntime['projectStatus']> };
type EnvironmentResponseBody = ReturnType<EnvironmentStore['describeUser']> | ProjectView | { error: string };
type EnvironmentResponse = Response<EnvironmentResponseBody>;
type EnvironmentRequest = { params: { projectId: string }; body: unknown };
type EnvironmentHandler = (req: EnvironmentRequest, res: EnvironmentResponse) =>
  EnvironmentResponse | undefined | Promise<EnvironmentResponse | undefined>;
export interface EnvironmentRouteApp {
  get: (path: string, handler: EnvironmentHandler) => void;
  put: (path: string, handler: EnvironmentHandler) => void;
  post: (path: string, handler: EnvironmentHandler) => void;
}

export const registerEnvironmentRoutes = (app: EnvironmentRouteApp, { store, runtime, listProjects, readClaudeConfigDir, onClaudeConfigChanged }: {
  store: EnvironmentStore;
  runtime: Pick<EnvironmentRuntime, 'projectStatus' | 'invalidateProject' | 'reloadProject' | 'vaultStatus'>;
  listProjects: () => Promise<{ id: string; path: string }[]>;
  readClaudeConfigDir?: () => string | undefined;
  onClaudeConfigChanged?: () => void;
}) => {
  const respondWithError = (res: EnvironmentResponse, cause: unknown, fallback: string) => {
    if (cause instanceof EnvironmentPatchError) return res.status(400).json({ error: cause.message });
    return res.status(500).json({ error: cause instanceof Error ? cause.message : fallback });
  };

  const withReferences = <Described extends object>(described: Described, variables: EnvironmentVariables) => {
    const references = Object.fromEntries(Object.entries(variables).filter(([, value]) => isVaultReference(value)));
    const statuses = runtime.vaultStatus(variables);
    return {
      ...described,
      references,
      vault: Object.fromEntries(Object.keys(references).filter((name) => Object.hasOwn(statuses, name) && statuses[name]).map((name) => [name, statuses[name]])),
    };
  };

  const userView = () => withReferences(store.describeUser(), store.userVariables());

  const projectView = (projectId: string) => ({
    ...withReferences(store.describeProject(projectId), store.projectEntry(projectId).variables),
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
      return res.json(userView());
    } catch (error) {
      return respondWithError(res, error, 'Failed to read environment variables');
    }
  });

  app.put('/api/environment', async (req, res) => {
    try {
      const patch = parseUserPatch(req.body);
      const touchesClaude = Boolean(patch.variables && Object.hasOwn(patch.variables, 'CLAUDE_CONFIG_DIR'));
      const before = touchesClaude ? readClaudeConfigDir?.() : undefined;
      await store.updateUser(patch);
      if (touchesClaude && readClaudeConfigDir?.() !== before) onClaudeConfigChanged?.();
      return res.json(userView());
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
      const patch = parseProjectPatch(req.body);
      await store.updateProject(projectId, patch);
      if (patch.variables !== undefined || patch.command !== undefined) runtime.invalidateProject(projectId);
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
