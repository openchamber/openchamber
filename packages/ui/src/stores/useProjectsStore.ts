import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { opencodeClient } from '@/lib/opencode/client';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import type { ProjectEntry } from '@/lib/api/types';
import type { DesktopSettings } from '@/lib/desktop';
import { type SettingsSyncedDetail, updateDesktopSettings } from '@/lib/persistence';
import { createProjectIdFromPath } from '@/lib/projectId';
import { getDeferredSafeStorage } from './utils/safeStorage';
import { useDirectoryStore } from './useDirectoryStore';
import { streamDebugEnabled } from '@/stores/utils/streamDebug';
import { PROJECT_COLORS } from '@/lib/projectMeta';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeApiBaseUrl } from '@/lib/runtime-switch';
import { getVSCodeBootstrapConfig } from '@/lib/vscodeBootstrap';
import { isVSCodeRuntime } from './utils/vscodeRuntime';

/** Pick a color key that's least used among existing projects */
const pickAutoColor = (projects: ProjectEntry[]): string => {
  const colorKeys = PROJECT_COLORS.map((c) => c.key);
  const usageCounts = new Map<string, number>();
  for (const key of colorKeys) {
    usageCounts.set(key, 0);
  }
  for (const p of projects) {
    if (p.color && usageCounts.has(p.color)) {
      usageCounts.set(p.color, (usageCounts.get(p.color) ?? 0) + 1);
    }
  }
  // Find minimum usage, then pick randomly among those with min usage
  const minUsage = Math.min(...usageCounts.values());
  const candidates = colorKeys.filter((k) => usageCounts.get(k) === minUsage);
  return candidates[Math.floor(Math.random() * candidates.length)];
};

interface ProjectPathValidationResult {
  ok: boolean;
  normalizedPath?: string;
  reason?: string;
}

interface VSCodeWorkspaceFolderConfig {
  name?: string;
  path: string;
}

interface ProjectsStore {
  projects: ProjectEntry[];
  activeProjectId: string | null;
  manualProjectOrder: string[];

  addProject: (path: string, options?: { label?: string; id?: string }) => Promise<ProjectEntry | null>;
  addProjects: (paths: string[]) => Promise<ProjectEntry[]>;
  removeProject: (id: string) => void;
  setActiveProject: (id: string) => void;
  setActiveProjectIdOnly: (id: string) => void;
  renameProject: (id: string, label: string) => void;
  updateProjectMeta: (id: string, meta: {
    label?: string;
    icon?: string | null;
    color?: string | null;
    iconBackground?: string | null;
    defaultModel?: string | null;
    defaultVariant?: string | null;
  }) => void;
  uploadProjectIcon: (id: string, file: File) => Promise<{ ok: boolean; error?: string }>;
  removeProjectIcon: (id: string) => Promise<{ ok: boolean; error?: string }>;
  discoverProjectIcon: (id: string, options?: { force?: boolean }) => Promise<{ ok: boolean; skipped?: boolean; reason?: string; error?: string }>;
  reorderProjects: (fromIndex: number, toIndex: number) => void;
  resetForRuntimeSwitch: () => void;
  validateProjectPath: (path: string) => ProjectPathValidationResult;
  synchronizeFromSettings: (settings: DesktopSettings, options?: { adoptActiveProject?: boolean }) => void;
  syncVSCodeWorkspaceFolders: (folders: VSCodeWorkspaceFolderConfig[], activePath?: string | null) => ProjectEntry | null;
  getActiveProject: () => ProjectEntry | null;
}

const safeStorage = getDeferredSafeStorage();
const PROJECTS_STORAGE_KEY = 'projects';
const ACTIVE_PROJECT_STORAGE_KEY = 'activeProjectId';

const getLocalRuntimeOrigin = (): string => {
  if (typeof window === 'undefined') return '';
  const value = (window as typeof window & { __OPENCHAMBER_LOCAL_ORIGIN__?: string }).__OPENCHAMBER_LOCAL_ORIGIN__;
  return typeof value === 'string' ? value.trim().replace(/\/+$/, '') : '';
};

const getProjectsStorageNamespace = (): string => {
  const apiBaseUrl = getRuntimeApiBaseUrl().trim().replace(/\/+$/, '');
  if (!apiBaseUrl) return '';
  return apiBaseUrl;
};

const getProjectsStorageKey = (): string => {
  const namespace = getProjectsStorageNamespace();
  return namespace ? `${PROJECTS_STORAGE_KEY}:${encodeURIComponent(namespace)}` : PROJECTS_STORAGE_KEY;
};

const getActiveProjectStorageKey = (): string => {
  const namespace = getProjectsStorageNamespace();
  return namespace ? `${ACTIVE_PROJECT_STORAGE_KEY}:${encodeURIComponent(namespace)}` : ACTIVE_PROJECT_STORAGE_KEY;
};

