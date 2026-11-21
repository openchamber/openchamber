import { z } from 'zod';
import { parseSource } from './sources.js';
import { supportsChangeRequestPatch, supportsChangeRequestRevisions } from './pull-request.js';
import { allowsTopLevelProjects } from '../source-control/project-path.js';
import { sourceControlProviderDescriptors } from '../source-control/provider-descriptors.js';
import type { Application, QueryValue, Response } from '../shared/http-contracts.js';
import type { ProviderReadContext } from '../source-control/provider-contract.js';
import type { WalkthroughSource } from './contracts.js';
import type { ModelJson } from './schema.js';

interface ReadContextInput {
  repositoryId?: unknown;
  provider?: unknown;
  instance?: unknown;
  accountId?: unknown;
  bindingRevision?: unknown;
  primaryRemote?: unknown;
}

interface WalkthroughBody extends ReadContextInput {
  directory?: unknown;
  source?: unknown;
  force?: unknown;
  model?: unknown;
  providerID?: unknown;
  modelID?: unknown;
  language?: unknown;
}

interface PullRequestInput {
  kind: 'pr';
  sourceRepo?: unknown;
  revision?: unknown;
  linked?: unknown;
}

interface RouteFailure {
  code?: unknown;
  statusCode?: unknown;
  status?: unknown;
  message?: unknown;
  model?: unknown;
  requiredChars?: unknown;
  availableChars?: unknown;
}

type WalkthroughModule = typeof import('./index.js');
type PullRequestModule = typeof import('./pull-request.js');

interface WalkthroughErrorResponse extends Pick<RouteFailure, 'code' | 'model' | 'requiredChars' | 'availableChars'> {
  error: RouteFailure['message'];
}

interface GenerationProgress {
  stage: ReturnType<WalkthroughModule['getGenerationStage']>;
  readContext?: ProviderReadContext;
}

export interface PullRequestOptions {
  allowEmpty?: boolean;
  sourceRepo: Extract<WalkthroughSource, { kind: 'pr' }>['sourceRepo'] | null;
  revision?: string | undefined;
}

export interface PullRequestFileOptions extends Omit<PullRequestOptions, 'allowEmpty'> {
  path: string;
  previousPath?: string | undefined;
  status: string;
  binary: boolean;
}

export interface WalkthroughRouteService extends Pick<WalkthroughModule,
  'getWalkthrough' | 'generateWalkthrough' | 'getRepositoryRootFor'
  | 'getGenerationStage' | 'cancelWalkthroughGeneration'> {
  getPullRequestDiff(
    directory: string, number: number, context: ProviderReadContext | undefined, options: PullRequestOptions,
  ): ReturnType<PullRequestModule['getPullRequestDiff']>;
  getPullRequestFileContents(
    directory: string, number: number, context: ProviderReadContext | undefined, options: PullRequestFileOptions,
  ): ReturnType<PullRequestModule['getPullRequestFileContents']>;
  readWalkthroughInstructions?: (directory: string) => Promise<string>;
}

export interface WalkthroughRouteDependencies {
  getWalkthroughService(): Promise<WalkthroughRouteService>;
  validateReadContext?: (input: ReadContextInput & {
    directory: string;
    bindingRevision: number;
  }) => Promise<ProviderReadContext>;
}

const isWalkthroughBody = (value: unknown): value is WalkthroughBody =>
  value !== null && (typeof value === 'object' || typeof value === 'function');

const isPullRequestInput = (value: unknown): value is PullRequestInput =>
  value !== null && (typeof value === 'object' || typeof value === 'function')
  && 'kind' in value && value.kind === 'pr';

const isRepositoryInput = (value: unknown): value is { owner?: unknown } =>
  value !== null && (typeof value === 'object' || typeof value === 'function');

const isRouteFailure = (value: unknown): value is RouteFailure =>
  value !== null && (typeof value === 'object' || typeof value === 'function');

const isText = (value: unknown): value is string => typeof value === 'string';

const providerIdSchema = z.string().trim().min(1).max(200).optional().catch(undefined);
const modelIdSchema = z.string().trim().min(1).max(200).optional().catch(undefined);

const clientIsGone = (res: Response) => res.writableEnded || res.destroyed;

