
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

export type PersonalProjectSetup = {
  setupWorktree: string[];
  setupWorktreeWait: boolean | null;
  setupWorktreeMode: SetupWorktreeMode;
  teardownWorktree: string[];
  createWorktreeCommand: string;
  projectActions: ProjectAction[];
  projectActionsPrimaryId: string | null;
  draftStarters: DraftStarter[];
  hiddenSharedActionIds: string[];
  sharedTrust: { hash: string; trustedAt: number } | null;
  notesTodosInRepository: boolean;
};

export type SharedProjectConfig = {
  setupWorktree: string[];
  setupWorktreeWait: boolean | null;
  teardownWorktree: string[];
  projectActions: ProjectAction[];
  draftStarters: DraftStarter[];
  plansDir: string | null;
};

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

const isJsonObject = (value: JsonValue | undefined): value is JsonObject =>
  value instanceof Object && !Array.isArray(value);

export type SharedProjectConfigRead =
  | { status: 'missing' }
  | { status: 'ok'; config: SharedProjectConfig; document: JsonObject }
  | { status: 'invalid'; reason: string; document?: JsonObject };

export type ProjectSetupSource = 'shared' | 'personal';

export type ProjectSetupView = {
  trust: { hash: string | null; trusted: boolean };
  setupWorktree: string[];
  setupWorktreeWait: boolean;
  teardownWorktree: string[];
  projectActions: Array<ProjectAction & { source: ProjectSetupSource }>;
  projectActionsPrimaryId: string | null;
  draftStarters: Array<DraftStarter & { source: ProjectSetupSource }>;
  shared: SharedProjectConfig & { status: SharedProjectConfigRead['status']; reason?: string; path: string };
  personal: PersonalProjectSetup;
};

export const SHARED_CONFIG_RELATIVE_PATH = '.openchamber/project.json';
const SHARED_CONFIG_VERSION = 1;

export const SHARED_SETUP_KEYS: readonly string[] = Object.freeze(['version', 'setupWorktree', 'setupWorktreeWait', 'teardownWorktree', 'projectActions', 'draftStarters', 'plansDir']);
const SHARED_SETUP_KEY_SET: ReadonlySet<string> = new Set(SHARED_SETUP_KEYS);

type StoredProjectSetupPatch = {
  'setup-worktree'?: string[];
  'setup-worktree-wait'?: boolean;
  setupWorktreeMode?: SetupWorktreeMode;
  teardownWorktree?: string[];
  createWorktreeCommand?: string | undefined;
  projectActions?: ProjectAction[];
  projectActionsPrimaryId?: string | undefined;
  draftStarters?: DraftStarter[];
  hiddenSharedActionIds?: string[];
  sharedTrust?: { hash: string; trustedAt: number } | undefined;
  notesTodosInRepository?: true | undefined;
  projectPath?: string;
};

export class ProjectSetupValidationError extends Error {}

const isObjectRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const clamp = (value: string, maxLength: number): string => (value.length > maxLength ? value.slice(0, maxLength) : value);

const trimmedString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const sanitizeCreateWorktreeCommand = (value: string): string => clamp(value.trim(), SETUP_COMMAND_MAX_LENGTH);

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

export const personalProjectSetupOf = (raw: unknown): PersonalProjectSetup => {
  const document = isObjectRecord(raw) ? raw : {};
  const projectActions = sanitizeProjectActions(document.projectActions);
  const primaryRaw = trimmedString(document.projectActionsPrimaryId);
  const wait = document['setup-worktree-wait'];
  return {
    setupWorktree: sanitizeSetupCommands(document['setup-worktree']),
    setupWorktreeWait: typeof wait === 'boolean' ? wait : null,
    setupWorktreeMode: setupWorktreeModeOf(document.setupWorktreeMode),
    teardownWorktree: sanitizeSetupCommands(document.teardownWorktree),
    createWorktreeCommand: sanitizeCreateWorktreeCommand(trimmedString(document.createWorktreeCommand)),
    projectActions,
    projectActionsPrimaryId: primaryRaw && projectActions.some((action) => action.id === primaryRaw) ? primaryRaw : null,
    draftStarters: sanitizeDraftStarters(document.draftStarters),
    hiddenSharedActionIds: sanitizeIdList(document.hiddenSharedActionIds),
    sharedTrust: sharedTrustOf(document.sharedTrust),
    notesTodosInRepository: document.notesTodosInRepository === true,
  };
};

const sharedTrustOf = (value: unknown): PersonalProjectSetup['sharedTrust'] => {
  if (!isObjectRecord(value)) return null;
  const hash = trimmedString(value.hash);
  if (!hash) return null;
  const trustedAt = value.trustedAt;
  return { hash, trustedAt: typeof trustedAt === 'number' && Number.isFinite(trustedAt) ? trustedAt : 0 };
};

