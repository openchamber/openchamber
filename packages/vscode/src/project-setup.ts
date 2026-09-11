// The client-owned part of a project's config file
// (`~/.config/openchamber/projects/<projectId>.json`): worktree setup
// commands, project actions, and pinned draft starters. A mirror of the
// server's `packages/web/server/lib/projects/project-setup.js`; keep the
// sanitizing rules in sync so a value written from VS Code reads back the
// same on every other surface.
//
// Kept free of `vscode` imports so it is unit-tested directly.

import crypto from 'node:crypto';

const ACTION_NAME_MAX_LENGTH = 80;
const ACTION_COMMAND_MAX_LENGTH = 4000;
const ACTION_OPEN_URL_MAX_LENGTH = 2000;
const ACTION_DESKTOP_FORWARD_MAX_LENGTH = 300;
const SETUP_COMMAND_MAX_LENGTH = 4000;
const SETUP_COMMANDS_MAX = 50;

type ActionPlatform = 'macos' | 'linux' | 'windows';
const ACTION_PLATFORMS: ReadonlySet<string> = new Set<ActionPlatform>(['macos', 'linux', 'windows']);

export type ProjectAction = {
  id: string;
  name: string;
  command: string;
  icon: string | null;
  autoOpenUrl?: true;
  openUrl?: string;
  desktopOpenSshForward?: string;
  platforms?: ActionPlatform[];
  runIn?: 'parent';
};

export type DraftStarter = { type: 'command' | 'skill'; name: string };

export type SetupWorktreeMode = 'append' | 'replace';

/** The personal file's part of the setup; the wait flag is `null` when the file does not set it. */
export type PersonalProjectSetup = {
  setupWorktree: string[];
  setupWorktreeWait: boolean | null;
  setupWorktreeMode: SetupWorktreeMode;
  projectActions: ProjectAction[];
  projectActionsPrimaryId: string | null;
  draftStarters: DraftStarter[];
  hiddenSharedActionIds: string[];
  /** The recorded answer to the trust prompt: which shared commands were trusted, and when. */
  sharedTrust: { hash: string; trustedAt: number } | null;
};

export type SharedProjectConfig = {
  setupWorktree: string[];
  setupWorktreeWait: boolean | null;
  projectActions: ProjectAction[];
  draftStarters: DraftStarter[];
  plansDir: string | null;
};

export type SharedProjectConfigRead =
  | { status: 'missing' }
  | { status: 'ok'; config: SharedProjectConfig }
  | { status: 'invalid'; reason: string };

export type ProjectSetupSource = 'shared' | 'personal';

/** The merged view every client sees; see `mergeProjectSetup` for the rules. */
export type ProjectSetupView = {
  /** Nothing to trust when `hash` is null; otherwise trusted only for the recorded hash. */
  trust: { hash: string | null; trusted: boolean };
  setupWorktree: string[];
  setupWorktreeWait: boolean;
  projectActions: Array<ProjectAction & { source: ProjectSetupSource }>;
  projectActionsPrimaryId: string | null;
  draftStarters: Array<DraftStarter & { source: ProjectSetupSource }>;
  shared: SharedProjectConfig & { status: SharedProjectConfigRead['status']; reason?: string; path: string };
  personal: PersonalProjectSetup;
};

export const SHARED_CONFIG_RELATIVE_PATH = '.openchamber/project.json';
const SHARED_CONFIG_VERSION = 1;

/**
 * The on-disk keys this module owns inside the personal config document, as
 * a patch: a key set to `undefined` is removed from the document.
 */
type StoredProjectSetupPatch = {
  'setup-worktree'?: string[];
  'setup-worktree-wait'?: boolean;
  setupWorktreeMode?: SetupWorktreeMode;
  projectActions?: ProjectAction[];
  projectActionsPrimaryId?: string | undefined;
  draftStarters?: DraftStarter[];
  hiddenSharedActionIds?: string[];
  sharedTrust?: { hash: string; trustedAt: number } | undefined;
  projectPath?: string;
};

export class ProjectSetupValidationError extends Error {}

const isObjectRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const clamp = (value: string, maxLength: number): string => (value.length > maxLength ? value.slice(0, maxLength) : value);

const trimmedString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

export const sanitizeSetupCommands = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const commands: string[] = [];
  for (const entry of value) {
    const command = clamp(trimmedString(entry), SETUP_COMMAND_MAX_LENGTH);
    if (!command) continue;
    commands.push(command);
    if (commands.length >= SETUP_COMMANDS_MAX) break;
  }
  return commands;
};

