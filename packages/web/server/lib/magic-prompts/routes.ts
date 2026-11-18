import type { promises as fsPromises } from 'node:fs';
import { isRecord as isRecordValue } from '../shared/guards.js';
import { createMagicPromptOwnerResolver, createMagicPromptRuntime, createProjectMagicPromptRuntime } from './runtime.js';
import type { JsonValue, MagicPromptOwnerDependencies, MagicPromptProject, ProjectMagicPromptDependencies } from './runtime.js';
import { createMagicPromptService } from './service.js';
import type { MagicPromptHttpResponse, MagicPromptQueryValue, MagicPromptRequest } from './service.js';
import type { Request, Response, Router } from '../shared/http-contracts.js';

type HttpRequest = Request<unknown, { id: string }, Record<string, MagicPromptQueryValue | undefined>>;
type HttpResponse = Response<MagicPromptHttpResponse['body']>;
type RouteHandler = (req: HttpRequest, res: HttpResponse) => Promise<HttpResponse>;
type RouteApp = Pick<Router, 'get' | 'put' | 'delete'>;

type RouteDependencies = Omit<MagicPromptOwnerDependencies, 'realpath' | 'listProjects'> & ProjectMagicPromptDependencies & {
  fsPromises: Pick<typeof fsPromises, 'mkdir' | 'readFile' | 'rename' | 'rm' | 'writeFile' | 'realpath'>;
  openchamberDataDir: string;
  readSettingsFromDisk: () => Promise<{ projects?: JsonValue } | null>;
  sanitizeProjects: (input: JsonValue | undefined) => MagicPromptProject[] | undefined;
};

const valuesOf = (value: MagicPromptQueryValue | undefined) => (value === undefined ? [] : [value]);
const isRecord = (value: unknown): value is { scope?: unknown; projectId?: unknown } => isRecordValue(value);
const hasText = (value: unknown): value is { text: string } =>
  value !== null && typeof value === 'object' && 'text' in value && typeof value.text === 'string';

const requestOf = (req: HttpRequest, method: MagicPromptRequest['method'], id: string | null): MagicPromptRequest => ({
  method,
  id,
  projectId: valuesOf(req.query?.projectId),
  scope: valuesOf(req.query?.scope),
  sessionDirectory: valuesOf(req.query?.sessionDirectory),
  text: hasText(req.body) ? req.body.text : null,
  bodyNamesSelector: isRecord(req.body) && ('scope' in req.body || 'projectId' in req.body),
});

export const registerMagicPromptRoutes = (app: RouteApp, dependencies: RouteDependencies) => {
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
    ownerOfDirectory: createMagicPromptOwnerResolver({ path, realpath: (value) => fsPromises.realpath(value), listProjects, resolvePrimaryWorktreeRoot, resolveWorktreeTopLevel }),
  });

  const answer = (method: MagicPromptRequest['method'], withId: boolean): RouteHandler => async (req, res) => {
    const { status, body } = await service.handle(requestOf(req, method, withId ? req.params.id : null));
    return res.status(status).json(body);
  };

  app.get('/api/magic-prompts', answer('GET', false));
  app.put('/api/magic-prompts/:id', answer('PUT', true));
  app.delete('/api/magic-prompts/:id', answer('DELETE', true));
  app.delete('/api/magic-prompts', answer('DELETE', false));

  return { overridesForDirectory: service.overridesForDirectory };
};