const shouldReadLegacyProjectsCache = (): boolean => {
  const namespace = getProjectsStorageNamespace();
  if (!namespace) return true;
  const localOrigin = getLocalRuntimeOrigin();
  return Boolean(localOrigin && namespace === localOrigin);
};

const resolveTildePath = (value: string, homeDir?: string | null): string => {
  const trimmed = value.trim();
  if (!trimmed.startsWith('~')) {
    return trimmed;
  }
  if (!homeDir) {
    return trimmed;
  }
  if (trimmed === '~') {
    return homeDir;
  }
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return `${homeDir}${trimmed.slice(1)}`;
  }
  return trimmed;
};

const HEX_COLOR_PATTERN = /^#(?:[\da-fA-F]{3}|[\da-fA-F]{6})$/;

const normalizeDefaultModel = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const separatorIndex = trimmed.indexOf('/');
  if (separatorIndex <= 0 || separatorIndex >= trimmed.length - 1) {
    return undefined;
  }
  return trimmed;
};

const normalizeIconBackground = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return HEX_COLOR_PATTERN.test(trimmed) ? trimmed.toLowerCase() : null;
};

const normalizeProjectPath = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }

  const homeDirectory = safeStorage.getItem('homeDirectory') || useDirectoryStore.getState().homeDirectory || '';
  const expanded = resolveTildePath(trimmed, homeDirectory);

  const normalized = expanded.replace(/\\/g, '/');
  if (normalized === '/') {
    return '/';
  }
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
};

// VS Code workspace folder paths come from the extension host with uppercase
// drive letters (see resolveWorkspaceFolders in packages/vscode), while paths
// typed or browsed in the webview keep the lowercase drive of fsPath. Normalize
// to the workspace form so dedupe and active-path matching agree on Windows.
const normalizeVSCodeWorkspacePath = (value: string): string =>
  value.replace(/^([a-z]):/, (_, letter: string) => letter.toUpperCase() + ':');

// Folder names are shown verbatim: title-casing them turned `.ssh` into `.Ssh`
// and made every project look like a name the user never chose.
const deriveProjectLabel = (path: string): string => {
  const normalized = normalizeProjectPath(path);
  if (!normalized || normalized === '/') {
    return 'Root';
  }
  const segments = normalized.split('/').filter(Boolean);
  return segments[segments.length - 1] || normalized;
};

// Labels auto-derived by older versions were title-cased and persisted. Drop
// them back to the folder name; labels the user typed themselves are kept.
const legacyAutoProjectLabel = (path: string): string => {
  const derived = deriveProjectLabel(path);
  return derived.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
};

const sanitizeProjectIconImage = (value: unknown): ProjectEntry['iconImage'] | undefined => {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const candidate = value as Record<string, unknown>;
  const mime = typeof candidate.mime === 'string' ? candidate.mime.trim() : '';
  const updatedAt = typeof candidate.updatedAt === 'number' && Number.isFinite(candidate.updatedAt)
    ? Math.max(0, Math.round(candidate.updatedAt))
    : 0;
  const source = candidate.source === 'custom' || candidate.source === 'auto'
    ? candidate.source
    : null;

  if (!mime || !updatedAt || !source) {
    return undefined;
  }

  return { mime, updatedAt, source };
};

const resolveUploadMime = (file: File): 'image/png' | 'image/jpeg' | 'image/svg+xml' | null => {
  const rawType = typeof file.type === 'string' ? file.type.trim().toLowerCase() : '';
  if (rawType === 'image/png' || rawType === 'image/jpeg' || rawType === 'image/svg+xml') {
    return rawType;
  }

  const lowerName = file.name.toLowerCase();
  if (lowerName.endsWith('.png')) return 'image/png';
  if (lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg')) return 'image/jpeg';
  if (lowerName.endsWith('.svg')) return 'image/svg+xml';

  return null;
};

const readFileAsDataUrl = async (file: File): Promise<string> => {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => {
      reject(new Error('Failed to read icon file'));
    };
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      if (!result) {
        reject(new Error('Failed to read icon file'));
        return;
      }
      resolve(result);
    };
    reader.readAsDataURL(file);
  });
};

