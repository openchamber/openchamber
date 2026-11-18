
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  EMPTY_SHARED_PROJECT_CONFIG,
  ProjectSetupValidationError,
  SHARED_CONFIG_RELATIVE_PATH,
  SHARED_SETUP_KEYS,
  applySharedProjectSetupPatch,
  isSharedProjectConfigEmpty,
  mergeProjectSetup,
  parseSharedProjectConfig,
  personalProjectSetupOf,
  projectSetupPatchToStored,
  serializeSharedProjectConfig,
  sharedTrustHashOf,
  type JsonObject,
  type JsonValue,
  type ProjectSetupView,
  type SharedProjectConfigRead,
} from './project-setup';

export type ProjectSetupBridgeMessage = { id: string; type: string; payload?: unknown };
export type ProjectSetupBridgeResponse = { id: string; type: string; success: boolean; data?: unknown; error?: string };

export type SharedProjectFileRead =
  | { status: 'missing' }
  | { status: 'ok'; document: JsonObject }
  | { status: 'invalid'; reason: string };

class SharedProjectFileError extends Error {
  readonly code: 'shared_config_invalid' | 'project_checkout_missing';

  constructor(message: string, code: SharedProjectFileError['code']) {
    super(message);
    this.code = code;
  }
}

export type ProjectSetupStore = {
  read: (projectId: string) => Promise<ProjectSetupView>;
  update: (projectId: string, patch: unknown) => Promise<ProjectSetupView>;
  updateShared: (projectId: string, patch: unknown) => Promise<ProjectSetupView>;
  readSharedFile: (projectPath: string) => Promise<SharedProjectFileRead>;
  updateSharedEntry: (
    projectPath: string,
    key: string,
    mutate: (current: JsonValue | undefined) => JsonValue | undefined,
  ) => Promise<JsonValue | undefined>;
};

const PROJECT_ID_PATTERN = /^[a-zA-Z0-9._:-]+$/;

const MAX_PROJECT_CONFIG_FILE_STEM_LENGTH = 200;
const HASHED_PROJECT_CONFIG_FILE_STEM_PREFIX = 'path_sha256_';

export const projectConfigFileStemOf = (projectId: string): string => {
  if (projectId.length <= MAX_PROJECT_CONFIG_FILE_STEM_LENGTH) return projectId;
  const digest = crypto.createHash('sha256').update(projectId, 'utf8').digest('hex');
  return `${HASHED_PROJECT_CONFIG_FILE_STEM_PREFIX}${digest}`;
};

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