export function registerWalkthroughRoutes(app: Application, { getWalkthroughService, validateReadContext }: WalkthroughRouteDependencies) {
  const respondWithError = (res: Response, cause: unknown, fallback: string) => {
    const error = isRouteFailure(cause) ? cause : undefined;
    let bindingStatus = 0;
    if (error?.code === 'INVALID_SOURCE_CONTROL_BINDING' || error?.code === 'INVALID_SOURCE_CONTROL_READ_CONTEXT') {
      bindingStatus = 400;
    } else if (error?.code === 'UNSUPPORTED_SOURCE_CONTROL_REPOSITORY') {
      bindingStatus = 422;
    }
    const statusCode = Number(error?.statusCode ?? error?.status) || bindingStatus || 500;
    if (statusCode >= 500) {
      console.error(`${fallback}:`, cause);
    }
    const body: WalkthroughErrorResponse = {
      error: error?.message || fallback,
    };
    if (error?.code) body.code = error.code;
    if (error?.model) body.model = error.model;
    if (Number.isFinite(error?.requiredChars)) body.requiredChars = error?.requiredChars;
    if (Number.isFinite(error?.availableChars)) body.availableChars = error?.availableChars;
    res.status(statusCode).json(body);
  };

  const readSource = (value: QueryValue | null | undefined): ModelJson => {
    if (!isText(value) || !value) return null;
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  };

  const validatePullRequestContext = async (source: PullRequestInput | undefined, input: ReadContextInput | undefined, directory: string) => {
    if (source?.kind !== 'pr') return undefined;
    if (!validateReadContext) {
      throw Object.assign(new Error('Bound source control reads are unavailable'), {
        statusCode: 501,
        code: 'SOURCE_CONTROL_BINDING_UNAVAILABLE',
      });
    }
    const readContext = await validateReadContext({
      directory,
      repositoryId: input?.repositoryId,
      provider: input?.provider,
      instance: input?.instance,
      accountId: input?.accountId,
      bindingRevision: Number(input?.bindingRevision),
      primaryRemote: input?.primaryRemote,
    });
    if (!supportsChangeRequestPatch(readContext.provider)) {
      throw Object.assign(new Error('This source control provider does not offer change request walkthroughs'), {
        statusCode: 422,
        code: 'UNSUPPORTED_WALKTHROUGH_PROVIDER',
      });
    }
    if ((isRepositoryInput(source.sourceRepo) ? source.sourceRepo.owner : undefined) === '' && !allowsTopLevelProjects(sourceControlProviderDescriptors.get(readContext.provider))) {
      throw Object.assign(new Error('pr sources require a valid repository'), { statusCode: 400 });
    }
    if (source.revision !== undefined && !supportsChangeRequestRevisions(readContext.provider)) {
      throw Object.assign(new Error('This source control provider does not keep change request revisions'), {
        statusCode: 400,
        code: 'INVALID_SOURCE_CONTROL_READ_CONTEXT',
      });
    }
    return source.linked === true ? { ...readContext, linked: true } : readContext;
  };

  app.get('/api/walkthrough', async (req, res) => {
    try {
      const directory = isText(req.query.directory) ? req.query.directory : '';
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const source = readSource(req.query.source);
      const readContext = await validatePullRequestContext(isPullRequestInput(source) ? source : undefined, req.query, directory);
      const { getWalkthrough, getPullRequestDiff, readWalkthroughInstructions } = await getWalkthroughService();
      const result = await getWalkthrough(
        {
          directory: readContext?.directory ?? directory,
          source,
          model: isText(req.query.model) ? req.query.model : undefined,
          providerID: providerIdSchema.parse(req.query.providerID),
          modelID: modelIdSchema.parse(req.query.modelID),
          language: isText(req.query.language) ? req.query.language : undefined,
          readContext,
        },
        { getPullRequestDiff, readWalkthroughInstructions },
      );
      res.json(result);
    } catch (error) {
      respondWithError(res, error, 'Failed to load walkthrough');
    }
  });

  app.get('/api/walkthrough/pr-diff', async (req, res) => {
    try {
      const query = new URL(req.originalUrl, 'http://localhost').searchParams;
      const directory = query.get('directory')?.trim() ?? '';
      if (!directory) return res.status(400).json({ error: 'directory parameter is required' });
      const source = parseSource(readSource(query.get('source')));
      if (source.kind !== 'pr') return res.status(400).json({ error: 'A pull request source is required' });
      const readContext = await validatePullRequestContext(isPullRequestInput(source) ? source : undefined, Object.fromEntries(query), directory);
      const { getPullRequestDiff } = await getWalkthroughService();
      const { patch } = await getPullRequestDiff(readContext?.directory ?? directory, source.number, readContext, {
        allowEmpty: true,
        sourceRepo: source.sourceRepo ?? null,
        revision: source.revision,
      });
      res.type('text/plain').send(patch);
    } catch (error) {
      respondWithError(res, error, 'Failed to load pull request diff');
    }
  });

  app.get('/api/walkthrough/pr-file', async (req, res) => {
    try {
      const query = new URL(req.originalUrl, 'http://localhost').searchParams;
      const directory = query.get('directory')?.trim() ?? '';
      if (!directory) return res.status(400).json({ error: 'directory parameter is required' });
      const source = parseSource(readSource(query.get('source')));
      if (source.kind !== 'pr') return res.status(400).json({ error: 'A pull request source is required' });
      const path = query.get('path')?.trim() ?? '';
      if (!path) return res.status(400).json({ error: 'path parameter is required' });
      const previousPath = query.get('previousPath')?.trim() || undefined;
      const status = query.get('status') ?? 'M';
      const readContext = await validatePullRequestContext(isPullRequestInput(source) ? source : undefined, Object.fromEntries(query), directory);
      const { getPullRequestFileContents } = await getWalkthroughService();
      res.json(await getPullRequestFileContents(readContext?.directory ?? directory, source.number, readContext, {
        path,
        previousPath,
        status,
        sourceRepo: source.sourceRepo ?? null,
        revision: source.revision,
        binary: query.get('binary') === 'true',
      }));
    } catch (error) {
      respondWithError(res, error, 'Failed to load pull request file');
    }
  });

  app.post('/api/walkthrough/generate', async (req, res) => {
    try {
      const { directory, source, force, model, providerID, modelID, language } = isWalkthroughBody(req.body) ? req.body : {};
      if (!directory || !isText(directory)) {
        return res.status(400).json({ error: 'directory is required' });
      }

      const readContext = await validatePullRequestContext(isPullRequestInput(source) ? source : undefined, isWalkthroughBody(req.body) ? req.body : undefined, directory);
      const { generateWalkthrough, getPullRequestDiff, readWalkthroughInstructions } = await getWalkthroughService();
      const result = await generateWalkthrough(
        {
          directory: readContext?.directory ?? directory,
          source,
          force: force === true,
          model: isText(model) ? model : undefined,
          providerID: providerIdSchema.parse(providerID),
          modelID: modelIdSchema.parse(modelID),
          language: isText(language) ? language : undefined,
          readContext,
        },
        { getPullRequestDiff, readWalkthroughInstructions },
      );
      if (clientIsGone(res)) return;
      res.json(result);
    } catch (error) {
      if (clientIsGone(res)) return;
      respondWithError(res, error, 'Failed to generate walkthrough');
    }
  });

  app.get('/api/walkthrough/progress', async (req, res) => {
    try {
      const directory = isText(req.query.directory) ? req.query.directory : '';
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const source = readSource(req.query.source);
      const readContext = await validatePullRequestContext(isPullRequestInput(source) ? source : undefined, req.query, directory);
      const { getGenerationStage, getRepositoryRootFor } = await getWalkthroughService();
      const { repoRoot, sourceKey } = await getRepositoryRootFor(readContext?.directory ?? directory, source, readContext);
      const result: GenerationProgress = { stage: getGenerationStage(repoRoot, sourceKey, readContext) };
      if (readContext) result.readContext = readContext;
      res.json(result);
    } catch (error) {
      respondWithError(res, error, 'Failed to read walkthrough progress');
    }
  });

  app.post('/api/walkthrough/cancel', async (req, res) => {
    try {
      const { directory, source } = isWalkthroughBody(req.body) ? req.body : {};
      if (!directory || !isText(directory)) {
        return res.status(400).json({ error: 'directory is required' });
      }

      const readContext = await validatePullRequestContext(isPullRequestInput(source) ? source : undefined, isWalkthroughBody(req.body) ? req.body : undefined, directory);
      const { cancelWalkthroughGeneration } = await getWalkthroughService();
      res.json(await cancelWalkthroughGeneration({ directory: readContext?.directory ?? directory, source, readContext }));
    } catch (error) {
      respondWithError(res, error, 'Failed to cancel walkthrough generation');
    }
  });
}
