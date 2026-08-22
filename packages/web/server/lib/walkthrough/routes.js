// `req.destroyed` is true for every healthy request once the body parser has
// consumed the stream, so using it as a disconnect check silently swallows every
// response. The response socket is the one that actually reflects whether the
// client is still there.
const clientIsGone = (res) => res.writableEnded || res.destroyed;

export function registerWalkthroughRoutes(app, { getWalkthroughService, buildOpenCodeUrl, getOpenCodeAuthHeaders }) {
  const serviceDeps = (getPullRequestDiff) => {
    const deps = { getPullRequestDiff };
    if (buildOpenCodeUrl instanceof Function) deps.openCodeBaseUrl = buildOpenCodeUrl('/', '').replace(/\/$/, '');
    if (getOpenCodeAuthHeaders instanceof Function) deps.openCodeAuthHeaders = getOpenCodeAuthHeaders();
    return deps;
  };
  const respondWithError = (res, error, fallback) => {
    const statusCode = Number(error?.statusCode) || 500;
    if (statusCode >= 500) {
      console.error(`${fallback}:`, error);
    }
    const payload = { error: error?.message || fallback };
    if (error?.code) payload.code = error.code;
    if (error?.model) payload.model = error.model;
    if (Number.isFinite(error?.requiredChars)) payload.requiredChars = error.requiredChars;
    if (Number.isFinite(error?.availableChars)) payload.availableChars = error.availableChars;
    res.status(statusCode).json(payload);
  };

  const readSource = (value) => {
    if (value?.constructor !== String || !value) return null;
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  };

  app.get('/api/walkthrough', async (req, res) => {
    try {
      const { getWalkthrough, getPullRequestDiff } = await getWalkthroughService();
      const directory = req.query.directory?.constructor === String ? req.query.directory : '';
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const result = await getWalkthrough(
        {
          directory,
          source: readSource(req.query.source),
          model: req.query.model?.constructor === String ? req.query.model : undefined,
          language: req.query.language?.constructor === String ? req.query.language : undefined,
        },
        serviceDeps(getPullRequestDiff),
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
      if (!directory || directory.constructor !== String) {
        return res.status(400).json({ error: 'directory is required' });
      }

      const result = await generateWalkthrough(
        {
          directory,
          source,
          force: force === true,
          model: model?.constructor === String ? model : undefined,
          language: language?.constructor === String ? language : undefined,
        },
        serviceDeps(getPullRequestDiff),
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
      const directory = req.query.directory?.constructor === String ? req.query.directory : '';
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
      if (!directory || directory.constructor !== String) {
        return res.status(400).json({ error: 'directory is required' });
      }

      res.json(await cancelWalkthroughGeneration({ directory, source }));
    } catch (error) {
      respondWithError(res, error, 'Failed to cancel walkthrough generation');
    }
  });
}
