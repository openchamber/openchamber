import type { promises as fsPromises } from 'node:fs';
import type { PlatformPath } from 'node:path';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

export type MagicPromptOverrides = Record<string, string>;
export type MagicPromptGlobalState = { version: number; overrides: MagicPromptOverrides };
export type MagicPromptScopeState =
  | { status: 'ok' | 'missing'; overrides: MagicPromptOverrides }
  | { status: 'invalid'; reason: string };
export type MagicPromptProject = { id: string; path: string };

type SharedProjectFileOwner = {
  readSharedProjectFile: (
    projectPath: string,
  ) => Promise<{ status: 'missing' } | { status: 'ok'; document: { [key: string]: JsonValue } } | { status: 'invalid'; reason: string }>;
  updateSharedProjectEntry: (
    projectId: string,
    projectPath: string,
    key: string,
    mutate: (stored: JsonValue | undefined) => JsonValue | undefined,
  ) => Promise<JsonValue | undefined>;
};

type MagicPromptRuntimeDependencies = {
  fsPromises: Pick<typeof fsPromises, 'mkdir' | 'readFile' | 'rename' | 'rm' | 'writeFile'>;
  path: PlatformPath;
  filePath: string;
};

export type MagicPromptOwnerDependencies = {
  path: PlatformPath;
  realpath: (value: string) => Promise<string>;
  listProjects: () => MagicPromptProject[] | Promise<MagicPromptProject[]>;
  resolvePrimaryWorktreeRoot: (directory: string) => Promise<{ root: string }>;
  resolveWorktreeTopLevel: (directory: string) => Promise<{ root: string; prefix?: string }>;
};

export type MagicPromptRuntime = ReturnType<typeof createMagicPromptRuntime>;
export type ProjectMagicPromptRuntime = ReturnType<typeof createProjectMagicPromptRuntime>;
export type ProjectMagicPromptDependencies = { projectConfigRuntime: SharedProjectFileOwner };

const FILE_VERSION = 1;
const MAX_PROMPT_TEXT_LENGTH = 200_000;
const PROMPT_ID_PATTERN = /^[A-Za-z0-9._-]{1,160}$/;
const isVisiblePromptID = (id: string) => id.endsWith('.visible');

const hasOwn = (input: JsonObject, key: string) => Object.prototype.hasOwnProperty.call(input, key);
const isPlainObject = (value: JsonValue | undefined): value is JsonObject => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === 'string';
const isMissingFileError = (value: unknown): value is { code: 'ENOENT' } =>
  value !== null && typeof value === 'object' && 'code' in value && value.code === 'ENOENT';
const isSharedConfigError = (value: unknown): value is { code: 'shared_config_invalid'; message: string } =>
  value !== null && typeof value === 'object' && 'code' in value && value.code === 'shared_config_invalid'
  && 'message' in value && isString(value.message);

export class MagicPromptValidationError extends Error {}

