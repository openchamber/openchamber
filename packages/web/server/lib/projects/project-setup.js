// A project's setup — worktree setup commands, project actions, pinned draft
// starters — comes from two files:
//
// - the personal file `~/.config/openchamber/projects/<projectId>.json`
//   (client-owned keys; server-owned `version` / `scheduledTasks` live beside
//   them and are never touched here), and
// - the shared file `<repo>/.openchamber/project.json`, committed by a team so
//   a teammate who pulls the code gets the setup without configuring anything.
//
// This module knows both shapes and the one merge rule per field. The route
// and the VS Code bridge (`packages/vscode/src/project-setup.ts`, a mirror of
// this file) use the same code paths so a value reads back the same on every
// surface.

import crypto from 'node:crypto';

const ACTION_NAME_MAX_LENGTH = 80;
const ACTION_COMMAND_MAX_LENGTH = 4000;
const ACTION_OPEN_URL_MAX_LENGTH = 2000;
const ACTION_DESKTOP_FORWARD_MAX_LENGTH = 300;
const SETUP_COMMAND_MAX_LENGTH = 4000;
const SETUP_COMMANDS_MAX = 50;

const ACTION_PLATFORMS = new Set(['macos', 'linux', 'windows']);
const SETUP_WORKTREE_MODES = new Set(['append', 'replace']);

const isObjectRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const clamp = (value, maxLength) => (value.length > maxLength ? value.slice(0, maxLength) : value);

const trimmedString = (value) => (typeof value === 'string' ? value.trim() : '');

/** Setup commands: non-empty trimmed strings, capped in count and length. */
export const sanitizeSetupCommands = (value) => {
  if (!Array.isArray(value)) return [];
  const commands = [];
  for (const entry of value) {
    const command = clamp(trimmedString(entry), SETUP_COMMAND_MAX_LENGTH);
    if (!command) continue;
    commands.push(command);
    if (commands.length >= SETUP_COMMANDS_MAX) break;
  }
  return commands;
};

const sanitizeActionPlatforms = (value) => {
  if (!Array.isArray(value)) return [];
  const platforms = [];
  for (const entry of value) {
    const platform = trimmedString(entry).toLowerCase();
    if (ACTION_PLATFORMS.has(platform) && !platforms.includes(platform)) platforms.push(platform);
  }
  return platforms;
};

/**
 * Project actions: `id`, `name`, and `command` are required and ids are
 * unique; every optional field is dropped when empty so the stored record
 * carries only what the user set. `runIn` keeps only the one value the UI
 * understands (`parent`); anything else means "run in the worktree".
 */
export const sanitizeProjectActions = (value) => {
  if (!Array.isArray(value)) return [];
  const actions = [];
  const seenIds = new Set();
  for (const entry of value) {
    if (!isObjectRecord(entry)) continue;
    const id = trimmedString(entry.id);
    const name = clamp(trimmedString(entry.name), ACTION_NAME_MAX_LENGTH);
    const command = clamp(trimmedString(entry.command), ACTION_COMMAND_MAX_LENGTH);
    if (!id || !name || !command || seenIds.has(id)) continue;
    seenIds.add(id);

    const icon = trimmedString(entry.icon);
    const platforms = sanitizeActionPlatforms(entry.platforms);
    const openUrl = clamp(trimmedString(entry.openUrl), ACTION_OPEN_URL_MAX_LENGTH);
    const desktopOpenSshForward = clamp(trimmedString(entry.desktopOpenSshForward), ACTION_DESKTOP_FORWARD_MAX_LENGTH);

    const action = { id, name, command, icon: icon || null };
    if (entry.autoOpenUrl === true) action.autoOpenUrl = true;
    if (openUrl) action.openUrl = openUrl;
    if (desktopOpenSshForward) action.desktopOpenSshForward = desktopOpenSshForward;
    if (platforms.length > 0) action.platforms = platforms;
    if (entry.runIn === 'parent') action.runIn = 'parent';
    actions.push(action);
  }
  return actions;
};

