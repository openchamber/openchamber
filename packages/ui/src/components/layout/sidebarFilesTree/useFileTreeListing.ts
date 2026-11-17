import React from 'react';

import { getRuntimeKey } from '@/lib/runtime-switch';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useFilesViewTabsStore } from '@/stores/useFilesViewTabsStore';
import { DirectoryRequests } from '@/components/views/files/directoryRequests';
import { areDirectoryNodesEqual } from '@/components/views/files/fileTreeStatus';
import { AUTO_RELIST_MAX_ENTRIES, useFileTreeChanges, type FileTreeChangeBatch } from '@/components/views/files/useFileTreeChanges';
import { opencodeClient } from '@/lib/opencode/client';
import { sortNodes, type FileNode } from './fileNode';
import { getParentPath, isAbsolutePath, normalizePath, shouldIgnoreEntryName } from './treePaths';
import { fileTreeCacheByRoot, fileTreeCacheKey, getOrCreateCache, touchCache } from './treeCache';

export const useFileTreeListing = ({
  root,
  visible,
  showHidden,
  showGitignored,
  expandedPaths,
}: {
  root: string;
  visible: boolean;
  showHidden: boolean;
  showGitignored: boolean;
  expandedPaths: string[];
}) => {
  const visibleRef = React.useRef(visible);
  visibleRef.current = visible;
  const { files } = useRuntimeAPIs();
  const cacheKey = fileTreeCacheKey(root);

  const [childrenByDir, setChildrenByDir] = React.useState<Record<string, FileNode[]>>({});
  const [loadErrorsByDir, setLoadErrorsByDir] = React.useState<Record<string, string>>({});
  const loadedDirsRef = React.useRef<Set<string>>(new Set());
  const entryCountByDirRef = React.useRef<Map<string, number>>(new Map());
  const directoryRequests = React.useMemo(() => new DirectoryRequests(), []);
  React.useEffect(() => () => directoryRequests.clear(), [directoryRequests]);
  const refreshAbortRef = React.useRef<AbortController | null>(null);

  React.useEffect(() => {
    if (!root) {
      setChildrenByDir({});
      setLoadErrorsByDir({});
      loadedDirsRef.current = new Set();
      return;
    }
    const cached = touchCache(root);
    if (cached) {
      setChildrenByDir({ ...cached.childrenByDir });
      setLoadErrorsByDir({ ...cached.loadErrorsByDir });
      loadedDirsRef.current = new Set(cached.loadedDirs);
    } else {
      setChildrenByDir({});
      setLoadErrorsByDir({});
      loadedDirsRef.current = new Set();
    }
  }, [root]);

  React.useEffect(() => {
    if (!root) return;
    const cache = getOrCreateCache(root);
    cache.childrenByDir = childrenByDir;
  }, [root, childrenByDir]);

  React.useEffect(() => {
    if (!root) return;
    const cache = getOrCreateCache(root);
    cache.loadErrorsByDir = loadErrorsByDir;
  }, [root, loadErrorsByDir]);

  React.useEffect(() => {
    if (!root) return;
    const cache = getOrCreateCache(root);
    cache.loadedDirs = new Set(loadedDirsRef.current);
  }, [root, childrenByDir, loadErrorsByDir]);

  React.useEffect(() => () => {
    if (!root) return;
    const cache = fileTreeCacheByRoot.get(cacheKey);
    if (cache && cache.loadedDirs.size === 0 && Object.keys(cache.childrenByDir).length === 0) {
      fileTreeCacheByRoot.delete(cacheKey);
    }
  }, [cacheKey, root]);

  const mapDirectoryEntries = React.useCallback((dirPath: string, entries: Array<{ name: string; path: string; isDirectory: boolean }>): FileNode[] => {
    const nodes = entries
      .filter((entry) => entry && typeof entry.name === 'string' && entry.name.length > 0)
      .filter((entry) => showHidden || !entry.name.startsWith('.'))
      .filter((entry) => showGitignored || !shouldIgnoreEntryName(entry.name))
      .map<FileNode>((entry) => {
        const name = entry.name;
        const normalizedEntryPath = normalizePath(entry.path || '');
        const path = normalizedEntryPath
          ? (isAbsolutePath(normalizedEntryPath)
            ? normalizedEntryPath
            : normalizePath(`${dirPath}/${normalizedEntryPath}`))
          : normalizePath(`${dirPath}/${name}`);
        const type = entry.isDirectory ? 'directory' : 'file';
        const extension = type === 'file' && name.includes('.') ? name.split('.').pop()?.toLowerCase() : undefined;
        return { name, path, type, extension };
      });

    return sortNodes(nodes);
  }, [showGitignored, showHidden]);

  const loadDirectory = React.useCallback(async (dirPath: string, isCancelled?: () => boolean, force = false) => {
    if (!visibleRef.current || isCancelled?.()) return;
    const normalizedDir = normalizePath(dirPath.trim());
    if (!normalizedDir) return;

    if (!force && loadedDirsRef.current.has(normalizedDir)) return;
    const requestRuntime = getRuntimeKey();
    return directoryRequests.run(normalizedDir, async (ownsRequest) => {
      const stale = () => !ownsRequest() || getRuntimeKey() !== requestRuntime;
      try {
        const respectGitignore = !showGitignored;
        const entries = files.listDirectory
          ? (await files.listDirectory(normalizedDir, { respectGitignore })).entries
          : await opencodeClient.listLocalDirectory(normalizedDir, { respectGitignore });
        if (stale()) return;
        entryCountByDirRef.current.set(normalizedDir, entries.length);
        const mapped = mapDirectoryEntries(normalizedDir, entries);
        loadedDirsRef.current = new Set(loadedDirsRef.current);
        loadedDirsRef.current.add(normalizedDir);
        setLoadErrorsByDir((prev) => {
          if (!prev[normalizedDir]) return prev;
          const next = { ...prev };
          delete next[normalizedDir];
          return next;
        });
        setChildrenByDir((prev) => prev[normalizedDir] && areDirectoryNodesEqual(prev[normalizedDir], mapped)
          ? prev : { ...prev, [normalizedDir]: mapped });
      } catch (error) {
        if (stale()) return;
        const message = error instanceof Error ? error.message : String(error ?? '');
        console.error('Failed to load sidebar directory:', error);
        setLoadErrorsByDir((prev) => ({ ...prev, [normalizedDir]: message }));
      }
    }, force);
  }, [directoryRequests, files, mapDirectoryEntries, showGitignored]);

  const refreshRoot = React.useCallback(async () => {
    if (!root) return;

    refreshAbortRef.current?.abort();
    const controller = new AbortController();
    refreshAbortRef.current = controller;
    directoryRequests.clear();

    try {
      const currentExpanded = useFilesViewTabsStore.getState().byRoot[root]?.expandedPaths ?? [];
      const normalizedExpanded = currentExpanded
        .map((p) => normalizePath(p))
        .filter((normalized): normalized is string =>
          Boolean(normalized) && normalized !== root && normalized.startsWith(`${root}/`),
        );
      const pathsToRefresh = [root, ...normalizedExpanded];

      loadedDirsRef.current = new Set(loadedDirsRef.current);
      for (const dirPath of pathsToRefresh) {
        loadedDirsRef.current.delete(dirPath);
      }

      setLoadErrorsByDir((prev) => {
        if (Object.keys(prev).length === 0) return prev;
        const next = { ...prev };
        let changed = false;
        for (const dirPath of pathsToRefresh) {
          if (dirPath in next) {
            delete next[dirPath];
            changed = true;
          }
        }
        return changed ? next : prev;
      });

      const isCancelled = () => controller.signal.aborted;

      await loadDirectory(root, isCancelled);
      for (let i = 0; i < normalizedExpanded.length && !controller.signal.aborted; i += 3) {
        const batch = normalizedExpanded.slice(i, i + 3);
        await Promise.all(batch.map((dirPath) => loadDirectory(dirPath, isCancelled)));
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      console.error('Failed to refresh sidebar tree:', error);
    } finally {
      if (refreshAbortRef.current === controller) {
        refreshAbortRef.current = null;
      }
    }
  }, [directoryRequests, loadDirectory, root]);

  const refreshDirectory = React.useCallback(async (dirPath: string) => {
    if (!dirPath) {
      await refreshRoot();
      return;
    }
    const normalized = normalizePath(dirPath);
    loadedDirsRef.current = new Set(loadedDirsRef.current);
    loadedDirsRef.current.delete(normalized);
    await loadDirectory(normalized, undefined, true);
  }, [loadDirectory, refreshRoot]);

  React.useEffect(() => {
    if (!root) return;

    refreshAbortRef.current?.abort();
    loadedDirsRef.current = new Set();
    directoryRequests.clear();
    setLoadErrorsByDir({});
    setChildrenByDir((prev) => (Object.keys(prev).length === 0 ? prev : {}));
    void loadDirectory(root);
  }, [directoryRequests, loadDirectory, root, showHidden, showGitignored]);

  React.useEffect(() => {
    if (!visible || !root || expandedPaths.length === 0) return;

    const toLoad = expandedPaths
      .map((p) => normalizePath(p))
      .filter((normalized): normalized is string =>
        !!normalized &&
        normalized !== root &&
        normalized.startsWith(`${root}/`) &&
        !loadedDirsRef.current.has(normalized) &&
          !directoryRequests.has(normalized),
      )
      .sort((a, b) => a.split('/').length - b.split('/').length);

    if (toLoad.length === 0) return;

    let cancelled = false;
    const isCancelled = () => cancelled;
    void (async () => {
      for (let i = 0; i < toLoad.length && !cancelled; i += 3) {
        const batch = toLoad.slice(i, i + 3);
        await Promise.all(batch.map((dir) => loadDirectory(dir, isCancelled)));
      }
    })();
    return () => { cancelled = true; };
  }, [directoryRequests, expandedPaths, loadDirectory, root, visible]);

  const wasVisibleRef = React.useRef(visible);
  React.useEffect(() => {
    const resumed = visible && !wasVisibleRef.current;
    wasVisibleRef.current = visible;
    if (resumed) void refreshRoot();
  }, [refreshRoot, visible]);

  const applyFileTreeChanges = React.useCallback(({ directories }: FileTreeChangeBatch) => {
    if (!root) return;
    const expanded = new Set(
      (useFilesViewTabsStore.getState().byRoot[root]?.expandedPaths ?? []).map((path) => normalizePath(path)),
    );
    const rootPrefix = root === '/' ? '/' : `${root}/`;
    const isOnScreen = (dir: string): boolean => {
      for (let current = dir; current !== root; current = getParentPath(current)) {
        if (!current.startsWith(rootPrefix) || !expanded.has(current)) return false;
      }
      return true;
    };
    const nearestLoaded = (dir: string): string | null => {
      for (let current = dir; current === root || current.startsWith(rootPrefix); current = getParentPath(current)) {
        if (loadedDirsRef.current.has(current)) return current;
        if (current === root) break;
      }
      return null;
    };

    const toLoad = new Set<string>();
    const toForget = new Set<string>();
    for (const changed of directories ?? loadedDirsRef.current) {
      const loaded = nearestLoaded(normalizePath(changed));
      if (!loaded) continue;
      (isOnScreen(loaded) ? toLoad : toForget).add(loaded);
    }
    if (toForget.size > 0) {
      loadedDirsRef.current = new Set([...loadedDirsRef.current].filter((dir) => !toForget.has(dir)));
    }
    const queue = [...toLoad].filter(
      (dir) => (entryCountByDirRef.current.get(dir) ?? 0) <= AUTO_RELIST_MAX_ENTRIES,
    );
    void (async () => {
      for (let i = 0; i < queue.length; i += 3) {
        await Promise.all(queue.slice(i, i + 3).map((dir) => loadDirectory(dir, undefined, true)));
      }
    })();
  }, [loadDirectory, root]);

  useFileTreeChanges({ root, active: visible, whileInactive: 'drop', onChanges: applyFileTreeChanges });

  return { childrenByDir, loadErrorsByDir, loadedDirsRef, loadDirectory, refreshRoot, refreshDirectory };
};
