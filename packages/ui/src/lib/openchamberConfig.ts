/**
 * OpenChamber project-level configuration service.
 * Stores per-project settings in ~/.config/openchamber/<projectId>.json.
 * Migrates from legacy <project>/.openchamber/openchamber.json.
 */

import type { FilesAPI, RuntimeAPIs } from './api/types';
import { getDesktopHomeDirectory } from './desktop';
import { isVSCodeRuntime } from './desktop';
import { resolveRuntimeApiBaseUrl } from '@/lib/instances/runtimeApiBaseUrl';
import { resolveSelectedInstance } from '@/stores/useInstancesStore';
import { getAccessToken } from '@/lib/auth/tokenStorage';

type ProjectRef = { id: string; path: string };

const CONFIG_FILENAME = 'openchamber.json';
// LEGACY_PROJECT_CONFIG: legacy per-project config root inside repo.
const LEGACY_CONFIG_DIR = '.openchamber';
const USER_CONFIG_DIR_SEGMENTS = ['.config', 'openchamber'];
const USER_PROJECTS_DIR_SEGMENTS = ['.config', 'openchamber', 'projects'];
const SETTINGS_FILENAME = 'settings.json';

const projectIdCache = new Map<string, string>();

const isSafeConfigFileId = (value: string): boolean => /^[A-Za-z0-9._-]+$/.test(value);

const toHex = (bytes: Uint8Array): string => {
  let out = '';
  for (const b of bytes) {
    out += b.toString(16).padStart(2, '0');
  }
  return out;
};

const sha1Hex = async (value: string): Promise<string | null> => {
  try {
    if (typeof crypto === 'undefined' || !crypto.subtle) {
      return null;
    }
    const encoder = new TextEncoder();
    const data = encoder.encode(value);
    const digest = await crypto.subtle.digest('SHA-1', data);
    return toHex(new Uint8Array(digest));
  } catch {
    return null;
  }
};

/**
 * Get the runtime Files API if available (Desktop/VSCode).
 */
function getRuntimeFilesAPI(): FilesAPI | null {
  if (typeof window === 'undefined') return null;
  const apis = (window as typeof window & { __OPENCHAMBER_RUNTIME_APIS__?: RuntimeAPIs }).__OPENCHAMBER_RUNTIME_APIS__;
  if (apis?.files) {
    return apis.files;
  }
  return null;
}

export interface OpenChamberConfig {
  'setup-worktree'?: string[];
  projectNotes?: string;
  projectTodos?: OpenChamberProjectTodoItem[];
  projectActions?: OpenChamberProjectAction[];
  projectActionsPrimaryId?: string;
}

export type OpenChamberProjectActionPlatform = 'macos' | 'linux' | 'windows';

export interface OpenChamberProjectAction {
  id: string;
  name: string;
  command: string;
  icon?: string | null;
  platforms?: OpenChamberProjectActionPlatform[];
  autoOpenUrl?: boolean;
  openUrl?: string;
  desktopOpenSshForward?: string;
}

export interface OpenChamberProjectActionsState {
  actions: OpenChamberProjectAction[];
  primaryActionId: string | null;
}

export interface OpenChamberProjectTodoItem {
  id: string;
  text: string;
  completed: boolean;
  createdAt: number;
}

export interface OpenChamberProjectNotesTodos {
  notes: string;
  todos: OpenChamberProjectTodoItem[];
}

export const OPENCHAMBER_PROJECT_NOTES_MAX_LENGTH = 1000;
export const OPENCHAMBER_PROJECT_TODO_TEXT_MAX_LENGTH = 120;
export const OPENCHAMBER_PROJECT_ACTION_NAME_MAX_LENGTH = 80;
export const OPENCHAMBER_PROJECT_ACTION_COMMAND_MAX_LENGTH = 4000;
export const OPENCHAMBER_PROJECT_ACTION_OPEN_URL_MAX_LENGTH = 2000;
export const OPENCHAMBER_PROJECT_ACTION_DESKTOP_FORWARD_MAX_LENGTH = 300;

const OPENCHAMBER_ACTION_PLATFORM_SET = new Set<OpenChamberProjectActionPlatform>(['macos', 'linux', 'windows']);

const normalize = (value: string): string => {
  if (!value) return '';
  const replaced = value.replace(/\\/g, '/');
  return replaced === '/' ? '/' : replaced.replace(/\/+$/, '');
};