/** Draft starters: `{ type: 'command' | 'skill', name }`, unique by `type:name`. */
export const sanitizeDraftStarters = (value) => {
  if (!Array.isArray(value)) return [];
  const starters = [];
  const seen = new Set();
  for (const entry of value) {
    if (!isObjectRecord(entry)) continue;
    const type = entry.type === 'command' || entry.type === 'skill' ? entry.type : null;
    const name = trimmedString(entry.name);
    if (!type || !name) continue;
    const key = `${type}:${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    starters.push({ type, name });
  }
  return starters;
};

/**
 * The client-facing view of a raw config document. A primary action id that
 * names no action is reported as `null`.
 */
const sanitizeIdList = (value) => {
  if (!Array.isArray(value)) return [];
  const ids = [];
  for (const entry of value) {
    const id = trimmedString(entry);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
};

/**
 * The personal part of the view, straight from the personal file. The wait
 * flag is `null` when the file does not set it, so the merge can let a
 * shared value through; `hiddenSharedActionIds` and `setupWorktreeMode` only
 * matter when a shared file exists.
 */
export const projectSetupViewOf = (raw) => {
  const document = isObjectRecord(raw) ? raw : {};
  const projectActions = sanitizeProjectActions(document.projectActions);
  const primaryRaw = trimmedString(document.projectActionsPrimaryId);
  return {
    setupWorktree: sanitizeSetupCommands(document['setup-worktree']),
    setupWorktreeWait: typeof document['setup-worktree-wait'] === 'boolean' ? document['setup-worktree-wait'] : null,
    setupWorktreeMode: SETUP_WORKTREE_MODES.has(document.setupWorktreeMode) ? document.setupWorktreeMode : 'append',
    projectActions,
    projectActionsPrimaryId: primaryRaw && projectActions.some((action) => action.id === primaryRaw) ? primaryRaw : null,
    draftStarters: sanitizeDraftStarters(document.draftStarters),
    hiddenSharedActionIds: sanitizeIdList(document.hiddenSharedActionIds),
    sharedTrust: sharedTrustOf(document.sharedTrust),
  };
};

/** The recorded answer to the trust prompt: which shared commands were trusted, and when. */
const sharedTrustOf = (value) => {
  if (!isObjectRecord(value)) return null;
  const hash = trimmedString(value.hash);
  if (!hash) return null;
  return { hash, trustedAt: Number.isFinite(value.trustedAt) ? value.trustedAt : 0 };
};

/**
 * Turn a client patch (view keys) into the on-disk keys it changes. Only the
 * keys present in the patch are returned, so a caller can merge the result
 * over the raw document without clearing what the patch did not mention.
 * A key with the wrong shape is a validation error, never silently dropped.
 */
export const projectSetupPatchToStored = (patch) => {
  if (!isObjectRecord(patch)) {
    throw new Error('patch must be an object');
  }
  const stored = {};
  if ('setupWorktree' in patch) {
    if (!Array.isArray(patch.setupWorktree)) throw new Error('setupWorktree must be an array of commands');
    stored['setup-worktree'] = sanitizeSetupCommands(patch.setupWorktree);
  }
  if ('setupWorktreeWait' in patch) {
    if (typeof patch.setupWorktreeWait !== 'boolean') throw new Error('setupWorktreeWait must be a boolean');
    stored['setup-worktree-wait'] = patch.setupWorktreeWait;
  }
  if ('projectActions' in patch) {
    if (!Array.isArray(patch.projectActions)) throw new Error('projectActions must be an array');
    stored.projectActions = sanitizeProjectActions(patch.projectActions);
  }
  if ('projectActionsPrimaryId' in patch) {
    const primary = patch.projectActionsPrimaryId;
    if (primary !== null && typeof primary !== 'string') throw new Error('projectActionsPrimaryId must be a string or null');
    stored.projectActionsPrimaryId = trimmedString(primary) || undefined;
  }
  if ('draftStarters' in patch) {
    if (!Array.isArray(patch.draftStarters)) throw new Error('draftStarters must be an array');
    stored.draftStarters = sanitizeDraftStarters(patch.draftStarters);
  }
  if ('hiddenSharedActionIds' in patch) {
    if (!Array.isArray(patch.hiddenSharedActionIds)) throw new Error('hiddenSharedActionIds must be an array');
    stored.hiddenSharedActionIds = sanitizeIdList(patch.hiddenSharedActionIds);
  }
  if ('setupWorktreeMode' in patch) {
    if (!SETUP_WORKTREE_MODES.has(patch.setupWorktreeMode)) throw new Error('setupWorktreeMode must be "append" or "replace"');
    stored.setupWorktreeMode = patch.setupWorktreeMode;
  }
  if ('sharedTrustHash' in patch) {
    const hash = patch.sharedTrustHash;
    if (hash !== null && (typeof hash !== 'string' || !hash.trim())) throw new Error('sharedTrustHash must be a non-empty string or null');
    stored.sharedTrust = hash === null ? undefined : { hash: hash.trim(), trustedAt: Date.now() };
  }
  if ('projectPath' in patch) {
    if (typeof patch.projectPath !== 'string') throw new Error('projectPath must be a string');
    const projectPath = patch.projectPath.trim();
    if (projectPath) stored.projectPath = projectPath;
  }
  return stored;
};

// ── Shared file ──

export const SHARED_CONFIG_RELATIVE_PATH = '.openchamber/project.json';
/** Where repository plans live unless the shared file's `plansDir` says otherwise. */
export const DEFAULT_PLANS_DIR = '.openchamber/plans';
const SHARED_CONFIG_VERSION = 1;

/**
 * A `plansDir` is a relative path inside the repo: no absolute paths, no
 * drive letters, no `..` segments, forward slashes. Returns the normalized
 * value or `null` when the value is not acceptable.
 */
export const normalizePlansDir = (value) => {
  const raw = trimmedString(value).replace(/\\/g, '/');
  if (!raw) return null;
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) return null;
  const segments = raw.split('/').filter((segment) => segment.length > 0 && segment !== '.');
  if (segments.length === 0 || segments.some((segment) => segment === '..')) return null;
  return segments.join('/');
};

const EMPTY_SHARED = Object.freeze({
  setupWorktree: [],
  setupWorktreeWait: null,
  projectActions: [],
  draftStarters: [],
  plansDir: null,
});

/**
 * Parse the text of a shared file. Anything that is not a version-1 object
 * is `invalid` with a reason (never an empty config: a teammate must see that
 * the file is broken, not that the project has no shared setup). A `plansDir`
 * that points outside the repo is invalid for the same reason.
 */
export const parseSharedProjectConfig = (raw) => {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { status: 'invalid', reason: `invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!isObjectRecord(parsed)) return { status: 'invalid', reason: 'not an object' };
  if (parsed.version !== SHARED_CONFIG_VERSION) return { status: 'invalid', reason: `unsupported version ${JSON.stringify(parsed.version)}` };
  if ('setupWorktree' in parsed && !Array.isArray(parsed.setupWorktree)) return { status: 'invalid', reason: 'setupWorktree must be an array' };
  if ('setupWorktreeWait' in parsed && typeof parsed.setupWorktreeWait !== 'boolean') return { status: 'invalid', reason: 'setupWorktreeWait must be a boolean' };
  if ('projectActions' in parsed && !Array.isArray(parsed.projectActions)) return { status: 'invalid', reason: 'projectActions must be an array' };
  if ('draftStarters' in parsed && !Array.isArray(parsed.draftStarters)) return { status: 'invalid', reason: 'draftStarters must be an array' };
  let plansDir = null;
  if ('plansDir' in parsed && parsed.plansDir !== null) {
    plansDir = normalizePlansDir(parsed.plansDir);
    if (!plansDir) return { status: 'invalid', reason: 'plansDir must be a relative path inside the repository' };
  }
  return {
    status: 'ok',
    config: {
      setupWorktree: sanitizeSetupCommands(parsed.setupWorktree),
      setupWorktreeWait: typeof parsed.setupWorktreeWait === 'boolean' ? parsed.setupWorktreeWait : null,
      projectActions: sanitizeProjectActions(parsed.projectActions),
      draftStarters: sanitizeDraftStarters(parsed.draftStarters),
      plansDir,
    },
  };
};

