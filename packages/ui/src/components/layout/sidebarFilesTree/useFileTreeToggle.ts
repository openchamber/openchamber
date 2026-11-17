import React from 'react';

import { useFileTreeDisclosure } from '@/components/views/files/useFileTreeDisclosure';
import { useFilesViewTabsStore } from '@/stores/useFilesViewTabsStore';
import { normalizePath } from './treePaths';

export const useFileTreeToggle = ({
  root,
  treeListRef,
  loadedDirsRef,
  loadDirectory,
}: {
  root: string;
  treeListRef: React.RefObject<HTMLUListElement | null>;
  loadedDirsRef: React.RefObject<Set<string>>;
  loadDirectory: (dirPath: string) => Promise<void>;
}) => {
  const toggleExpandedPath = useFilesViewTabsStore((state) => state.toggleExpandedPath);
  const [slidingRowPaths, setSlidingRowPaths] = React.useState<readonly string[] | null>(null);
  const clearSlidingRowPaths = React.useCallback(() => setSlidingRowPaths(null), []);
  const toggleWithMotion = useFileTreeDisclosure(treeListRef, { onSettled: clearSlidingRowPaths });
  const toggleDirectory = React.useCallback(async (dirPath: string) => {
    const normalized = normalizePath(dirPath);
    if (!root) return;

    const expanded = useFilesViewTabsStore.getState().byRoot[root]?.expandedPaths.includes(normalized) ?? false;
    toggleWithMotion(dirPath, expanded, () => {
      const mountedPaths = Array.from(treeListRef.current?.querySelectorAll<HTMLElement>('[data-tree-disclosure-path]') ?? [], (row) => row.dataset.treeDisclosurePath ?? '');
      setSlidingRowPaths(expanded ? null : mountedPaths.slice(mountedPaths.indexOf(dirPath) + 1));
      toggleExpandedPath(root, normalized);
    });
    if (!loadedDirsRef.current.has(normalized)) {
      await loadDirectory(normalized);
    }
  }, [loadDirectory, loadedDirsRef, root, toggleExpandedPath, toggleWithMotion, treeListRef]);

  return { slidingRowPaths, toggleDirectory };
};
