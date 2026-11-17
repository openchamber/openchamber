import React from 'react';
import { whenLayoutSettled } from '@/lib/layoutAnimation';
import { isBinaryFile, isDelimitedTableFile, isDrawioFile, isImageFile, isMermaidFile, isPdfFile, isSvgFile, looksLikeBinaryText } from '@/lib/toolHelpers';
import { MAX_OPEN_FILE_BYTES } from '@/lib/fileOpenLimits';
import { initialFileTextMode } from '../../fileEditorContent';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { rebaseMovedPath, rebaseMovedPathKeys, subscribeToFilePathMoves } from '@/lib/filePathMoves';
import { useFilesViewTabsStore } from '@/stores/useFilesViewTabsStore';
import { getContextFileSizeLimitMessage } from '@/lib/contextFileOpenGuard';
import type { FileNode } from './fileViewTypes';
import { getAncestorPaths } from './fileViewPaths';
import { isDirectoryReadError } from './fileViewEntries';
import { isMarkdownFile, opensInFileCanvas, isJsonFile, isHtmlFile } from './fileViewKinds';
import type { FilesViewOptions } from './fileViewTypes';
import type { useFilesViewState } from './useFilesViewState';
import type { useFileDirectory } from './useFileDirectory';
import type { useFileSaving } from './useFileSaving';