const sanitizeProjects = (value: unknown): ProjectEntry[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  const result: ProjectEntry[] = [];
  const seenIds = new Set<string>();
  const seenPaths = new Set<string>();

  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const candidate = entry as Record<string, unknown>;

    const rawPath = typeof candidate.path === 'string' ? candidate.path.trim() : '';
    if (!rawPath) continue;

    const normalizedPath = normalizeProjectPath(rawPath);
    if (!normalizedPath) continue;

    const id = createProjectIdFromPath(normalizedPath);
    if (!id) continue;

    if (seenIds.has(id) || seenPaths.has(normalizedPath)) continue;
    seenIds.add(id);
    seenPaths.add(normalizedPath);

    const project: ProjectEntry = {
      id,
      path: normalizedPath,
    };

    if (typeof candidate.label === 'string' && candidate.label.trim().length > 0) {
      const storedLabel = candidate.label.trim();
      project.label = storedLabel === legacyAutoProjectLabel(normalizedPath)
        ? deriveProjectLabel(normalizedPath)
        : storedLabel;
    }
    if (typeof candidate.icon === 'string' && candidate.icon.trim().length > 0) {
      project.icon = candidate.icon.trim();
    }
    if (candidate.iconImage === null) {
      project.iconImage = null;
    } else {
      const iconImage = sanitizeProjectIconImage(candidate.iconImage);
      if (iconImage) {
        project.iconImage = iconImage;
      }
    }
    if (typeof candidate.color === 'string' && candidate.color.trim().length > 0) {
      project.color = candidate.color.trim();
    }
    const defaultModel = normalizeDefaultModel(candidate.defaultModel);
    if (defaultModel) {
      project.defaultModel = defaultModel;
      // A variant only means something next to the model it belongs to.
      if (typeof candidate.defaultVariant === 'string' && candidate.defaultVariant.trim().length > 0) {
        project.defaultVariant = candidate.defaultVariant.trim();
      }
    }
    if (candidate.iconBackground === null) {
      project.iconBackground = null;
    } else {
      const iconBackground = normalizeIconBackground(candidate.iconBackground);
      if (iconBackground) {
        project.iconBackground = iconBackground;
      }
    }
    if (typeof candidate.addedAt === 'number' && Number.isFinite(candidate.addedAt) && candidate.addedAt >= 0) {
      project.addedAt = candidate.addedAt;
    }
    if (typeof candidate.lastOpenedAt === 'number' && Number.isFinite(candidate.lastOpenedAt) && candidate.lastOpenedAt >= 0) {
      project.lastOpenedAt = candidate.lastOpenedAt;
    }
    if (typeof candidate.sidebarCollapsed === 'boolean') {
      project.sidebarCollapsed = candidate.sidebarCollapsed;
    }
    result.push(project);
  }

  return result;
};

const readPersistedProjects = (): ProjectEntry[] => {
  try {
    const raw = safeStorage.getItem(getProjectsStorageKey())
      || (shouldReadLegacyProjectsCache() ? safeStorage.getItem(PROJECTS_STORAGE_KEY) : null);
    if (!raw) {
      return [];
    }
    return sanitizeProjects(JSON.parse(raw));
  } catch {
    return [];
  }
};

