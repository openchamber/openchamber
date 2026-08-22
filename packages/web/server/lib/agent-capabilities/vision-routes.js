import express from 'express';
import { DEFAULT_VISION_PROMPT, sanitizeVisionConfig } from '../opencode/settings-helpers.js';

// Vision settings routes: the vision tool's model + prompt config lives in the
// persisted `vision` settings field. GET returns the current config (or null)
// plus the default prompt the server falls back to; PUT replaces the config
// only after validation, so an invalid save can never erase a working one.
// Vision settings PUTs are read-modify-write over the settings file.
// persistSettings serializes its own writes, but the read half happens
// outside that lock, so two concurrent partial saves could both read the
// same base and one would silently drop the other's field. Chain the whole
// merge here instead (mirrors the fusion preset routes' write lock).
let visionWriteLock = Promise.resolve();
const withVisionWriteLock = (task) => {
  const run = visionWriteLock.then(task, task);
  visionWriteLock = run.catch(() => undefined);
  return run;
};

export const registerVisionRoutes = (app, { readSettingsFromDiskMigrated, persistSettings }) => {
  app.get('/api/openchamber/vision', async (req, res) => {
    try {
      const settings = await readSettingsFromDiskMigrated();
      return res.json({
        config: sanitizeVisionConfig(settings?.vision) || null,
        defaultPrompt: DEFAULT_VISION_PROMPT,
      });
    } catch (error) {
      return res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to read vision settings' });
    }
  });

  app.put('/api/openchamber/vision', express.json({ limit: '100kb' }), async (req, res) => {
    const incoming = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const model = typeof incoming.model === 'string' ? incoming.model.trim() : '';
    const prompt = typeof incoming.prompt === 'string' ? incoming.prompt.trim() : undefined;
    if (!model && prompt === undefined) {
      return res.status(400).json({ error: 'Provide a vision model in provider/model format' });
    }
    try {
      const saved = await withVisionWriteLock(async () => {
        // Merge, don't replace: an overlapping PUT from a stale editor must not
        // silently drop the field the other editor just saved. The persisted
        // config is the authority for fields the incoming request omits, and
        // the read+merge+write all run under one lock so two concurrent saves
        // cannot lose each other's fields.
        const settings = await readSettingsFromDiskMigrated();
        const existing = sanitizeVisionConfig(settings?.vision) || {};
        const merged = {
          model: model || existing.model,
          ...(prompt !== undefined ? { prompt } : existing.prompt ? { prompt: existing.prompt } : {}),
        };
        const sanitized = sanitizeVisionConfig(merged);
        if (!sanitized) {
          throw new Error('vision.model is required and must be in provider/model format');
        }
        const updated = await persistSettings({ vision: sanitized });
        return sanitizeVisionConfig(updated?.vision) || sanitized;
      });
      return res.json({ config: saved });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to save vision settings';
      const status = /provider\/model format/.test(message) ? 400 : 500;
      return res.status(status).json({ error: message });
    }
  });
};
