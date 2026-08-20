import express from 'express';
import { DEFAULT_VISION_PROMPT, sanitizeVisionConfig } from '../opencode/settings-helpers.js';

// Vision settings routes: the vision tool's model + prompt config lives in the
// persisted `vision` settings field. GET returns the current config (or null)
// plus the default prompt the server falls back to; PUT replaces the config
// only after validation, so an invalid save can never erase a working one.
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
    const sanitized = sanitizeVisionConfig(req.body);
    if (!sanitized) {
      return res.status(400).json({ error: 'vision.model is required and must be in provider/model format' });
    }
    try {
      const settings = await persistSettings({ vision: sanitized });
      return res.json({ config: sanitizeVisionConfig(settings?.vision) || sanitized });
    } catch (error) {
      return res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to save vision settings' });
    }
  });
};
