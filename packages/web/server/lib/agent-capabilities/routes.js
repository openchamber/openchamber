import express from 'express';
import { OpenChamberControlError, asControlError } from '../openchamber-control/error.js';
import { listFusionPresets } from './fusion-presets.js';
import { FUSION_PRESET_NAME_PATTERN, sanitizeFusionPresets } from '../opencode/settings-helpers.js';

const sendServiceError = (res, error, fallback) => {
  const controlError = asControlError(error, fallback);
  return res.status(controlError.statusCode).json({ error: controlError.message });
};

const requestBody = (req) => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});

// Preset mutations are read-modify-write over the settings file.
// persistSettings serializes its own writes, but the read half happens
// outside that lock, so two concurrent saves could lose one preset. Chain the
// whole mutation here instead.
let presetWriteLock = Promise.resolve();
const withPresetWriteLock = (task) => {
  const run = presetWriteLock.then(task, task);
  presetWriteLock = run.catch(() => undefined);
  return run;
};

export const registerAgentCapabilityRoutes = (app, dependencies) => {
  const { readSettingsFromDiskMigrated, persistSettings } = dependencies;

  app.get('/api/openchamber/fusion/presets', async (req, res) => {
    try {
      const settings = await readSettingsFromDiskMigrated();
      return res.json({ presets: listFusionPresets(settings) });
    } catch (error) {
      return sendServiceError(res, error, 'Failed to list fusion presets');
    }
  });

  app.post('/api/openchamber/fusion/presets/:name', express.json({ limit: '1mb' }), async (req, res) => {
    try {
      const body = requestBody(req);
      const name = typeof req.params.name === 'string' ? req.params.name.trim() : '';
      if (!name || !FUSION_PRESET_NAME_PATTERN.test(name)) {
        throw new OpenChamberControlError(
          'Preset name must start with a letter or digit and use only letters, digits, dot, dash, or underscore (1-64 chars)',
          400,
        );
      }
      const saved = await withPresetWriteLock(async () => {
        const settings = await readSettingsFromDiskMigrated();
        const existing = listFusionPresets(settings);
        const next = [
          ...existing.filter((entry) => entry.name !== name),
          { name, ...(typeof body.description === 'string' ? { description: body.description } : {}), models: Array.isArray(body.models) ? body.models : [] },
        ];
        // Validate BEFORE persisting: persistSettings sanitizes, so an invalid
        // preset must never replace (or erase) an existing one on disk. The
        // sanitizer is the single source of truth for what survives the write,
        // so validation and persistence can never disagree.
        const sanitized = sanitizeFusionPresets(next);
        const preset = sanitized.find((entry) => entry.name === name);
        if (!preset) {
          throw new OpenChamberControlError('Preset needs a valid name and 2-4 provider/model models', 400);
        }
        await persistSettings({ fusionPresets: sanitized });
        return preset;
      });
      return res.json({ preset: saved });
    } catch (error) {
      return sendServiceError(res, error, 'Failed to save fusion preset');
    }
  });

  app.delete('/api/openchamber/fusion/presets/:name', async (req, res) => {
    try {
      const name = typeof req.params.name === 'string' ? req.params.name : '';
      const removed = await withPresetWriteLock(async () => {
        const settings = await readSettingsFromDiskMigrated();
        const existing = listFusionPresets(settings);
        const next = existing.filter((entry) => entry.name !== name);
        await persistSettings({ fusionPresets: next });
        return existing.length !== next.length;
      });
      return res.json({ removed });
    } catch (error) {
      return sendServiceError(res, error, 'Failed to remove fusion preset');
    }
  });
};