const joinPath = (base: string, segment: string): string => {
  const normalizedBase = normalize(base);
  const cleanSegment = segment.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  if (!normalizedBase || normalizedBase === '/') {
    return `/${cleanSegment}`;
  }
  return `${normalizedBase}/${cleanSegment}`;
};

const getLegacyConfigPath = (projectDirectory: string): string => {
  return joinPath(joinPath(projectDirectory, LEGACY_CONFIG_DIR), CONFIG_FILENAME);
};

const getBaseUrl = (): string => {
  return resolveRuntimeApiBaseUrl();
};

const getAuthHeader = (): string | null => {
  const selectedInstance = resolveSelectedInstance();
  if (!selectedInstance) {
    return null;
  }
  const token = getAccessToken(selectedInstance.id);
  if (!token) {
    return null;
  }
  return `Bearer ${token}`;
};

const createAuthHeaders = (baseHeaders?: Record<string, string>): Record<string, string> => {
  const headers: Record<string, string> = {
    ...(baseHeaders || {}),
  };
  const authorization = getAuthHeader();
  if (authorization) {
    headers.Authorization = authorization;
  }
  return headers;
};

const postJson = async <T>(url: string, body: unknown): Promise<{ ok: boolean; data: T | null }> => {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: createAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      return { ok: false, data: null };
    }
    const data = (await response.json().catch(() => null)) as T | null;
    return { ok: true, data };
  } catch {
    return { ok: false, data: null };
  }
};

const mkdirp = async (path: string): Promise<boolean> => {
  const runtimeFiles = getRuntimeFilesAPI();
  if (runtimeFiles?.createDirectory) {
    try {
      const result = await runtimeFiles.createDirectory(path);
      if (result?.success) {
        return true;
      }
    } catch {
      // fall through
    }
  }

  const res = await postJson<{ success?: boolean }>(`${getBaseUrl()}/fs/mkdir`, { path });
  return Boolean(res.ok);
};

const readTextFile = async (path: string): Promise<string | null> => {
  const runtimeFiles = getRuntimeFilesAPI();
  if (runtimeFiles?.readFile) {
    try {
      const result = await runtimeFiles.readFile(path);
      const content = typeof result?.content === 'string' ? result.content : '';
      return content;
    } catch {
      return null;
    }
  }

  try {
    const response = await fetch(`${getBaseUrl()}/fs/read?path=${encodeURIComponent(path)}`, {
      headers: createAuthHeaders(),
    });
    if (!response.ok) {
      return null;
    }
    return await response.text();
  } catch {
    return null;
  }
};

const writeTextFile = async (path: string, content: string): Promise<boolean> => {
  const runtimeFiles = getRuntimeFilesAPI();
  if (runtimeFiles?.writeFile) {
    try {
      const result = await runtimeFiles.writeFile(path, content);
      if (result?.success) {
        return true;
      }
    } catch {
      // fall through
    }
  }

  const res = await postJson<{ success?: boolean }>(`${getBaseUrl()}/fs/write`, { path, content });
  return Boolean(res.ok);
};

const resolveHomeDirectory = async (): Promise<string | null> => {
  // VSCode webview sets __OPENCHAMBER_HOME__ to workspace folder (not OS home).
  // For user config (~/.config/openchamber), always use /api/fs/home in VSCode.
  if (!isVSCodeRuntime()) {
    const desktopHome = await getDesktopHomeDirectory().catch(() => null);
    if (desktopHome && desktopHome.trim().length > 0) {
      return normalize(desktopHome);
    }
  }

  try {
    const response = await fetch(`${getBaseUrl()}/fs/home`, {
      headers: createAuthHeaders(),
    });
    if (!response.ok) {
      return null;
    }
    const payload = await response.json().catch(() => null) as { home?: unknown } | null;
    const home = typeof payload?.home === 'string' ? payload.home.trim() : '';
    return home ? normalize(home) : null;
  } catch {
    return null;
  }
};

const getUserConfigRootDirectory = async (): Promise<string | null> => {
  const home = await resolveHomeDirectory();
  if (!home) {
    return null;
  }
  return USER_CONFIG_DIR_SEGMENTS.reduce((acc, segment) => joinPath(acc, segment), home);
};

const getUserProjectsDirectory = async (): Promise<string | null> => {
  const home = await resolveHomeDirectory();
  if (!home) {
    return null;
  }
  return USER_PROJECTS_DIR_SEGMENTS.reduce((acc, segment) => joinPath(acc, segment), home);
};

const getSettingsPath = async (): Promise<string | null> => {
  const base = await getUserConfigRootDirectory();
  if (!base) {
    return null;
  }
  return joinPath(base, SETTINGS_FILENAME);
};

