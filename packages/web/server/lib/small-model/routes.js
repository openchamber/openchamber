export function registerSmallModelRoutes(app, { getSmallModelService }) {
  app.get('/api/small-model', async (req, res) => {
    try {
      const { describeSmallModel, listAuthenticatedProviders } = await getSmallModelService();
      const resolved = await describeSmallModel({
        directory: typeof req.query.directory === 'string' ? req.query.directory : undefined,
        preferredProviderID: typeof req.query.providerID === 'string' ? req.query.providerID : undefined,
        preferredModelID: typeof req.query.modelID === 'string' ? req.query.modelID : undefined,
      });
      res.json({
        available: Boolean(resolved),
        model: resolved,
        authenticatedProviders: await listAuthenticatedProviders(),
      });
    } catch (error) {
      console.error('Failed to resolve small model:', error);
      res.status(500).json({ error: error.message || 'Failed to resolve small model' });
    }
  });

  app.post('/api/small-model/generate', async (req, res) => {
    try {
      const { generateSmallModelText } = await getSmallModelService();
      const { prompt, system, maxOutputTokens, model, directory, sessionID, preferredProviderID, preferredModelID, restrictToPreferredProvider, onOverflow } = req.body || {};
      const result = await generateSmallModelText({
        prompt,
        system,
        maxOutputTokens,
        model,
        directory,
        sessionID,
        preferredProviderID,
        preferredModelID,
        restrictToPreferredProvider: restrictToPreferredProvider === true,
        // Callers may refuse truncation; anything unrecognized keeps the
        // historical clamp behavior.
        onOverflow: onOverflow === 'error' || onOverflow === 'truncate' ? onOverflow : 'truncate',
      });
      res.json(result);
    } catch (error) {
      const statusCode = Number(error?.statusCode) || 500;
      if (statusCode >= 500) {
        console.error('Small model generation failed:', error);
      }
      // 404 (no small model) and 413 (context-too-small) carry actionable
      // backend messages — required/available characters on 413. Everything
      // else is replaced by the generic guidance copy.
      const messagePassesThrough = statusCode === 404 || statusCode === 413;
      res.status(statusCode).json({
        error: messagePassesThrough
          ? (error.message || 'No small model is available')
          : 'The selected Small Model could not complete this action. Choose another model in Settings → Sessions → Small Model and try again.',
        ...(error?.code ? { code: error.code } : {}),
      });
    }
  });
}
