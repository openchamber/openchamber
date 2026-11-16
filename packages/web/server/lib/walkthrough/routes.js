import { z } from 'zod';
import { parseSource } from './sources.js';
import { supportsChangeRequestPatch, supportsChangeRequestRevisions } from './pull-request.js';
import { allowsTopLevelProjects } from '../source-control/project-path.js';
import { sourceControlProviderDescriptors } from '../source-control/provider-descriptors.js';

const providerIdSchema = z.string().trim().min(1).max(200).optional().catch(undefined);
const modelIdSchema = z.string().trim().min(1).max(200).optional().catch(undefined);

const clientIsGone = (res) => res.writableEnded || res.destroyed;

export function registerWalkthroughRoutes(app, { getWalkthroughService, validateReadContext }) {
  const respondWithError = (res, error, fallback) => {
    let bindingStatus = 0;
    if (error?.code === 'INVALID_SOURCE_CONTROL_BINDING' || error?.code === 'INVALID_SOURCE_CONTROL_READ_CONTEXT') {
      bindingStatus = 400;
    } else if (error?.code === 'UNSUPPORTED_SOURCE_CONTROL_REPOSITORY') {
      bindingStatus = 422;
    }
    const statusCode = Number(error?.statusCode ?? error?.status) || bindingStatus || 500;
    if (statusCode >= 500) {
      console.error(`${fallback}:`, error);
    }
    res.status(statusCode).json({
      error: error?.message || fallback,
      ...(error?.code ? { code: error.code } : {}),
      ...(error?.model ? { model: error.model } : {}),
      ...(Number.isFinite(error?.requiredChars) ? { requiredChars: error.requiredChars } : {}),
      ...(Number.isFinite(error?.availableChars) ? { availableChars: error.availableChars } : {}),
    });
  };

  const readSource = (value) => {
    if (typeof value !== 'string' || !value) return null;
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  };

  const validatePullRequestContext = async (source, input, directory) => {
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
    if (source.sourceRepo?.owner === '' && !allowsTopLevelProjects(sourceControlProviderDescriptors.get(readContext.provider))) {
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
      const directory = typeof req.query.directory === 'string' ? req.query.directory : '';
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const source = readSource(req.query.source);
      const readContext = await validatePullRequestContext(source, req.query, directory);
      const { getWalkthrough, getPullRequestDiff, readWalkthroughInstructions } = await getWalkthroughService();
      const result = await getWalkthrough(
        {
          directory: readContext?.directory ?? directory,
          source,
          model: typeof req.query.model === 'string' ? req.query.model : undefined,
          providerID: providerIdSchema.parse(req.query.providerID),
          modelID: modelIdSchema.parse(req.query.modelID),
          language: typeof req.query.language === 'string' ? req.query.language : undefined,
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
      const readContext = await validatePullRequestContext(source, Object.fromEntries(query), directory);
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
      const readContext = await validatePullRequestContext(source, Object.fromEntries(query), directory);
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
      const { directory, source, force, model, providerID, modelID, language } = req.body || {};
      if (!directory || typeof directory !== 'string') {
        return res.status(400).json({ error: 'directory is required' });
      }

      const readContext = await validatePullRequestContext(source, req.body, directory);
      const { generateWalkthrough, getPullRequestDiff, readWalkthroughInstructions } = await getWalkthroughService();
      const result = await generateWalkthrough(
        {
          directory: readContext?.directory ?? directory,
          source,
          force: force === true,
          model: typeof model === 'string' ? model : undefined,
          providerID: providerIdSchema.parse(providerID),
          modelID: modelIdSchema.parse(modelID),
          language: typeof language === 'string' ? language : undefined,
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
      const directory = typeof req.query.directory === 'string' ? req.query.directory : '';
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const source = readSource(req.query.source);
      const readContext = await validatePullRequestContext(source, req.query, directory);
      const { getGenerationStage, getRepositoryRootFor } = await getWalkthroughService();
      const { repoRoot, sourceKey } = await getRepositoryRootFor(readContext?.directory ?? directory, source, readContext);
      const result = { stage: getGenerationStage(repoRoot, sourceKey, readContext) };
      if (readContext) result.readContext = readContext;
      res.json(result);
    } catch (error) {
      respondWithError(res, error, 'Failed to read walkthrough progress');
    }
  });

  app.post('/api/walkthrough/cancel', async (req, res) => {
    try {
      const { directory, source } = req.body || {};
      if (!directory || typeof directory !== 'string') {
        return res.status(400).json({ error: 'directory is required' });
      }

      const readContext = await validatePullRequestContext(source, req.body, directory);
      const { cancelWalkthroughGeneration } = await getWalkthroughService();
      res.json(await cancelWalkthroughGeneration({ directory: readContext?.directory ?? directory, source, readContext }));
    } catch (error) {
      respondWithError(res, error, 'Failed to cancel walkthrough generation');
    }
  });
}
