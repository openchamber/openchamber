import { isRecord as isObjectRecord } from '../shared/guards.js';
import crypto from 'node:crypto';

const ACTION_NAME_MAX_LENGTH = 80;
const ACTION_COMMAND_MAX_LENGTH = 4000;
const ACTION_OPEN_URL_MAX_LENGTH = 2000;
const ACTION_DESKTOP_FORWARD_MAX_LENGTH = 300;
const SETUP_COMMAND_MAX_LENGTH = 4000;
const SETUP_COMMANDS_MAX = 50;

const ACTION_PLATFORMS = new Set(['macos', 'linux', 'windows']);
const SETUP_WORKTREE_MODES = new Set(['append', 'replace']);

const clamp = (value, maxLength) => (value.length > maxLength ? value.slice(0, maxLength) : value);

const trimmedString = (value) => (typeof value === 'string' ? value.trim() : '');

const sanitizeCreateWorktreeCommand = (value) => clamp(trimmedString(value), SETUP_COMMAND_MAX_LENGTH);

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

const sanitizeIdList = (value) => {
  if (!Array.isArray(value)) return [];
  const ids = [];
  for (const entry of value) {
    const id = trimmedString(entry);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
};

export const projectSetupViewOf = (raw) => {
  const document = isObjectRecord(raw) ? raw : {};
  const projectActions = sanitizeProjectActions(document.projectActions);
  const primaryRaw = trimmedString(document.projectActionsPrimaryId);
  return {
    setupWorktree: sanitizeSetupCommands(document['setup-worktree']),
    setupWorktreeWait: typeof document['setup-worktree-wait'] === 'boolean' ? document['setup-worktree-wait'] : null,
    setupWorktreeMode: SETUP_WORKTREE_MODES.has(document.setupWorktreeMode) ? document.setupWorktreeMode : 'append',
    teardownWorktree: sanitizeSetupCommands(document.teardownWorktree),
    createWorktreeCommand: sanitizeCreateWorktreeCommand(document.createWorktreeCommand),
    projectActions,
    projectActionsPrimaryId: primaryRaw && projectActions.some((action) => action.id === primaryRaw) ? primaryRaw : null,
    draftStarters: sanitizeDraftStarters(document.draftStarters),
    hiddenSharedActionIds: sanitizeIdList(document.hiddenSharedActionIds),
    sharedTrust: sharedTrustOf(document.sharedTrust),
    notesTodosInRepository: document.notesTodosInRepository === true,
  };
};

const sharedTrustOf = (value) => {
  if (!isObjectRecord(value)) return null;
  const hash = trimmedString(value.hash);
  if (!hash) return null;
  return { hash, trustedAt: Number.isFinite(value.trustedAt) ? value.trustedAt : 0 };
};

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
  if ('teardownWorktree' in patch) {
    if (!Array.isArray(patch.teardownWorktree)) throw new Error('teardownWorktree must be an array of commands');
    stored.teardownWorktree = sanitizeSetupCommands(patch.teardownWorktree);
  }
  if ('createWorktreeCommand' in patch) {
    if (typeof patch.createWorktreeCommand !== 'string') throw new Error('createWorktreeCommand must be a string');
    stored.createWorktreeCommand = sanitizeCreateWorktreeCommand(patch.createWorktreeCommand) || undefined;
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
  if ('notesTodosInRepository' in patch) {
    if (patch.notesTodosInRepository !== true && patch.notesTodosInRepository !== false) {
      throw new Error('notesTodosInRepository must be a boolean');
    }
    stored.notesTodosInRepository = patch.notesTodosInRepository || undefined;
  }
  if ('projectPath' in patch) {
    if (typeof patch.projectPath !== 'string') throw new Error('projectPath must be a string');
    const projectPath = patch.projectPath.trim();
    if (projectPath) stored.projectPath = projectPath;
  }
  return stored;
};

export const SHARED_CONFIG_RELATIVE_PATH = '.openchamber/project.json';
export const DEFAULT_PLANS_DIR = '.openchamber/plans';
export const NOTES_TODOS_RELATIVE_PATH = '.openchamber/notes-todos.json';
const SHARED_CONFIG_VERSION = 1;
export const SHARED_SETUP_KEYS = Object.freeze(['version', 'setupWorktree', 'setupWorktreeWait', 'teardownWorktree', 'projectActions', 'draftStarters', 'plansDir']);
const SHARED_SETUP_KEY_SET = new Set(SHARED_SETUP_KEYS);

const foreignSharedEntriesOf = (document) => (
  isObjectRecord(document) ? Object.entries(document).filter(([key]) => !SHARED_SETUP_KEY_SET.has(key)) : []
);

export const defineOwnEntry = (target, key, value) => {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
};

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
  teardownWorktree: [],
  projectActions: [],
  draftStarters: [],
  plansDir: null,
});