const sanitizeActionPlatforms = (value: unknown): ActionPlatform[] => {
  if (!Array.isArray(value)) return [];
  const platforms: ActionPlatform[] = [];
  for (const entry of value) {
    const platform = trimmedString(entry).toLowerCase();
    if (!ACTION_PLATFORMS.has(platform)) continue;
    // SAFETY: membership in ACTION_PLATFORMS was just checked.
    const known = platform as ActionPlatform;
    if (!platforms.includes(known)) platforms.push(known);
  }
  return platforms;
};

export const sanitizeProjectActions = (value: unknown): ProjectAction[] => {
  if (!Array.isArray(value)) return [];
  const actions: ProjectAction[] = [];
  const seenIds = new Set<string>();
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

    const action: ProjectAction = { id, name, command, icon: icon || null };
    if (entry.autoOpenUrl === true) action.autoOpenUrl = true;
    if (openUrl) action.openUrl = openUrl;
    if (desktopOpenSshForward) action.desktopOpenSshForward = desktopOpenSshForward;
    if (platforms.length > 0) action.platforms = platforms;
    if (entry.runIn === 'parent') action.runIn = 'parent';
    actions.push(action);
  }
  return actions;
};

export const sanitizeDraftStarters = (value: unknown): DraftStarter[] => {
  if (!Array.isArray(value)) return [];
  const starters: DraftStarter[] = [];
  const seen = new Set<string>();
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

const sanitizeIdList = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  for (const entry of value) {
    const id = trimmedString(entry);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
};

const setupWorktreeModeOf = (value: unknown): SetupWorktreeMode => (value === 'replace' ? 'replace' : 'append');

/** The personal part of the view, straight from the personal file. */
export const personalProjectSetupOf = (raw: unknown): PersonalProjectSetup => {
  const document = isObjectRecord(raw) ? raw : {};
  const projectActions = sanitizeProjectActions(document.projectActions);
  const primaryRaw = trimmedString(document.projectActionsPrimaryId);
  const wait = document['setup-worktree-wait'];
  return {
    setupWorktree: sanitizeSetupCommands(document['setup-worktree']),
    setupWorktreeWait: typeof wait === 'boolean' ? wait : null,
    setupWorktreeMode: setupWorktreeModeOf(document.setupWorktreeMode),
    projectActions,
    projectActionsPrimaryId: primaryRaw && projectActions.some((action) => action.id === primaryRaw) ? primaryRaw : null,
    draftStarters: sanitizeDraftStarters(document.draftStarters),
    hiddenSharedActionIds: sanitizeIdList(document.hiddenSharedActionIds),
    sharedTrust: sharedTrustOf(document.sharedTrust),
  };
};

const sharedTrustOf = (value: unknown): PersonalProjectSetup['sharedTrust'] => {
  if (!isObjectRecord(value)) return null;
  const hash = trimmedString(value.hash);
  if (!hash) return null;
  const trustedAt = value.trustedAt;
  return { hash, trustedAt: typeof trustedAt === 'number' && Number.isFinite(trustedAt) ? trustedAt : 0 };
};

/**
 * What a trust answer covers: the shared setup commands and the shared
 * actions' commands, canonical order, hashed; `null` when nothing executes.
 */
export const sharedTrustHashOf = (shared: SharedProjectConfig): string | null => {
  const commands = shared.setupWorktree;
  const actions = shared.projectActions
    .map((action) => {
      const executable: { id: string; command: string; runIn?: 'parent' } = { id: action.id, command: action.command };
      if (action.runIn) executable.runIn = action.runIn;
      return executable;
    })
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  if (commands.length === 0 && actions.length === 0) return null;
  const digest = crypto.createHash('sha256').update(JSON.stringify({ setupWorktree: commands, projectActions: actions })).digest('hex');
  return `sha256:${digest}`;
};

/**
 * A `plansDir` is a relative path inside the repo: no absolute paths, no
 * drive letters, no `..` segments, forward slashes.
 */
export const normalizePlansDir = (value: unknown): string | null => {
  const raw = trimmedString(value).replace(/\\/g, '/');
  if (!raw) return null;
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) return null;
  const segments = raw.split('/').filter((segment) => segment.length > 0 && segment !== '.');
  if (segments.length === 0 || segments.some((segment) => segment === '..')) return null;
  return segments.join('/');
};

