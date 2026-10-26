const FILE_VERSION = 1;
const MAX_PROMPT_TEXT_LENGTH = 200_000;
const PROMPT_ID_PATTERN = /^[a-z0-9._-]{1,160}$/;
const isVisiblePromptID = (id) => typeof id === 'string' && id.endsWith('.visible');

const hasOwn = (input, key) => Object.prototype.hasOwnProperty.call(input, key);
const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** A request or storage problem the routes answer with 400. */
export class MagicPromptValidationError extends Error {}

/** Stored prompts that cannot be read as prompts; the routes answer with 409. */
export class MagicPromptStorageError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

const defineEntry = (target, key, value) => {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
};

// Maps are rebuilt with own properties, so the id `__proto__` (the id pattern
// allows it) stays a key instead of changing the prototype. `undefined`
// removes the key.
const withEntry = (map, key, value) => {
  const next = {};
  for (const [entryKey, entryValue] of Object.entries(map)) {
    if (entryKey !== key) defineEntry(next, entryKey, entryValue);
  }
  if (value !== undefined) defineEntry(next, key, value);
  return next;
};

const normalizePromptID = (id) => {
  const normalizedId = typeof id === 'string' ? id.trim() : '';
  if (!PROMPT_ID_PATTERN.test(normalizedId)) {
    throw new MagicPromptValidationError('Invalid prompt id');
  }
  return normalizedId;
};

const validatePromptText = (id, text) => {
  if (typeof text !== 'string') {
    throw new MagicPromptValidationError('Prompt text must be a string');
  }
  if (isVisiblePromptID(id) && text.trim().length === 0) {
    throw new MagicPromptValidationError('Visible prompt text cannot be empty');
  }
  if (text.length > MAX_PROMPT_TEXT_LENGTH) {
    throw new MagicPromptValidationError('Prompt text is too long');
  }
};

/** Override maps as the global file has always read them: entries with a bad id or value are skipped. */
const sanitizeOverrides = (value) => {
  if (!isPlainObject(value)) {
    return {};
  }

  const next = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!PROMPT_ID_PATTERN.test(key) || typeof entry !== 'string') {
      continue;
    }
    defineEntry(next, key, entry);
  }
  return next;
};

// Combined keys older builds stored in the global file.
const LEGACY_PROMPT_KEYS = [
  { key: 'git.commit.generate', visible: 'git.commit.generate.visible', instructions: 'git.commit.generate.instructions' },
  { key: 'git.pr.generate', visible: 'git.pr.generate.visible', instructions: 'git.pr.generate.instructions' },
];

// A combined key's first line fills `<key>.visible` and the rest
// `<key>.instructions`, only where the same map has no split key and the part
// is not blank.
const expandLegacyKeys = (overrides) => {
  let result = overrides;
  for (const legacy of LEGACY_PROMPT_KEYS) {
    if (!hasOwn(overrides, legacy.key)) continue;
    const value = overrides[legacy.key];
    const newline = value.indexOf('\n');
    const visible = (newline === -1 ? value : value.slice(0, newline)).trim();
    const instructions = (newline === -1 ? '' : value.slice(newline + 1)).trim();
    if (!hasOwn(overrides, legacy.visible) && visible) result = withEntry(result, legacy.visible, visible);
    if (!hasOwn(overrides, legacy.instructions) && instructions) result = withEntry(result, legacy.instructions, instructions);
  }
  return result;
};

/**
 * The overrides that apply: the project map over the global map, each with
 * its legacy keys expanded first. Key presence decides, so an empty string
 * wins. Prompts no map sets are absent; the client adds the built-in text.
 */
export const mergeEffectiveOverrides = (globalOverrides, projectOverrides) => {
  const effective = {};
  for (const map of [expandLegacyKeys(globalOverrides), expandLegacyKeys(projectOverrides)]) {
    for (const [key, value] of Object.entries(map)) defineEntry(effective, key, value);
  }
  return effective;
};

