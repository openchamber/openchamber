import { MagicPromptStorageError, MagicPromptValidationError, mergeEffectiveOverrides } from './runtime.js';

const PROJECT_FILE = '.openchamber/project.json';

class SelectorError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// One non-blank value. Express hands over its parsed value as the only
// element, so a repeated or nested parameter arrives as a non-string and is
// refused like a second value.
const singleQueryValue = (values, name) => {
  if (values.length === 0) return undefined;
  const value = values.length === 1 && typeof values[0] === 'string' ? values[0].trim() : '';
  if (!value) throw new SelectorError(400, `${name} must be one non-empty value`, 'invalid_selector');
  return value;
};

/**
 * Which storage a request targets, from the query string only. Without
 * `projectId` a request is the legacy global request. With `projectId` the
 * response is the two-scope view of that project, and a mutation must name
 * its `scope`, so a project edit can never land in the global file. Selector
 * keys in a body are refused rather than ignored for the same reason.
 * `sessionDirectory` asks a read for the overrides that apply to work there.
 */
const selectorOf = (request, mutation, pathModule) => {
  if (mutation && request.bodyNamesSelector) {
    throw new SelectorError(400, 'scope and projectId belong in the query string', 'invalid_selector');
  }
  const projectId = singleQueryValue(request.projectId, 'projectId');
  const scope = singleQueryValue(request.scope, 'scope');
  const sessionDirectory = singleQueryValue(request.sessionDirectory, 'sessionDirectory');
  if (sessionDirectory !== undefined) {
    if (mutation || projectId !== undefined || scope !== undefined) {
      throw new SelectorError(400, 'sessionDirectory is a read of its own', 'invalid_selector');
    }
    if (!pathModule.isAbsolute(sessionDirectory)) {
      throw new SelectorError(400, 'sessionDirectory must be an absolute path', 'invalid_selector');
    }
    return { scope: null, projectId: null, sessionDirectory };
  }
  if (!mutation) {
    if (scope !== undefined) throw new SelectorError(400, 'scope applies to changes only', 'invalid_selector');
    return { scope: null, projectId: projectId ?? null, sessionDirectory: null };
  }
  if (scope !== undefined && scope !== 'global' && scope !== 'project') {
    throw new SelectorError(400, 'scope must be "global" or "project"', 'invalid_selector');
  }
  if (projectId !== undefined && scope === undefined) {
    throw new SelectorError(400, 'scope is required with projectId', 'invalid_selector');
  }
  if (scope === 'project' && projectId === undefined) {
    throw new SelectorError(400, 'projectId is required for the project scope', 'invalid_selector');
  }
  return { scope: scope ?? 'global', projectId: projectId ?? null, sessionDirectory: null };
};

const errorResponse = (error, fallbackMessage) => {
  const message = error instanceof Error && error.message ? error.message : fallbackMessage;
  if (error instanceof SelectorError) return { status: error.status, body: { error: message, code: error.code } };
  if (error instanceof MagicPromptValidationError) return { status: 400, body: { error: message, code: 'invalid_prompt' } };
  if (error instanceof MagicPromptStorageError) return { status: 409, body: { error: message, code: error.code } };
  return { status: 500, body: { error: message } };
};

/**
 * The `/api/magic-prompts` requests, answered as `{ status, body }` for the
 * Express routes and the VS Code bridge alike. The caller supplies the two
 * stores, its registered projects and its owner resolution, so each runtime
 * keeps its own project list, git access and shared-file owner.
 */
export const createMagicPromptService = ({ path, runtime, projectRuntime, listProjects, ownerOfDirectory }) => {
  // Settings names the project it edits by id: its checkout holds the file.
  // An unknown id never falls back to the global file.
  const resolveProject = async (projectId) => {
    const project = (await listProjects()).find((entry) => entry.id === projectId);
    if (!project) throw new SelectorError(404, 'Project not found', 'project_not_found');
    return { id: project.id, path: project.path };
  };

  // A failed read of either file is an error, never fewer overrides.
  const overridesForDirectory = async (directory) => {
    const owner = await ownerOfDirectory(directory);
    const [globalState, projectState] = await Promise.all([
      runtime.readPromptState(),
      owner ? projectRuntime.readProjectState(owner) : null,
    ]);
    if (projectState?.status === 'invalid') {
      throw new MagicPromptStorageError(
        `Magic prompts in ${path.join(owner.path, PROJECT_FILE)} cannot be read: ${projectState.reason}`,
        'project_prompts_invalid',
      );
    }
    return mergeEffectiveOverrides(globalState.overrides, projectState?.overrides ?? {});
  };

  const globalScopeOf = async () => {
    try {
      return { status: 'ok', overrides: (await runtime.readPromptState()).overrides };
    } catch (error) {
      if (error instanceof MagicPromptStorageError) return { status: 'invalid', reason: error.message };
      throw error;
    }
  };

  const scopedViewOf = async (project) => {
    const [global, projectScope] = await Promise.all([globalScopeOf(), projectRuntime.readProjectState(project)]);
    return {
      version: 1,
      project: { id: project.id, path: project.path, file: PROJECT_FILE },
      scopes: { global, project: projectScope },
    };
  };

  const read = async (request) => {
    const { projectId, sessionDirectory } = selectorOf(request, false, path);
    if (sessionDirectory) return { version: 1, overrides: await overridesForDirectory(sessionDirectory) };
    if (projectId) return scopedViewOf(await resolveProject(projectId));
    return runtime.readPromptState();
  };

  // A legacy request answers with the global file only, as it always has; a
  // request naming a project answers with both scopes of that project.
  const mutate = async (request, fallbackMessage, change) => {
    try {
      const selector = selectorOf(request, true, path);
      const project = selector.projectId ? await resolveProject(selector.projectId) : null;
      if (selector.scope === 'project') {
        await change.project(project);
        return { status: 200, body: await scopedViewOf(project) };
      }
      const state = await change.global();
      return { status: 200, body: project ? await scopedViewOf(project) : state };
    } catch (error) {
      return errorResponse(error, fallbackMessage);
    }
  };

  const handle = async (request) => {
    const { id, text } = request;
    if (request.method === 'GET') {
      return read(request).then((body) => ({ status: 200, body }), (error) => errorResponse(error, 'Failed to read magic prompts'));
    }
    if (request.method === 'PUT') {
      if (text === null) return { status: 400, body: { error: 'text is required', code: 'invalid_prompt' } };
      return mutate(request, 'Failed to save magic prompt', {
        global: () => runtime.setOverride(id, text),
        project: (project) => projectRuntime.setOverride(project, id, text),
      });
    }
    if (id !== null) {
      return mutate(request, 'Failed to reset magic prompt', {
        global: () => runtime.resetOverride(id),
        project: (project) => projectRuntime.resetOverride(project, id),
      });
    }
    return mutate(request, 'Failed to reset magic prompts', {
      global: () => runtime.resetAllOverrides(),
      project: (project) => projectRuntime.resetAllOverrides(project),
    });
  };

  return { handle, overridesForDirectory };
};