const resolveConfigProjectId = async (project: ProjectRef): Promise<string | null> => {
  const projectDirectory = typeof project?.path === 'string' ? project.path.trim() : '';
  const normalizedProject = projectDirectory ? normalize(projectDirectory) : '';

  const explicitId = typeof project?.id === 'string' ? project.id.trim() : '';
  if (explicitId && isSafeConfigFileId(explicitId)) {
    return explicitId;
  }

  if (normalizedProject) {
    const cached = projectIdCache.get(normalizedProject);
    if (cached) {
      return cached;
    }
  }

  // Best-effort map project directory -> persisted project id from settings.json.
  const settingsPath = await getSettingsPath();
  if (settingsPath && normalizedProject) {
    const raw = await readTextFile(settingsPath);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { projects?: unknown };
        const projects = Array.isArray(parsed?.projects) ? parsed.projects : [];
        for (const entry of projects) {
          if (!entry || typeof entry !== 'object') continue;
          const record = entry as { id?: unknown; path?: unknown };
          const id = typeof record.id === 'string' ? record.id.trim() : '';
          const path = typeof record.path === 'string' ? normalize(record.path.trim()) : '';
          if (id && isSafeConfigFileId(id) && path && path === normalizedProject) {
            projectIdCache.set(normalizedProject, id);
            return id;
          }
        }
      } catch {
        // ignore
      }
    }
  }

  // Fallback: stable id derived from path (used in VSCode when project isn't registered).
  if (normalizedProject) {
    const digest = await sha1Hex(normalizedProject);
    const fallback = digest ? `path_${digest}` : `path_${normalizedProject.replace(/[^A-Za-z0-9._-]+/g, '_')}`;
    projectIdCache.set(normalizedProject, fallback);
    return fallback;
  }

  return null;
};

const getUserConfigPath = async (project: ProjectRef): Promise<string | null> => {
  const base = await getUserProjectsDirectory();
  if (!base) {
    return null;
  }
  const safeId = await resolveConfigProjectId(project);
  if (!safeId) {
    return null;
  }
  return joinPath(base, `${safeId}.json`);
};

const trimToMaxLength = (value: string, maxLength: number): string => {
  if (value.length <= maxLength) {
    return value;
  }
  return value.slice(0, maxLength);
};

const sanitizeProjectNotes = (value: unknown): string => {
  if (typeof value !== 'string') {
    return '';
  }
  return trimToMaxLength(value, OPENCHAMBER_PROJECT_NOTES_MAX_LENGTH);
};

const sanitizeProjectTodoItems = (value: unknown): OpenChamberProjectTodoItem[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  const sanitized: OpenChamberProjectTodoItem[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }

    const record = entry as {
      id?: unknown;
      text?: unknown;
      completed?: unknown;
      createdAt?: unknown;
    };

    const id = typeof record.id === 'string' ? record.id.trim() : '';
    const textRaw = typeof record.text === 'string' ? record.text : '';
    const text = trimToMaxLength(textRaw.trim(), OPENCHAMBER_PROJECT_TODO_TEXT_MAX_LENGTH);
    if (!id || !text) {
      continue;
    }

    const completed = Boolean(record.completed);
    const createdAt =
      typeof record.createdAt === 'number' && Number.isFinite(record.createdAt) && record.createdAt >= 0
        ? record.createdAt
        : Date.now();

    sanitized.push({
      id,
      text,
      completed,
      createdAt,
    });

  }

  return sanitized;
};