export class MagicPromptStorageError extends Error {
  code: string;

  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

const defineEntry = (target: MagicPromptOverrides, key: string, value: string) => {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
};

const withEntry = (map: MagicPromptOverrides, key: string, value: string | undefined) => {
  const next: MagicPromptOverrides = {};
  for (const [entryKey, entryValue] of Object.entries(map)) {
    if (entryKey !== key) defineEntry(next, entryKey, entryValue);
  }
  if (value !== undefined) defineEntry(next, key, value);
  return next;
};

const normalizePromptID = (id: string | null) => {
  const normalizedId = id === null ? '' : id.trim();
  if (!PROMPT_ID_PATTERN.test(normalizedId)) {
    throw new MagicPromptValidationError('Invalid prompt id');
  }
  return normalizedId;
};

const validatePromptText = (id: string, text: string) => {
  if (isVisiblePromptID(id) && text.trim().length === 0) {
    throw new MagicPromptValidationError('Visible prompt text cannot be empty');
  }
  if (text.length > MAX_PROMPT_TEXT_LENGTH) {
    throw new MagicPromptValidationError('Prompt text is too long');
  }
};

const sanitizeOverrides = (value: JsonValue | undefined) => {
  const next: MagicPromptOverrides = {};
  if (!isPlainObject(value)) {
    return next;
  }

  for (const [key, entry] of Object.entries(value)) {
    if (!PROMPT_ID_PATTERN.test(key) || !isString(entry)) {
      continue;
    }
    defineEntry(next, key, entry);
  }
  return next;
};

const LEGACY_PROMPT_KEYS = [
  { key: 'git.commit.generate', visible: 'git.commit.generate.visible', instructions: 'git.commit.generate.instructions' },
  { key: 'git.pr.generate', visible: 'git.pr.generate.visible', instructions: 'git.pr.generate.instructions' },
];

const expandLegacyKeys = (overrides: MagicPromptOverrides) => {
  let result = overrides;
  for (const legacy of LEGACY_PROMPT_KEYS) {
    if (!hasOwn(overrides, legacy.key)) continue;
    const value = overrides[legacy.key];
    if (value === undefined) throw new TypeError('Legacy prompt entry is missing');
    const newline = value.indexOf('\n');
    const visible = (newline === -1 ? value : value.slice(0, newline)).trim();
    const instructions = (newline === -1 ? '' : value.slice(newline + 1)).trim();
    if (!hasOwn(overrides, legacy.visible) && visible) result = withEntry(result, legacy.visible, visible);
    if (!hasOwn(overrides, legacy.instructions) && instructions) result = withEntry(result, legacy.instructions, instructions);
  }
  return result;
};

export const mergeEffectiveOverrides = (globalOverrides: MagicPromptOverrides, projectOverrides: MagicPromptOverrides) => {
  const effective: MagicPromptOverrides = {};
  for (const map of [expandLegacyKeys(globalOverrides), expandLegacyKeys(projectOverrides)]) {
    for (const [key, value] of Object.entries(map)) defineEntry(effective, key, value);
  }
  return effective;
};

const isInside = (pathModule: PlatformPath, root: string, directory: string) => {
  const relative = pathModule.relative(root, directory);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${pathModule.sep}`) && !pathModule.isAbsolute(relative));
};

export const createMagicPromptOwnerResolver = ({ path: pathModule, realpath, listProjects, resolvePrimaryWorktreeRoot, resolveWorktreeTopLevel }: MagicPromptOwnerDependencies) => async (directory: string) => {
  const canonical = async (value: string) => {
    const resolved = pathModule.resolve(value);
    let existing = resolved;
    for (;;) {
      const real = await realpath(existing).catch(() => null);
      if (real) return pathModule.join(real, pathModule.relative(existing, resolved));
      const parent = pathModule.dirname(existing);
      if (parent === existing) return resolved;
      existing = parent;
    }
  };
  const target = await canonical(directory);
  const projects = await Promise.all((await listProjects()).map(async (project) => ({ id: project.id, path: await canonical(project.path) })));
  const deepestHolding = (candidate: string) => projects
    .filter((project) => isInside(pathModule, project.path, candidate))
    .reduce<MagicPromptProject | null>((best, project) => (!best || project.path.length > best.path.length ? project : best), null);

  const direct = deepestHolding(target);
  const [checkout, primary] = await Promise.all([resolveWorktreeTopLevel(target), resolvePrimaryWorktreeRoot(target)]);
  const checkoutRoot = pathModule.resolve(checkout.root);
  const primaryRoot = pathModule.resolve(primary.root);
  if (checkoutRoot === primaryRoot) return direct;
  if (direct && isInside(pathModule, checkoutRoot, direct.path)) return direct;
  const inCheckout = checkout.prefix ?? pathModule.relative(checkoutRoot, target);
  return deepestHolding(pathModule.resolve(primaryRoot, inCheckout)) ?? direct;
};

const parseProjectOverrides = (value: JsonValue | undefined) => {
  if (!isPlainObject(value)) {
    throw new MagicPromptStorageError('magicPrompts must be an object', 'project_prompts_invalid');
  }
  const overrides: MagicPromptOverrides = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!PROMPT_ID_PATTERN.test(key)) {
      throw new MagicPromptStorageError(`magicPrompts has an invalid prompt id ${JSON.stringify(key)}`, 'project_prompts_invalid');
    }
    if (!isString(entry) || entry.length > MAX_PROMPT_TEXT_LENGTH) {
      throw new MagicPromptStorageError(`magicPrompts.${key} must be a string of at most ${MAX_PROMPT_TEXT_LENGTH} characters`, 'project_prompts_invalid');
    }
    defineEntry(overrides, key, entry);
  }
  return overrides;
};

export const createMagicPromptRuntime = (dependencies: MagicPromptRuntimeDependencies) => {
  const {
    fsPromises,
    path,
    filePath,
  } = dependencies;

  let writeLock: Promise<MagicPromptGlobalState | void> = Promise.resolve();

  const readDocument = async () => {
    let raw;
    try {
      raw = await fsPromises.readFile(filePath, 'utf8');
    } catch (error) {
      if (isMissingFileError(error)) {
        return null;
      }
      throw new MagicPromptStorageError(`Failed to read magic prompts: ${error instanceof Error ? error.message : String(error)}`, 'global_prompts_unreadable');
    }
    let parsed: JsonValue;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new MagicPromptStorageError(`Magic prompts file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, 'global_prompts_invalid');
    }
    if (!isPlainObject(parsed)) {
      throw new MagicPromptStorageError('Magic prompts file is not an object', 'global_prompts_invalid');
    }
    return parsed;
  };

  const stateOf = (document: JsonObject | null): MagicPromptGlobalState => ({
    version: FILE_VERSION,
    overrides: sanitizeOverrides(document?.overrides),
  });

  const readPromptState = async () => stateOf(await readDocument());

  const writeDocument = async (document: JsonObject) => {
    await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    try {
      await fsPromises.writeFile(temporaryPath, JSON.stringify(document, null, 2), 'utf8');
      await fsPromises.rename(temporaryPath, filePath);
    } catch (error) {
      await fsPromises.rm(temporaryPath, { force: true }).catch(() => {});
      throw error;
    }
  };

  const persist = async (mutateOverrides: (overrides: MagicPromptOverrides) => MagicPromptOverrides) => {
    const run = async () => {
      const document = await readDocument();
      const current = stateOf(document);
      const overrides = mutateOverrides(current.overrides);
      if (overrides === current.overrides) {
        return current;
      }
      const next = { version: FILE_VERSION, overrides };
      await writeDocument({ ...(document ?? {}), ...next });
      return next;
    };
    const result = writeLock.then(run, run);
    writeLock = result.catch(() => {});
    return result;
  };

  const setOverride = async (id: string | null, text: string) => {
    const normalizedId = normalizePromptID(id);
    validatePromptText(normalizedId, text);
    return persist((overrides) => withEntry(overrides, normalizedId, text));
  };

  const resetOverride = async (id: string | null) => {
    const normalizedId = normalizePromptID(id);
    return persist((overrides) => (hasOwn(overrides, normalizedId) ? withEntry(overrides, normalizedId, undefined) : overrides));
  };

  const resetAllOverrides = async () => persist(() => ({}));

  return {
    readPromptState,
    setOverride,
    resetOverride,
    resetAllOverrides,
  };
};

