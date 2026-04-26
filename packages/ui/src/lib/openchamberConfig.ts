/**
 * OpenChamber project-level configuration service.
 * Stores per-project settings in ~/.config/openchamber/<projectId>.json.
 * Migrates from legacy <project>/.openchamber/openchamber.json.
 */

import type { FilesAPI, RuntimeAPIs } from './api/types';
import { getDesktopHomeDirectory } from './desktop';
import { isVSCodeRuntime } from './desktop';
import { createProjectIdFromPath } from './projectId';

type ProjectRef = { id: string; path: string };

const CONFIG_FILENAME = 'openchamber.json';
// LEGACY_PROJECT_CONFIG: legacy per-project config root inside repo.
const LEGACY_CONFIG_DIR = '.openchamber';
const USER_PROJECTS_DIR_SEGMENTS = ['.config', 'openchamber', 'projects'];

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
  projectPath?: string;
  'setup-worktree'?: string[];
  projectNotes?: string;
  projectTodos?: OpenChamberProjectTodoItem[];
  projectPlanFiles?: OpenChamberProjectPlanFileLink[];
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

export interface OpenChamberProjectPlanFileLink {
  id: string;
  path: string;
  createdAt: number;
}

export interface OpenChamberProjectPlanFile {
  title: string;
  body: string;
  raw: string;
  path: string;
}

export interface OpenChamberProjectNotesTodos {
  notes: string;
  todos: OpenChamberProjectTodoItem[];
}

export interface OpenChamberProjectContextData extends OpenChamberProjectNotesTodos {
  plans: OpenChamberProjectPlanFileLink[];
}

export const OPENCHAMBER_PROJECT_NOTES_MAX_LENGTH = 1000;
export const OPENCHAMBER_PROJECT_TODO_TEXT_MAX_LENGTH = 120;
export const OPENCHAMBER_PROJECT_ACTION_NAME_MAX_LENGTH = 80;
export const OPENCHAMBER_PROJECT_ACTION_COMMAND_MAX_LENGTH = 4000;
export const OPENCHAMBER_PROJECT_ACTION_OPEN_URL_MAX_LENGTH = 2000;
export const OPENCHAMBER_PROJECT_ACTION_DESKTOP_FORWARD_MAX_LENGTH = 300;
export const OPENCHAMBER_PROJECT_PLAN_TITLE_MAX_LENGTH = 160;

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
  const defaultBaseUrl = import.meta.env.VITE_OPENCODE_URL || '/api';
  if (defaultBaseUrl.startsWith('/')) {
    return defaultBaseUrl;
  }
  return defaultBaseUrl;
};

