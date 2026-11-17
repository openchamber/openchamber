import React from 'react';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { areDirectoryNodesEqual } from '../fileTreeStatus';
import { opencodeClient } from '@/lib/opencode/client';
import { type FileNode } from './fileViewTypes';
import { sortNodes, normalizePath, isAbsolutePath } from './fileViewPaths';
import { shouldIgnoreEntryName } from './fileViewEntries';
import { DirectoryRequests } from '../directoryRequests';
import { type useFileDocument } from './useFileDocument';
import { type useFileLayout } from './useFileLayout';
import { type useFileScope } from './useFileScope';
import { type useFileTabs } from './useFileTabs';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';

export function useFileDirectory({ fileDocument, layout, scope, tabs, files }: {
  fileDocument: Pick<ReturnType<typeof useFileDocument>, 'activeFileLoadIdRef' | 'loadingFilePathRef' | 'setDesktopImageSrc' | 'setFileContent' | 'setFileError' | 'setLoadedFilePath'>;
  layout: Pick<ReturnType<typeof useFileLayout>, 'setShowMobilePageContent'>;
  scope: Pick<ReturnType<typeof useFileScope>, 'fileScope' | 'root' | 'showGitignored' | 'showHidden' | 'treeActive' | 'treeScope' | 'treeScopeRef'>;
  tabs: Pick<ReturnType<typeof useFileTabs>, 'expandedPaths' | 'removeExpandedPathsByPrefix'>;
  files: ReturnType<typeof useRuntimeAPIs>['files'];
}) {
  const { activeFileLoadIdRef, loadingFilePathRef, setDesktopImageSrc, setFileContent, setFileError, setLoadedFilePath } = fileDocument;
  const { setShowMobilePageContent } = layout;
  const { fileScope, root, showGitignored, showHidden, treeActive, treeScope, treeScopeRef } = scope;
  const { expandedPaths, removeExpandedPathsByPrefix } = tabs;
  const [childrenByDir, setChildrenByDir] = React.useState<Record<string, FileNode[]>>({});
  const [loadErrorsByDir, setLoadErrorsByDir] = React.useState<Record<string, string>>({});
  const loadedDirsRef = React.useRef<Set<string>>(new Set());
  const directoryRequests = React.useMemo(() => new DirectoryRequests(), []);
  React.useEffect(() => () => directoryRequests.clear(), [directoryRequests]);

  const mapDirectoryEntries = React.useCallback((dirPath: string, entries: Array<{ name: string; path: string; isDirectory: boolean }>): FileNode[] => {
    const nodes: FileNode[] = [];
    for (const entry of entries) {
      if (!(entry && typeof entry.name === 'string' && entry.name.length > 0)) continue;
      if (!showHidden && entry.name.startsWith('.')) continue;
      if (!showGitignored && shouldIgnoreEntryName(entry.name)) continue;
      const name = entry.name;
      const normalizedEntryPath = normalizePath(entry.path || '');
      const path = normalizedEntryPath
        ? (isAbsolutePath(normalizedEntryPath)
          ? normalizedEntryPath
          : normalizePath(`${dirPath}/${normalizedEntryPath}`))
        : normalizePath(`${dirPath}/${name}`);
      const type = entry.isDirectory ? 'directory' : 'file';
      const extension = type === 'file' && name.includes('.') ? name.split('.').pop()?.toLowerCase() : undefined;
      nodes.push({ name, path, type, extension });
    }

    return sortNodes(nodes);
  }, [showGitignored, showHidden]);

  const loadDirectory = React.useCallback(async (dirPath: string, force = false) => {
    if (!treeActive) return;
    const normalizedDir = normalizePath(dirPath.trim());
    if (!normalizedDir) {
      return;
    }

    if (!force && loadedDirsRef.current.has(normalizedDir)) {
      return;
    }

    const scope = treeScopeRef.current;
    const requestRuntime = getRuntimeKey();
    return directoryRequests.run(normalizedDir, async (ownsRequest) => {
      const isCurrentRequest = () => ownsRequest() && treeScopeRef.current === scope && getRuntimeKey() === requestRuntime;
      try {
        const respectGitignore = !showGitignored;
        const entries = files.listDirectory
          ? (await files.listDirectory(normalizedDir, { respectGitignore })).entries
          : await opencodeClient.listLocalDirectory(normalizedDir, { respectGitignore });
        if (!isCurrentRequest()) return;
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
        if (!isCurrentRequest()) return;
        const message = error instanceof Error ? error.message : String(error ?? '');
        if (message === 'Directory not found' && root && normalizedDir !== root) {
          removeExpandedPathsByPrefix(root, normalizedDir);
          setLoadErrorsByDir((prev) => {
            if (!prev[normalizedDir]) return prev;
            const next = { ...prev };
            delete next[normalizedDir];
            return next;
          });
          return;
        }
        console.error('Failed to load files directory:', error);
        setLoadErrorsByDir((prev) => ({
          ...prev,
          [normalizedDir]: message,
        }));
      }
    }, force);
  }, [directoryRequests, files, mapDirectoryEntries, removeExpandedPathsByPrefix, root, showGitignored, treeActive]);

  const refreshRoot = React.useCallback(async () => {
    if (!root) {
      return;
    }

    loadedDirsRef.current = new Set();
    directoryRequests.clear();
    setLoadErrorsByDir({});
    setChildrenByDir((prev) => (Object.keys(prev).length === 0 ? prev : {}));

    await loadDirectory(root);
  }, [directoryRequests, loadDirectory, root]);

  const refreshDirectory = React.useCallback(async (dirPath: string) => {
    if (!dirPath) {
      await refreshRoot();
      return;
    }
    const normalized = normalizePath(dirPath);
    loadedDirsRef.current = new Set(loadedDirsRef.current);
    loadedDirsRef.current.delete(normalized);
    await loadDirectory(normalized, true);
  }, [loadDirectory, refreshRoot]);

  const lastFileScopeRef = React.useRef<string>('');
  const lastFilesViewTreeKeyRef = React.useRef<string>('');

  React.useEffect(() => {
    if (!root) {
      return;
    }

    const treeKey = treeScope;
    const dirChanged = lastFileScopeRef.current !== fileScope;
    const treeKeyChanged = lastFilesViewTreeKeyRef.current !== treeKey;

    if (!dirChanged && !treeKeyChanged) {
      return;
    }

    if (dirChanged) {
      lastFileScopeRef.current = fileScope;
      activeFileLoadIdRef.current += 1;
      loadingFilePathRef.current = null;
      setFileContent('');
      setFileError(null);
      setDesktopImageSrc('');
      setLoadedFilePath(null);
      setShowMobilePageContent(false);
    }

    if (treeKeyChanged) {
      lastFilesViewTreeKeyRef.current = treeKey;
      loadedDirsRef.current = new Set();
      directoryRequests.clear();
      setLoadErrorsByDir({});
      setChildrenByDir((prev) => (Object.keys(prev).length === 0 ? prev : {}));
      void loadDirectory(root);
    }
  }, [directoryRequests, fileScope, loadDirectory, root, treeScope]);

  React.useEffect(() => {
    if (!treeActive || !files.listDirectory) return;

    const handleVisibilityChange = () => {
      if (!document.hidden && expandedPaths.length > 0) {
        for (const dir of expandedPaths) {
          if (!directoryRequests.has(dir)) void refreshDirectory(dir);
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [directoryRequests, expandedPaths, files.listDirectory, refreshDirectory, treeActive]);

  const treeWasActiveRef = React.useRef(false);
  React.useEffect(() => {
    const resumed = treeActive && !treeWasActiveRef.current;
    treeWasActiveRef.current = treeActive;
    if (!treeActive || !root) return;
    void loadDirectory(root);
    if (resumed) {
      for (const dir of expandedPaths) {
        if (!directoryRequests.has(dir)) void refreshDirectory(dir);
      }
    }
  }, [directoryRequests, expandedPaths, loadDirectory, refreshDirectory, root, treeActive]);

  React.useEffect(() => {
    if (!treeActive || !files.listDirectory) return;
    if (expandedPaths.length === 0) return;

    const interval = setInterval(() => {
      if (document.hidden) return;
      for (const dir of expandedPaths) {
        if (!directoryRequests.has(dir)) void refreshDirectory(dir);
      }
    }, 8000);

    return () => clearInterval(interval);
  }, [directoryRequests, expandedPaths, files.listDirectory, refreshDirectory, treeActive]);

  return {
  mapDirectoryEntries, loadDirectory, refreshRoot, refreshDirectory,
  childrenByDir, loadErrorsByDir, loadedDirsRef,
  };
}