const sanitizeProjectActionPlatforms = (value: unknown): OpenChamberProjectActionPlatform[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  const unique: OpenChamberProjectActionPlatform[] = [];
  const seen = new Set<OpenChamberProjectActionPlatform>();
  for (const entry of value) {
    if (typeof entry !== 'string') {
      continue;
    }
    const normalized = entry.trim().toLowerCase() as OpenChamberProjectActionPlatform;
    if (!OPENCHAMBER_ACTION_PLATFORM_SET.has(normalized) || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    unique.push(normalized);
  }

  return unique;
};

const sanitizeProjectActions = (value: unknown): OpenChamberProjectAction[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  const sanitized: OpenChamberProjectAction[] = [];
  const seenIds = new Set<string>();

  for (const entry of value) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }

    const record = entry as {
      id?: unknown;
      name?: unknown;
      command?: unknown;
      icon?: unknown;
      platforms?: unknown;
      autoOpenUrl?: unknown;
      openUrl?: unknown;
      desktopOpenSshForward?: unknown;
    };

    const id = typeof record.id === 'string' ? record.id.trim() : '';
    const name = trimToMaxLength(typeof record.name === 'string' ? record.name.trim() : '', OPENCHAMBER_PROJECT_ACTION_NAME_MAX_LENGTH);
    const command = trimToMaxLength(typeof record.command === 'string' ? record.command.trim() : '', OPENCHAMBER_PROJECT_ACTION_COMMAND_MAX_LENGTH);

    if (!id || !name || !command || seenIds.has(id)) {
      continue;
    }
    seenIds.add(id);

    const iconRaw = typeof record.icon === 'string' ? record.icon.trim() : '';
    const platforms = sanitizeProjectActionPlatforms(record.platforms);
    const autoOpenUrl = record.autoOpenUrl === true;
    const openUrlRaw = typeof record.openUrl === 'string' ? record.openUrl.trim() : '';
    const openUrl = trimToMaxLength(openUrlRaw, OPENCHAMBER_PROJECT_ACTION_OPEN_URL_MAX_LENGTH);
    const desktopOpenSshForwardRaw = typeof record.desktopOpenSshForward === 'string'
      ? record.desktopOpenSshForward.trim()
      : '';
    const desktopOpenSshForward = trimToMaxLength(
      desktopOpenSshForwardRaw,
      OPENCHAMBER_PROJECT_ACTION_DESKTOP_FORWARD_MAX_LENGTH
    );

    sanitized.push({
      id,
      name,
      command,
      icon: iconRaw || null,
      ...(autoOpenUrl ? { autoOpenUrl: true } : {}),
      ...(openUrl ? { openUrl } : {}),
      ...(desktopOpenSshForward ? { desktopOpenSshForward } : {}),
      ...(platforms.length > 0 ? { platforms } : {}),
    });
  }

  return sanitized;
};

const sanitizeProjectActionsState = (value: {
  actions?: unknown;
  primaryActionId?: unknown;
} | null | undefined): OpenChamberProjectActionsState => {
  const actions = sanitizeProjectActions(value?.actions);
  const primaryRaw = typeof value?.primaryActionId === 'string' ? value.primaryActionId.trim() : '';
  const primaryActionId = primaryRaw && actions.some((entry) => entry.id === primaryRaw)
    ? primaryRaw
    : null;

  return {
    actions,
    primaryActionId,
  };
};

const sanitizeProjectNotesAndTodos = (value: {
  notes?: unknown;
  todos?: unknown;
} | null | undefined): OpenChamberProjectNotesTodos => {
  return {
    notes: sanitizeProjectNotes(value?.notes),
    todos: sanitizeProjectTodoItems(value?.todos),
  };
};

/**
 * Read the config for a project.
 * Returns null if file doesn't exist or is invalid.
 */
export async function readOpenChamberConfig(project: ProjectRef): Promise<OpenChamberConfig | null> {
  const projectDirectory = typeof project?.path === 'string' ? project.path.trim() : '';
  if (!projectDirectory) {
    return null;
  }

  const configPath = await getUserConfigPath(project);

  const readText = async (path: string): Promise<string | null> => {
    // Keep behavior consistent with other helpers.
    const text = await readTextFile(path);
    if (text === null) {
      return null;
    }
    return text;
  };

  const parseConfig = (text: string | null): OpenChamberConfig | null => {
    if (typeof text !== 'string') {
      return null;
    }
    const trimmed = text.trim();
    if (!trimmed) {
      return null;
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== 'object') {
        return null;
      }
      return parsed as OpenChamberConfig;
    } catch {
      return null;
    }
  };

  // 1) Prefer new per-user config.
  if (configPath) {
    const existing = parseConfig(await readText(configPath));
    if (existing) {
      return existing;
    }
  }

  // 2) Migrate legacy <project>/.openchamber/openchamber.json.
  // LEGACY_PROJECT_CONFIG: migrate project-local openchamber.json -> ~/.config/openchamber/projects/<projectId>.json
  const legacyPath = getLegacyConfigPath(projectDirectory);
  const legacyConfig = parseConfig(await readText(legacyPath));
  if (!legacyConfig) {
    return null;
  }

  // Best-effort write + delete legacy.
  try {
    const wrote = await writeOpenChamberConfig(project, legacyConfig);
    if (wrote) {
      await deleteLegacyOpenChamberConfig(projectDirectory);
    }
  } catch {
    // Ignore migration failures; still return legacy content.
  }

  return legacyConfig;
}

