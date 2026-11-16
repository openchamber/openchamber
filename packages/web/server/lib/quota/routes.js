import express from 'express';
import { deleteManagedCredential, getManagedCredentialStatus, normalizers, readManagedCredential, writeManagedCredential } from './credentials/providers.js';
import { importCursorCredential, validateCursorCredential } from './providers/cursor.js';
import { fetchExeDevUsage } from './providers/exe-dev.js';
import { validateOpenDesignCredential } from './providers/opendesign.js';
import { aliases as zaiAliases, giftResetTypes as zaiGiftResetTypes, useZaiGiftReset } from './providers/zai.js';
import { fetchQuota as fetchZenmuxQuota } from './providers/zenmux.js';
import {
  listConfiguredQuotaProviders,
  fetchQuotaForProvider,
  fetchQuotaForProviderInstances,
} from './index.js';

// The endpoint resolves its providers from the quota module itself —
// the same module the CLI reads through (code#2490, #2282) — rather
// than through an injected resolver. registerQuotaRoutes still
// accepts a getQuotaProviders override, but only as a thin
// pass-through for tests that stub the provider set.
const defaultQuotaProviders = {
  listConfiguredQuotaProviders,
  fetchQuotaForProvider,
  fetchQuotaForProviderInstances,
};

const resolveQuotaProviders = async (getQuotaProviders) => {
  if (typeof getQuotaProviders === 'function') {
    return getQuotaProviders();
  }
  return defaultQuotaProviders;
};

// Keyed by the same provider ids as `normalizers`: a provider with a normalizer
// but no validator would be stored without ever being checked.
const validators = {
  'exe-dev': fetchExeDevUsage,
  cursor: validateCursorCredential,
  zenmux: async (credential) => {
    const result = await fetchZenmuxQuota({ readCredential: () => credential });
    if (!result.ok) throw new Error(result.error ?? 'Credential validation failed');
  },
  opendesign: validateOpenDesignCredential,
};

const getProvider = (req, res) => {
  const providerId = req.params.providerId;
  if (!Object.hasOwn(normalizers, providerId)) {
    res.status(404).json({ code: 'UNSUPPORTED_PROVIDER', error: 'Unsupported credential provider' });
    return null;
  }
  return providerId;
};

const credentialError = (res, error) => res.status(400).json({
  code: 'INVALID_CREDENTIAL',
  error: error instanceof Error ? error.message : 'Credential validation failed',
});

export function registerQuotaRoutes(app, { getQuotaProviders } = {}) {
  app.get('/api/quota/providers', async (_req, res) => {
    try {
      const { listConfiguredQuotaProviders } = await resolveQuotaProviders(getQuotaProviders);
      res.json({ providers: await listConfiguredQuotaProviders() });
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
      const { fetchQuotaForProvider, fetchQuotaForProviderInstances } = await resolveQuotaProviders(getQuotaProviders);
      // Per-credential providers answer one labeled result per stored
      // credential (#474); the web route must carry all of them, not just the
      // active credential (#481). A single result keeps the long-standing
      // object shape so existing consumers see no change.
      if (fetchQuotaForProviderInstances) {
        const results = await fetchQuotaForProviderInstances(providerId);
        return res.json(results.length === 1 ? results[0] : results);
      }
      res.json(await fetchQuotaForProvider(providerId));
    } catch (error) {
      console.error('Failed to fetch quota:', error);
      res.status(500).json({ error: error.message || 'Failed to fetch quota' });
    }
  });

  app.post('/api/quota/:providerId/gift-reset/use', express.json({ limit: '16kb' }), async (req, res) => {
    try {
      const providerId = req.params.providerId;
      if (!zaiAliases.includes(providerId)) {
        return res.status(404).json({ code: 'UNSUPPORTED_PROVIDER', error: 'Unsupported quota provider' });
      }
      const { recordId, resetType } = req.body ?? {};
      if (!Number.isFinite(recordId) || !zaiGiftResetTypes.includes(resetType)) {
        return res.status(400).json({ code: 'INVALID_REQUEST', error: 'Invalid gift reset request' });
      }
      await useZaiGiftReset({ recordId, resetType });
      res.json({ success: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (message === 'Not configured') {
        return res.status(400).json({ code: 'NOT_CONFIGURED', error: 'Not configured' });
      }
      console.error('Failed to activate gift reset:', error);
      res.status(502).json({ error: message || 'Failed to activate gift reset' });
    }
  });
}
