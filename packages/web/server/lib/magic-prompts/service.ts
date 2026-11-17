import type { PlatformPath } from 'node:path';
import { MagicPromptStorageError, MagicPromptValidationError, mergeEffectiveOverrides } from './runtime.js';
import type { MagicPromptGlobalState, MagicPromptOverrides, MagicPromptProject, MagicPromptRuntime, MagicPromptScopeState, ProjectMagicPromptRuntime } from './runtime.js';

export type MagicPromptQueryValue = string | { [key: string]: MagicPromptQueryValue | undefined } | MagicPromptQueryValue[];

export type MagicPromptRequest = {
  method: 'GET' | 'PUT' | 'DELETE';
  id: string | null;
  projectId: MagicPromptQueryValue[];
  scope: MagicPromptQueryValue[];
  sessionDirectory: MagicPromptQueryValue[];
  text: string | null;
  bodyNamesSelector: boolean;
};

type ScopedView = {
  version: number;
  project: { id: string; path: string; file: string };
  scopes: { global: MagicPromptScopeState; project: MagicPromptScopeState };
};

export type MagicPromptHttpResponse = { status: number; body: MagicPromptGlobalState | ScopedView | { error: string; code?: string } };

type ServiceDependencies = {
  path: PlatformPath;
  runtime: MagicPromptRuntime;
  projectRuntime: ProjectMagicPromptRuntime;
  listProjects: () => MagicPromptProject[] | Promise<MagicPromptProject[]>;
  ownerOfDirectory: (directory: string) => Promise<MagicPromptProject | null>;
};

type Selector =
  | { scope: null; projectId: string | null; sessionDirectory: string | null }
  | { scope: 'global'; projectId: string | null; sessionDirectory: null }
  | { scope: 'project'; projectId: string; sessionDirectory: null };

type ScopeChange = {
  global: () => Promise<MagicPromptGlobalState>;
  project: (project: MagicPromptProject) => Promise<void>;
};

const isString = (value: unknown): value is string => typeof value === 'string';

const PROJECT_FILE = '.openchamber/project.json';

class SelectorError extends Error {
  status: number;
  code: string;

  constructor(status: number, message: string, code: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const singleQueryValue = (values: MagicPromptQueryValue[], name: string) => {
  if (values.length === 0) return undefined;
  const value = values.length === 1 && isString(values[0]) ? values[0].trim() : '';
  if (!value) throw new SelectorError(400, `${name} must be one non-empty value`, 'invalid_selector');
  return value;
};

const selectorOf = (request: MagicPromptRequest, mutation: boolean, pathModule: PlatformPath): Selector => {
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
  if (scope === 'project') {
    if (projectId === undefined) {
      throw new SelectorError(400, 'projectId is required for the project scope', 'invalid_selector');
    }
    return { scope, projectId, sessionDirectory: null };
  }
  return { scope: scope ?? 'global', projectId: projectId ?? null, sessionDirectory: null };
};

const errorResponse = (error: Error | null, fallbackMessage: string): MagicPromptHttpResponse => {
  const message = error instanceof Error && error.message ? error.message : fallbackMessage;
  if (error instanceof SelectorError) return { status: error.status, body: { error: message, code: error.code } };
  if (error instanceof MagicPromptValidationError) return { status: 400, body: { error: message, code: 'invalid_prompt' } };
  if (error instanceof MagicPromptStorageError) return { status: 409, body: { error: message, code: error.code } };
  return { status: 500, body: { error: message } };
};

export const createMagicPromptService = ({ path, runtime, projectRuntime, listProjects, ownerOfDirectory }: ServiceDependencies) => {
  const resolveProject = async (projectId: string) => {
    const project = (await listProjects()).find((entry) => entry.id === projectId);
    if (!project) throw new SelectorError(404, 'Project not found', 'project_not_found');
    return { id: project.id, path: project.path };
  };

  const overridesForDirectory = async (directory: string): Promise<MagicPromptOverrides> => {
    const owner = await ownerOfDirectory(directory);
    const [globalState, projectState] = await Promise.all([
      runtime.readPromptState(),
      owner ? projectRuntime.readProjectState(owner) : null,
    ]);
    if (projectState?.status === 'invalid') {
      if (owner) {
        throw new MagicPromptStorageError(
          `Magic prompts in ${path.join(owner.path, PROJECT_FILE)} cannot be read: ${projectState.reason}`,
          'project_prompts_invalid',
        );
      }
      throw new TypeError('Invalid project scope has no owner');
    }
    return mergeEffectiveOverrides(globalState.overrides, projectState?.overrides ?? {});
  };

  const globalScopeOf = async (): Promise<MagicPromptScopeState> => {
    try {
      return { status: 'ok', overrides: (await runtime.readPromptState()).overrides };
    } catch (error) {
      if (error instanceof MagicPromptStorageError) return { status: 'invalid', reason: error.message };
      throw error;
    }
  };

  const scopedViewOf = async (project: MagicPromptProject): Promise<ScopedView> => {
    const [global, projectScope] = await Promise.all([globalScopeOf(), projectRuntime.readProjectState(project)]);
    return {
      version: 1,
      project: { id: project.id, path: project.path, file: PROJECT_FILE },
      scopes: { global, project: projectScope },
    };
  };

  const read = async (request: MagicPromptRequest) => {
    const { projectId, sessionDirectory } = selectorOf(request, false, path);
    if (sessionDirectory) return { version: 1, overrides: await overridesForDirectory(sessionDirectory) };
    if (projectId) return scopedViewOf(await resolveProject(projectId));
    return runtime.readPromptState();
  };

  const mutate = async (request: MagicPromptRequest, fallbackMessage: string, change: ScopeChange): Promise<MagicPromptHttpResponse> => {
    try {
      const selector = selectorOf(request, true, path);
      if (selector.scope === 'project') {
        const project = await resolveProject(selector.projectId);
        await change.project(project);
        return { status: 200, body: await scopedViewOf(project) };
      }
      const project = selector.projectId ? await resolveProject(selector.projectId) : null;
      const state = await change.global();
      return { status: 200, body: project ? await scopedViewOf(project) : state };
    } catch (error) {
      return errorResponse(error instanceof Error ? error : null, fallbackMessage);
    }
  };

  const handle = async (request: MagicPromptRequest): Promise<MagicPromptHttpResponse> => {
    const { id, text } = request;
    if (request.method === 'GET') {
      try {
        return { status: 200, body: await read(request) };
      } catch (error) {
        return errorResponse(error instanceof Error ? error : null, 'Failed to read magic prompts');
      }
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