const withSource = (entries, source) => entries.map((entry) => ({ ...entry, source }));

/**
 * What a trust answer covers: the shared setup commands and the shared
 * actions' commands, in a canonical order, hashed. A pull that changes any
 * of them changes the hash, so the prompt returns for the new commands.
 * `null` when the shared config has nothing that executes.
 */
export const sharedTrustHashOf = (shared) => {
  const commands = shared.setupWorktree;
  const actions = shared.projectActions
    .map((action) => {
      const executable = { id: action.id, command: action.command };
      if (action.runIn) executable.runIn = action.runIn;
      return executable;
    })
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  if (commands.length === 0 && actions.length === 0) return null;
  const digest = crypto.createHash('sha256').update(JSON.stringify({ setupWorktree: commands, projectActions: actions })).digest('hex');
  return `sha256:${digest}`;
};

/**
 * One merged view from the personal view and the shared read. Rules:
 * - setup commands: shared first, then personal; personal `setupWorktreeMode`
 *   `replace` uses only the personal list;
 * - wait flag: personal when the personal file sets it, else shared, else off;
 * - actions: union by id, a personal action replaces the shared one with the
 *   same id, hidden shared ids are dropped, primary is personal only;
 * - draft starters: union by `type:name`, shared first.
 * Every merged action and starter carries `source`. The `shared` and
 * `personal` blocks are returned too so a page can edit one without guessing
 * which entries came from where.
 */