const EMPTY_SHARED: SharedProjectConfig = {
  setupWorktree: [],
  setupWorktreeWait: null,
  projectActions: [],
  draftStarters: [],
  plansDir: null,
};

/**
 * Parse the text of a shared file. Anything that is not a version-1 object
 * is `invalid` with a reason, never an empty config.
 */
export const parseSharedProjectConfig = (raw: string): SharedProjectConfigRead => {
  let parsed: unknown;
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
  let plansDir: string | null = null;
  if ('plansDir' in parsed && parsed.plansDir !== null) {
    plansDir = normalizePlansDir(parsed.plansDir);
    if (!plansDir) return { status: 'invalid', reason: 'plansDir must be a relative path inside the repository' };
  }
  const wait = parsed.setupWorktreeWait;
  return {
    status: 'ok',
    config: {
      setupWorktree: sanitizeSetupCommands(parsed.setupWorktree),
      setupWorktreeWait: typeof wait === 'boolean' ? wait : null,
      projectActions: sanitizeProjectActions(parsed.projectActions),
      draftStarters: sanitizeDraftStarters(parsed.draftStarters),
      plansDir,
    },
  };
};

const withSource = <T,>(entries: T[], source: ProjectSetupSource): Array<T & { source: ProjectSetupSource }> =>
  entries.map((entry) => ({ ...entry, source }));

/**
 * One merged view from the personal part and the shared read. Same rules as
 * the server: shared setup commands first (unless personal replaces), the
 * personal wait flag wins when set, actions union by id with personal
 * replacing shared and hidden shared ids dropped, starters union by key.
 */
export const mergeProjectSetup = (personal: PersonalProjectSetup, sharedRead: SharedProjectConfigRead): ProjectSetupView => {
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
    projectActions: [...withSource(sharedActions, 'shared'), ...withSource(personal.projectActions, 'personal')],
    projectActionsPrimaryId: personal.projectActionsPrimaryId,
    draftStarters: [...withSource(shared.draftStarters, 'shared'), ...withSource(personalStarters, 'personal')],
    shared: sharedBlockOf(sharedRead, shared),
    personal,
  };
};

const sharedBlockOf = (sharedRead: SharedProjectConfigRead, shared: SharedProjectConfig): ProjectSetupView['shared'] => {
  const block: ProjectSetupView['shared'] = { status: sharedRead.status, path: SHARED_CONFIG_RELATIVE_PATH, ...shared };
  if (sharedRead.status === 'invalid') block.reason = sharedRead.reason;
  return block;
};

/** An action without an icon is written without the key; readers fall back to the play icon. */
const withoutEmptyIcon = (action: ProjectAction): Omit<ProjectAction, 'icon'> & { icon?: string } => {
  const { icon, ...rest } = action;
  return icon === null ? rest : { ...rest, icon };
};

/** True when the shared config carries nothing: the file should not exist. */
export const isSharedProjectConfigEmpty = (config: SharedProjectConfig): boolean => (
  config.setupWorktree.length === 0
  && config.setupWorktreeWait === null
  && config.projectActions.length === 0
  && config.draftStarters.length === 0
  && config.plansDir === null
);

/** The bytes of a shared file: version first, only the keys that carry something, pretty-printed. */
export const serializeSharedProjectConfig = (config: SharedProjectConfig): string => {
  const document: Record<string, unknown> = { version: SHARED_CONFIG_VERSION };
  if (config.setupWorktree.length > 0) document.setupWorktree = config.setupWorktree;
  if (config.setupWorktreeWait !== null) document.setupWorktreeWait = config.setupWorktreeWait;
  if (config.projectActions.length > 0) document.projectActions = sanitizeProjectActions(config.projectActions).map(withoutEmptyIcon);
  if (config.draftStarters.length > 0) document.draftStarters = config.draftStarters;
  if (config.plansDir !== null) document.plansDir = config.plansDir;
  return `${JSON.stringify(document, null, 2)}\n`;
};

export const EMPTY_SHARED_PROJECT_CONFIG: SharedProjectConfig = EMPTY_SHARED;

