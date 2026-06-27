/**
 * Credential routes
 *
 * Express routes for managed credential CRUD and validation.
 *
 * CRITICAL: All GET responses return sanitized records (no `credential`
 * field). POST/PATCH accept `credential` in the body but never return
 * it in the response.
 *
 * Routes:
 *   POST   /api/quota/credentials              — create credential
 *   GET    /api/quota/credentials               — list all (sanitized)
 *   GET    /api/quota/credentials/:id           — get one (sanitized)
 *   PATCH  /api/quota/credentials/:id           — update credential
 *   DELETE /api/quota/credentials/:id           — delete credential
 *   POST   /api/quota/credentials/:id/validate  — validate credential
 *   GET    /api/quota/credentials/legacy/:providerId — discover legacy
 *
 * @module quota/credentials/routes
 */

import express from 'express';
import {
  listCredentials,
  getCredentialById,
  createCredential,
  updateCredentialById,
  deleteCredentialById,
  validateCredentialById,
  discoverCredentials,
} from './registry.js';

/**
 * Register credential management routes on an Express app.
 *
 * @param {import('express').Express} app
 */
export function registerCredentialRoutes(app) {
  const jsonParser = express.json({ limit: '64kb' });

  // POST /api/quota/credentials — create credential
  app.post('/api/quota/credentials', jsonParser, async (req, res) => {
    try {
      const { providerId, label, accountHint, credential } = req.body || {};

      const result = createCredential({ providerId, label, accountHint, credential });
      if (!result.valid) {
        return res.status(400).json({ error: result.error });
      }

      return res.status(201).json(result.record);
    } catch (error) {
      console.error('Failed to create credential:', error);
      return res.status(500).json({ error: 'Failed to create credential' });
    }
  });

  // GET /api/quota/credentials — list all (sanitized)
  app.get('/api/quota/credentials', (_req, res) => {
    try {
      const credentials = listCredentials();
      return res.json({ credentials });
    } catch (error) {
      console.error('Failed to list credentials:', error);
      return res.status(500).json({ error: 'Failed to list credentials' });
    }
  });

  // GET /api/quota/credentials/legacy/:providerId — discover legacy
  // Registered before /:id so the literal "legacy" segment doesn't match :id
  app.get('/api/quota/credentials/legacy/:providerId', async (req, res) => {
    try {
      const { providerId } = req.params;
      const result = await discoverCredentials(providerId);
      return res.json({ legacy: result });
    } catch (error) {
      console.error('Failed to discover legacy credentials:', error);
      return res.status(500).json({ error: 'Failed to discover legacy credentials' });
    }
  });

  // GET /api/quota/credentials/:id — get one (sanitized)
  app.get('/api/quota/credentials/:id', (req, res) => {
    try {
      const credential = getCredentialById(req.params.id);
      if (!credential) {
        return res.status(404).json({ error: 'Credential not found' });
      }
      return res.json(credential);
    } catch (error) {
      console.error('Failed to get credential:', error);
      return res.status(500).json({ error: 'Failed to get credential' });
    }
  });

  // PATCH /api/quota/credentials/:id — update credential
  app.patch('/api/quota/credentials/:id', (req, res) => {
    try {
      const result = updateCredentialById(req.params.id, req.body || {});
      if (!result.valid) {
        const status = result.error === 'Credential not found' ? 404 : 400;
        return res.status(status).json({ error: result.error });
      }
      return res.json(result.record);
    } catch (error) {
      console.error('Failed to update credential:', error);
      return res.status(500).json({ error: 'Failed to update credential' });
    }
  });

  // DELETE /api/quota/credentials/:id — delete credential
  app.delete('/api/quota/credentials/:id', (req, res) => {
    try {
      const removed = deleteCredentialById(req.params.id);
      if (!removed) {
        return res.status(404).json({ error: 'Credential not found' });
      }
      return res.status(204).send();
    } catch (error) {
      console.error('Failed to delete credential:', error);
      return res.status(500).json({ error: 'Failed to delete credential' });
    }
  });

  // POST /api/quota/credentials/:id/validate — validate stored credential
  app.post('/api/quota/credentials/:id/validate', (req, res) => {
    try {
      const result = validateCredentialById(req.params.id);
      if (result.status === null) {
        return res.status(404).json({ error: result.error });
      }
      return res.json({ valid: result.valid, error: result.error });
    } catch (error) {
      console.error('Failed to validate credential:', error);
      return res.status(500).json({ error: 'Failed to validate credential' });
    }
  });
}
