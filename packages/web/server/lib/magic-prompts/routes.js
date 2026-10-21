import { isRecord } from '../shared/guards.js';
import { createMagicPromptOwnerResolver, createMagicPromptRuntime, createProjectMagicPromptRuntime } from './runtime.js';
import { createMagicPromptService } from './service.js';

// A query value goes to the service whole, as its only value: a string, or
// the array or object a repeated or nested parameter parses to.
const valuesOf = (value) => (value === undefined ? [] : [value]);

const requestOf = (req, method, id) => ({
  method,
  id,
  projectId: valuesOf(req.query?.projectId),
  scope: valuesOf(req.query?.scope),
  sessionDirectory: valuesOf(req.query?.sessionDirectory),
  text: typeof req.body?.text === 'string' ? req.body.text : null,
  bodyNamesSelector: isRecord(req.body) && ('scope' in req.body || 'projectId' in req.body),
});

export const registerMagicPromptRoutes = (app, dependencies) => {
  const {
    fsPromises,
    path,
    openchamberDataDir,
    projectConfigRuntime,
    readSettingsFromDisk,
    sanitizeProjects,
    resolvePrimaryWorktreeRoot,
    resolveWorktreeTopLevel,
  } = dependencies;

  const listProjects = async () => sanitizeProjects((await readSettingsFromDisk())?.projects) || [];
  const service = createMagicPromptService({
    path,
    runtime: createMagicPromptRuntime({ fsPromises, path, filePath: path.join(openchamberDataDir, 'magic-prompts.json') }),
    projectRuntime: createProjectMagicPromptRuntime({ projectConfigRuntime }),
    listProjects,
    ownerOfDirectory: createMagicPromptOwnerResolver({ path, listProjects, resolvePrimaryWorktreeRoot, resolveWorktreeTopLevel }),
  });

  const answer = (method, withId) => async (req, res) => {
    const { status, body } = await service.handle(requestOf(req, method, withId ? req.params.id : null));
    return res.status(status).json(body);
  };

  app.get('/api/magic-prompts', answer('GET', false));
  app.put('/api/magic-prompts/:id', answer('PUT', true));
  app.delete('/api/magic-prompts/:id', answer('DELETE', true));
  app.delete('/api/magic-prompts', answer('DELETE', false));
};
