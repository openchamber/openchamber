import { isRecord as isObjectRecord } from '../shared/guards.js';
import path from 'node:path';
import { z } from 'zod';
import { createProjectIdFromPath } from './project-id.js';
import { actionPlatformOf, isProjectSetupValidationError } from './project-setup.js';
import type { Application, Response } from '../shared/http-contracts.js';
import type { DirectoryValidation, SessionProject } from './contracts.js';
import type { SettingsDocument } from '../settings/settings-helpers.js';
import type { createProjectConfigRuntime } from './project-config.js';

export interface ProjectDirectoryDependencies {
  fsPromises: Pick<typeof import('node:fs/promises'), 'mkdir'>;
  validateDirectoryPath: (directory: string) => Promise<DirectoryValidation>;
  readSettingsFromDisk: () => Promise<SettingsDocument>;
  sanitizeProjects: (projects: SettingsDocument[string]) => SessionProject[] | null | undefined;
  persistSettings: (settings: { projects: SessionProject[]; activeProjectId: string; lastDirectory: string }) => Promise<SettingsDocument>;
}

export interface ProjectSetupDependencies {
  projectConfigRuntime: Pick<ReturnType<typeof createProjectConfigRuntime>, 'readProjectSetup' | 'updateSharedProjectSetup' | 'updateProjectSetup'>;
}

const hasReadableMessage = (value: unknown): value is { message?: unknown } => value !== null && value !== undefined;

const directoryRequestSchema = z.object({
  path: z.string().trim().catch(''),
  create: z.literal(true).catch(false),
}).catch({ path: '', create: false });

const respondWithError = (res: Response, cause: unknown, fallbackMessage: string) => {
  const message = cause instanceof Error ? cause.message : fallbackMessage;
  if (isProjectSetupValidationError(cause)) {
    return res.status(400).json({ error: message });
  }
  return res.status(500).json({ error: message || fallbackMessage });
};

export const registerProjectDirectoryRoutes = (app: Application, dependencies: ProjectDirectoryDependencies) => {
  const { fsPromises, validateDirectoryPath, readSettingsFromDisk, sanitizeProjects, persistSettings } = dependencies;

  app.post('/api/openchamber/directory', async (req, res) => {
    try {
      const { path: requestedPath, create } = directoryRequestSchema.parse(req.body);
      if (!requestedPath) {
        return res.status(400).json({ error: 'Path is required' });
      }

      if (create) {
        await fsPromises.mkdir(path.resolve(requestedPath), { recursive: true });
      }

      const validated = await validateDirectoryPath(requestedPath);
      if (!validated.ok) {
        return res.status(400).json({ error: validated.error });
      }

      const resolvedPath = validated.directory;
      const currentSettings = await readSettingsFromDisk();
      const existingProjects = sanitizeProjects(currentSettings.projects) || [];
      const existing = existingProjects.find((project) => project.path === resolvedPath) || null;

      const nextProjects = existing
        ? existingProjects
        : [
            ...existingProjects,
            {
              id: createProjectIdFromPath(resolvedPath),
              path: resolvedPath,
              addedAt: Date.now(),
              lastOpenedAt: Date.now(),
            },
          ];

      const activeProjectId = existing ? existing.id : createProjectIdFromPath(resolvedPath);

      const updated = await persistSettings({
        projects: nextProjects,
        activeProjectId,
        lastDirectory: resolvedPath,
      });

      return res.json({
        success: true,
        restarted: false,
        path: resolvedPath,
        settings: updated,
      });
    } catch (error) {
      console.error('Failed to update project directory:', error);
      if (!hasReadableMessage(error)) throw new TypeError(`Cannot read properties of ${error} (reading 'message')`);
      return res.status(500).json({ error: error.message || 'Failed to update working directory' });
    }
  });
};

export const registerProjectSetupRoutes = (app: Application, dependencies: ProjectSetupDependencies) => {
  const { projectConfigRuntime } = dependencies;

  app.get('/api/projects/:projectId/config', async (req, res) => {
    try {
      return res.json({ ...await projectConfigRuntime.readProjectSetup(req.params.projectId), platform: actionPlatformOf(process.platform) ?? null });
    } catch (error) {
      return respondWithError(res, error, 'Failed to read project config');
    }
  });

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
