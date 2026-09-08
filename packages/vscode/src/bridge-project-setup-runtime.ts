// Extension-host side of the project setup routes
// (`GET/PUT /api/projects/:projectId/config`): the webview cannot reach the
// filesystem, so it bridges here and this module reads and writes
// `~/.config/openchamber/projects/<projectId>.json` with the same rules the
// OpenChamber server applies (`project-setup.ts`). Server-owned keys in the
// file (`version`, `scheduledTasks`) and keys from newer builds survive a
// write untouched.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  EMPTY_SHARED_PROJECT_CONFIG,
  ProjectSetupValidationError,
  SHARED_CONFIG_RELATIVE_PATH,
  applySharedProjectSetupPatch,
  isSharedProjectConfigEmpty,
  mergeProjectSetup,
  parseSharedProjectConfig,
  personalProjectSetupOf,
  projectSetupPatchToStored,
  serializeSharedProjectConfig,
  sharedTrustHashOf,
  type ProjectSetupView,
  type SharedProjectConfigRead,
} from './project-setup';

export type ProjectSetupBridgeMessage = { id: string; type: string; payload?: unknown };
export type ProjectSetupBridgeResponse = { id: string; type: string; success: boolean; data?: unknown; error?: string };

export type ProjectSetupStore = {
  read: (projectId: string) => Promise<ProjectSetupView>;
  update: (projectId: string, patch: unknown) => Promise<ProjectSetupView>;
  updateShared: (projectId: string, patch: unknown) => Promise<ProjectSetupView>;
};

const PROJECT_ID_PATTERN = /^[a-zA-Z0-9._:-]+$/;

/** The checkout a `path_<base64url>` id names, or `''` for ids of another form. */
export const projectPathFromId = (projectId: string): string => {
  if (!projectId.startsWith('path_')) return '';
  const encoded = projectId.slice('path_'.length);
  if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) return '';
  return Buffer.from(encoded, 'base64url').toString('utf8');
};

const isObjectRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const sanitizeProjectId = (value: unknown): string => {
  const projectId = typeof value === 'string' ? value.trim() : '';
  if (!projectId) throw new ProjectSetupValidationError('projectId is required');
  if (!PROJECT_ID_PATTERN.test(projectId)) throw new ProjectSetupValidationError('projectId contains unsupported characters');
  return projectId;
};