export function useFileOpening({
  visible, t, runtime, isMobile, root, treeActive, fileScopeRef, searchQuery, setSearchQuery,
  setShowMobilePageContent, setTextViewMode, textViewModeByPathRef, mdViewModeByPathRef, htmlViewModeByPathRef,
  svgViewModeByPathRef, mermaidViewModeByPathRef, tableViewModeByPathRef, drawioViewModeByPathRef,
  canvasViewModeByPathRef, setSelectedPath, expandPaths, selectedFile, loadedDirsRef, setFileContent,
  setFileLoading, setFileError, setDesktopImageSrc, loadedFilePath, setLoadedFilePath, loadedFilePathRef,
  pendingPathMoveRef, setDocumentPathAlias, editorDocumentPath, setFailedFilePath, missingSeenPathRef,
  setDraftContent, diagramXmlRef, diagramSavedXmlRef, setCanvasDirty, lastLoadedFileStatRef, activeFileLoadIdRef,
  loadingFilePathRef, fileContentRevision, setContentDetectedBinary, setConfirmDiscardOpen, pendingSelectFileRef,
  skipDirtyOnceRef, loadDirectory, readFile, readFileStat, isDirty, applyLoadedTextContent,
}: Pick<FilesViewOptions, 'visible'> &
Pick<ReturnType<typeof useFilesViewState>,
  't' | 'runtime' | 'isMobile' | 'root' | 'treeActive' | 'fileScopeRef' | 'searchQuery' | 'setSearchQuery' |
  'setShowMobilePageContent' | 'setTextViewMode' | 'textViewModeByPathRef' | 'mdViewModeByPathRef' |
  'htmlViewModeByPathRef' | 'svgViewModeByPathRef' | 'mermaidViewModeByPathRef' | 'tableViewModeByPathRef' |
  'drawioViewModeByPathRef' | 'canvasViewModeByPathRef' | 'setSelectedPath' | 'expandPaths' | 'selectedFile' |
  'loadedDirsRef' | 'setFileContent' | 'setFileLoading' | 'setFileError' | 'setDesktopImageSrc' |
  'loadedFilePath' | 'setLoadedFilePath' | 'loadedFilePathRef' | 'pendingPathMoveRef' | 'setDocumentPathAlias' |
  'editorDocumentPath' | 'setFailedFilePath' | 'missingSeenPathRef' | 'setDraftContent' | 'diagramXmlRef' |
  'diagramSavedXmlRef' | 'setCanvasDirty' | 'lastLoadedFileStatRef' | 'activeFileLoadIdRef' |
  'loadingFilePathRef' | 'fileContentRevision' | 'setContentDetectedBinary' | 'setConfirmDiscardOpen' |
  'pendingSelectFileRef' | 'skipDirtyOnceRef'> &
Pick<ReturnType<typeof useFileDirectory>,
  'loadDirectory'> &
Pick<ReturnType<typeof useFileSaving>,
  'readFile' | 'readFileStat' | 'isDirty' | 'applyLoadedTextContent'>) {
  const loadSelectedFile = React.useCallback(async (node: FileNode) => {
    const loadId = activeFileLoadIdRef.current + 1;
    activeFileLoadIdRef.current = loadId;
    const requestRuntime = getRuntimeKey();
    const requestScope = fileScopeRef.current;
    const isCurrentLoad = () => {
      if (!root || getRuntimeKey() !== requestRuntime || fileScopeRef.current !== requestScope) return false;
      const rootState = useFilesViewTabsStore.getState().byRoot[root];
      const currentPath = rootState?.selectedPath ?? rootState?.openPaths[0] ?? null;
      return activeFileLoadIdRef.current === loadId && currentPath === node.path;
    };

    pendingPathMoveRef.current = null;
    setDocumentPathAlias(null);
    setFileError(null);
    setFailedFilePath(null);
    missingSeenPathRef.current = null;
    setDesktopImageSrc('');
    setLoadedFilePath(null);
    setContentDetectedBinary(false);
    setFileLoading(true);

    const selectedIsImage = isImageFile(node.path);
    const isSvg = isSvgFile(node.path);
    const selectedIsPdf = isPdfFile(node.path);
    const selectedIsBinary = isBinaryFile(node.path);

    if (isMobile) {
      setShowMobilePageContent(true);
    }

    // Desktop: binary images are loaded via readFileBinary (data URL).
    if (runtime.isDesktop && selectedIsImage && !isSvg) {
      setFileContent('');
      setDraftContent('');
      return;
    }

    // Web: binary images should not be read as utf8.
    if (!runtime.isDesktop && selectedIsImage && !isSvg) {
      setFileContent('');
      setDraftContent('');
      setLoadedFilePath(node.path);
      setFileLoading(false);
      return;
    }

    if (selectedIsPdf) {
      setFileContent('');
      setDraftContent('');
      setLoadedFilePath(node.path);
      setFileLoading(false);
      return;
    }

    // Other known binaries (docx/xlsx/zip/…) must never be opened as text —
    // a later autosave would corrupt them.
    if (selectedIsBinary) {
      setFileContent('');
      setDraftContent('');
      setLoadedFilePath(node.path);
      setFileLoading(false);
      return;
    }

    // A file past the size limit shows as a failed read instead of being
    // pulled in whole; a file whose size is unknown is read as before.
    const sizeStat = await readFileStat(node.path).catch(() => null);
    if (!isCurrentLoad()) {
      return;
    }
    if (sizeStat && sizeStat.size > MAX_OPEN_FILE_BYTES && isDelimitedTableFile(node.path)) {
      // Too large for the editor, not for the table: it opens read-only, from its bytes.
      setContentDetectedBinary(true);
      setFileContent('');
      setDraftContent('');
      setLoadedFilePath(node.path);
      setFileLoading(false);
      return;
    }
    if (sizeStat && sizeStat.size > MAX_OPEN_FILE_BYTES) {
      setFileContent('');
      setDraftContent('');
      setFileError(getContextFileSizeLimitMessage(sizeStat.size, t));
      setFailedFilePath(node.path);
      lastLoadedFileStatRef.current = null;
      setFileLoading(false);
      return;
    }

    await readFile(node.path)
      .then(async (content) => {
        // A file that arrives while its zone is still opening renders after
        // the animation: a long file's first render takes several frames,
        // and inside the animation it stopped the panel halfway.
        await whenLayoutSettled();
        if (!isCurrentLoad()) {
          return;
        }
        if (looksLikeBinaryText(content)) {
          setContentDetectedBinary(true);
          setFileContent('');
          setDraftContent('');
          setLoadedFilePath(node.path);
          return;
        }
        const editorContent = applyLoadedTextContent(content);
        const hasOwnPreviewMode = isMarkdownFile(node.path) || isHtmlFile(node.path)
          || isJsonFile(node.path) || isDrawioFile(node.path) || isSvgFile(node.path)
          || isMermaidFile(node.path) || isDelimitedTableFile(node.path)
          || opensInFileCanvas(node.path);
        setTextViewMode(hasOwnPreviewMode ? 'edit' : initialFileTextMode(editorContent, textViewModeByPathRef.current[node.path]));
        setLoadedFilePath(node.path);
        void readFileStat(node.path)
          .then((stat) => {
            if (stat && isCurrentLoad()) {
              lastLoadedFileStatRef.current = stat;
            }
          })
          .catch(() => {});
      })
      .catch((error) => {
        if (!isCurrentLoad()) {
          return;
        }
        if (isDirectoryReadError(error)) {
          setFileLoading(false);
          if (root) {
            setSelectedPath(root, null);
          }
          setFileError(null);
          setFileContent('');
          setDraftContent('');
          setLoadedFilePath(null);
          lastLoadedFileStatRef.current = null;
          if (searchQuery.trim().length > 0) {
            setSearchQuery('');
          }
          if (isMobile) {
            setShowMobilePageContent(false);
          }
          if (root) {
            const ancestors = getAncestorPaths(node.path, root);
            const pathsToExpand = [...ancestors, node.path];
            if (pathsToExpand.length > 0) {
              expandPaths(root, pathsToExpand);
            }
            for (const path of pathsToExpand) {
              if (!loadedDirsRef.current.has(path)) {
                void loadDirectory(path);
              }
            }
          }
          return;
        }
        // A missing file keeps its tab and shows the error like any other
        // failed read; the host's tab still names this path.
        setFileContent('');
        setDraftContent('');
        setFileError(error instanceof Error ? error.message : t('filesView.error.readFileFailed'));
        setFailedFilePath(node.path);
        lastLoadedFileStatRef.current = null;
      })
      .finally(() => {
        if (isCurrentLoad()) {
          setFileLoading(false);
        }
      });
  }, [applyLoadedTextContent, expandPaths, isMobile, loadDirectory, readFile, readFileStat, root, runtime.isDesktop, searchQuery, setSelectedPath, t]);

  const ensurePathVisible = React.useCallback(async (targetPath: string, includeTarget: boolean) => {
    if (!visible || !root) {
      return;
    }

    const ancestors = getAncestorPaths(targetPath, root);
    const pathsToExpand = includeTarget ? [...ancestors, targetPath] : ancestors;

    if (pathsToExpand.length > 0) {
      expandPaths(root, pathsToExpand);
    }

    // Desktop editor-only still reveals the selected path in the shared sidebar.
    // Only the surface that owns a tree needs to load these directories.
    if (!treeActive) return;
    const loadPromises = pathsToExpand.map((path) => {
      if (!loadedDirsRef.current.has(path)) {
        return loadDirectory(path);
      }
      return undefined;
    }).filter(Boolean);
    await Promise.all(loadPromises);
  }, [expandPaths, loadDirectory, root, treeActive, visible]);

  const getNextOpenFile = React.useCallback((path: string, filesList: FileNode[]) => {
    const index = filesList.findIndex((file) => file.path === path);
    if (index === -1 || filesList.length <= 1) {
      return null;
    }
    return filesList[index + 1] ?? filesList[index - 1] ?? null;
  }, []);

  const handleSelectFile = React.useCallback(async (node: FileNode) => {
    if (skipDirtyOnceRef.current) {
      skipDirtyOnceRef.current = false;
    } else if (isDirty) {
      setConfirmDiscardOpen(true);
      pendingSelectFileRef.current = node;
      return;
    }

    if (root) {
      setSelectedPath(root, node.path);
      void ensurePathVisible(node.path, false);
    }

    setFileError(null);
    setDesktopImageSrc('');
    setFileContent('');
    diagramXmlRef.current = '';
    diagramSavedXmlRef.current = '';
    setCanvasDirty(false);
    setDraftContent('');
    setLoadedFilePath(null);
    if (isMobile) {
      setShowMobilePageContent(true);
    }
  }, [ensurePathVisible, isDirty, isMobile, root, setSelectedPath]);

  React.useEffect(() => {
    if (!selectedFile?.path) {
      return;
    }

    void ensurePathVisible(selectedFile.path, false);
  }, [ensurePathVisible, selectedFile?.path]);

  React.useEffect(() => subscribeToFilePathMoves(({ runtimeKey, from, to }) => {
    if (runtimeKey !== getRuntimeKey()) return;
    // View modes (preview or source, table or text) follow the file.
    textViewModeByPathRef.current = rebaseMovedPathKeys(textViewModeByPathRef.current, from, to);
    mdViewModeByPathRef.current = rebaseMovedPathKeys(mdViewModeByPathRef.current, from, to);
    htmlViewModeByPathRef.current = rebaseMovedPathKeys(htmlViewModeByPathRef.current, from, to);
    svgViewModeByPathRef.current = rebaseMovedPathKeys(svgViewModeByPathRef.current, from, to);
    mermaidViewModeByPathRef.current = rebaseMovedPathKeys(mermaidViewModeByPathRef.current, from, to);
    tableViewModeByPathRef.current = rebaseMovedPathKeys(tableViewModeByPathRef.current, from, to);
    drawioViewModeByPathRef.current = rebaseMovedPathKeys(drawioViewModeByPathRef.current, from, to);
    canvasViewModeByPathRef.current = rebaseMovedPathKeys(canvasViewModeByPathRef.current, from, to);
    const pending = pendingPathMoveRef.current;
    const heldPath = pending?.to ?? loadedFilePathRef.current;
    const movedPath = heldPath ? rebaseMovedPath(heldPath, from, to) : null;
    if (heldPath && movedPath) {
      pendingPathMoveRef.current = { from: pending?.from ?? heldPath, to: movedPath };
    }
  }), []);

  React.useEffect(() => {
    // Adopt a moved file before anything reloads it, visible or not: the
    // draft stays, only the path the editor saves to changes.
    const pendingMove = pendingPathMoveRef.current;
    if (pendingMove && selectedFile?.path === pendingMove.to) {
      pendingPathMoveRef.current = null;
      if (loadedFilePath === pendingMove.from) {
        setDocumentPathAlias({ path: pendingMove.to, documentPath: editorDocumentPath ?? pendingMove.from });
        setLoadedFilePath(pendingMove.to);
        return;
      }
    } else if (pendingMove && loadedFilePath !== pendingMove.from) {
      // Another file finished loading while the move landed (the user
      // switched tabs mid-move): nothing is left to adopt, and a stale hold
      // would block every save of the file now open.
      pendingPathMoveRef.current = null;
    }

    if (!visible) return;
    if (!selectedFile) {
      activeFileLoadIdRef.current += 1;
      loadingFilePathRef.current = null;
      setFileLoading(false);
      return;
    }

    if (loadedFilePath === selectedFile.path || loadingFilePathRef.current === selectedFile.path) {
      return;
    }

    // Selection changes are guarded; this effect is also what restores persisted tabs on mount.
    const loadingPath = selectedFile.path;
    loadingFilePathRef.current = loadingPath;
    void loadSelectedFile(selectedFile).finally(() => {
      if (loadingFilePathRef.current === loadingPath) {
        loadingFilePathRef.current = null;
      }
    });
  }, [editorDocumentPath, fileContentRevision, loadSelectedFile, loadedFilePath, selectedFile, visible]);
  return {
  getNextOpenFile, handleSelectFile,
  };
}