/**
 * Write the per-user config for a project.
 */
export async function writeOpenChamberConfig(
  project: ProjectRef,
  config: OpenChamberConfig
): Promise<boolean> {
  const projectDirectory = typeof project?.path === 'string' ? project.path.trim() : '';
  if (!projectDirectory) {
    return false;
  }

  const configDir = await getUserProjectsDirectory();
  const configPath = await getUserConfigPath(project);
  if (!configDir || !configPath) {
    return false;
  }

  try {
    // Ensure user config directory exists.
    const okDir = await mkdirp(configDir);
    if (!okDir) {
      return false;
    }

    const content = JSON.stringify(config, null, 2);
    return await writeTextFile(configPath, content);
  } catch (error) {
    console.error('Failed to write openchamber config:', error);
    return false;
  }
}

/**
 * Update specific keys in the config, preserving other values.
 */
export async function updateOpenChamberConfig(
  project: ProjectRef,
  updates: Partial<OpenChamberConfig>
): Promise<boolean> {
  const existing = await readOpenChamberConfig(project) || {};
  const merged = { ...existing, ...updates };
  return writeOpenChamberConfig(project, merged);
}

/**
 * Get worktree setup commands from config.
 */
export async function getWorktreeSetupCommands(project: ProjectRef): Promise<string[]> {
  const config = await readOpenChamberConfig(project);
  return config?.['setup-worktree'] ?? [];
}

export async function saveWorktreeSetupCommands(project: ProjectRef, commands: string[]): Promise<boolean> {
  const filtered = commands.filter((cmd) => cmd.trim().length > 0);
  return updateOpenChamberConfig(project, { 'setup-worktree': filtered });
}

export async function getProjectNotesAndTodos(project: ProjectRef): Promise<OpenChamberProjectNotesTodos> {
  const config = await readOpenChamberConfig(project);
  return sanitizeProjectNotesAndTodos({
    notes: config?.projectNotes,
    todos: config?.projectTodos,
  });
}

export async function saveProjectNotesAndTodos(
  project: ProjectRef,
  value: OpenChamberProjectNotesTodos
): Promise<boolean> {
  const sanitized = sanitizeProjectNotesAndTodos({
    notes: value.notes,
    todos: value.todos,
  });

  return updateOpenChamberConfig(project, {
    projectNotes: sanitized.notes,
    projectTodos: sanitized.todos,
  });
}

export async function getProjectActionsState(project: ProjectRef): Promise<OpenChamberProjectActionsState> {
  const config = await readOpenChamberConfig(project);
  return sanitizeProjectActionsState({
    actions: config?.projectActions,
    primaryActionId: config?.projectActionsPrimaryId,
  });
}

export async function saveProjectActionsState(
  project: ProjectRef,
  value: OpenChamberProjectActionsState
): Promise<boolean> {
  const sanitized = sanitizeProjectActionsState({
    actions: value.actions,
    primaryActionId: value.primaryActionId,
  });

  return updateOpenChamberConfig(project, {
    projectActions: sanitized.actions,
    projectActionsPrimaryId: sanitized.primaryActionId ?? undefined,
  });
}

/**
 * Substitute variables in a command string.
 * Supported variables:
 * - $ROOT_PROJECT_PATH: The root project directory path
 * - $ROOT_WORKTREE_PATH: Legacy alias for $ROOT_PROJECT_PATH
 */
export function substituteCommandVariables(
  command: string,
  variables: { rootWorktreePath: string }
): string {
  return command
    // New preferred name
    .replace(/\$ROOT_PROJECT_PATH/g, variables.rootWorktreePath)
    .replace(/\$\{ROOT_PROJECT_PATH\}/g, variables.rootWorktreePath)
    // Legacy
    .replace(/\$ROOT_WORKTREE_PATH/g, variables.rootWorktreePath)
    .replace(/\$\{ROOT_WORKTREE_PATH\}/g, variables.rootWorktreePath);
}

async function deleteLegacyOpenChamberConfig(projectDirectory: string): Promise<void> {
  const legacyPath = getLegacyConfigPath(projectDirectory);
  const runtimeFiles = getRuntimeFilesAPI();

  if (runtimeFiles?.delete) {
    try {
      await runtimeFiles.delete(legacyPath);
      return;
    } catch {
      // fall through
    }
  }

  try {
    await postJson(`${getBaseUrl()}/fs/delete`, { path: legacyPath });
  } catch {
    // ignored
  }
}

export type { ProjectRef };