export const sharedTrustHashOf = (shared: SharedProjectConfig): string | null => {
  const commands = shared.setupWorktree;
  const teardown = shared.teardownWorktree;
  const actions = shared.projectActions
    .map((action) => {
      const executable: { id: string; command: string; runIn?: 'parent' } = { id: action.id, command: action.command };
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
  teardownWorktree: [],
  projectActions: [],
  draftStarters: [],
  plansDir: null,
};

export const parseSharedProjectConfig = (raw: string): SharedProjectConfigRead => {
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { status: 'invalid', reason: `invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!isJsonObject(parsed)) return { status: 'invalid', reason: 'not an object' };
  const document = parsed;
  if (parsed.version !== SHARED_CONFIG_VERSION) return { status: 'invalid', reason: `unsupported version ${JSON.stringify(parsed.version)}` };
  const invalid = (reason: string): SharedProjectConfigRead => ({ status: 'invalid', reason, document });
  if ('setupWorktree' in parsed && !Array.isArray(parsed.setupWorktree)) return invalid('setupWorktree must be an array');
  if ('setupWorktreeWait' in parsed && typeof parsed.setupWorktreeWait !== 'boolean') return invalid('setupWorktreeWait must be a boolean');
  if ('teardownWorktree' in parsed && !Array.isArray(parsed.teardownWorktree)) return invalid('teardownWorktree must be an array');
  if ('projectActions' in parsed && !Array.isArray(parsed.projectActions)) return invalid('projectActions must be an array');
  if ('draftStarters' in parsed && !Array.isArray(parsed.draftStarters)) return invalid('draftStarters must be an array');
  let plansDir: string | null = null;
  if ('plansDir' in parsed && parsed.plansDir !== null) {
    plansDir = normalizePlansDir(parsed.plansDir);
    if (!plansDir) return invalid('plansDir must be a relative path inside the repository');
  }
  const wait = parsed.setupWorktreeWait;
  return {
    status: 'ok',
    document,
    config: {
      setupWorktree: sanitizeSetupCommands(parsed.setupWorktree),
      setupWorktreeWait: typeof wait === 'boolean' ? wait : null,
      teardownWorktree: sanitizeSetupCommands(parsed.teardownWorktree),
      projectActions: sanitizeProjectActions(parsed.projectActions),
      draftStarters: sanitizeDraftStarters(parsed.draftStarters),
      plansDir,
    },
  };
};

const withSource = <T,>(entries: T[], source: ProjectSetupSource): Array<T & { source: ProjectSetupSource }> =>
  entries.map((entry) => ({ ...entry, source }));

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
    teardownWorktree: [...shared.teardownWorktree, ...personal.teardownWorktree],
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

const withoutEmptyIcon = (action: ProjectAction): Omit<ProjectAction, 'icon'> & { icon?: string } => {
  const { icon, ...rest } = action;
  return icon === null ? rest : { ...rest, icon };
};

const foreignSharedEntriesOf = (document: JsonObject): Array<[string, JsonValue]> => (
  Object.entries(document).filter(([key]) => !SHARED_SETUP_KEY_SET.has(key))
);

export const isSharedProjectConfigEmpty = (config: SharedProjectConfig, document: JsonObject = {}): boolean => (
  config.setupWorktree.length === 0
  && config.setupWorktreeWait === null
  && config.teardownWorktree.length === 0
  && config.projectActions.length === 0
  && config.draftStarters.length === 0
  && config.plansDir === null
  && foreignSharedEntriesOf(document).length === 0
);

export const serializeSharedProjectConfig = (config: SharedProjectConfig, document: JsonObject = {}): string => {
  const output: Record<string, unknown> = { version: SHARED_CONFIG_VERSION };
  if (config.setupWorktree.length > 0) output.setupWorktree = config.setupWorktree;
  if (config.setupWorktreeWait !== null) output.setupWorktreeWait = config.setupWorktreeWait;
  if (config.teardownWorktree.length > 0) output.teardownWorktree = config.teardownWorktree;
  if (config.projectActions.length > 0) output.projectActions = sanitizeProjectActions(config.projectActions).map(withoutEmptyIcon);
  if (config.draftStarters.length > 0) output.draftStarters = config.draftStarters;
  if (config.plansDir !== null) output.plansDir = config.plansDir;
  for (const [key, value] of foreignSharedEntriesOf(document)) {
    Object.defineProperty(output, key, { value, enumerable: true, writable: true, configurable: true });
  }
  return `${JSON.stringify(output, null, 2)}\n`;
};

export const EMPTY_SHARED_PROJECT_CONFIG: SharedProjectConfig = EMPTY_SHARED;

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
  if ('teardownWorktree' in patch) {
    if (!Array.isArray(patch.teardownWorktree)) throw new ProjectSetupValidationError('teardownWorktree must be an array of commands');
    next.teardownWorktree = sanitizeSetupCommands(patch.teardownWorktree);
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
  if ('teardownWorktree' in patch) {
    if (!Array.isArray(patch.teardownWorktree)) throw new ProjectSetupValidationError('teardownWorktree must be an array of commands');
    stored.teardownWorktree = sanitizeSetupCommands(patch.teardownWorktree);
  }
  if ('createWorktreeCommand' in patch) {
    if (typeof patch.createWorktreeCommand !== 'string') throw new ProjectSetupValidationError('createWorktreeCommand must be a string');
    stored.createWorktreeCommand = sanitizeCreateWorktreeCommand(patch.createWorktreeCommand) || undefined;
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
  if ('notesTodosInRepository' in patch) {
    if (patch.notesTodosInRepository !== true && patch.notesTodosInRepository !== false) {
      throw new ProjectSetupValidationError('notesTodosInRepository must be a boolean');
    }
    stored.notesTodosInRepository = patch.notesTodosInRepository || undefined;
  }
  if ('projectPath' in patch) {
    if (typeof patch.projectPath !== 'string') throw new ProjectSetupValidationError('projectPath must be a string');
    const projectPath = patch.projectPath.trim();
    if (projectPath) stored.projectPath = projectPath;
  }
  return stored;
};
