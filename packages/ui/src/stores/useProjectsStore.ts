import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { opencodeClient } from '@/lib/opencode/client';
import type { ProjectEntry } from '@/lib/api/types';
import type { DesktopSettings } from '@/lib/desktop';
import { updateDesktopSettings } from '@/lib/persistence';
import { getSafeStorage } from './utils/safeStorage';
import { useDirectoryStore } from './useDirectoryStore';
import { streamDebugEnabled } from '@/stores/utils/streamDebug';
import { PROJECT_COLORS } from '@/lib/projectMeta';

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

interface ProjectsStore {
  projects: ProjectEntry[];
  activeProjectId: string | null;

  addProject: (path: string, options?: { label?: string; id?: string }) => ProjectEntry | null;
  removeProject: (id: string) => void;
  setActiveProject: (id: string) => void;
  setActiveProjectIdOnly: (id: string) => void;
  renameProject: (id: string, label: string) => void;
  updateProjectMeta: (id: string, meta: { label?: string; icon?: string | null; color?: string | null; iconBackground?: string | null }) => void;
  uploadProjectIcon: (id: string, file: File) => Promise<{ ok: boolean; error?: string }>;
  removeProjectIcon: (id: string) => Promise<{ ok: boolean; error?: string }>;
  discoverProjectIcon: (id: string, options?: { force?: boolean }) => Promise<{ ok: boolean; skipped?: boolean; reason?: string; error?: string }>;
  reorderProjects: (fromIndex: number, toIndex: number) => void;
  validateProjectPath: (path: string) => ProjectPathValidationResult;
  synchronizeFromSettings: (settings: DesktopSettings) => void;
  getActiveProject: () => ProjectEntry | null;
}

const safeStorage = getSafeStorage();
const PROJECTS_STORAGE_KEY = 'projects';
const ACTIVE_PROJECT_STORAGE_KEY = 'activeProjectId';

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

const deriveProjectLabel = (path: string): string => {
  const normalized = normalizeProjectPath(path);
  if (!normalized || normalized === '/') {
    return 'Root';
  }
  const segments = normalized.split('/').filter(Boolean);
  const raw = segments[segments.length - 1] || normalized;
  return raw.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
};

