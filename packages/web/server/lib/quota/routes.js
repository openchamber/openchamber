import express from 'express';
import { deleteManagedCredential, getManagedCredentialStatus, normalizers, readManagedCredential, writeManagedCredential } from './credentials/providers.js';
import { fetchOpenCodeGoUsage } from './providers/opencode-go.js';
import { fetchOllamaCloudUsage } from './providers/ollama-cloud.js';
import { importCursorCredential, validateCursorCredential } from './providers/cursor.js';

const validators = {
  'opencode-go': fetchOpenCodeGoUsage,
  'ollama-cloud': fetchOllamaCloudUsage,
  cursor: validateCursorCredential,
};

const getProvider = (req, res) => {
  const providerId = req.params.providerId;
  if (!normalizers[providerId]) {
    res.status(404).json({ code: 'UNSUPPORTED_PROVIDER', error: 'Unsupported credential provider' });
    return null;
  }
  return providerId;
};

const credentialError = (res, error) => res.status(400).json({
  code: 'INVALID_CREDENTIAL',
  error: error instanceof Error ? error.message : 'Credential validation failed',
});

export function registerQuotaRoutes(app, { getQuotaProviders }) {
  app.get('/api/quota/providers', async (_req, res) => {
    try {
      const { listConfiguredQuotaProviders } = await getQuotaProviders();
      res.json({ providers: listConfiguredQuotaProviders() });
    } catch (error) {
      console.error('Failed to list quota providers:', error);
      res.status(500).json({ error: error.message || 'Failed to list quota providers' });
    }
  });

  app.get('/api/quota/credentials/:providerId', (req, res) => {
    const providerId = getProvider(req, res);
    if (providerId) res.json(getManagedCredentialStatus(providerId));
  });

  app.put('/api/quota/credentials/:providerId', express.json({ limit: '16kb' }), async (req, res) => {
    const providerId = getProvider(req, res);
    if (!providerId) return;
    const credential = normalizers[providerId](req.body);
    if (!credential) return credentialError(res, new Error('Invalid credential'));
    try {
      await validators[providerId](credential);
      res.json(writeManagedCredential(providerId, credential));
    } catch (error) {
      credentialError(res, error);
    }
  });

  app.post('/api/quota/credentials/:providerId/validate', async (req, res) => {
    const providerId = getProvider(req, res);
    if (!providerId) return;
    const credential = readManagedCredential(providerId);
    if (!credential) return res.status(404).json({ code: 'NOT_CONFIGURED', error: 'Not configured' });
    try {
      await validators[providerId](credential);
      res.json({ valid: true });
    } catch (error) {
      credentialError(res, error);
    }
  });

  app.post('/api/quota/credentials/:providerId/import', async (req, res) => {
    const providerId = getProvider(req, res);
    if (!providerId) return;
    if (providerId !== 'cursor') return res.status(404).json({ code: 'IMPORT_UNAVAILABLE', error: 'Import unavailable' });
    try {
      res.json(await importCursorCredential());
    } catch (error) {
      credentialError(res, error);
    }
  });

  app.delete('/api/quota/credentials/:providerId', (req, res) => {
    const providerId = getProvider(req, res);
    if (!providerId) return;
    deleteManagedCredential(providerId);
    res.json({ configured: false });
  });

  app.get('/api/quota/:providerId', async (req, res) => {
    try {
      const { providerId } = req.params;
      if (!providerId) return res.status(400).json({ error: 'Provider ID is required' });
      const { fetchQuotaForProvider } = await getQuotaProviders();
      res.json(await fetchQuotaForProvider(providerId));
    } catch (error) {
      console.error('Failed to fetch quota:', error);
      res.status(500).json({ error: error.message || 'Failed to fetch quota' });
    }
  });
}
