import React from 'react';
import { toast } from '@/components/ui';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useFileTreeUpload } from '../useFileTreeUpload';
import { moveWorkspacePath } from '../moveWorkspacePath';
import { areDirectoryNodesEqual } from '../fileTreeStatus';
import { opencodeClient } from '@/lib/opencode/client';
import type { FileNode } from './fileViewTypes';
import { sortNodes, normalizePath, isAbsolutePath, getDisplayPath } from './fileViewPaths';
import { shouldIgnoreEntryName, shouldIgnorePath } from './fileViewEntries';
import type { useFilesViewState } from './useFilesViewState';

export function useFileDirectory({
  t, files, isMobile, showHidden, showGitignored, currentDirectory, root, panelRoot, treeActive, fileScope,
  treeScope, treeScopeRef, searchFiles, debouncedSearchQuery, setShowMobilePageContent, expandedPaths,
  removeOpenPathsByPrefix, removeExpandedPathsByPrefix, setSelectedPath, selectedFile, setChildrenByDir,
  setLoadErrorsByDir, loadedDirsRef, directoryRequests, setSearchResults, setSearching, setFileContent,
  setFileError, setDesktopImageSrc, setLoadedFilePath, activeFileLoadIdRef, loadingFilePathRef, activeDialog,
  setActiveDialog, dialogData, dialogInputValue, setIsDialogSubmitting,
}: Pick<ReturnType<typeof useFilesViewState>,
  't' | 'files' | 'isMobile' | 'showHidden' | 'showGitignored' | 'currentDirectory' | 'root' | 'panelRoot' |
  'treeActive' | 'fileScope' | 'treeScope' | 'treeScopeRef' | 'searchFiles' | 'debouncedSearchQuery' |
  'setShowMobilePageContent' | 'expandedPaths' | 'removeOpenPathsByPrefix' | 'removeExpandedPathsByPrefix' |
  'setSelectedPath' | 'selectedFile' | 'setChildrenByDir' | 'setLoadErrorsByDir' | 'loadedDirsRef' |
  'directoryRequests' | 'setSearchResults' | 'setSearching' | 'setFileContent' | 'setFileError' |
  'setDesktopImageSrc' | 'setLoadedFilePath' | 'activeFileLoadIdRef' | 'loadingFilePathRef' | 'activeDialog' |
  'setActiveDialog' | 'dialogData' | 'dialogInputValue' | 'setIsDialogSubmitting'>) {
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

  /**
   * Incrementally refresh a single directory without nuking the rest of the
   * tree.  After the operation the parent directory is reloaded in-place so
   * the new/renamed/deleted entry becomes visible immediately while every
   * other expanded directory keeps its cached children.
   */
  const refreshDirectory = React.useCallback(async (dirPath: string) => {
    if (!dirPath) {
      await refreshRoot();
      return;
    }
    const normalized = normalizePath(dirPath);
    // Remove from loaded set so loadDirectory will actually fetch again.
    loadedDirsRef.current = new Set(loadedDirsRef.current);
    loadedDirsRef.current.delete(normalized);
    await loadDirectory(normalized, true);
  }, [loadDirectory, refreshRoot]);

  const {
    canUpload,
    uploadingDirectory,
    pickFiles,
    uploadElements,
  } = useFileTreeUpload({ root, refreshDirectory });
  const isUploading = uploadingDirectory !== null;

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

  // Auto-refresh expanded directories when user returns to the tab
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

  // Poll expanded directories for external changes
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

  const handleDialogSubmit = React.useCallback(async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!dialogData || !activeDialog) return;

    setIsDialogSubmitting(true);
    const finishDialogOperation = () => {
      setActiveDialog(null);
    };

    const failDialogOperation = (message: string) => {
      toast.error(message);
    };

    const done = () => {
      setIsDialogSubmitting(false);
    };

    if (activeDialog === 'createFile') {
      if (!dialogInputValue.trim()) {
        failDialogOperation(t('sidebarFilesTree.toast.filenameRequired'));
        done();
        return;
      }
      if (!files.writeFile) {
        failDialogOperation(t('sidebarFilesTree.toast.writeNotSupported'));
        done();
        return;
      }

      const parentPath = dialogData.path;
      const prefix = parentPath ? `${parentPath}/` : '';
      const newPath = normalizePath(`${prefix}${dialogInputValue.trim()}`);
      await files.writeFile(newPath, '')
        .then(async (result) => {
          if (result.success) {
            toast.success(t('sidebarFilesTree.toast.fileCreated'));
            await refreshDirectory(parentPath);
          }
          finishDialogOperation();
        })
        .catch(() => failDialogOperation(t('sidebarFilesTree.toast.operationFailed')))
        .finally(done);
      return;
    }

    if (activeDialog === 'createFolder') {
      if (!dialogInputValue.trim()) {
        failDialogOperation(t('sidebarFilesTree.toast.folderNameRequired'));
        done();
        return;
      }

      const parentPath = dialogData.path;
      const prefix = parentPath ? `${parentPath}/` : '';
      const newPath = normalizePath(`${prefix}${dialogInputValue.trim()}`);
      await files.createDirectory(newPath)
        .then(async (result) => {
          if (result.success) {
            toast.success(t('sidebarFilesTree.toast.folderCreated'));
            await refreshDirectory(parentPath);
          }
          finishDialogOperation();
        })
        .catch(() => failDialogOperation(t('sidebarFilesTree.toast.operationFailed')))
        .finally(done);
      return;
    }

    if (activeDialog === 'rename') {
      if (!dialogInputValue.trim()) {
        failDialogOperation(t('sidebarFilesTree.toast.nameRequired'));
        done();
        return;
      }

      if (!files.rename) {
        failDialogOperation(t('sidebarFilesTree.toast.renameNotSupported'));
        done();
        return;
      }

      const oldPath = dialogData.path;
      const parentDir = oldPath.split('/').slice(0, -1).join('/');
      const prefix = parentDir ? `${parentDir}/` : '';
      const newName = dialogInputValue.trim();
      const newPath = normalizePath(`${prefix}${newName}`);

      // Open tabs and the editor, unsaved edits included, follow the new name.
      try {
        const result = await moveWorkspacePath(files, { tabs: panelRoot, files: root }, oldPath, newPath);
        if (result === 'moved') {
          toast.success(t('sidebarFilesTree.toast.renamedSuccessfully'));
          await refreshDirectory(parentDir);
          finishDialogOperation();
        } else if (result === 'conflict') {
          failDialogOperation(t('sidebarFilesTree.toast.nameTaken', {
            name: newName,
            folder: getDisplayPath(root, parentDir) || t('sidebarFilesTree.dialog.rootFallback'),
          }));
        } else {
          failDialogOperation(t('sidebarFilesTree.toast.operationFailed'));
        }
      } catch {
        failDialogOperation(t('sidebarFilesTree.toast.operationFailed'));
      } finally {
        done();
      }
      return;
    }

    if (activeDialog === 'delete') {
      if (!files.delete) {
        failDialogOperation(t('sidebarFilesTree.toast.deleteNotSupported'));
        done();
        return;
      }

      const deletedPath = dialogData.path;
      const parentDir = deletedPath.split('/').slice(0, -1).join('/');
      await files.delete(deletedPath)
        .then(async (result) => {
          if (result.success) {
            toast.success(t('sidebarFilesTree.toast.deletedSuccessfully'));
            await refreshDirectory(parentDir);
            if (root) {
              removeOpenPathsByPrefix(root, deletedPath);
            }
            if (selectedFile?.path === deletedPath || selectedFile?.path.startsWith(`${deletedPath}/`)) {
              if (root) {
                setSelectedPath(root, null);
              }
              setFileContent('');
              setFileError(null);
              setDesktopImageSrc('');
              setLoadedFilePath(null);
              if (isMobile) {
                setShowMobilePageContent(false);
              }
            }
          }
          finishDialogOperation();
        })
        .catch(() => failDialogOperation(t('sidebarFilesTree.toast.operationFailed')))
        .finally(done);
      return;
    }

    done();
  }, [activeDialog, dialogData, dialogInputValue, files, panelRoot, refreshDirectory, isMobile, removeOpenPathsByPrefix, root, selectedFile?.path, setSelectedPath, t]);

  React.useEffect(() => {
    if (!currentDirectory) {
      setSearchResults([]);
      setSearching(false);
      return;
    }

    const trimmedQuery = debouncedSearchQuery.trim();
    if (!trimmedQuery) {
      setSearchResults([]);
      setSearching(false);
      return;
    }

    let cancelled = false;
    setSearching(true);

    searchFiles(currentDirectory, trimmedQuery, 150, {
      includeHidden: showHidden,
      respectGitignore: !showGitignored,
      type: 'file',
    })
      .then((hits) => {
        if (cancelled) {
          return;
        }

        const filtered = hits.filter((hit) => showGitignored || !shouldIgnorePath(hit.path));

        const mapped: FileNode[] = filtered.map((hit) => ({
          name: hit.name,
          path: normalizePath(hit.path),
          type: 'file',
          extension: hit.extension,
          relativePath: hit.relativePath,
        }));

        setSearchResults(mapped);
      })
      .catch(() => {
        if (!cancelled) {
          setSearchResults([]);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setSearching(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [currentDirectory, debouncedSearchQuery, searchFiles, showHidden, showGitignored]);
  return {
  mapDirectoryEntries, loadDirectory, refreshRoot, refreshDirectory, canUpload, pickFiles, uploadElements,
  isUploading, handleDialogSubmit,
  };
}