const readPersistedManualOrder = (): string[] => {
  try {
    const raw = safeStorage.getItem(getProjectsStorageKey() + ':manualOrder');
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
};

const readPersistedActiveProjectId = (): string | null => {
  try {
    const raw = safeStorage.getItem(getActiveProjectStorageKey())
      || (shouldReadLegacyProjectsCache() ? safeStorage.getItem(ACTIVE_PROJECT_STORAGE_KEY) : null);
    if (typeof raw === 'string' && raw.trim().length > 0) {
      return raw.trim();
    }
  } catch {
    return null;
  }
  return null;
};

const cacheActiveProjectId = (activeProjectId: string | null) => {
  try {
    const activeProjectStorageKey = getActiveProjectStorageKey();
    if (activeProjectId) {
      safeStorage.setItem(activeProjectStorageKey, activeProjectId);
    } else {
      safeStorage.removeItem(activeProjectStorageKey);
    }
  } catch {
    // ignored
  }
};

const cacheProjects = (projects: ProjectEntry[], activeProjectId: string | null) => {
  try {
    safeStorage.setItem(getProjectsStorageKey(), JSON.stringify(projects));
  } catch {
    // ignored
  }
  cacheActiveProjectId(activeProjectId);
};

const persistProjects = (projects: ProjectEntry[], activeProjectId: string | null, manualOrder?: string[]) => {
  cacheProjects(projects, activeProjectId);
  if (manualOrder) {
    persistManualProjectOrder(manualOrder);
  }
  void updateDesktopSettings({ projects, activeProjectId: activeProjectId ?? undefined });
};

const persistManualProjectOrder = (manualOrder: string[]) => {
  try {
    safeStorage.setItem(getProjectsStorageKey() + ':manualOrder', JSON.stringify(manualOrder));
  } catch {
    // ignored
  }
};

const initialProjects = readPersistedProjects();
const normalizeVSCodeWorkspaceFolders = (folders: VSCodeWorkspaceFolderConfig[]): VSCodeWorkspaceFolderConfig[] => {
  const result: VSCodeWorkspaceFolderConfig[] = [];
  const seen = new Set<string>();
  for (const folder of folders) {
    const normalizedPath = normalizeProjectPath(folder.path);
    if (!normalizedPath || seen.has(normalizedPath)) {
      continue;
    }
    seen.add(normalizedPath);
    result.push({
      name: folder.name?.trim(),
      path: normalizedPath,
    });
  }
  return result;
};

const createVSCodeWorkspaceProject = (
  folder: VSCodeWorkspaceFolderConfig,
  existing: ProjectEntry | null,
  now: number,
  activePath: string | null,
): ProjectEntry | null => {
  const normalizedPath = normalizeProjectPath(folder.path);
  if (!normalizedPath) {
    return null;
  }
  const id = createProjectIdFromPath(normalizedPath);
  const isActive = activePath === normalizedPath;
  return {
    ...existing,
    id,
    path: normalizedPath,
    label: deriveProjectLabel(normalizedPath),
    addedAt: existing?.addedAt ?? now,
    lastOpenedAt: isActive ? now : existing?.lastOpenedAt ?? now,
  };
};

const getVSCodeWorkspaceFolders = (): VSCodeWorkspaceFolderConfig[] | null => {
  const runtimeApis = getRegisteredRuntimeAPIs();
  const config = getVSCodeBootstrapConfig();
  if (!isVSCodeRuntime(runtimeApis, config)) {
    return null;
  }
  const folders = Array.isArray(config?.workspaceFolders)
    ? config.workspaceFolders
        .map((entry) => {
          const candidate = entry as { name?: unknown; path?: unknown };
          const path = typeof candidate.path === 'string' ? candidate.path.trim() : '';
          if (!path) return null;
          const name = typeof candidate.name === 'string' ? candidate.name.trim() : '';
          return { name, path };
        })
        .filter((entry): entry is { name: string; path: string } => entry !== null)
    : [];

  if (folders.length > 0) {
    return normalizeVSCodeWorkspaceFolders(folders);
  }

  const workspaceFolder = config?.workspaceFolder;
  if (typeof workspaceFolder !== 'string' || workspaceFolder.trim().length === 0) {
    return null;
  }

  return normalizeVSCodeWorkspaceFolders([{ path: workspaceFolder }]);
};

const createVSCodeWorkspaceProjects = (
  folders: VSCodeWorkspaceFolderConfig[],
  existingProjects: ProjectEntry[],
  activePath?: string | null,
): { projects: ProjectEntry[]; activeProjectId: string | null; activeProject: ProjectEntry | null } | null => {
  const normalizedFolders = normalizeVSCodeWorkspaceFolders(folders);
  const normalizedActivePath = activePath ? normalizeProjectPath(activePath) : null;
  const effectiveFolders = normalizedFolders.length === 0 && normalizedActivePath
    ? [{ path: normalizedActivePath }]
    : normalizedActivePath && !normalizedFolders.some((folder) => folder.path === normalizedActivePath)
    ? [...normalizedFolders, { path: normalizedActivePath }]
    : normalizedFolders;
  if (effectiveFolders.length === 0) {
    return null;
  }
  const now = Date.now();
  const projects = effectiveFolders
    .map((folder) => createVSCodeWorkspaceProject(
      folder,
      existingProjects.find((project) => project.path === folder.path) ?? null,
      now,
      normalizedActivePath,
    ))
    .filter((project): project is ProjectEntry => project !== null);

  if (projects.length === 0) {
    return null;
  }

  const activeProject = normalizedActivePath
    ? projects.find((project) => project.path === normalizedActivePath) ?? null
    : projects[0] ?? null;
  const activeProjectId = activeProject?.id ?? projects[0]?.id ?? null;

  if (streamDebugEnabled()) {
    console.log('[OpenChamber][VSCode][projects] Using workspace projects', projects);
  }

  return { projects, activeProjectId, activeProject: activeProject ?? projects[0] ?? null };
};

const projectIconImagesEqual = (
  left: ProjectEntry['iconImage'],
  right: ProjectEntry['iconImage'],
): boolean => {
  if (left === right) return true;
  if (!left || !right) return left === right;
  return left.mime === right.mime
    && left.updatedAt === right.updatedAt
    && left.source === right.source;
};

const vscodeWorkspaceProjectsEqual = (left: ProjectEntry[], right: ProjectEntry[]): boolean => {
  if (left.length !== right.length) return false;
  return left.every((leftProject, index) => {
    const rightProject = right[index];
    if (!rightProject) return false;
    return leftProject.id === rightProject.id
      && leftProject.path === rightProject.path
      && leftProject.label === rightProject.label
      && leftProject.icon === rightProject.icon
      && leftProject.color === rightProject.color
      && leftProject.iconBackground === rightProject.iconBackground
      && leftProject.defaultModel === rightProject.defaultModel
      && leftProject.defaultVariant === rightProject.defaultVariant
      && leftProject.addedAt === rightProject.addedAt
      && leftProject.lastOpenedAt === rightProject.lastOpenedAt
      && leftProject.sidebarCollapsed === rightProject.sidebarCollapsed
      && projectIconImagesEqual(leftProject.iconImage, rightProject.iconImage);
  });
};

const getVSCodeWorkspaceProject = (): { projects: ProjectEntry[]; activeProjectId: string | null } | null => {
  const folders = getVSCodeWorkspaceFolders();
  if (!folders) {
    return null;
  }
  const result = createVSCodeWorkspaceProjects(folders, []);
  if (!result) {
    return null;
  }
  return { projects: result.projects, activeProjectId: result.activeProjectId };
};

// VS Code runtime is scoped to the workspace folders opened in VS Code.
// Always prefer the VS Code workspace projects over any persisted multi-project registry.
const vscodeWorkspace = getVSCodeWorkspaceProject();
const isVSCodeProjectsRuntime = (() => {
  return isVSCodeRuntime(getRegisteredRuntimeAPIs(), getVSCodeBootstrapConfig());
})();
const effectiveInitialProjects = vscodeWorkspace?.projects ?? (isVSCodeProjectsRuntime ? [] : initialProjects);
const persistedInitialActiveProjectId = vscodeWorkspace?.activeProjectId ?? (isVSCodeProjectsRuntime ? null : readPersistedActiveProjectId());
const initialActiveProjectId = effectiveInitialProjects.some((project) => project.id === persistedInitialActiveProjectId)
  ? persistedInitialActiveProjectId
  : effectiveInitialProjects[0]?.id ?? null;

if (vscodeWorkspace) {
  cacheProjects(effectiveInitialProjects, initialActiveProjectId);
}

export const useProjectsStore = create<ProjectsStore>()(
  devtools((set, get) => ({
    projects: effectiveInitialProjects,
    activeProjectId: initialActiveProjectId,
    manualProjectOrder: readPersistedManualOrder(),

    validateProjectPath: (path: string): ProjectPathValidationResult => {
      if (typeof path !== 'string' || path.trim().length === 0) {
        return { ok: false, reason: 'Provide a directory path.' };
      }

      const normalized = normalizeProjectPath(path);
      if (!normalized) {
        return { ok: false, reason: 'Directory path cannot be empty.' };
      }

      return { ok: true, normalizedPath: normalized };
    },

    addProject: async (path: string, options?: { label?: string; id?: string }) => {
      if (isVSCodeProjectsRuntime) {
        // Projects are scoped to VS Code workspace folders in this runtime.
        // Adding a folder through the extension host makes the project appear
        // in the workspace and the new folder is synced back as a project.
        const validation = get().validateProjectPath(path);
        if (!validation.ok || !validation.normalizedPath) {
          return null;
        }
        const normalizedPath = normalizeVSCodeWorkspacePath(validation.normalizedPath);
        const existing = get().projects.find((project) => project.path === normalizedPath);
        if (existing) {
          return existing;
        }
        const runtimeApis = getRegisteredRuntimeAPIs();
        if (runtimeApis?.vscode?.addWorkspaceFolder) {
          try {
            const folders = await runtimeApis.vscode.addWorkspaceFolder(normalizedPath);
            return get().syncVSCodeWorkspaceFolders(folders, normalizedPath);
          } catch {
            return null;
          }
        }
        return null;
      }
      const { validateProjectPath } = get();
      const validation = validateProjectPath(path);
      if (!validation.ok || !validation.normalizedPath) {
        return null;
      }

      const normalizedPath = validation.normalizedPath;
      const existing = get().projects.find((project) => project.path === normalizedPath);
      if (existing) {
        get().setActiveProject(existing.id);
        return existing;
      }

      const now = Date.now();
      const label = options?.label?.trim() || deriveProjectLabel(normalizedPath);
      const id = createProjectIdFromPath(normalizedPath);
      const entry: ProjectEntry = {
        id,
        path: normalizedPath,
        label,
        color: pickAutoColor(get().projects),
        addedAt: now,
        lastOpenedAt: now,
      };

      const nextProjects = [...get().projects, entry];
      set({ projects: nextProjects });

      if (streamDebugEnabled()) {
        console.info('[ProjectsStore] Added project', entry);
      }

      get().setActiveProject(entry.id);
      void get().discoverProjectIcon(entry.id);
      return entry;
    },

    addProjects: async (paths: string[]) => {
      if (isVSCodeProjectsRuntime) {
        // VS Code paths are added via runtimeApis.vscode.addWorkspaceFolder,
        // which is reached only by addProject. Iterate so valid selections
        // succeed instead of silently returning []. Dedupe by path so the
        // returned array mirrors the non-VS Code contract.
        const added: ProjectEntry[] = [];
        const seen = new Set<string>();
        for (const path of paths) {
          if (seen.has(path)) continue;
          seen.add(path);
          const project = await get().addProject(path);
          if (project) {
            added.push(project);
          }
        }
        return added;
      }
      const current = get();
      const existingPaths = new Set(current.projects.map((project) => project.path));
      const now = Date.now();
      const entries: ProjectEntry[] = [];
      const seenPaths = new Set<string>();

      for (const rawPath of paths) {
        const validation = get().validateProjectPath(rawPath);
        if (!validation.ok || !validation.normalizedPath) {
          continue;
        }
        const normalizedPath = validation.normalizedPath;
        if (existingPaths.has(normalizedPath) || seenPaths.has(normalizedPath)) {
          continue;
        }
        seenPaths.add(normalizedPath);
        entries.push({
          id: createProjectIdFromPath(normalizedPath),
          path: normalizedPath,
          label: deriveProjectLabel(normalizedPath),
          color: pickAutoColor([...current.projects, ...entries]),
          addedAt: now,
          lastOpenedAt: now,
        });
      }

      if (entries.length === 0) {
        return [];
      }

      const nextProjects = [...current.projects, ...entries];
      set({ projects: nextProjects });

      if (streamDebugEnabled()) {
        console.info('[ProjectsStore] Added projects', entries);
      }

      // Mirror addProject: the first newly added project becomes active.
      get().setActiveProject(entries[0].id);
      for (const entry of entries) {
        void get().discoverProjectIcon(entry.id);
      }
      return entries;
    },

    removeProject: (id: string) => {
      if (isVSCodeProjectsRuntime) {
        return;
      }
      const current = get();
      const project = current.projects.find((p) => p.id === id);
      const nextProjects = current.projects.filter((project) => project.id !== id);
      let nextActiveId = current.activeProjectId;

      if (current.activeProjectId === id) {
        nextActiveId = nextProjects[0]?.id ?? null;
      }

      const nextManualOrder = get().manualProjectOrder.filter((oid) => oid !== id);
      set({ projects: nextProjects, activeProjectId: nextActiveId, manualProjectOrder: nextManualOrder });
      persistProjects(nextProjects, nextActiveId, nextManualOrder);

      // Clean up worktree entries for the removed project
      if (project) {
        const normalizedPath = project.path.replace(/\\/g, '/').replace(/\/+$/, '') || '/';
        useSessionUIStore.setState((s) => {
          const next = new Map(s.availableWorktreesByProject);
          next.delete(normalizedPath);
          return { availableWorktreesByProject: next };
        });
      }

      if (nextActiveId) {
        const nextActive = nextProjects.find((project) => project.id === nextActiveId);
        if (nextActive) {
          opencodeClient.setDirectory(nextActive.path);
          useDirectoryStore.getState().setDirectory(nextActive.path, { showOverlay: false });
        }
      } else {
        void useDirectoryStore.getState().goHome();
      }
    },

    setActiveProject: (id: string) => {
      if (isVSCodeProjectsRuntime) {
        return;
      }
      const { projects, activeProjectId } = get();
      if (activeProjectId === id) {
        return;
      }
      const target = projects.find((project) => project.id === id);
      if (!target) {
        return;
      }

      const now = Date.now();
      const nextProjects = projects.map((project) =>
        project.id === id ? { ...project, lastOpenedAt: now } : project
      );

      set({ projects: nextProjects, activeProjectId: id });
      persistProjects(nextProjects, id, get().manualProjectOrder);

      opencodeClient.setDirectory(target.path);
      useDirectoryStore.getState().setDirectory(target.path, { showOverlay: false });
    },

    setActiveProjectIdOnly: (id: string) => {
      if (isVSCodeProjectsRuntime) {
        return;
      }
      const { projects, activeProjectId } = get();
      if (activeProjectId === id) {
        return;
      }
      if (!projects.some((project) => project.id === id)) {
        return;
      }

      set({ activeProjectId: id });
      cacheActiveProjectId(id);
      void updateDesktopSettings({ activeProjectId: id });
    },

    renameProject: (id: string, label: string) => {
      if (isVSCodeProjectsRuntime) {
        return;
      }
      const trimmed = label.trim();
      if (!trimmed) {
        return;
      }

      const { projects, activeProjectId } = get();
      const nextProjects = projects.map((project) =>
        project.id === id ? { ...project, label: trimmed } : project
      );
      set({ projects: nextProjects });
      persistProjects(nextProjects, activeProjectId, get().manualProjectOrder);
    },

    updateProjectMeta: (id: string, meta: {
      label?: string;
      icon?: string | null;
      color?: string | null;
      iconBackground?: string | null;
      defaultModel?: string | null;
      defaultVariant?: string | null;
    }) => {
      if (isVSCodeProjectsRuntime) {
        return;
      }
      const { projects, activeProjectId } = get();
      const nextProjects = projects.map((project) => {
        if (project.id !== id) return project;
        const updated = { ...project };
        if (meta.label !== undefined) {
          const trimmed = meta.label.trim();
          if (trimmed) updated.label = trimmed;
        }
        if (meta.icon !== undefined) updated.icon = meta.icon;
        if (meta.color !== undefined) updated.color = meta.color;
        if (meta.iconBackground !== undefined) {
          updated.iconBackground = normalizeIconBackground(meta.iconBackground);
        }
        if (meta.defaultModel !== undefined) {
          const normalized = normalizeDefaultModel(meta.defaultModel);
          if (normalized) {
            updated.defaultModel = normalized;
          } else {
            delete updated.defaultModel;
          }
        }
        if (meta.defaultVariant !== undefined) {
          const trimmed = meta.defaultVariant?.trim();
          if (trimmed) {
            updated.defaultVariant = trimmed;
          } else {
            delete updated.defaultVariant;
          }
        }
        // A variant without its model is meaningless, and the model may have
        // just been cleared in this same update.
        if (!updated.defaultModel) {
          delete updated.defaultVariant;
        }
        return updated;
      });
      set({ projects: nextProjects });
      persistProjects(nextProjects, activeProjectId, get().manualProjectOrder);
    },

    uploadProjectIcon: async (id: string, file: File) => {
      if (isVSCodeProjectsRuntime) {
        return { ok: false, error: 'Custom icons are not supported in this runtime' };
      }

      const mime = resolveUploadMime(file);
      if (!mime) {
        return { ok: false, error: 'Only PNG, JPEG, and SVG are supported' };
      }
      if (!Number.isFinite(file.size) || file.size <= 0) {
        return { ok: false, error: 'Icon file is empty' };
      }
      if (file.size > 5 * 1024 * 1024) {
        return { ok: false, error: 'Icon exceeds size limit (5 MB)' };
      }

      try {
        const dataUrl = await readFileAsDataUrl(file);
        const normalizedDataUrl = dataUrl.replace(/^data:[^;]+;/i, `data:${mime};`);

        const response = await runtimeFetch(`/api/projects/${encodeURIComponent(id)}/icon`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({ dataUrl: normalizedDataUrl }),
        });

        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as { error?: string } | null;
          return { ok: false, error: payload?.error || 'Failed to upload project icon' };
        }

        const payload = (await response.json().catch(() => null)) as { settings?: DesktopSettings } | null;
        if (payload?.settings) {
          get().synchronizeFromSettings(payload.settings, { adoptActiveProject: false });
        }
        return { ok: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, error: message || 'Failed to upload project icon' };
      }
    },

    removeProjectIcon: async (id: string) => {
      if (isVSCodeProjectsRuntime) {
        return { ok: false, error: 'Custom icons are not supported in this runtime' };
      }

      try {
        const response = await runtimeFetch(`/api/projects/${encodeURIComponent(id)}/icon`, {
          method: 'DELETE',
          headers: {
            Accept: 'application/json',
          },
        });

        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as { error?: string } | null;
          return { ok: false, error: payload?.error || 'Failed to remove project icon' };
        }

        const payload = (await response.json().catch(() => null)) as { settings?: DesktopSettings } | null;
        if (payload?.settings) {
          get().synchronizeFromSettings(payload.settings, { adoptActiveProject: false });
        }
        return { ok: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, error: message || 'Failed to remove project icon' };
      }
    },

    discoverProjectIcon: async (id: string, options?: { force?: boolean }) => {
      if (isVSCodeProjectsRuntime) {
        return { ok: false, error: 'Custom icons are not supported in this runtime' };
      }

      try {
        const response = await runtimeFetch(`/api/projects/${encodeURIComponent(id)}/icon/discover`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({ force: options?.force === true }),
        });

        const payload = (await response.json().catch(() => null)) as {
          error?: string;
          skipped?: boolean;
          reason?: string;
          settings?: DesktopSettings;
        } | null;

        if (!response.ok) {
          return { ok: false, error: payload?.error || 'Failed to discover project icon' };
        }

        if (payload?.settings) {
          get().synchronizeFromSettings(payload.settings, { adoptActiveProject: false });
        }

        return {
          ok: true,
          skipped: payload?.skipped === true,
          reason: typeof payload?.reason === 'string' ? payload.reason : undefined,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, error: message || 'Failed to discover project icon' };
      }
    },

    reorderProjects: (fromIndex: number, toIndex: number) => {
      if (isVSCodeProjectsRuntime) {
        return;
      }
      const { projects, activeProjectId } = get();
      if (
        fromIndex < 0 ||
        fromIndex >= projects.length ||
        toIndex < 0 ||
        toIndex >= projects.length ||
        fromIndex === toIndex
      ) {
        return;
      }

      const nextProjects = [...projects];
      const [moved] = nextProjects.splice(fromIndex, 1);
      nextProjects.splice(toIndex, 0, moved);

      const newOrder = nextProjects.map((p) => p.id);
      set({ projects: nextProjects, manualProjectOrder: newOrder });
      persistProjects(nextProjects, activeProjectId, newOrder);
    },

    resetForRuntimeSwitch: () => {
      if (isVSCodeProjectsRuntime) {
        return;
      }
      const projects = readPersistedProjects();
      const activeProjectId = readPersistedActiveProjectId();
      const nextActiveProjectId = projects.some((project) => project.id === activeProjectId)
        ? activeProjectId
        : projects[0]?.id ?? null;
      set({ projects, activeProjectId: nextActiveProjectId, manualProjectOrder: [] });
    },

    synchronizeFromSettings: (settings: DesktopSettings, options?: { adoptActiveProject?: boolean }) => {
      if (isVSCodeProjectsRuntime) {
        return;
      }
      const adoptActiveProject = options?.adoptActiveProject !== false;
      const incomingProjects = sanitizeProjects(settings.projects ?? []);
      const incomingActive = typeof settings.activeProjectId === 'string' && settings.activeProjectId.trim()
        ? settings.activeProjectId.trim()
        : null;

      const current = get();
      const incomingIds = new Set(incomingProjects.map((p) => p.id));

      // The settings document is shared by every window on this server, so
      // outside a bootstrap sync the incoming active pointer is just another
      // window's choice — the project LIST still reconciles, but this
      // window's active project stays its own while it remains valid.
      const nextActive = adoptActiveProject
        ? incomingActive
        : (current.activeProjectId && incomingIds.has(current.activeProjectId)
          ? current.activeProjectId
          : incomingActive);

      const projectsChanged = JSON.stringify(current.projects) !== JSON.stringify(incomingProjects);
      const activeChanged = current.activeProjectId !== nextActive;

      if (!projectsChanged && !activeChanged) {
        return;
      }

      const cleanedOrder = get().manualProjectOrder.filter((id) => incomingIds.has(id));
      set({ projects: incomingProjects, activeProjectId: nextActive, manualProjectOrder: cleanedOrder });
      cacheProjects(incomingProjects, nextActive);
      persistManualProjectOrder(cleanedOrder);

      if (activeChanged && nextActive) {
        const activeProject = incomingProjects.find((project) => project.id === nextActive);
        if (activeProject) {
          opencodeClient.setDirectory(activeProject.path);
          useDirectoryStore.getState().setDirectory(activeProject.path, { showOverlay: false });
        }
      }
    },

    syncVSCodeWorkspaceFolders: (folders, activePath) => {
      if (!isVSCodeProjectsRuntime) {
        return null;
      }

      const current = get();
      const currentActiveProject = current.activeProjectId
        ? current.projects.find((project) => project.id === current.activeProjectId) ?? null
        : null;
      const targetActivePath = activePath ?? currentActiveProject?.path ?? null;
      const result = createVSCodeWorkspaceProjects(folders, current.projects, targetActivePath);
      if (!result) {
        if (folders.length === 0 && !activePath && current.projects.length > 0) {
          set({ projects: [], activeProjectId: null });
          cacheProjects([], null);
        }
        return null;
      }

      const projectsChanged = !vscodeWorkspaceProjectsEqual(current.projects, result.projects);
      const activeChanged = current.activeProjectId !== result.activeProjectId;

      if (projectsChanged || activeChanged) {
        set({ projects: result.projects, activeProjectId: result.activeProjectId });
        cacheProjects(result.projects, result.activeProjectId);
      }

      if (result.activeProject) {
        opencodeClient.setDirectory(result.activeProject.path);
        useDirectoryStore.getState().setDirectory(result.activeProject.path, { showOverlay: false });
      }

      return result.activeProject;
    },

    getActiveProject: () => {
      const { projects, activeProjectId } = get();
      if (!activeProjectId) {
        return null;
      }
      return projects.find((project) => project.id === activeProjectId) ?? null;
    },

  }), { name: 'projects-store' })
);

if (typeof window !== 'undefined') {
  window.addEventListener('openchamber:settings-synced', (event: Event) => {
    const detail = (event as CustomEvent<SettingsSyncedDetail>).detail;
    if (detail && typeof detail === 'object' && detail.settings) {
      useProjectsStore.getState().synchronizeFromSettings(detail.settings, {
        adoptActiveProject: detail.adoptWorkspace,
      });
    }
  });
}
