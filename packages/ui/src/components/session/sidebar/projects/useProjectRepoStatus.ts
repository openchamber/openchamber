import React from 'react';
import { getRootBranch } from '@/lib/worktrees/worktreeStatus';
import { useGitStore } from '@/stores/useGitStore';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { runBackgroundNetworkTask } from '@/lib/background-network';
import { captureRuntimeInstance } from '@/lib/runtime-switch';
import type { RuntimeAPIs } from '@/lib/api/types';

type Project = { id: string; path: string; normalizedPath: string };
const ROOT_BRANCH_TTL_MS = 5 * 60_000;

type Args = {
  enabled?: boolean;
  normalizedProjects: Project[];
  gitRepoStatus: Map<string, { isGitRepo: boolean | null; branch: string | null }>;
  setProjectRepoStatus: React.Dispatch<React.SetStateAction<Map<string, boolean | null>>>;
  setProjectRootBranches: React.Dispatch<React.SetStateAction<Map<string, string>>>;
};

export const useProjectRepoStatus = (args: Args): void => {
  const {
    normalizedProjects,
    enabled = true,
    gitRepoStatus,
    setProjectRepoStatus,
    setProjectRootBranches,
  } = args;

  const { git } = useRuntimeAPIs();
  const ensureStatus = useGitStore((state) => state.ensureStatus);
  const gitRuntimeKey = useGitStore((state) => state.runtimeKey);
  const requestedStatusRef = React.useRef<{ runtimeKey: string; git: RuntimeAPIs['git']; paths: Set<string> } | null>(null);

  const wasEnabledRef = React.useRef(enabled);
  React.useEffect(() => {
    const reshown = enabled && !wasEnabledRef.current;
    wasEnabledRef.current = enabled;
    const requested = requestedStatusRef.current;
    if (!reshown || !git || !requested || requested.git !== git || requested.runtimeKey !== gitRuntimeKey) return;
    for (const path of requested.paths) {
      void runBackgroundNetworkTask(() => ensureStatus(path, git));
    }
  }, [enabled, ensureStatus, git, gitRuntimeKey]);

  React.useEffect(() => {
    if (!enabled) return;
    if (!git || normalizedProjects.length === 0) {
      requestedStatusRef.current = null;
      setProjectRepoStatus(new Map());
      return;
    }

    let requested = requestedStatusRef.current;
    if (!requested || requested.runtimeKey !== gitRuntimeKey || requested.git !== git) {
      requested = { runtimeKey: gitRuntimeKey, git, paths: new Set() };
      requestedStatusRef.current = requested;
    }
    const { paths } = requested;
    const currentPaths = new Set(normalizedProjects.map((project) => project.normalizedPath));
    for (const path of paths) {
      if (!currentPaths.has(path)) paths.delete(path);
    }
    const newPaths = [...currentPaths].filter((path) => !paths.has(path));
    if (newPaths.length === 0) return;
    for (const path of newPaths) paths.add(path);
    const forgetIfUnknown = (path: string) => {
      const state = useGitStore.getState().directories.get(path);
      if (state?.isGitRepo !== false && !state?.status) paths.delete(path);
    };
    const isCurrent = captureRuntimeInstance();
    void runBackgroundNetworkTask(async () => {
      void git.prefetchProjectStatuses?.(newPaths).catch(() => undefined);
      if (!isCurrent()) return;
      await Promise.all(newPaths.map((path) => ensureStatus(path, git).then(
        () => forgetIfUnknown(path),
        () => forgetIfUnknown(path),
      )));
    });
  }, [enabled, normalizedProjects, git, gitRuntimeKey, ensureStatus, setProjectRepoStatus]);

  React.useEffect(() => {
    if (!enabled) return;
    const next = new Map<string, boolean | null>();
    normalizedProjects.forEach((project) => {
      next.set(project.id, gitRepoStatus.get(project.normalizedPath)?.isGitRepo ?? null);
    });
    setProjectRepoStatus(next);
  }, [enabled, normalizedProjects, gitRepoStatus, setProjectRepoStatus]);

  const projectGitBranchesKey = React.useMemo(() => {
    return normalizedProjects
      .map((project) => {
        const branch = gitRepoStatus.get(project.normalizedPath)?.branch ?? '';
        return `${project.id}:${branch}`;
      })
      .join('|');
  }, [normalizedProjects, gitRepoStatus]);

  const resolvedInputKeyByProjectId = React.useRef<Map<string, string>>(new Map());

  const rootBranchCacheRef = React.useRef<Map<string, { branch: string; at: number }>>(new Map());

  React.useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    const timer = setTimeout(() => {
      const run = async () => {
        const validIds = new Set(normalizedProjects.map((project) => project.id));
        for (const id of resolvedInputKeyByProjectId.current.keys()) {
          if (!validIds.has(id)) {
            resolvedInputKeyByProjectId.current.delete(id);
            rootBranchCacheRef.current.delete(id);
          }
        }

        const now = Date.now();
        const pending = normalizedProjects.filter((project) => {
          const status = gitRepoStatus.get(project.normalizedPath);
          if (status?.isGitRepo === false) {
            resolvedInputKeyByProjectId.current.delete(project.id);
            rootBranchCacheRef.current.delete(project.id);
            return false;
          }
          if (status?.isGitRepo !== true || status.branch === null) {
            return false;
          }
          const currentBranch = status.branch.trim();
          const currentInputKey = `${project.normalizedPath}\0${currentBranch}`;
          const lastInputKey = resolvedInputKeyByProjectId.current.get(project.id);
          if (lastInputKey === currentInputKey) {
            const cached = rootBranchCacheRef.current.get(project.id);
            if (cached) cached.at = now;
            return false;
          }
          if (lastInputKey !== undefined && now - (rootBranchCacheRef.current.get(project.id)?.at ?? 0) < ROOT_BRANCH_TTL_MS) {
            return false;
          }
          return true;
        });

        if (pending.length === 0) {
          return;
        }

        const entries = await runBackgroundNetworkTask(() =>
          Promise.all(pending.map(async (project) => {
            const inputBranch = gitRepoStatus.get(project.normalizedPath)?.branch?.trim() ?? '';
            const inputKey = `${project.normalizedPath}\0${inputBranch}`;
            const branch = await getRootBranch(
              project.normalizedPath,
              inputBranch ? { knownBranch: inputBranch } : undefined,
            ).catch(() => null);
            return { id: project.id, inputKey, branch };
          })),
        );
        if (!entries || cancelled) {
          return;
        }

        const resolved = entries.filter((entry) => entry.branch);
        if (resolved.length === 0) {
          return;
        }

        const nowAfter = Date.now();
        setProjectRootBranches((prev) => {
          const next = new Map(prev);
          resolved.forEach(({ id, branch }) => {
            if (branch) {
              next.set(id, branch);
            }
          });
          return next;
        });
        resolved.forEach(({ id, inputKey, branch }) => {
          resolvedInputKeyByProjectId.current.set(id, inputKey);
          if (branch) {
            rootBranchCacheRef.current.set(id, { branch, at: nowAfter });
          }
        });
      };
      void run();
    }, 150);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [enabled, normalizedProjects, projectGitBranchesKey, gitRepoStatus, setProjectRootBranches]);
};
