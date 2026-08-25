import { getProjectGitProviders, saveProjectGitProviders } from './project-config.js';

const asNonEmptyString = (value) => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const parseProjectId = (req) => asNonEmptyString(req?.params?.projectId);

const isPlainObject = (value) =>
  value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value);

export function registerGitProviderRoutes(app) {
  app.get('/api/projects/:projectId/git-providers', async (req, res) => {
    const projectId = parseProjectId(req);
    if (!projectId) {
      return res.status(400).json({ error: 'projectId is required' });
    }
    try {
      return res.json({ gitProviders: getProjectGitProviders(projectId) });
    } catch (error) {
      console.error('[GitProviders] failed to load project git providers:', error);
      return res.status(500).json({ error: 'Failed to load project git providers' });
    }
  });

  app.put('/api/projects/:projectId/git-providers', async (req, res) => {
    const projectId = parseProjectId(req);
    if (!projectId) {
      return res.status(400).json({ error: 'projectId is required' });
    }
    if (!isPlainObject(req.body) || !isPlainObject(req.body.gitProviders)) {
      return res.status(400).json({ error: 'gitProviders payload is required' });
    }
    try {
      const saved = await saveProjectGitProviders(projectId, req.body.gitProviders);
      return res.json({ gitProviders: saved });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to save project git providers';
      const statusCode = message.toLowerCase().includes('unsupported characters') ? 400 : 500;
      if (statusCode === 500) {
        console.error('[GitProviders] failed to save project git providers:', error);
      }
      return res.status(statusCode).json({ error: message });
    }
  });
}