const isInside = (pathModule, root, directory) => {
  const relative = pathModule.relative(root, directory);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${pathModule.sep}`) && !pathModule.isAbsolute(relative));
};

/**
 * The registered project that owns work in `directory`, or null. The deepest
 * registered project that holds the directory owns it. In a linked git
 * worktree, a project registered at or inside the worktree that holds the
 * directory stays its owner; otherwise the directory's path inside the
 * worktree is mapped onto the primary checkout, and the deepest project
 * holding that path owns it, so `<worktree>/ai` belongs to the project at
 * `<repo>/ai`. The git helpers answer the directory itself when git cannot
 * tell, so a folder outside any repository keeps its direct owner.
 */
export const createMagicPromptOwnerResolver = ({ path: pathModule, realpath, listProjects, resolvePrimaryWorktreeRoot, resolveWorktreeTopLevel }) => async (directory) => {
  // Git reports checkout roots with symlinks resolved, so project paths and
  // the target are compared in the same form: a project registered through a
  // symlink (`/tmp` on macOS) still owns its linked worktrees. A folder that
  // does not exist yet resolves through its nearest existing parent.
  const canonical = async (value) => {
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
  const deepestHolding = (candidate) => projects
    .filter((project) => isInside(pathModule, project.path, candidate))
    .reduce((best, project) => (!best || project.path.length > best.path.length ? project : best), null);

  const direct = deepestHolding(target);
  const [checkout, primary] = await Promise.all([resolveWorktreeTopLevel(target), resolvePrimaryWorktreeRoot(target)]);
  const checkoutRoot = pathModule.resolve(checkout.root);
  const primaryRoot = pathModule.resolve(primary.root);
  if (checkoutRoot === primaryRoot) return direct;
  if (direct && isInside(pathModule, checkoutRoot, direct.path)) return direct;
  // Git's prefix is right also for a directory reached through a symlink.
  const inCheckout = checkout.prefix ?? pathModule.relative(checkoutRoot, target);
  return deepestHolding(pathModule.resolve(primaryRoot, inCheckout)) ?? direct;
};

/**
 * The `magicPrompts` map of a project file, checked whole. The file is
 * hand-edited and committed, so a wrong entry makes the project scope
 * unreadable instead of silently changing which prompt applies.
 */
const parseProjectOverrides = (value) => {
  if (!isPlainObject(value)) {
    throw new MagicPromptStorageError('magicPrompts must be an object', 'project_prompts_invalid');
  }
  const overrides = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!PROMPT_ID_PATTERN.test(key)) {
      throw new MagicPromptStorageError(`magicPrompts has an invalid prompt id ${JSON.stringify(key)}`, 'project_prompts_invalid');
    }
    if (typeof entry !== 'string' || entry.length > MAX_PROMPT_TEXT_LENGTH) {
      throw new MagicPromptStorageError(`magicPrompts.${key} must be a string of at most ${MAX_PROMPT_TEXT_LENGTH} characters`, 'project_prompts_invalid');
    }
    defineEntry(overrides, key, entry);
  }
  return overrides;
};

/**
 * The global overrides file, `<data dir>/magic-prompts.json`. A missing file
 * means no overrides. A file that cannot be read or parsed is an error, for
 * reads and writes alike, so it is never mistaken for "no overrides" and
 * never overwritten. Writes go through a temporary file and a rename and keep
 * top-level keys this build does not know. Writes are queued per runtime
 * instance only; two servers sharing one data dir are not serialized.
 */
export const createMagicPromptRuntime = (dependencies) => {
  const {
    fsPromises,
    path,
    filePath,
  } = dependencies;

  let writeLock = Promise.resolve();

  const readDocument = async () => {
    let raw;
    try {
      raw = await fsPromises.readFile(filePath, 'utf8');
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') {
        return null;
      }
      throw new MagicPromptStorageError(`Failed to read magic prompts: ${error instanceof Error ? error.message : String(error)}`, 'global_prompts_unreadable');
    }
    let parsed;
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

  const stateOf = (document) => ({
    version: FILE_VERSION,
    overrides: sanitizeOverrides(document?.overrides),
  });

  const readPromptState = async () => stateOf(await readDocument());

  const writeDocument = async (document) => {
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

  const persist = async (mutateOverrides) => {
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

  const setOverride = async (id, text) => {
    const normalizedId = normalizePromptID(id);
    validatePromptText(normalizedId, text);
    return persist((overrides) => withEntry(overrides, normalizedId, text));
  };

  const resetOverride = async (id) => {
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

/**
 * Project overrides: the `magicPrompts` map of the project's shared file
 * `<checkout>/.openchamber/project.json`, read and written through the
 * project config runtime that owns that file. `project` is `{ id, path }`
 * of a registered project, resolved by the caller; nothing here falls back to
 * the global file.
 */
export const createProjectMagicPromptRuntime = ({ projectConfigRuntime }) => {
  const PROJECT_KEY = 'magicPrompts';

  /** `{ status: 'missing' | 'ok', overrides } | { status: 'invalid', reason }`. */
  const readProjectState = async (project) => {
    const read = await projectConfigRuntime.readSharedProjectFile(project.path);
    if (read.status === 'missing') return { status: 'missing', overrides: {} };
    if (read.status === 'invalid') return { status: 'invalid', reason: read.reason };
    if (!hasOwn(read.document, PROJECT_KEY)) return { status: 'missing', overrides: {} };
    try {
      return { status: 'ok', overrides: parseProjectOverrides(read.document[PROJECT_KEY]) };
    } catch (error) {
      return { status: 'invalid', reason: error.message };
    }
  };

  // The stored map is checked before any change, so an invalid one is
  // refused and stays on disk as it is. An empty map removes the key.
  const update = async (project, mutateOverrides) => {
    try {
      await projectConfigRuntime.updateSharedProjectEntry(project.id, project.path, PROJECT_KEY, (stored) => {
        const current = stored === undefined ? {} : parseProjectOverrides(stored);
        const next = mutateOverrides(current);
        if (next === current) return stored;
        return Object.keys(next).length > 0 ? next : undefined;
      });
    } catch (error) {
      if (error?.code === 'shared_config_invalid') {
        throw new MagicPromptStorageError(error.message, 'project_config_invalid');
      }
      if (error instanceof Error && error.message === 'project checkout not found') {
        throw new MagicPromptStorageError('Project checkout not found', 'project_checkout_missing');
      }
      // The write lock is named after the id, which must be file-name safe.
      if (error instanceof Error && error.message === 'projectId contains unsupported characters') {
        throw new MagicPromptStorageError('This project id cannot hold project prompts', 'project_id_unsupported');
      }
      throw error;
    }
  };

  const setOverride = async (project, id, text) => {
    const normalizedId = normalizePromptID(id);
    validatePromptText(normalizedId, text);
    await update(project, (overrides) => withEntry(overrides, normalizedId, text));
  };

  const resetOverride = async (project, id) => {
    const normalizedId = normalizePromptID(id);
    await update(project, (overrides) => (hasOwn(overrides, normalizedId) ? withEntry(overrides, normalizedId, undefined) : overrides));
  };

  const resetAllOverrides = async (project) => {
    await update(project, (overrides) => (Object.keys(overrides).length === 0 ? overrides : {}));
  };

  return {
    readProjectState,
    setOverride,
    resetOverride,
    resetAllOverrides,
  };
};
