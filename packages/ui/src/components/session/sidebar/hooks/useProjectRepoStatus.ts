import React from 'react';
import { checkIsGitRepository } from '@/lib/gitApi';
import { getRootBranch } from '@/lib/worktrees/worktreeStatus';

type Project = { id: string; path: string; normalizedPath: string };

type DirectoryState = { status?: { current?: string | null } | null };

type Args = {
  projects: Array<{ id: string; path: string }>;
  normalizedProjects: Project[];
  normalizePath: (value?: string | null) => string | null;
  gitDirectories: Map<string, DirectoryState>;
  setProjectRepoStatus: React.Dispatch<React.SetStateAction<Map<string, boolean | null>>>;
  setProjectRootBranches: React.Dispatch<React.SetStateAction<Map<string, string>>>;
};

export const useProjectRepoStatus = (args: Args): void => {
  const {
    projects,
    normalizedProjects,
    normalizePath,
    gitDirectories,
    setProjectRepoStatus,
    setProjectRootBranches,
  } = args;

  React.useEffect(() => {
    let cancelled = false;
    const normalized = projects
      .map((project) => ({ id: project.id, path: normalizePath(project.path) }))
      .filter((project): project is { id: string; path: string } => Boolean(project.path));

    setProjectRepoStatus(new Map());

    if (normalized.length === 0) {
      return () => {
        cancelled = true;
      };
    }

    normalized.forEach((project) => {
      checkIsGitRepository(project.path)
        .then((result) => {
          if (!cancelled) {
            setProjectRepoStatus((prev) => {
              const next = new Map(prev);
              next.set(project.id, result);
              return next;
            });
          }
        })
        .catch(() => {
          if (!cancelled) {
            setProjectRepoStatus((prev) => {
              const next = new Map(prev);
              next.set(project.id, null);
              return next;
            });
          }
        });
    });

    return () => {
      cancelled = true;
    };
  }, [normalizePath, projects, setProjectRepoStatus]);

  const projectGitBranchesKey = React.useMemo(() => {
    return normalizedProjects
      .map((project) => {
        const dirState = gitDirectories.get(project.normalizedPath);
        return `${project.id}:${dirState?.status?.current ?? ''}`;
      })
      .join('|');
  }, [normalizedProjects, gitDirectories]);

  React.useEffect(() => {
    let cancelled = false;
    const run = async () => {
        const entries = await Promise.all(
        normalizedProjects.map(async (project) => {
          const branch = await getRootBranch(project.normalizedPath).catch(() => null);
          return { id: project.id, branch };
        }),
      );
      if (cancelled) {
        return;
      }
      setProjectRootBranches((prev) => {
        const next = new Map(prev);
        entries.forEach(({ id, branch }) => {
          if (branch) {
            next.set(id, branch);
          }
        });
        return next;
      });
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [normalizedProjects, projectGitBranchesKey, setProjectRootBranches]);
};
