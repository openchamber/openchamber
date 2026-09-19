import { create } from 'zustand';
import { opencodeClient } from '@/lib/opencode/client';
import { listProjectWorktrees, removeProjectWorktree, type ProjectRef } from '@/lib/worktrees/worktreeManager';
import { useDirectoryStore } from './useDirectoryStore';
import { useProjectsStore } from './useProjectsStore';
import { deleteSessionInDirectory } from '@/sync/session-actions';
import { listGlobalSessionPages } from './globalSessions';
import type { WorktreeMetadata } from '@/types/worktree';
import type { Session } from '@opencode-ai/sdk/v2';
import { buildAgentGroups, type AgentGroup, type AgentGroupSession } from '@/lib/multirun/groups';
import { getMultiRunIdentity } from '@/lib/multirun/identity';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { checkIsGitRepository } from '@/lib/gitApi';

export type { AgentGroup, AgentGroupSession } from '@/lib/multirun/groups';
let loadGeneration = 0;

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

interface DeleteAgentGroupResult {
  failedIds: string[];
  failedWorktreePaths: string[];
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
// Store
// ---------------------------------------------------------------------------

interface AgentGroupsState {
  groups: AgentGroup[];
  selectedGroupId: string | null;
  selectedSessionId: string | null;
  isLoading: boolean;
  error: string | null;
}

interface AgentGroupsActions {
  /** List worktrees, fetch sessions per worktree, build groups. */
  loadGroups: () => Promise<void>;
  selectGroup: (groupId: string | null) => void;
  selectSession: (sessionId: string | null) => void;
  deleteGroupSessions: (sessions: AgentGroupSession[], options?: { removeWorktrees?: boolean }) => Promise<DeleteAgentGroupResult>;
  clearError: () => void;
  resetForRuntimeSwitch: () => void;
}

type Store = AgentGroupsState & AgentGroupsActions;

export const useAgentGroupsStore = create<Store>()(
  (set, get) => ({
    groups: [],
    selectedGroupId: null,
    selectedSessionId: null,
    isLoading: false,
    error: null,

    loadGroups: async () => {
      const generation = ++loadGeneration;
      const runtimeKey = getRuntimeKey();
      const projectRef = resolveProjectRef();
      if (!projectRef) {
        set({ groups: [], isLoading: false, error: 'No project directory' });
        return;
      }

      set({ isLoading: true, error: null });

      try {
        // 1. List worktrees (already cached 30s by worktreeManager)
        const isGit = await checkIsGitRepository(projectRef.path);
        if (generation !== loadGeneration || runtimeKey !== getRuntimeKey()) return;
        const worktrees = isGit ? await listProjectWorktrees(projectRef) : [];
        if (generation !== loadGeneration || runtimeKey !== getRuntimeKey()) return;
        const metaByPath = new Map<string, WorktreeMetadata>();
        const dirs: string[] = [projectRef.path];
        for (const meta of worktrees) {
          if (meta?.path) {
            const key = normalize(meta.path);
            if (!dirs.includes(key)) dirs.push(key);
            metaByPath.set(key, meta);
          }
        }

        // 2. Fetch sessions for each worktree directory (parallel, max 5)
        const api = opencodeClient.getApiClient();
        const allSessions: Session[] = [];
        const failedDirectories = new Set<string>();

        const fetchDir = async (dir: string) => {
          try {
            if (generation !== loadGeneration || runtimeKey !== getRuntimeKey()) return;
            const list = await listGlobalSessionPages(api, { directory: dir, archived: true, narrowToArchived: false, pageSize: 500 });
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
        if (generation !== loadGeneration || runtimeKey !== getRuntimeKey()) return;
        const groups = buildAgentGroups(allSessions, metaByPath, projectRef.path);
        for (const previous of get().groups) {
          const retained = previous.sessions.filter((session) => failedDirectories.has(session.path));
          if (!retained.length) continue;
          const current = groups.find((group) => group.id === previous.id);
          if (current) {
            current.sessions.push(...retained);
            current.sessionCount = current.sessions.length;
            current.lastActive = Math.max(current.lastActive, previous.lastActive);
          } else {
            groups.push({ ...previous, sessions: retained, sessionCount: retained.length });
          }
        }
        set({
          groups,
          isLoading: false,
          error: failedDirectories.size > 0 ? `Failed to load sessions for ${failedDirectories.size} worktree${failedDirectories.size === 1 ? '' : 's'}` : null,
        });
      } catch (err) {
        if (generation !== loadGeneration || runtimeKey !== getRuntimeKey()) return;
        set({
          groups: get().groups, // preserve on error
          isLoading: false,
          error: err instanceof Error ? err.message : 'Failed to load groups',
        });
      }
    },

    selectGroup: (groupId) => {
      if (!groupId) {
        set({ selectedGroupId: null, selectedSessionId: null });
        return;
      }
      const group = get().groups.find((g) => g.id === groupId);
      set({
        selectedGroupId: groupId,
        selectedSessionId: group?.sessions[0]?.id ?? null,
      });
    },

    selectSession: (sessionId) => set({ selectedSessionId: sessionId }),

    deleteGroupSessions: async (sessions, options) => {
      const runtimeKey = getRuntimeKey();
      const assertCurrent = () => {
        if (runtimeKey !== getRuntimeKey()) throw new Error('Runtime changed');
      };
      const failedIds: string[] = [];
      const failedWorktreePaths: string[] = [];
      const removeWorktrees = options?.removeWorktrees === true;
      const deletedIds = new Set<string>();

      for (const s of sessions) {
        assertCurrent();
        if (!s.path) { failedIds.push(s.id); continue; }
        try {
          const current = await opencodeClient.getSession(s.id, s.path);
          assertCurrent();
          const scope = s.worktreeMetadata?.projectDirectory ?? resolveProjectRef()?.path ?? s.path;
          if (normalize(current.directory) !== normalize(s.path) || getMultiRunIdentity(current, scope)?.key !== s.groupKey) {
            failedIds.push(s.id);
            continue;
          }
        } catch {
          assertCurrent();
          failedIds.push(s.id);
          continue;
        }
        const ok = await deleteSessionInDirectory(s.id, s.path, runtimeKey);
        assertCurrent();
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
          assertCurrent();
          if (pathSessions.some((session) => failedIds.includes(session.id))) {
            failedWorktreePaths.push(path);
            continue;
          }

          const source = pathSessions.find((session) => session.worktreeMetadata)?.worktreeMetadata ?? pathSessions[0]?.worktreeMetadata;
          const projectRef = pathSessions.map(resolveProjectRefForWorktree).find((value): value is ProjectRef => value !== null) ?? null;
          if (!source || !projectRef) {
            continue;
          }
          if (normalize(projectRef.path) === path) continue;

          try {
            const remaining = await listGlobalSessionPages(opencodeClient.getSdkClient(), {
              directory: path, archived: true, narrowToArchived: false, pageSize: 500,
            });
            assertCurrent();
            if (remaining.length > 0) { failedWorktreePaths.push(path); continue; }
            await removeProjectWorktree(projectRef, source, { deleteLocalBranch: true });
            assertCurrent();
            const directoryStore = useDirectoryStore.getState();
            if (normalize(directoryStore.currentDirectory) === path) {
              directoryStore.setDirectory(projectRef.path, { showOverlay: false });
            }
          } catch {
            assertCurrent();
            failedWorktreePaths.push(path);
          }
        }
      }

      // Clear selection if needed
      const { selectedSessionId, selectedGroupId } = get();
      if (selectedSessionId && deletedIds.has(selectedSessionId)) {
        set({ selectedSessionId: null });
      }
      if (selectedGroupId) {
        const group = get().groups.find((g) => g.id === selectedGroupId);
        if (group && group.sessions.every((s) => deletedIds.has(s.id))) {
          set({ selectedGroupId: null, selectedSessionId: null });
        }
      }

      // Refresh groups after delete
      void get().loadGroups();

      return { failedIds, failedWorktreePaths };
    },

    clearError: () => set({ error: null }),
    resetForRuntimeSwitch: () => {
      loadGeneration += 1;
      set({ groups: [], selectedGroupId: null, selectedSessionId: null, isLoading: false, error: null });
    },
  }),
);
