// `req.destroyed` is true for every healthy request once the body parser has
// consumed the stream, so using it as a disconnect check silently swallows every
// response. The response socket is the one that actually reflects whether the
// client is still there.
const clientIsGone = (res) => res.writableEnded || res.destroyed;

export function registerWalkthroughRoutes(app, { getWalkthroughService }) {
  const respondWithError = (res, error, fallback) => {
    const statusCode = Number(error?.statusCode) || 500;
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

  app.get('/api/walkthrough', async (req, res) => {
    try {
      const { getWalkthrough, getPullRequestDiff } = await getWalkthroughService();
      const directory = typeof req.query.directory === 'string' ? req.query.directory : '';
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const result = await getWalkthrough(
        {
          directory,
          source: readSource(req.query.source),
          model: typeof req.query.model === 'string' ? req.query.model : undefined,
          language: typeof req.query.language === 'string' ? req.query.language : undefined,
        },
        { getPullRequestDiff },
      );
      res.json(result);
    } catch (error) {
      respondWithError(res, error, 'Failed to load walkthrough');
    }
  });

  // Deliberately not aborted when the client disconnects: generation runs for
  // minutes and a refresh must not throw the work away. Leaving detaches the
  // client; the job finishes and caches its result. Stopping is an explicit
  // request below.
  app.post('/api/walkthrough/generate', async (req, res) => {
    try {
      const { generateWalkthrough, getPullRequestDiff } = await getWalkthroughService();
      const { directory, source, force, model, language } = req.body || {};
      if (!directory || typeof directory !== 'string') {
        return res.status(400).json({ error: 'directory is required' });
      }

      const result = await generateWalkthrough(
        {
          directory,
          source,
          force: force === true,
          model: typeof model === 'string' ? model : undefined,
          language: typeof language === 'string' ? language : undefined,
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
      const { getGenerationStage, getRepositoryRootFor } = await getWalkthroughService();
      const directory = typeof req.query.directory === 'string' ? req.query.directory : '';
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const { repoRoot, sourceKey } = await getRepositoryRootFor(directory, readSource(req.query.source));
      res.json({ stage: getGenerationStage(repoRoot, sourceKey) });
    } catch (error) {
      respondWithError(res, error, 'Failed to read walkthrough progress');
    }
  });

  app.post('/api/walkthrough/cancel', async (req, res) => {
    try {
      const { cancelWalkthroughGeneration } = await getWalkthroughService();
      const { directory, source } = req.body || {};
      if (!directory || typeof directory !== 'string') {
        return res.status(400).json({ error: 'directory is required' });
      }

      res.json(await cancelWalkthroughGeneration({ directory, source }));
    } catch (error) {
      respondWithError(res, error, 'Failed to cancel walkthrough generation');
    }
  });
}