export const createProjectMagicPromptRuntime = ({ projectConfigRuntime }: ProjectMagicPromptDependencies) => {
  const PROJECT_KEY = 'magicPrompts';

  const readProjectState = async (project: MagicPromptProject): Promise<MagicPromptScopeState> => {
    const read = await projectConfigRuntime.readSharedProjectFile(project.path);
    if (read.status === 'missing') return { status: 'missing', overrides: {} };
    if (read.status === 'invalid') return { status: 'invalid', reason: read.reason };
    if (!hasOwn(read.document, PROJECT_KEY)) return { status: 'missing', overrides: {} };
    try {
      return { status: 'ok', overrides: parseProjectOverrides(read.document[PROJECT_KEY]) };
    } catch (error) {
      if (!(error instanceof MagicPromptStorageError)) throw error;
      return { status: 'invalid', reason: error.message };
    }
  };

  const update = async (project: MagicPromptProject, mutateOverrides: (overrides: MagicPromptOverrides) => MagicPromptOverrides) => {
    try {
      await projectConfigRuntime.updateSharedProjectEntry(project.id, project.path, PROJECT_KEY, (stored) => {
        const current = stored === undefined ? {} : parseProjectOverrides(stored);
        const next = mutateOverrides(current);
        if (next === current) return stored;
        return Object.keys(next).length > 0 ? next : undefined;
      });
    } catch (error) {
      if (isSharedConfigError(error)) {
        throw new MagicPromptStorageError(error.message, 'project_config_invalid');
      }
      if (error instanceof Error && error.message === 'project checkout not found') {
        throw new MagicPromptStorageError('Project checkout not found', 'project_checkout_missing');
      }
      if (error instanceof Error && error.message === 'projectId contains unsupported characters') {
        throw new MagicPromptStorageError('This project id cannot hold project prompts', 'project_id_unsupported');
      }
      throw error;
    }
  };

  const setOverride = async (project: MagicPromptProject, id: string | null, text: string) => {
    const normalizedId = normalizePromptID(id);
    validatePromptText(normalizedId, text);
    await update(project, (overrides) => withEntry(overrides, normalizedId, text));
  };

  const resetOverride = async (project: MagicPromptProject, id: string | null) => {
    const normalizedId = normalizePromptID(id);
    await update(project, (overrides) => (hasOwn(overrides, normalizedId) ? withEntry(overrides, normalizedId, undefined) : overrides));
  };

  const resetAllOverrides = async (project: MagicPromptProject) => {
    await update(project, (overrides) => (Object.keys(overrides).length === 0 ? overrides : {}));
  };

  return {
    readProjectState,
    setOverride,
    resetOverride,
    resetAllOverrides,
  };
};
