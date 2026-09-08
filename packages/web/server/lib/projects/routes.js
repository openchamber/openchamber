/**
 * Project setup routes: the client-owned part of a project's config file
 * (worktree setup commands, project actions, draft starters).
 *
 * These replace the shared UI's direct `/api/fs/*` access to
 * `~/.config/openchamber/projects/<projectId>.json`. The client no longer
 * resolves the home directory or composes the path, and every write goes
 * through the same lock the scheduled-task writers hold.
 *
 * `/api/projects` is on the JSON-body allowlist in `core-routes.js`, so
 * `req.body` is parsed here without a per-route parser.
 */

import { isProjectSetupValidationError } from './project-setup.js';

const isObjectRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const respondWithError = (res, error, fallbackMessage) => {
  const message = error instanceof Error ? error.message : fallbackMessage;
  if (isProjectSetupValidationError(error)) {
    return res.status(400).json({ error: message });
  }
  return res.status(500).json({ error: message || fallbackMessage });
};

export const registerProjectSetupRoutes = (app, dependencies) => {
  const { projectConfigRuntime } = dependencies;

  app.get('/api/projects/:projectId/config', async (req, res) => {
    try {
      return res.json(await projectConfigRuntime.readProjectSetup(req.params.projectId));
    } catch (error) {
      return respondWithError(res, error, 'Failed to read project config');
    }
  });

  // The team's shared file in the checkout; see `updateSharedProjectSetup`.
  app.put('/api/projects/:projectId/config/shared', async (req, res) => {
    if (!isObjectRecord(req.body)) {
      return res.status(400).json({ error: 'Body must be an object' });
    }
    try {
      return res.json(await projectConfigRuntime.updateSharedProjectSetup(req.params.projectId, req.body));
    } catch (error) {
      return respondWithError(res, error, 'Failed to save the shared project config');
    }
  });

  app.put('/api/projects/:projectId/config', async (req, res) => {
    if (!isObjectRecord(req.body)) {
      return res.status(400).json({ error: 'Body must be an object' });
    }
    try {
      return res.json(await projectConfigRuntime.updateProjectSetup(req.params.projectId, req.body));
    } catch (error) {
      return respondWithError(res, error, 'Failed to save project config');
    }
  });
};
