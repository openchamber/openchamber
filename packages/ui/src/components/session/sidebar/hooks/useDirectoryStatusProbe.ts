import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2';
import { opencodeClient } from '@/lib/opencode/client';
import { normalizePath } from '../utils';

type ProjectLike = { path: string };

type Args = {
  sortedSessions: Session[];
  projects: ProjectLike[];
  directoryStatus: Map<string, 'unknown' | 'exists' | 'missing'>;
  setDirectoryStatus: React.Dispatch<React.SetStateAction<Map<string, 'unknown' | 'exists' | 'missing'>>>;
};

export const useDirectoryStatusProbe = ({
  sortedSessions,
  projects,
  directoryStatus,
  setDirectoryStatus,
}: Args): void => {
  const directoryStatusRef = React.useRef<Map<string, 'unknown' | 'exists' | 'missing'>>(new Map());
  const checkingDirectories = React.useRef<Set<string>>(new Set());

  React.useEffect(() => {
    directoryStatusRef.current = directoryStatus;
  }, [directoryStatus]);

  React.useEffect(() => {
    const directories = new Set<string>();
    sortedSessions.forEach((session) => {
      const dir = normalizePath((session as Session & { directory?: string | null }).directory ?? null);
      if (dir) {
        directories.add(dir);
      }
    });
    projects.forEach((project) => {
      const normalized = normalizePath(project.path);
      if (normalized) {
        directories.add(normalized);
      }
    });

    directories.forEach((directory) => {
      const known = directoryStatusRef.current.get(directory);
      if ((known && known !== 'unknown') || checkingDirectories.current.has(directory)) {
        return;
      }
      checkingDirectories.current.add(directory);
      opencodeClient
        .listLocalDirectory(directory)
        .then(() => {
          setDirectoryStatus((prev) => {
            const next = new Map(prev);
            if (next.get(directory) === 'exists') {
              return prev;
            }
            next.set(directory, 'exists');
            return next;
          });
        })
        .catch(async () => {
          const looksLikeSdkWorktree =
            directory.includes('/opencode/worktree/') ||
            directory.includes('/.opencode/data/worktree/') ||
            directory.includes('/.local/share/opencode/worktree/');

          if (looksLikeSdkWorktree) {
            const ok = await opencodeClient.probeDirectory(directory).catch(() => false);
            if (ok) {
              setDirectoryStatus((prev) => {
                const next = new Map(prev);
                if (next.get(directory) === 'exists') {
                  return prev;
                }
                next.set(directory, 'exists');
                return next;
              });
              return;
            }
          }

          setDirectoryStatus((prev) => {
            const next = new Map(prev);
            if (next.get(directory) === 'missing') {
              return prev;
            }
            next.set(directory, 'missing');
            return next;
          });
        })
        .finally(() => {
          checkingDirectories.current.delete(directory);
        });
    });
  }, [sortedSessions, projects, setDirectoryStatus]);
};