const postJson = async <T>(url: string, body: unknown): Promise<{ ok: boolean; data: T | null }> => {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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

const readTextFile = async (path: string, directory?: string | null): Promise<string | null> => {
  // Always use the direct fetch path with allowMissing=true so the server returns
  // 204 (not 404) for missing config files, avoiding noisy browser console errors.
  // The runtime files API (runtimeFiles.readFile) does not support allowMissing and
  // would trigger a 404 that shows as a red error in the console even though we
  // catch it here.
  try {
    const normalizedDirectory = typeof directory === 'string' ? directory.trim() : '';
    const queryParams = new URLSearchParams({ path, allowMissing: 'true' });
    if (normalizedDirectory) {
      queryParams.set('directory', normalizedDirectory);
    }
    const response = await fetch(`${getBaseUrl()}/fs/read?${queryParams.toString()}`, {
      headers: normalizedDirectory ? { 'x-opencode-directory': normalizedDirectory } : undefined,
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
  // Use server-reported home as the source of truth for user config paths.
  // In some runtimes, window.__OPENCHAMBER_HOME__ can be workspace/project-root
  // scoped, which would incorrectly route writes into the project directory.
  try {
    const response = await fetch(`${getBaseUrl()}/fs/home`);
    if (!response.ok) {
      throw new Error('Failed to resolve home directory from API');
    }
    const payload = await response.json().catch(() => null) as { home?: unknown } | null;
    const home = typeof payload?.home === 'string' ? payload.home.trim() : '';
    if (home) {
      return normalize(home);
    }
  } catch {
    // fall through
  }

  // Fallback for environments where /api/fs/home is unavailable.
  // VSCode intentionally avoids this because embedded home equals workspace path.
  if (!isVSCodeRuntime()) {
    const desktopHome = await getDesktopHomeDirectory().catch(() => null);
    if (desktopHome && desktopHome.trim().length > 0) {
      return normalize(desktopHome);
    }
  }
  return null;
};

const getUserProjectsDirectory = async (): Promise<string | null> => {
  const home = await resolveHomeDirectory();
  if (!home) {
    return null;
  }
  return USER_PROJECTS_DIR_SEGMENTS.reduce((acc, segment) => joinPath(acc, segment), home);
};

const resolveConfigProjectId = (project: ProjectRef): string | null => {
  const projectDirectory = typeof project?.path === 'string' ? project.path.trim() : '';
  const normalizedProject = projectDirectory ? normalize(projectDirectory) : '';
  if (!normalizedProject) return null;
  return createProjectIdFromPath(normalizedProject) || null;
};

const getUserConfigPath = async (project: ProjectRef): Promise<string | null> => {
  const base = await getUserProjectsDirectory();
  if (!base) {
    return null;
  }
  const safeId = resolveConfigProjectId(project);
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

const sanitizeProjectPlanFileLinks = (value: unknown): OpenChamberProjectPlanFileLink[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  const sanitized: OpenChamberProjectPlanFileLink[] = [];
  const seenIds = new Set<string>();

  for (const entry of value) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }

    const record = entry as {
      id?: unknown;
      path?: unknown;
      createdAt?: unknown;
    };

    const id = typeof record.id === 'string' ? record.id.trim() : '';
    const path = typeof record.path === 'string' ? record.path.trim() : '';
    const createdAt =
      typeof record.createdAt === 'number' && Number.isFinite(record.createdAt) && record.createdAt >= 0
        ? record.createdAt
        : Date.now();

    if (!id || !path || seenIds.has(id)) {
      continue;
    }

    seenIds.add(id);
    sanitized.push({ id, path, createdAt });
  }

  return sanitized.sort((a, b) => b.createdAt - a.createdAt);
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

const sanitizeProjectContextData = (value: {
  notes?: unknown;
  todos?: unknown;
  plans?: unknown;
} | null | undefined): OpenChamberProjectContextData => {
  const notesAndTodos = sanitizeProjectNotesAndTodos(value);
  return {
    ...notesAndTodos,
    plans: sanitizeProjectPlanFileLinks(value?.plans),
  };
};

const slugifyPlanTitle = (value: string): string => {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[`*_#>[\](){}.!?,:;"']/g, '')
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

  return normalized || 'plan';
};

const sanitizePlanTitle = (value: string): string => {
  return trimToMaxLength(value.trim(), OPENCHAMBER_PROJECT_PLAN_TITLE_MAX_LENGTH);
};

const createProjectPlanId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `plan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
};

const getProjectStorageDirectory = async (project: ProjectRef): Promise<string | null> => {
  const base = await getUserProjectsDirectory();
  const safeId = resolveConfigProjectId(project);
  if (!base || !safeId) {
    return null;
  }
  return joinPath(base, safeId);
};

const getProjectPlansDirectory = async (project: ProjectRef): Promise<string | null> => {
  const projectDirectory = await getProjectStorageDirectory(project);
  if (!projectDirectory) {
    return null;
  }
  return joinPath(projectDirectory, 'plans');
};

export const formatProjectPlanMarkdown = (title: string, body: string): string => {
  const normalizedTitle = sanitizePlanTitle(title) || 'Plan';
  const normalizedBody = body.trim();
  return normalizedBody
    ? `# ${normalizedTitle}\n\n${normalizedBody}`
    : `# ${normalizedTitle}\n`;
};

export const parseProjectPlanMarkdown = (raw: string): { title: string; body: string } => {
  const text = typeof raw === 'string' ? raw : '';
  const normalized = text.replace(/\r\n?/g, '\n');
  const match = normalized.match(/^\s*#\s+(.+?)\s*(?:\n+|$)/);
  if (match) {
    const title = sanitizePlanTitle(match[1]);
    const body = normalized.slice(match[0].length).replace(/^\n+/, '');
    return {
      title: title || 'Plan',
      body,
    };
  }

  const firstNonEmptyLine = normalized.split('\n').map((line) => line.trim()).find(Boolean) || 'Plan';
  return {
    title: sanitizePlanTitle(firstNonEmptyLine.replace(/^#+\s*/, '')) || 'Plan',
    body: normalized.trim(),
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

  const readText = async (path: string, directory?: string | null): Promise<string | null> => {
    // Keep behavior consistent with other helpers.
    const text = await readTextFile(path, directory);
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
  const legacyConfig = parseConfig(await readText(legacyPath, projectDirectory));
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
 *
 * Server owns `version` and `scheduledTasks` keys; client reads them via their
 * dedicated route and never round-trips them through this config write path to
 * avoid a read-then-write race clobbering a concurrent server update.
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
    const okDir = await mkdirp(configDir);
    if (!okDir) {
      return false;
    }

    const existingRaw = await readTextFile(configPath);
    let existing: Record<string, unknown> = {};
    if (typeof existingRaw === 'string' && existingRaw.trim()) {
      try {
        const parsed = JSON.parse(existingRaw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          existing = parsed as Record<string, unknown>;
        }
      } catch {
        existing = {};
      }
    }

    const serverOwned: Record<string, unknown> = {};
    if (existing.version !== undefined) serverOwned.version = existing.version;
    if (existing.scheduledTasks !== undefined) serverOwned.scheduledTasks = existing.scheduledTasks;

    const content = JSON.stringify({
      ...existing,
      ...config,
      ...serverOwned,
      projectPath: normalize(projectDirectory),
    }, null, 2);
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

export async function getProjectContextData(project: ProjectRef): Promise<OpenChamberProjectContextData> {
  const config = await readOpenChamberConfig(project);
  return sanitizeProjectContextData({
    notes: config?.projectNotes,
    todos: config?.projectTodos,
    plans: config?.projectPlanFiles,
  });
}

export async function getProjectPlanFiles(project: ProjectRef): Promise<OpenChamberProjectPlanFileLink[]> {
  const config = await readOpenChamberConfig(project);
  return sanitizeProjectPlanFileLinks(config?.projectPlanFiles);
}

export async function saveProjectPlanFiles(
  project: ProjectRef,
  value: OpenChamberProjectPlanFileLink[]
): Promise<boolean> {
  const sanitized = sanitizeProjectPlanFileLinks(value);
  return updateOpenChamberConfig(project, {
    projectPlanFiles: sanitized,
  });
}

export async function readProjectPlanFile(path: string): Promise<OpenChamberProjectPlanFile | null> {
  const trimmedPath = typeof path === 'string' ? path.trim() : '';
  if (!trimmedPath) {
    return null;
  }

  const raw = await readTextFile(trimmedPath);
  if (raw === null) {
    return null;
  }

  const parsed = parseProjectPlanMarkdown(raw);
  return {
    title: parsed.title,
    body: parsed.body,
    raw,
    path: trimmedPath,
  };
}

const deleteFile = async (path: string): Promise<boolean> => {
  const runtimeFiles = getRuntimeFilesAPI();
  if (runtimeFiles?.delete) {
    try {
      const result = await runtimeFiles.delete(path);
      if (result?.success !== false) {
        return true;
      }
    } catch {
      // fall through
    }
  }

  const res = await postJson<{ success?: boolean }>(`${getBaseUrl()}/fs/delete`, { path });
  return Boolean(res.ok);
};

export async function deleteProjectPlanFile(
  project: ProjectRef,
  planId: string
): Promise<boolean> {
  const trimmedId = typeof planId === 'string' ? planId.trim() : '';
  if (!trimmedId) {
    return false;
  }

  const existing = await getProjectPlanFiles(project);
  const target = existing.find((entry) => entry.id === trimmedId);
  if (!target) {
    return false;
  }

  const next = existing.filter((entry) => entry.id !== trimmedId);
  const saved = await saveProjectPlanFiles(project, next);
  if (!saved) {
    return false;
  }

  // Best-effort: remove underlying markdown file, ignore failure.
  await deleteFile(target.path).catch(() => false);
  return true;
}

export async function importProjectPlanFileFromContent(
  project: ProjectRef,
  content: string,
  fallbackTitle?: string
): Promise<OpenChamberProjectPlanFileLink | null> {
  const raw = typeof content === 'string' ? content : '';
  if (!raw.trim()) {
    return null;
  }

  const parsed = parseProjectPlanMarkdown(raw);
  const title = parsed.title || sanitizePlanTitle(fallbackTitle ?? '') || 'Plan';
  return createProjectPlanFile(project, { title, body: parsed.body });
}

export async function createProjectPlanFile(
  project: ProjectRef,
  value: { title: string; body: string }
): Promise<OpenChamberProjectPlanFileLink | null> {
  const plansDirectory = await getProjectPlansDirectory(project);
  if (!plansDirectory) {
    return null;
  }

  const title = sanitizePlanTitle(value.title) || 'Plan';
  const createdAt = Date.now();
  const id = createProjectPlanId();
  const filePath = joinPath(plansDirectory, `${createdAt}-${slugifyPlanTitle(title)}.md`);

  const projectDirectory = await getProjectStorageDirectory(project);
  if (!projectDirectory) {
    return null;
  }

  const createdProjectDir = await mkdirp(projectDirectory);
  const createdPlansDir = createdProjectDir ? await mkdirp(plansDirectory) : false;
  if (!createdProjectDir || !createdPlansDir) {
    return null;
  }

  const wrote = await writeTextFile(filePath, formatProjectPlanMarkdown(title, value.body));
  if (!wrote) {
    return null;
  }

  const existing = await getProjectPlanFiles(project);
  const nextEntry = { id, path: filePath, createdAt };
  const saved = await saveProjectPlanFiles(project, [nextEntry, ...existing]);
  if (!saved) {
    return null;
  }

  return nextEntry;
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