export const parseSharedProjectConfig = (raw) => {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { status: 'invalid', reason: `invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!isObjectRecord(parsed)) return { status: 'invalid', reason: 'not an object' };
  if (parsed.version !== SHARED_CONFIG_VERSION) return { status: 'invalid', reason: `unsupported version ${JSON.stringify(parsed.version)}` };
  const invalid = (reason) => ({ status: 'invalid', reason, document: parsed });
  if ('setupWorktree' in parsed && !Array.isArray(parsed.setupWorktree)) return invalid('setupWorktree must be an array');
  if ('setupWorktreeWait' in parsed && typeof parsed.setupWorktreeWait !== 'boolean') return invalid('setupWorktreeWait must be a boolean');
  if ('teardownWorktree' in parsed && !Array.isArray(parsed.teardownWorktree)) return invalid('teardownWorktree must be an array');
  if ('projectActions' in parsed && !Array.isArray(parsed.projectActions)) return invalid('projectActions must be an array');
  if ('draftStarters' in parsed && !Array.isArray(parsed.draftStarters)) return invalid('draftStarters must be an array');
  let plansDir = null;
  if ('plansDir' in parsed && parsed.plansDir !== null) {
    plansDir = normalizePlansDir(parsed.plansDir);
    if (!plansDir) return invalid('plansDir must be a relative path inside the repository');
  }
  return {
    status: 'ok',
    document: parsed,
    config: {
      setupWorktree: sanitizeSetupCommands(parsed.setupWorktree),
      setupWorktreeWait: typeof parsed.setupWorktreeWait === 'boolean' ? parsed.setupWorktreeWait : null,
      teardownWorktree: sanitizeSetupCommands(parsed.teardownWorktree),
      projectActions: sanitizeProjectActions(parsed.projectActions),
      draftStarters: sanitizeDraftStarters(parsed.draftStarters),
      plansDir,
    },
  };
};

const withSource = (entries, source) => entries.map((entry) => ({ ...entry, source }));

export const sharedTrustHashOf = (shared) => {
  const commands = shared.setupWorktree;
  const teardown = shared.teardownWorktree;
  const actions = shared.projectActions
    .map((action) => {
      const executable = { id: action.id, command: action.command };
      if (action.runIn) executable.runIn = action.runIn;
      return executable;
    })
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  if (commands.length === 0 && teardown.length === 0 && actions.length === 0) return null;
  const executable = teardown.length > 0
    ? { setupWorktree: commands, projectActions: actions, teardownWorktree: teardown }
    : { setupWorktree: commands, projectActions: actions };
  const digest = crypto.createHash('sha256').update(JSON.stringify(executable)).digest('hex');
  return `sha256:${digest}`;
};

export const mergeProjectSetup = (personal, sharedRead) => {
  const shared = sharedRead.status === 'ok' ? sharedRead.config : EMPTY_SHARED;
  const hidden = new Set(personal.hiddenSharedActionIds);
  const personalIds = new Set(personal.projectActions.map((action) => action.id));
  const sharedActions = shared.projectActions.filter((action) => !hidden.has(action.id) && !personalIds.has(action.id));
  const starterKeys = new Set(shared.draftStarters.map((starter) => `${starter.type}:${starter.name}`));
  const personalStarters = personal.draftStarters.filter((starter) => !starterKeys.has(`${starter.type}:${starter.name}`));
  const trustHash = sharedTrustHashOf(shared);
  return {
    trust: { hash: trustHash, trusted: trustHash === null || personal.sharedTrust?.hash === trustHash },
    setupWorktree: personal.setupWorktreeMode === 'replace'
      ? personal.setupWorktree
      : [...shared.setupWorktree, ...personal.setupWorktree],
    setupWorktreeWait: personal.setupWorktreeWait !== null
      ? personal.setupWorktreeWait
      : shared.setupWorktreeWait === true,
    teardownWorktree: [...shared.teardownWorktree, ...personal.teardownWorktree],
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

const withoutEmptyIcon = (action) => {
  if (action.icon !== null) return action;
  const { icon: _emptyIcon, ...rest } = action;
  return rest;
};

export const isSharedProjectConfigEmpty = (config, document = {}) => (
  config.setupWorktree.length === 0
  && config.setupWorktreeWait === null
  && config.teardownWorktree.length === 0
  && config.projectActions.length === 0
  && config.draftStarters.length === 0
  && config.plansDir === null
  && foreignSharedEntriesOf(document).length === 0
);

export const serializeSharedProjectConfig = (config, document = {}) => {
  const output = { version: SHARED_CONFIG_VERSION };
  if (config.setupWorktree.length > 0) output.setupWorktree = config.setupWorktree;
  if (config.setupWorktreeWait !== null) output.setupWorktreeWait = config.setupWorktreeWait;
  if (config.teardownWorktree.length > 0) output.teardownWorktree = config.teardownWorktree;
  if (config.projectActions.length > 0) output.projectActions = sanitizeProjectActions(config.projectActions).map(withoutEmptyIcon);
  if (config.draftStarters.length > 0) output.draftStarters = config.draftStarters;
  if (config.plansDir !== null) output.plansDir = config.plansDir;
  for (const [key, value] of foreignSharedEntriesOf(document)) defineOwnEntry(output, key, value);
  return `${JSON.stringify(output, null, 2)}\n`;
};

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
  if ('teardownWorktree' in patch) {
    if (!Array.isArray(patch.teardownWorktree)) throw new Error('teardownWorktree must be an array of commands');
    next.teardownWorktree = sanitizeSetupCommands(patch.teardownWorktree);
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
