import { parseSource } from './sources.js';
import { canRespondToRequest, createRequestAbortSignal } from '../request-abort.js';

export function registerWalkthroughRoutes(app, { getWalkthroughService }) {
  const respondWithError = (res, error, fallback, requestAbort) => {
    if (!canRespondToRequest(res, requestAbort)) return;
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
    const requestAbort = createRequestAbortSignal(req, res);
    try {
      if (!canRespondToRequest(res, requestAbort)) return;
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
        { getPullRequestDiff, signal: requestAbort.signal },
      );
      if (!canRespondToRequest(res, requestAbort)) return;
      res.json(result);
    } catch (error) {
      respondWithError(res, error, 'Failed to load walkthrough', requestAbort);
    } finally {
      requestAbort.cleanup();
    }
  });

  // The comparison view needs the complete published patch, without model
  // readiness checks, generated-file filtering, or local working-tree reads.
  app.get('/api/walkthrough/pr-diff', async (req, res) => {
    const requestAbort = createRequestAbortSignal(req, res);
    try {
      if (!canRespondToRequest(res, requestAbort)) return;
      const query = new URL(req.originalUrl, 'http://localhost').searchParams;
      const directory = query.get('directory')?.trim() ?? '';
      if (!directory) return res.status(400).json({ error: 'directory parameter is required' });
      const source = parseSource(readSource(query.get('source')));
      if (source.kind !== 'pr') return res.status(400).json({ error: 'A pull request source is required' });
      const { getPullRequestDiff } = await getWalkthroughService();
      const { patch } = await getPullRequestDiff(directory, source.number, source.sourceRepo, {
        allowEmpty: true,
        signal: requestAbort.signal,
      });
      if (!canRespondToRequest(res, requestAbort)) return;
      res.type('text/plain').send(patch);
    } catch (error) {
      respondWithError(res, error, 'Failed to load pull request diff', requestAbort);
    } finally {
      requestAbort.cleanup();
    }
  });

  // One file, both sides, straight from GitHub: the comparison view expands
  // collapsed context on demand without touching the working tree.
  app.get('/api/walkthrough/pr-file', async (req, res) => {
    const requestAbort = createRequestAbortSignal(req, res);
    try {
      if (!canRespondToRequest(res, requestAbort)) return;
      const query = new URL(req.originalUrl, 'http://localhost').searchParams;
      const directory = query.get('directory')?.trim() ?? '';
      if (!directory) return res.status(400).json({ error: 'directory parameter is required' });
      const source = parseSource(readSource(query.get('source')));
      if (source.kind !== 'pr') return res.status(400).json({ error: 'A pull request source is required' });
      const path = query.get('path')?.trim() ?? '';
      if (!path) return res.status(400).json({ error: 'path parameter is required' });
      const previousPath = query.get('previousPath')?.trim() || undefined;
      const status = query.get('status') ?? 'M';
      const { getPullRequestFileContents } = await getWalkthroughService();
      const result = await getPullRequestFileContents(directory, source.number, source.sourceRepo, {
        path,
        previousPath,
        status,
        signal: requestAbort.signal,
      });
      if (!canRespondToRequest(res, requestAbort)) return;
      res.json(result);
    } catch (error) {
      respondWithError(res, error, 'Failed to load pull request file', requestAbort);
    } finally {
      requestAbort.cleanup();
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
      if (!canRespondToRequest(res)) return;
      res.json(result);
    } catch (error) {
      if (!canRespondToRequest(res)) return;
      respondWithError(res, error, 'Failed to generate walkthrough');
    }
  });

  // Memory-only, so it is safe to poll while a generation runs. The full read
  // re-runs the whole git pipeline and must not be used for this.
  app.get('/api/walkthrough/progress', async (req, res) => {
    const requestAbort = createRequestAbortSignal(req, res);
    try {
      if (!canRespondToRequest(res, requestAbort)) return;
      const { getGenerationStage, getRepositoryRootFor } = await getWalkthroughService();
      const directory = typeof req.query.directory === 'string' ? req.query.directory : '';
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const { repoRoot, sourceKey } = await getRepositoryRootFor(
        directory,
        readSource(req.query.source),
        { signal: requestAbort.signal },
      );
      if (!canRespondToRequest(res, requestAbort)) return;
      res.json({ stage: getGenerationStage(repoRoot, sourceKey) });
    } catch (error) {
      respondWithError(res, error, 'Failed to read walkthrough progress', requestAbort);
    } finally {
      requestAbort.cleanup();
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
