import React from 'react';

import type { FileTreeGitStatus } from '@/components/views/files/fileTreeRow';
import type { useGitStatus } from '@/stores/useGitStore';

type GitStatusSnapshot = ReturnType<typeof useGitStatus>;

export const useFileTreeGitMarks = (gitStatus: GitStatusSnapshot, root: string) => {
  // statusByPath / badgeByDir are precomputed once per gitStatus change so the
  // tree render is O(1) per node instead of O(N) per node. Without these
  // maps, a deep tree with 200 files and 40 directories would do ~8000
  // string comparisons on every render.

  const statusByPath = React.useMemo(() => {
    const map = new Map<string, FileTreeGitStatus>();
    if (!gitStatus?.files) return map;
    for (const file of gitStatus.files) {
      if (file.index === 'A' || file.working_dir === '?') {
        map.set(file.path, 'git-added');
      } else if (file.index === 'D') {
        map.set(file.path, 'git-deleted');
      } else if (file.index === 'M' || file.working_dir === 'M') {
        map.set(file.path, 'git-modified');
      }
    }
    return map;
  }, [gitStatus]);

  const badgeByDir = React.useMemo(() => {
    const map = new Map<string, { modified: number; added: number }>();
    if (!gitStatus?.files || !root) return map;
    for (const file of gitStatus.files) {
      const isModified = file.index === 'M' || file.working_dir === 'M';
      const isAdded = file.index === 'A' || file.working_dir === '?';
      if (!isModified && !isAdded) continue;
      const segments = file.path.split('/');
      if (segments.length <= 1) continue;
      let currentDir = root;
      for (let i = 0; i < segments.length - 1; i++) {
        currentDir = `${currentDir}/${segments[i]}`;
        let entry = map.get(currentDir);
        if (!entry) {
          entry = { modified: 0, added: 0 };
          map.set(currentDir, entry);
        }
        if (isModified) entry.modified++;
        if (isAdded) entry.added++;
      }
    }
    return map;
  }, [gitStatus, root]);

  const getFileStatus = React.useCallback((path: string): FileTreeGitStatus | null => {
    if (statusByPath.size === 0) return null;
    const relative = path.startsWith(root + '/') ? path.slice(root.length + 1) : path;
    return statusByPath.get(relative) ?? null;
  }, [statusByPath, root]);

  const getFolderBadge = React.useCallback((dirPath: string): { modified: number; added: number } | null => {
    if (badgeByDir.size === 0) return null;
    const entry = badgeByDir.get(dirPath);
    if (!entry) return null;
    return entry.modified + entry.added > 0 ? entry : null;
  }, [badgeByDir]);

  return { getFileStatus, getFolderBadge };
};
