import { create } from 'zustand';
import { opencodeClient } from '@/lib/opencode/client';
import { listProjectWorktrees, removeProjectWorktree, type ProjectRef } from '@/lib/worktrees/worktreeManager';
import { useDirectoryStore } from './useDirectoryStore';
import { useProjectsStore } from './useProjectsStore';
import { deleteSessionInDirectory } from '@/sync/session-actions';
import { retry } from '@/sync/retry';
import type { WorktreeMetadata } from '@/types/worktree';
import type { Session } from '@opencode-ai/sdk/v2';

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

const normalize = (value: string): string => {
  if (!value) return '';
  const replaced = value.replace(/\\/g, '/');
  if (replaced === '/') return '/';
  return replaced.replace(/\/+$/, '');
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentGroupSession {
  id: string;
  path: string;
  providerId: string;
  modelId: string;
  instanceNumber: number;
  branch: string;
  displayLabel: string;
  worktreeMetadata?: WorktreeMetadata;
}

export interface AgentGroup {
  name: string;
  sessions: AgentGroupSession[];
  lastActive: number;
  sessionCount: number;
}

export interface DeleteAgentGroupResult {
  failedIds: string[];
  failedWorktreePaths: string[];
}

// ---------------------------------------------------------------------------
// parseSessionTitle
// ---------------------------------------------------------------------------

export function parseSessionTitle(title: string | undefined): {
  groupSlug: string;
  provider: string;
  model: string;
  index: number;
} | null {
  if (!title) return null;
  const parts = title.split('/');
  if (parts.length < 3) return null;

  const groupSlug = parts[0];
  if (!groupSlug || groupSlug.includes(' ')) return null;

  const provider = parts[1];
  if (!provider) return null;

  const lastPart = parts[parts.length - 1];
  const lastPartNum = parseInt(lastPart, 10);
  const hasIndex = parts.length >= 4 && !isNaN(lastPartNum) && String(lastPartNum) === lastPart;

  const modelParts = hasIndex ? parts.slice(2, -1) : parts.slice(2);
  if (modelParts.length === 0) return null;

  return { groupSlug, provider, model: modelParts.join('/'), index: hasIndex ? lastPartNum : 1 };
}

// ---------------------------------------------------------------------------
// resolveProjectRef
// ---------------------------------------------------------------------------

function resolveProjectRef(): { id: string; path: string } | null {
  const currentDirectory = useDirectoryStore.getState().currentDirectory;
  const projectsState = useProjectsStore.getState();
  const activeProjectId = projectsState.activeProjectId;
  const activeProjectPath = activeProjectId
    ? projectsState.projects.find((p) => p.id === activeProjectId)?.path
    : undefined;

  const raw = (typeof activeProjectPath === 'string' && activeProjectPath.trim().length > 0)
    ? activeProjectPath
    : currentDirectory;

  if (!raw) return null;
  const path = normalize(raw);
  if (!path) return null;

  const entry = projectsState.projects.find((p) => normalize(p.path) === path);
  return { id: entry?.id ?? `path:${path}`, path };
}

function resolveProjectRefForWorktree(session: AgentGroupSession): ProjectRef | null {
  const projectsState = useProjectsStore.getState();
  const projectPath = normalize(session.worktreeMetadata?.projectDirectory ?? '');
  if (projectPath) {
    const project = projectsState.projects.find((entry) => normalize(entry.path) === projectPath);
    return { id: project?.id ?? `path:${projectPath}`, path: projectPath };
  }
  return resolveProjectRef();
}

// ---------------------------------------------------------------------------
// buildGroups — turns raw sessions + worktree metadata into AgentGroup[]
// ---------------------------------------------------------------------------

function buildGroups(
  sessions: Session[],
  metaByPath: Map<string, WorktreeMetadata>,
): AgentGroup[] {
  const map = new Map<string, AgentGroupSession[]>();

  for (const session of sessions) {
    const parsed = parseSessionTitle(session.title);
    if (!parsed) continue;

    const sessionPath = normalize(session.directory ?? '');
    const meta = metaByPath.get(sessionPath);

    const entry: AgentGroupSession = {
      id: session.id,
      path: sessionPath,
      providerId: parsed.provider,
      modelId: parsed.model,
      instanceNumber: parsed.index,
      branch: meta?.branch ?? '',
      displayLabel: `${parsed.provider}/${parsed.model}`,
      worktreeMetadata: meta,
    };

    const existing = map.get(parsed.groupSlug);
    if (existing) existing.push(entry);
    else map.set(parsed.groupSlug, [entry]);
  }

  const groups: AgentGroup[] = [];
  for (const [name, groupSessions] of map) {
    const lastActive = groupSessions.reduce((max, gs) => {
      const raw = sessions.find((s) => s.id === gs.id);
      const t = (raw as { time?: { updated?: number | null } } | undefined)?.time?.updated ?? 0;
      return Math.max(max, typeof t === 'number' ? t : 0);
    }, 0);

    groupSessions.sort((a, b) => {
      const p = a.providerId.localeCompare(b.providerId);
      if (p !== 0) return p;
      const m = a.modelId.localeCompare(b.modelId);
      if (m !== 0) return m;
      return a.instanceNumber - b.instanceNumber;
    });

    groups.push({ name, sessions: groupSessions, lastActive: lastActive || Date.now(), sessionCount: groupSessions.length });
  }

  groups.sort((a, b) => a.name.localeCompare(b.name));
  return groups;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface AgentGroupsState {
  groups: AgentGroup[];
  selectedGroupName: string | null;
  selectedSessionId: string | null;
  isLoading: boolean;
  error: string | null;
}

interface AgentGroupsActions {
  /** List worktrees, fetch sessions per worktree, build groups. */
  loadGroups: () => Promise<void>;
  selectGroup: (groupName: string | null) => void;
  selectSession: (sessionId: string | null) => void;
  deleteGroupSessions: (sessions: AgentGroupSession[], options?: { removeWorktrees?: boolean }) => Promise<DeleteAgentGroupResult>;
  clearError: () => void;
}

type Store = AgentGroupsState & AgentGroupsActions;

export const useAgentGroupsStore = create<Store>()(
  (set, get) => ({
    groups: [],
    selectedGroupName: null,
    selectedSessionId: null,
    isLoading: false,
    error: null,

    loadGroups: async () => {
      const projectRef = resolveProjectRef();
      if (!projectRef) {
        set({ groups: [], isLoading: false, error: 'No project directory' });
        return;
      }

      set({ isLoading: true, error: null });

      try {
        // 1. List worktrees (already cached 30s by worktreeManager)
        const worktrees = await listProjectWorktrees(projectRef);
        const metaByPath = new Map<string, WorktreeMetadata>();
        const dirs: string[] = [];
        for (const meta of worktrees) {
          if (meta?.path) {
            const key = normalize(meta.path);
            dirs.push(key);
            metaByPath.set(key, meta);
          }
        }

        if (dirs.length === 0) {
          set({ groups: [], isLoading: false });
          return;
        }

        // 2. Fetch sessions for each worktree directory (parallel, max 5)
        const api = opencodeClient.getApiClient();
        const allSessions: Session[] = [];
        const failedDirectories = new Set<string>();

        const fetchDir = async (dir: string) => {
          try {
            const res = await retry(async () => {
              const result = await api.session.list({ directory: dir });
              if ((result as { error?: unknown }).error) {
                throw new Error(`session.list failed for ${dir}: ${String((result as { error?: unknown }).error)}`);
              }
              return result;
            });
            const list = Array.isArray(res.data) ? res.data : [];
            for (const s of list) if (s?.id) allSessions.push(s);
          } catch {
            failedDirectories.add(dir);
          }
        };

        // Simple concurrency limiter
        let idx = 0;
        const worker = async () => {
          while (idx < dirs.length) {
            const i = idx++;
            await fetchDir(dirs[i]);
          }
        };
        await Promise.all(Array.from({ length: Math.min(5, dirs.length) }, () => worker()));

        // 3. Build groups
        const groups = buildGroups(allSessions, metaByPath);
        set({
          groups,
          isLoading: false,
          error: failedDirectories.size > 0 ? `Failed to load sessions for ${failedDirectories.size} worktree${failedDirectories.size === 1 ? '' : 's'}` : null,
        });
      } catch (err) {
        set({
          groups: get().groups, // preserve on error
          isLoading: false,
          error: err instanceof Error ? err.message : 'Failed to load groups',
        });
      }
    },

    selectGroup: (groupName) => {
      if (!groupName) {
        set({ selectedGroupName: null, selectedSessionId: null });
        return;
      }
      const group = get().groups.find((g) => g.name === groupName);
      set({
        selectedGroupName: groupName,
        selectedSessionId: group?.sessions[0]?.id ?? null,
      });
    },

    selectSession: (sessionId) => set({ selectedSessionId: sessionId }),

    deleteGroupSessions: async (sessions, options) => {
      const failedIds: string[] = [];
      const failedWorktreePaths: string[] = [];
      const removeWorktrees = options?.removeWorktrees === true;
      const deletedIds = new Set<string>();

      for (const s of sessions) {
        if (!s.path) continue;
        const ok = await deleteSessionInDirectory(s.id, s.path);
        if (!ok) failedIds.push(s.id);
        else deletedIds.add(s.id);
      }

      if (removeWorktrees) {
        const worktreesByPath = new Map<string, AgentGroupSession[]>();
        for (const session of sessions) {
          const path = normalize(session.path);
          if (!path) continue;
          const existing = worktreesByPath.get(path);
          if (existing) existing.push(session);
          else worktreesByPath.set(path, [session]);
        }

        for (const [path, pathSessions] of worktreesByPath) {
          if (pathSessions.some((session) => failedIds.includes(session.id))) {
            failedWorktreePaths.push(path);
            continue;
          }

          const source = pathSessions.find((session) => session.worktreeMetadata)?.worktreeMetadata ?? pathSessions[0]?.worktreeMetadata;
          const projectRef = pathSessions.map(resolveProjectRefForWorktree).find((value): value is ProjectRef => value !== null) ?? null;
          if (!source || !projectRef) {
            failedWorktreePaths.push(path);
            continue;
          }

          try {
            await removeProjectWorktree(projectRef, source, { deleteLocalBranch: true });
            const directoryStore = useDirectoryStore.getState();
            if (normalize(directoryStore.currentDirectory) === path) {
              directoryStore.setDirectory(projectRef.path, { showOverlay: false });
            }
          } catch {
            failedWorktreePaths.push(path);
          }
        }
      }

      // Clear selection if needed
      const { selectedSessionId, selectedGroupName } = get();
      if (selectedSessionId && deletedIds.has(selectedSessionId)) {
        set({ selectedSessionId: null });
      }
      if (selectedGroupName) {
        const group = get().groups.find((g) => g.name === selectedGroupName);
        if (group && group.sessions.every((s) => deletedIds.has(s.id))) {
          set({ selectedGroupName: null, selectedSessionId: null });
        }
      }

      // Refresh groups after delete
      void get().loadGroups();

      return { failedIds, failedWorktreePaths };
    },

    clearError: () => set({ error: null }),
  }),
);
