import { createMagicPromptRuntime } from './runtime.js';

export const registerMagicPromptRoutes = (app, dependencies) => {
  const {
    fsPromises,
    path,
    openchamberDataDir,
  } = dependencies;

  const runtime = createMagicPromptRuntime({
    fsPromises,
    path,
    filePath: path.join(openchamberDataDir, 'magic-prompts.json'),
  });

  app.get('/api/magic-prompts', async (_req, res) => {
    try {
      const state = await runtime.readPromptState();
      res.json(state);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to read magic prompts' });
    }
  });

  app.put('/api/magic-prompts/:id', async (req, res) => {
    const id = typeof req.params?.id === 'string' ? req.params.id : '';
    const text = typeof req.body?.text === 'string' ? req.body.text : null;
    if (text === null) {
      return res.status(400).json({ error: 'text is required' });
    }

    try {
      const state = await runtime.setOverride(id, text);
      return res.json(state);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message.includes('Invalid prompt id') || message.includes('too long') || message.includes('cannot be empty') ? 400 : 500;
      return res.status(status).json({ error: message });
    }
  });

  app.delete('/api/magic-prompts/:id', async (req, res) => {
    const id = typeof req.params?.id === 'string' ? req.params.id : '';
    try {
      const state = await runtime.resetOverride(id);
      return res.json(state);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message.includes('Invalid prompt id') ? 400 : 500;
      return res.status(status).json({ error: message });
    }
  });

  app.delete('/api/magic-prompts', async (_req, res) => {
    try {
      const state = await runtime.resetAllOverrides();
      return res.json(state);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(500).json({ error: message || 'Failed to reset magic prompts' });
    }
  });
};