const createProjectId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `proj_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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

    const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
    const rawPath = typeof candidate.path === 'string' ? candidate.path.trim() : '';
    if (!id || !rawPath) continue;

    const normalizedPath = normalizeProjectPath(rawPath);
    if (!normalizedPath) continue;

    if (seenIds.has(id) || seenPaths.has(normalizedPath)) continue;
    seenIds.add(id);
    seenPaths.add(normalizedPath);

    const project: ProjectEntry = {
      id,
      path: normalizedPath,
    };

    if (typeof candidate.label === 'string' && candidate.label.trim().length > 0) {
      project.label = candidate.label.trim();
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
    const raw = safeStorage.getItem(PROJECTS_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    return sanitizeProjects(JSON.parse(raw));
  } catch {
    return [];
  }
};

const readPersistedActiveProjectId = (): string | null => {
  try {
    const raw = safeStorage.getItem(ACTIVE_PROJECT_STORAGE_KEY);
    if (typeof raw === 'string' && raw.trim().length > 0) {
      return raw.trim();
    }
  } catch {
    return null;
  }
  return null;
};

const cacheProjects = (projects: ProjectEntry[], activeProjectId: string | null) => {
  try {
    safeStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(projects));
  } catch {
    // ignored
  }

  try {
    if (activeProjectId) {
      safeStorage.setItem(ACTIVE_PROJECT_STORAGE_KEY, activeProjectId);
    } else {
      safeStorage.removeItem(ACTIVE_PROJECT_STORAGE_KEY);
    }
  } catch {
    // ignored
  }
};

const persistProjects = (projects: ProjectEntry[], activeProjectId: string | null) => {
  cacheProjects(projects, activeProjectId);
  void updateDesktopSettings({ projects, activeProjectId: activeProjectId ?? undefined });
};

const initialProjects = readPersistedProjects();

type VSCodeWorkspaceContext = {
  projects: ProjectEntry[];
  activeProjectId: string | null;
  activeProjectPath: string | null;
};

const isVSCodeWorkspaceRuntime = (): boolean => {
  if (typeof window === 'undefined') {
    return false;
  }

  const runtimeApis = (window as unknown as { __OPENCHAMBER_RUNTIME_APIS__?: { runtime?: { isVSCode?: boolean } } })
    .__OPENCHAMBER_RUNTIME_APIS__;
  return Boolean(runtimeApis?.runtime?.isVSCode);
};

const readVSCodeWorkspaceContext = (): VSCodeWorkspaceContext | null => {
  if (!isVSCodeWorkspaceRuntime()) {
    return null;
  }

  const persistedByPath = new Map(
    readPersistedProjects().map((project) => [normalizeProjectPath(project.path), project] as const),
  );

  const config = (window as unknown as {
    __VSCODE_CONFIG__?: {
      workspaceFolder?: unknown;
      activeWorkspaceFolder?: unknown;
      workspaceFolders?: unknown;
    };
  }).__VSCODE_CONFIG__;

  const workspaceFolders = Array.isArray(config?.workspaceFolders)
    ? config?.workspaceFolders
    : [];

  const projects: ProjectEntry[] = workspaceFolders.reduce<ProjectEntry[]>((acc, entry) => {
      if (!entry || typeof entry !== 'object') {
        return acc;
      }
      const candidate = entry as { name?: unknown; path?: unknown };
      const normalizedPath = typeof candidate.path === 'string'
        ? normalizeProjectPath(candidate.path)
        : '';
      if (!normalizedPath) {
        return acc;
      }

      const label = typeof candidate.name === 'string' && candidate.name.trim().length > 0
        ? candidate.name.trim()
        : deriveProjectLabel(normalizedPath);
      const persisted = persistedByPath.get(normalizedPath);

      const id = `vscode:${normalizedPath}`;
      acc.push({
        id,
        path: normalizedPath,
        label,
        addedAt: persisted?.addedAt ?? 0,
        lastOpenedAt: persisted?.lastOpenedAt ?? 0,
      });
      return acc;
    }, []);

  const fallbackWorkspaceFolder = typeof config?.workspaceFolder === 'string'
    ? normalizeProjectPath(config.workspaceFolder)
    : '';
  const activeWorkspaceFolder = typeof config?.activeWorkspaceFolder === 'string'
    ? normalizeProjectPath(config.activeWorkspaceFolder)
    : fallbackWorkspaceFolder;

  const normalizedProjects: ProjectEntry[] = projects.length > 0 ? projects : (() => {
    if (!fallbackWorkspaceFolder) {
      return [];
    }
    return [{
      id: `vscode:${fallbackWorkspaceFolder}`,
      path: fallbackWorkspaceFolder,
      label: deriveProjectLabel(fallbackWorkspaceFolder),
      addedAt: persistedByPath.get(fallbackWorkspaceFolder)?.addedAt ?? 0,
      lastOpenedAt: persistedByPath.get(fallbackWorkspaceFolder)?.lastOpenedAt ?? 0,
    } satisfies ProjectEntry];
  })();

  if (normalizedProjects.length === 0) {
    return null;
  }

  const persistedActiveId = readPersistedActiveProjectId();
  const activeProject = normalizedProjects.find((project) => project.path === activeWorkspaceFolder)
    ?? (persistedActiveId ? normalizedProjects.find((project) => project.id === persistedActiveId) : null)
    ?? normalizedProjects[0]
    ?? null;

  if (streamDebugEnabled()) {
    console.log('[OpenChamber][VSCode][projects] Using workspace roots', normalizedProjects);
  }

  return {
    projects: normalizedProjects,
    activeProjectId: activeProject?.id ?? null,
    activeProjectPath: activeProject?.path ?? null,
  };
};

const syncVSCodeRuntimeSelection = (project: ProjectEntry | null) => {
  if (!project || typeof window === 'undefined') {
    return;
  }

  const windowWithConfig = window as typeof window & {
    __VSCODE_CONFIG__?: {
      workspaceFolder: string;
      activeWorkspaceFolder?: string;
      workspaceFolders?: Array<{ name: string; path: string; index?: number }>;
      theme: string;
      connectionStatus: string;
      cliAvailable?: boolean;
      panelType?: string;
      viewMode?: 'sidebar' | 'editor';
      initialSessionId?: string | null;
    };
    __OPENCHAMBER_HOME__?: string;
  };

  if (windowWithConfig.__VSCODE_CONFIG__) {
    windowWithConfig.__VSCODE_CONFIG__ = {
      ...windowWithConfig.__VSCODE_CONFIG__,
      workspaceFolder: project.path,
      activeWorkspaceFolder: project.path,
    };
  }

  windowWithConfig.__OPENCHAMBER_HOME__ = project.path;
  window.dispatchEvent(new CustomEvent('openchamber:vscode-workspace-context', {
    detail: {
      workspaceFolder: project.path,
      activeWorkspaceFolder: project.path,
      workspaceFolders: windowWithConfig.__VSCODE_CONFIG__?.workspaceFolders ?? [],
    },
  }));
  useDirectoryStore.getState().synchronizeHomeDirectory(project.path);
  opencodeClient.setDirectory(project.path);
  useDirectoryStore.getState().setDirectory(project.path, { showOverlay: false });
};

const vscodeWorkspace = readVSCodeWorkspaceContext();
const isVSCodeWorkspace = Boolean(vscodeWorkspace);
const effectiveInitialProjects = vscodeWorkspace?.projects ?? initialProjects;
const initialActiveProjectId = vscodeWorkspace?.activeProjectId
  ?? readPersistedActiveProjectId()
  ?? effectiveInitialProjects[0]?.id
  ?? null;

if (vscodeWorkspace) {
  cacheProjects(effectiveInitialProjects, initialActiveProjectId);
  const initialActiveProject = effectiveInitialProjects.find((project) => project.id === initialActiveProjectId) ?? null;
  syncVSCodeRuntimeSelection(initialActiveProject);
}

export const useProjectsStore = create<ProjectsStore>()(
  devtools((set, get) => ({
    projects: effectiveInitialProjects,
    activeProjectId: initialActiveProjectId,

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

    addProject: (path: string, options?: { label?: string; id?: string }) => {
      if (isVSCodeWorkspace) {
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
      const candidateId = options?.id?.trim();
      const id = candidateId && !get().projects.some((project) => project.id === candidateId)
        ? candidateId
        : createProjectId();
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

    removeProject: (id: string) => {
      if (isVSCodeWorkspace) {
        return;
      }
      const current = get();
      const nextProjects = current.projects.filter((project) => project.id !== id);
      let nextActiveId = current.activeProjectId;

      if (current.activeProjectId === id) {
        nextActiveId = nextProjects[0]?.id ?? null;
      }

      set({ projects: nextProjects, activeProjectId: nextActiveId });
      persistProjects(nextProjects, nextActiveId);

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
      if (isVSCodeWorkspace) {
        cacheProjects(nextProjects, id);
        syncVSCodeRuntimeSelection(target);
      } else {
        persistProjects(nextProjects, id);
        opencodeClient.setDirectory(target.path);
        useDirectoryStore.getState().setDirectory(target.path, { showOverlay: false });
      }
    },

    setActiveProjectIdOnly: (id: string) => {
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
      if (isVSCodeWorkspace) {
        cacheProjects(nextProjects, id);
        syncVSCodeRuntimeSelection(target);
      } else {
        persistProjects(nextProjects, id);
      }
    },

    renameProject: (id: string, label: string) => {
      if (isVSCodeWorkspace) {
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
      persistProjects(nextProjects, activeProjectId);
    },

    updateProjectMeta: (id: string, meta: { label?: string; icon?: string | null; color?: string | null; iconBackground?: string | null }) => {
      if (isVSCodeWorkspace) {
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
        return updated;
      });
      set({ projects: nextProjects });
      persistProjects(nextProjects, activeProjectId);
    },

    uploadProjectIcon: async (id: string, file: File) => {
      if (isVSCodeWorkspace) {
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

        const response = await fetch(`/api/projects/${encodeURIComponent(id)}/icon`, {
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
          get().synchronizeFromSettings(payload.settings);
        }
        return { ok: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, error: message || 'Failed to upload project icon' };
      }
    },

    removeProjectIcon: async (id: string) => {
      if (isVSCodeWorkspace) {
        return { ok: false, error: 'Custom icons are not supported in this runtime' };
      }

      try {
        const response = await fetch(`/api/projects/${encodeURIComponent(id)}/icon`, {
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
          get().synchronizeFromSettings(payload.settings);
        }
        return { ok: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, error: message || 'Failed to remove project icon' };
      }
    },

    discoverProjectIcon: async (id: string, options?: { force?: boolean }) => {
      if (isVSCodeWorkspace) {
        return { ok: false, error: 'Custom icons are not supported in this runtime' };
      }

      try {
        const response = await fetch(`/api/projects/${encodeURIComponent(id)}/icon/discover`, {
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
          get().synchronizeFromSettings(payload.settings);
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
      if (isVSCodeWorkspace) {
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

      set({ projects: nextProjects });
      persistProjects(nextProjects, activeProjectId);
    },

    synchronizeFromSettings: (settings: DesktopSettings) => {
      if (isVSCodeWorkspace) {
        return;
      }
      const incomingProjects = sanitizeProjects(settings.projects ?? []);
      const incomingActive = typeof settings.activeProjectId === 'string' && settings.activeProjectId.trim()
        ? settings.activeProjectId.trim()
        : null;

      const current = get();
      const projectsChanged = JSON.stringify(current.projects) !== JSON.stringify(incomingProjects);
      const activeChanged = current.activeProjectId !== incomingActive;

      if (!projectsChanged && !activeChanged) {
        return;
      }

      set({ projects: incomingProjects, activeProjectId: incomingActive });
      cacheProjects(incomingProjects, incomingActive);

      if (incomingActive) {
        const activeProject = incomingProjects.find((project) => project.id === incomingActive);
        if (activeProject) {
          opencodeClient.setDirectory(activeProject.path);
          useDirectoryStore.getState().setDirectory(activeProject.path, { showOverlay: false });
        }
      }
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
    const detail = (event as CustomEvent<DesktopSettings>).detail;
    if (detail && typeof detail === 'object') {
      useProjectsStore.getState().synchronizeFromSettings(detail);
    }
  });

  window.addEventListener('openchamber:vscode-workspace-context', () => {
    const context = readVSCodeWorkspaceContext();
    if (!context) {
      return;
    }

    const current = useProjectsStore.getState();
    const activeProjectId = context.activeProjectId ?? context.projects[0]?.id ?? null;
    const projectsChanged = JSON.stringify(current.projects) !== JSON.stringify(context.projects);
    const activeChanged = current.activeProjectId !== activeProjectId;

    if (!projectsChanged && !activeChanged) {
      return;
    }

    useProjectsStore.setState({
      projects: context.projects,
      activeProjectId,
    });
    cacheProjects(context.projects, activeProjectId);

    const activeProject = context.projects.find((project) => project.id === activeProjectId) ?? null;
    syncVSCodeRuntimeSelection(activeProject);
  });
}