/** The next shared config after a client patch over the current one; wrong shapes are validation errors. */
export const applySharedProjectSetupPatch = (current: SharedProjectConfig, patch: unknown): SharedProjectConfig => {
  if (!isObjectRecord(patch)) throw new ProjectSetupValidationError('patch must be an object');
  const next: SharedProjectConfig = { ...current };
  if ('setupWorktree' in patch) {
    if (!Array.isArray(patch.setupWorktree)) throw new ProjectSetupValidationError('setupWorktree must be an array of commands');
    next.setupWorktree = sanitizeSetupCommands(patch.setupWorktree);
  }
  if ('setupWorktreeWait' in patch) {
    const wait = patch.setupWorktreeWait;
    if (wait !== null && typeof wait !== 'boolean') throw new ProjectSetupValidationError('setupWorktreeWait must be a boolean or null');
    next.setupWorktreeWait = wait;
  }
  if ('projectActions' in patch) {
    if (!Array.isArray(patch.projectActions)) throw new ProjectSetupValidationError('projectActions must be an array');
    next.projectActions = sanitizeProjectActions(patch.projectActions);
  }
  if ('draftStarters' in patch) {
    if (!Array.isArray(patch.draftStarters)) throw new ProjectSetupValidationError('draftStarters must be an array');
    next.draftStarters = sanitizeDraftStarters(patch.draftStarters);
  }
  if ('plansDir' in patch) {
    const raw = patch.plansDir;
    if (raw === null || (typeof raw === 'string' && !raw.trim())) {
      next.plansDir = null;
    } else {
      const plansDir = normalizePlansDir(raw);
      if (!plansDir) throw new ProjectSetupValidationError('plansDir must be a relative path inside the repository');
      next.plansDir = plansDir;
    }
  }
  return next;
};

/**
 * The stored keys a client patch changes; `undefined` marks a key to remove.
 * A key with the wrong shape is a validation error, never silently dropped.
 */
export const projectSetupPatchToStored = (patch: unknown): StoredProjectSetupPatch => {
  if (!isObjectRecord(patch)) {
    throw new ProjectSetupValidationError('patch must be an object');
  }
  const stored: StoredProjectSetupPatch = {};
  if ('setupWorktree' in patch) {
    if (!Array.isArray(patch.setupWorktree)) throw new ProjectSetupValidationError('setupWorktree must be an array of commands');
    stored['setup-worktree'] = sanitizeSetupCommands(patch.setupWorktree);
  }
  if ('setupWorktreeWait' in patch) {
    if (typeof patch.setupWorktreeWait !== 'boolean') throw new ProjectSetupValidationError('setupWorktreeWait must be a boolean');
    stored['setup-worktree-wait'] = patch.setupWorktreeWait;
  }
  if ('projectActions' in patch) {
    if (!Array.isArray(patch.projectActions)) throw new ProjectSetupValidationError('projectActions must be an array');
    stored.projectActions = sanitizeProjectActions(patch.projectActions);
  }
  if ('projectActionsPrimaryId' in patch) {
    const primary = patch.projectActionsPrimaryId;
    if (primary !== null && typeof primary !== 'string') {
      throw new ProjectSetupValidationError('projectActionsPrimaryId must be a string or null');
    }
    stored.projectActionsPrimaryId = trimmedString(primary) || undefined;
  }
  if ('draftStarters' in patch) {
    if (!Array.isArray(patch.draftStarters)) throw new ProjectSetupValidationError('draftStarters must be an array');
    stored.draftStarters = sanitizeDraftStarters(patch.draftStarters);
  }
  if ('hiddenSharedActionIds' in patch) {
    if (!Array.isArray(patch.hiddenSharedActionIds)) throw new ProjectSetupValidationError('hiddenSharedActionIds must be an array');
    stored.hiddenSharedActionIds = sanitizeIdList(patch.hiddenSharedActionIds);
  }
  if ('setupWorktreeMode' in patch) {
    if (patch.setupWorktreeMode !== 'append' && patch.setupWorktreeMode !== 'replace') {
      throw new ProjectSetupValidationError('setupWorktreeMode must be "append" or "replace"');
    }
    stored.setupWorktreeMode = patch.setupWorktreeMode;
  }
  if ('sharedTrustHash' in patch) {
    const hash = patch.sharedTrustHash;
    if (hash !== null && (typeof hash !== 'string' || !hash.trim())) {
      throw new ProjectSetupValidationError('sharedTrustHash must be a non-empty string or null');
    }
    stored.sharedTrust = hash === null ? undefined : { hash: hash.trim(), trustedAt: Date.now() };
  }
  if ('projectPath' in patch) {
    if (typeof patch.projectPath !== 'string') throw new ProjectSetupValidationError('projectPath must be a string');
    const projectPath = patch.projectPath.trim();
    if (projectPath) stored.projectPath = projectPath;
  }
  return stored;
};
