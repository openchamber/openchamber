export const registerBrowserRuntimeStatusRoute = (app, { lifecycle, uiAuthController }) => {
  app.get('/api/browser/runtime-status', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      // Password-free cookies do not authenticate access to Chrome connection details.
      const authRequest = uiAuthController.enabled
        ? req
        : { ...req, headers: { ...req.headers, cookie: '' } };
      const context = await uiAuthController.resolveAuthContext(authRequest, res, { allowUrlToken: false });
      const authenticated = context?.type === 'client' || (uiAuthController.enabled && context?.type === 'session');
      if (!authenticated) return res.status(401).json({ error: 'Browser runtime authentication required' });
      return res.json(await lifecycle.getRuntimeStatus());
    } catch {
      return res.status(503).json({ error: 'Browser runtime status is unavailable' });
    }
  });
};
