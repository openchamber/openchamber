import { parseSource } from './sources.js';

// `req.destroyed` is true for every healthy request once the body parser has
// consumed the stream, so using it as a disconnect check silently swallows every
// response. The response socket is the one that actually reflects whether the
// client is still there.
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
    if (readContext.provider !== 'github') {
      throw Object.assign(new Error('Pull request walkthroughs currently support GitHub only'), {
        statusCode: 422,
        code: 'UNSUPPORTED_WALKTHROUGH_PROVIDER',
      });
    }
    return readContext;
  };

  app.get('/api/walkthrough', async (req, res) => {
    try {
      const directory = typeof req.query.directory === 'string' ? req.query.directory : '';
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const source = readSource(req.query.source);
      const readContext = await validatePullRequestContext(source, req.query, directory);
      const { getWalkthrough, getPullRequestDiff } = await getWalkthroughService();
      const result = await getWalkthrough(
        {
          directory: readContext?.directory ?? directory,
          source,
          model: typeof req.query.model === 'string' ? req.query.model : undefined,
          language: typeof req.query.language === 'string' ? req.query.language : undefined,
          readContext,
        },
        { getPullRequestDiff },
      );
      res.json(result);
    } catch (error) {
      respondWithError(res, error, 'Failed to load walkthrough');
    }
  });

  // The comparison view needs the complete published patch, without model
  // readiness checks, generated-file filtering, or local working-tree reads.
  app.get('/api/walkthrough/pr-diff', async (req, res) => {
    try {
      const query = new URL(req.originalUrl, 'http://localhost').searchParams;
      const directory = query.get('directory')?.trim() ?? '';
      if (!directory) return res.status(400).json({ error: 'directory parameter is required' });
      const source = parseSource(readSource(query.get('source')));
      if (source.kind !== 'pr') return res.status(400).json({ error: 'A pull request source is required' });
      // Same exact binding authority as the walkthrough routes: the repository
      // and account come from the checkout's binding, and a named source
      // repository is only checked against it.
      const readContext = await validatePullRequestContext(source, Object.fromEntries(query), directory);
      const { getPullRequestDiff } = await getWalkthroughService();
      const { patch } = await getPullRequestDiff(readContext?.directory ?? directory, source.number, readContext, {
        allowEmpty: true,
        sourceRepo: source.sourceRepo ?? null,
      });
      res.type('text/plain').send(patch);
    } catch (error) {
      respondWithError(res, error, 'Failed to load pull request diff');
    }
  });

  // Deliberately not aborted when the client disconnects: generation runs for
  // minutes and a refresh must not throw the work away. Leaving detaches the
  // client; the job finishes and caches its result. Stopping is an explicit
  // request below.
  app.post('/api/walkthrough/generate', async (req, res) => {
    try {
      const { directory, source, force, model, language } = req.body || {};
      if (!directory || typeof directory !== 'string') {
        return res.status(400).json({ error: 'directory is required' });
      }

      const readContext = await validatePullRequestContext(source, req.body, directory);
      const { generateWalkthrough, getPullRequestDiff } = await getWalkthroughService();
      const result = await generateWalkthrough(
        {
          directory: readContext?.directory ?? directory,
          source,
          force: force === true,
          model: typeof model === 'string' ? model : undefined,
          language: typeof language === 'string' ? language : undefined,
          readContext,
        },
        { getPullRequestDiff },
      );
      if (clientIsGone(res)) return;
      res.json(result);
    } catch (error) {
      if (clientIsGone(res)) return;
      respondWithError(res, error, 'Failed to generate walkthrough');
    }
  });

  // Memory-only, so it is safe to poll while a generation runs. The full read
  // re-runs the whole git pipeline and must not be used for this.
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