const readJsonDocument = async (filePath: string): Promise<Record<string, unknown>> => {
  let raw: string;
  try {
    raw = await fs.promises.readFile(filePath, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return {};
    throw error;
  }
  const parsed: unknown = JSON.parse(raw);
  return isObjectRecord(parsed) ? parsed : {};
};

const writeJsonAtomic = async (filePath: string, text: string): Promise<void> => {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    await fs.promises.writeFile(tmp, text, 'utf8');
    await fs.promises.rename(tmp, filePath);
  } catch (error) {
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
};

/** A store over one projects directory; the default is the shared OpenChamber one. */
export const createProjectSetupStore = (
  projectsDir: string = path.join(os.homedir(), '.config', 'openchamber', 'projects'),
): ProjectSetupStore => {
  const filePathFor = (projectId: string): string => path.join(projectsDir, `${sanitizeProjectId(projectId)}.json`);
  // Writes to one file are chained so two quick saves from the webview cannot
  // interleave their read-modify-write.
  const writeChains = new Map<string, Promise<unknown>>();

  // The shared file lives in the checkout the id names (the personal file's
  // `projectPath` is the fallback). A missing file is the normal case; an
  // unreadable or unparsable one is reported, never treated as empty.
  const projectPathOf = (projectId: string, personalRaw: Record<string, unknown>): string => {
    const storedPath = personalRaw.projectPath;
    return projectPathFromId(projectId) || (typeof storedPath === 'string' ? storedPath.trim() : '');
  };
  const sharedConfigPathOf = (projectPath: string): string => path.join(projectPath, ...SHARED_CONFIG_RELATIVE_PATH.split('/'));

  const readShared = async (projectId: string, personalRaw: Record<string, unknown>): Promise<SharedProjectConfigRead> => {
    const projectPath = projectPathOf(projectId, personalRaw);
    if (!projectPath) return { status: 'missing' };
    let raw: string;
    try {
      raw = await fs.promises.readFile(sharedConfigPathOf(projectPath), 'utf8');
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { status: 'missing' };
      return { status: 'invalid', reason: error instanceof Error ? error.message : String(error) };
    }
    return parseSharedProjectConfig(raw);
  };

  const mergedViewOf = async (projectId: string, personalRaw: Record<string, unknown>): Promise<ProjectSetupView> =>
    mergeProjectSetup(personalProjectSetupOf(personalRaw), await readShared(projectId, personalRaw));

  const read = async (projectId: string): Promise<ProjectSetupView> => mergedViewOf(projectId, await readJsonDocument(filePathFor(projectId)));

  const update = async (projectId: string, patch: unknown): Promise<ProjectSetupView> => {
    const filePath = filePathFor(projectId);
    const stored = projectSetupPatchToStored(patch);
    const previous = writeChains.get(filePath) ?? Promise.resolve();
    const next = previous.then(async () => {
      const existing = await readJsonDocument(filePath);
      const merged: Record<string, unknown> = { ...existing, ...stored };
      for (const [key, value] of Object.entries(stored)) {
        if (value === undefined) delete merged[key];
      }
      await writeJsonAtomic(filePath, JSON.stringify(merged, null, 2));
      return mergedViewOf(projectId, merged);
    });
    writeChains.set(filePath, next.catch(() => undefined));
    return next;
  };

  // The team's shared file in the checkout; same rules as the server: a
  // broken file counts as empty, an empty result removes the file, and the
  // writer's own trust record is set to the new hash.
  const updateShared = async (projectId: string, patch: unknown): Promise<ProjectSetupView> => {
    const filePath = filePathFor(projectId);
    const previous = writeChains.get(filePath) ?? Promise.resolve();
    const next = previous.then(async () => {
      const personalRaw = await readJsonDocument(filePath);
      const projectPath = projectPathOf(projectId, personalRaw);
      if (!projectPath) throw new ProjectSetupValidationError('project checkout not found');
      const isDirectory = await fs.promises.stat(projectPath).then((stat) => stat.isDirectory()).catch(() => false);
      if (!isDirectory) throw new ProjectSetupValidationError('project checkout not found');
      const currentRead = await readShared(projectId, personalRaw);
      const current = currentRead.status === 'ok' ? currentRead.config : EMPTY_SHARED_PROJECT_CONFIG;
      const nextShared = applySharedProjectSetupPatch(current, patch);
      const sharedPath = sharedConfigPathOf(projectPath);
      if (isSharedProjectConfigEmpty(nextShared)) {
        await fs.promises.rm(sharedPath, { force: true });
        await fs.promises.rmdir(path.dirname(sharedPath)).catch(() => {});
      } else {
        await writeJsonAtomic(sharedPath, serializeSharedProjectConfig(nextShared));
      }
      const hash = sharedTrustHashOf(nextShared);
      const personalNext: Record<string, unknown> = { ...personalRaw };
      if (hash) personalNext.sharedTrust = { hash, trustedAt: Date.now() };
      else delete personalNext.sharedTrust;
      await writeJsonAtomic(filePath, JSON.stringify(personalNext, null, 2));
      return mergedViewOf(projectId, personalNext);
    });
    writeChains.set(filePath, next.catch(() => undefined));
    return next;
  };

  return { read, update, updateShared };
};

export async function handleProjectSetupBridgeMessage(
  message: ProjectSetupBridgeMessage,
  store: ProjectSetupStore,
): Promise<ProjectSetupBridgeResponse | null> {
  const { id, type, payload } = message;
  if (type !== 'api:project-setup:get' && type !== 'api:project-setup:update' && type !== 'api:project-setup:update-shared') return null;

  try {
    const request = isObjectRecord(payload) ? payload : {};
    const projectId = sanitizeProjectId(request.projectId);
    const data = type === 'api:project-setup:get'
      ? await store.read(projectId)
      : type === 'api:project-setup:update'
        ? await store.update(projectId, request.patch)
        : await store.updateShared(projectId, request.patch);
    return { id, type, success: true, data };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Project config request failed';
    return { id, type, success: false, error: message };
  }
}

