export function registerQuotaRoutes(app, { getQuotaProviders }) {
  app.get('/api/quota/providers', async (_req, res) => {
    try {
      const { listConfiguredQuotaProviders } = await getQuotaProviders();
      const providers = listConfiguredQuotaProviders();
      res.json({ providers });
    } catch (error) {
      console.error('Failed to list quota providers:', error);
      res.status(500).json({ error: error.message || 'Failed to list quota providers' });
    }
  });

  app.get('/api/quota/:providerId', async (req, res) => {
    try {
      const { providerId } = req.params;
      if (!providerId) {
        return res.status(400).json({ error: 'Provider ID is required' });
      }
      const { fetchQuotaForProvider } = await getQuotaProviders();
      const result = await fetchQuotaForProvider(providerId);
      res.json(result);
    } catch (error) {
      console.error('Failed to fetch quota:', error);
      res.status(500).json({ error: error.message || 'Failed to fetch quota' });
    }
  });
}