export const mergeProjectSetup = (personal, sharedRead) => {
  const shared = sharedRead.status === 'ok' ? sharedRead.config : EMPTY_SHARED;
  const hidden = new Set(personal.hiddenSharedActionIds);
  const personalIds = new Set(personal.projectActions.map((action) => action.id));
  const sharedActions = shared.projectActions.filter((action) => !hidden.has(action.id) && !personalIds.has(action.id));
  const starterKeys = new Set(shared.draftStarters.map((starter) => `${starter.type}:${starter.name}`));
  const personalStarters = personal.draftStarters.filter((starter) => !starterKeys.has(`${starter.type}:${starter.name}`));
  const trustHash = sharedTrustHashOf(shared);
  return {
    // Nothing executable in the shared file means nothing to trust; otherwise
    // the recorded answer must match the current commands exactly.
    trust: { hash: trustHash, trusted: trustHash === null || personal.sharedTrust?.hash === trustHash },
    setupWorktree: personal.setupWorktreeMode === 'replace'
      ? personal.setupWorktree
      : [...shared.setupWorktree, ...personal.setupWorktree],
    setupWorktreeWait: personal.setupWorktreeWait !== null
      ? personal.setupWorktreeWait
      : shared.setupWorktreeWait === true,
    projectActions: [...withSource(sharedActions, 'shared'), ...withSource(personal.projectActions, 'personal')],
    projectActionsPrimaryId: personal.projectActionsPrimaryId,
    draftStarters: [...withSource(shared.draftStarters, 'shared'), ...withSource(personalStarters, 'personal')],
    shared: sharedBlockOf(sharedRead, shared),
    personal,
  };
};

const sharedBlockOf = (sharedRead, shared) => {
  const block = { status: sharedRead.status, path: SHARED_CONFIG_RELATIVE_PATH, ...shared };
  if (sharedRead.status === 'invalid') block.reason = sharedRead.reason;
  return block;
};

/** An action without an icon is written without the key; readers fall back to the play icon. */
const withoutEmptyIcon = (action) => {
  if (action.icon !== null) return action;
  const { icon: _emptyIcon, ...rest } = action;
  return rest;
};

/** True when the shared config carries nothing: the file should not exist. */
export const isSharedProjectConfigEmpty = (config) => (
  config.setupWorktree.length === 0
  && config.setupWorktreeWait === null
  && config.projectActions.length === 0
  && config.draftStarters.length === 0
  && config.plansDir === null
);

/**
 * The bytes of a shared file: version first, then only the keys that carry
 * something, in a fixed order, pretty-printed — the file is committed and
 * reviewed, so its diffs must stay readable. Actions lose their `source`
 * mark and keep only the fields the user set.
 */
export const serializeSharedProjectConfig = (config) => {
  const document = { version: SHARED_CONFIG_VERSION };
  if (config.setupWorktree.length > 0) document.setupWorktree = config.setupWorktree;
  if (config.setupWorktreeWait !== null) document.setupWorktreeWait = config.setupWorktreeWait;
  if (config.projectActions.length > 0) document.projectActions = sanitizeProjectActions(config.projectActions).map(withoutEmptyIcon);
  if (config.draftStarters.length > 0) document.draftStarters = config.draftStarters;
  if (config.plansDir !== null) document.plansDir = config.plansDir;
  return `${JSON.stringify(document, null, 2)}\n`;
};

/**
 * The next shared config after a client patch over the current one. Every
 * named key replaces the current value; a wrongly shaped key is a validation
 * error, and a `plansDir` outside the repo is refused rather than stored.
 */
export const applySharedProjectSetupPatch = (current, patch) => {
  if (!isObjectRecord(patch)) throw new Error('patch must be an object');
  const next = { ...current };
  if ('setupWorktree' in patch) {
    if (!Array.isArray(patch.setupWorktree)) throw new Error('setupWorktree must be an array of commands');
    next.setupWorktree = sanitizeSetupCommands(patch.setupWorktree);
  }
  if ('setupWorktreeWait' in patch) {
    if (patch.setupWorktreeWait !== null && typeof patch.setupWorktreeWait !== 'boolean') throw new Error('setupWorktreeWait must be a boolean or null');
    next.setupWorktreeWait = patch.setupWorktreeWait;
  }
  if ('projectActions' in patch) {
    if (!Array.isArray(patch.projectActions)) throw new Error('projectActions must be an array');
    next.projectActions = sanitizeProjectActions(patch.projectActions);
  }
  if ('draftStarters' in patch) {
    if (!Array.isArray(patch.draftStarters)) throw new Error('draftStarters must be an array');
    next.draftStarters = sanitizeDraftStarters(patch.draftStarters);
  }
  if ('plansDir' in patch) {
    if (patch.plansDir === null || (typeof patch.plansDir === 'string' && !patch.plansDir.trim())) {
      next.plansDir = null;
    } else {
      const plansDir = normalizePlansDir(patch.plansDir);
      if (!plansDir) throw new Error('plansDir must be a relative path inside the repository');
      next.plansDir = plansDir;
    }
  }
  return next;
};

export const EMPTY_SHARED_PROJECT_CONFIG = EMPTY_SHARED;

export const isProjectSetupValidationError = (error) => {
  const message = error instanceof Error ? error.message : '';
  return message.includes('must be') || message.includes('is required') || message.includes('unsupported characters') || message.includes('not found');
};