const readJsonDocumentIfPresent = async (filePath: string, missingCodes: string[]): Promise<Record<string, unknown> | null> => {
  let raw: string;
  try {
    raw = await fs.promises.readFile(filePath, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && typeof error.code === 'string' && missingCodes.includes(error.code)) return null;
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

export const createProjectSetupStore = (
  projectsDir: string = path.join(os.homedir(), '.config', 'openchamber', 'projects'),
): ProjectSetupStore => {
  const filePathFor = (projectId: string): string => path.join(projectsDir, `${projectConfigFileStemOf(sanitizeProjectId(projectId))}.json`);
  const legacyFilePathFor = (projectId: string): string | null => {
    const safeProjectId = sanitizeProjectId(projectId);
    if (projectConfigFileStemOf(safeProjectId) === safeProjectId) return null;
    return path.join(projectsDir, `${safeProjectId}.json`);
  };
  const readPersonalDocument = async (projectId: string): Promise<Record<string, unknown>> => {
    const current = await readJsonDocumentIfPresent(filePathFor(projectId), ['ENOENT']);
    if (current) return current;
    const legacyPath = legacyFilePathFor(projectId);
    const legacy = legacyPath ? await readJsonDocumentIfPresent(legacyPath, ['ENOENT', 'ENAMETOOLONG']) : null;
    return legacy ?? {};
  };
  const writePersonalDocument = async (projectId: string, document: Record<string, unknown>): Promise<void> => {
    await writeJsonAtomic(filePathFor(projectId), JSON.stringify(document, null, 2));
    const legacyPath = legacyFilePathFor(projectId);
    if (legacyPath) await fs.promises.rm(legacyPath, { force: true }).catch(() => {});
  };
  const writeChains = new Map<string, Promise<unknown>>();
  const serialized = <T,>(key: string, task: () => Promise<T>): Promise<T> => {
    const previous = writeChains.get(key) ?? Promise.resolve();
    const next = previous.then(task);
    const settled = next.catch(() => undefined);
    writeChains.set(key, settled);
    void settled.then(() => {
      if (writeChains.get(key) === settled) writeChains.delete(key);
    });
    return next;
  };
  const sharedChainKeyOf = async (projectPath: string): Promise<string> => {
    const resolved = path.resolve(projectPath);
    return `shared:${await fs.promises.realpath(resolved).catch(() => resolved)}`;
  };

  const projectPathOf = (projectId: string, personalRaw: Record<string, unknown>): string => {
    const storedPath = personalRaw.projectPath;
    return projectPathFromId(projectId) || (typeof storedPath === 'string' ? storedPath.trim() : '');
  };
  const sharedConfigPathOf = (projectPath: string): string => path.join(projectPath, ...SHARED_CONFIG_RELATIVE_PATH.split('/'));

  const readSharedText = async (projectPath: string): Promise<{ status: 'missing' } | { status: 'invalid'; reason: string } | { status: 'text'; raw: string }> => {
    try {
      return { status: 'text', raw: await fs.promises.readFile(sharedConfigPathOf(projectPath), 'utf8') };
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { status: 'missing' };
      return { status: 'invalid', reason: error instanceof Error ? error.message : String(error) };
    }
  };

  const readSharedAt = async (projectPath: string): Promise<SharedProjectConfigRead> => {
    const read = await readSharedText(projectPath);
    return read.status === 'text' ? parseSharedProjectConfig(read.raw) : read;
  };

  const readShared = async (projectId: string, personalRaw: Record<string, unknown>): Promise<SharedProjectConfigRead> => {
    const projectPath = projectPathOf(projectId, personalRaw);
    if (!projectPath) return { status: 'missing' };
    return readSharedAt(projectPath);
  };

  const isDirectory = (projectPath: string): Promise<boolean> =>
    fs.promises.stat(projectPath).then((stat) => stat.isDirectory()).catch(() => false);

  const writeSharedFile = async (projectPath: string, text: string | null): Promise<void> => {
    const sharedPath = sharedConfigPathOf(projectPath);
    if (text === null) {
      await fs.promises.rm(sharedPath, { force: true });
      await fs.promises.rmdir(path.dirname(sharedPath)).catch(() => {});
      return;
    }
    await writeJsonAtomic(sharedPath, text);
  };

  const readSharedFile = async (projectPath: string): Promise<SharedProjectFileRead> => {
    const read = await readSharedAt(projectPath);
    if (read.status === 'ok') return { status: 'ok', document: read.document };
    if (read.status === 'invalid') return { status: 'invalid', reason: read.reason };
    return read;
  };

  const updateSharedEntry: ProjectSetupStore['updateSharedEntry'] = async (projectPath, key, mutate) => {
    if (SHARED_SETUP_KEYS.includes(key)) throw new Error(`${key} belongs to the shared setup writer`);
    return serialized(await sharedChainKeyOf(projectPath), async () => {
      if (!(await isDirectory(projectPath))) {
        throw new SharedProjectFileError('project checkout not found', 'project_checkout_missing');
      }
      const read = await readSharedFile(projectPath);
      if (read.status === 'invalid') {
        throw new SharedProjectFileError(`${SHARED_CONFIG_RELATIVE_PATH} is invalid: ${read.reason}`, 'shared_config_invalid');
      }
      const document = read.status === 'ok' ? read.document : Object.fromEntries([['version', 1]]);
      const current = Object.hasOwn(document, key) ? document[key] : undefined;
      const next = mutate(current);
      if (next === current) return current;

      const entries = Object.entries(document).filter(([entryKey]) => entryKey !== key);
      if (next !== undefined) entries.push([key, next]);
      const nextDocument = Object.fromEntries(entries);
      const onlyVersion = Object.keys(nextDocument).every((entryKey) => entryKey === 'version');
      await writeSharedFile(projectPath, onlyVersion ? null : `${JSON.stringify(nextDocument, null, 2)}\n`);
      return next;
    });
  };

  const mergedViewOf = async (projectId: string, personalRaw: Record<string, unknown>): Promise<ProjectSetupView> =>
    mergeProjectSetup(personalProjectSetupOf(personalRaw), await readShared(projectId, personalRaw));

  const read = async (projectId: string): Promise<ProjectSetupView> => mergedViewOf(projectId, await readPersonalDocument(projectId));

  const update = async (projectId: string, patch: unknown): Promise<ProjectSetupView> => {
    const filePath = filePathFor(projectId);
    const stored = projectSetupPatchToStored(patch);
    return serialized(filePath, async () => {
      const existing = await readPersonalDocument(projectId);
      const merged: Record<string, unknown> = { ...existing, ...stored };
      for (const [key, value] of Object.entries(stored)) {
        if (value === undefined) delete merged[key];
      }
      await writePersonalDocument(projectId, merged);
      return mergedViewOf(projectId, merged);
    });
  };

  const updateShared = async (projectId: string, patch: unknown): Promise<ProjectSetupView> => {
    const filePath = filePathFor(projectId);
    return serialized(filePath, async () => {
      const personalRaw = await readPersonalDocument(projectId);
      const projectPath = projectPathOf(projectId, personalRaw);
      if (!projectPath || !(await isDirectory(projectPath))) throw new ProjectSetupValidationError('project checkout not found');
      const nextShared = await serialized(await sharedChainKeyOf(projectPath), async () => {
        const currentRead = await readSharedAt(projectPath);
        const current = currentRead.status === 'ok' ? currentRead.config : EMPTY_SHARED_PROJECT_CONFIG;
        const document = currentRead.status === 'missing' ? undefined : currentRead.document;
        const applied = applySharedProjectSetupPatch(current, patch);
        await writeSharedFile(
          projectPath,
          isSharedProjectConfigEmpty(applied, document) ? null : serializeSharedProjectConfig(applied, document),
        );
        return applied;
      });
      const hash = sharedTrustHashOf(nextShared);
      const personalNext: Record<string, unknown> = { ...personalRaw };
      if (hash) personalNext.sharedTrust = { hash, trustedAt: Date.now() };
      else delete personalNext.sharedTrust;
      await writePersonalDocument(projectId, personalNext);
      return mergedViewOf(projectId, personalNext);
    });
  };

  return { read, update, updateShared, readSharedFile, updateSharedEntry };
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

