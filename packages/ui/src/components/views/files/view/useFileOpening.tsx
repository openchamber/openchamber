import React from 'react';
import { whenLayoutSettled } from '@/lib/layoutAnimation';
import { isBinaryFile, isDelimitedTableFile, isDrawioFile, isImageFile, isMermaidFile, isPdfFile, isSvgFile, looksLikeBinaryText } from '@/lib/toolHelpers';
import { MAX_OPEN_FILE_BYTES } from '@/lib/fileOpenLimits';
import { initialFileTextMode } from '../../fileEditorContent';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { rebaseMovedPath, rebaseMovedPathKeys, subscribeToFilePathMoves } from '@/lib/filePathMoves';
import { useFilesViewTabsStore } from '@/stores/useFilesViewTabsStore';
import { getContextFileSizeLimitMessage } from '@/lib/contextFileOpenGuard';
import { type FileNode } from './fileViewTypes';
import { getAncestorPaths } from './fileViewPaths';
import { isDirectoryReadError } from './fileViewEntries';
import { isMarkdownFile, opensInFileCanvas, isJsonFile, isHtmlFile } from './fileViewKinds';
import { type useFileDirectory } from './useFileDirectory';
import { type useFileSaving, type useFileDraft } from './useFileSaving';
import { type useFileCanvasState } from './useFileCanvas';
import { type useFileCloseState } from './useFileClosing';
import { type useFileDiagram, type useFileViewModes } from './useFilePreviewModes';
import { type useFileDocument } from './useFileDocument';
import { type useFileLayout } from './useFileLayout';
import { type useFileScope } from './useFileScope';
import { type useFileSearch } from './useFileSearch';
import { type useFileTabs } from './useFileTabs';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useI18n } from '@/lib/i18n';

export function useFileOpening({ canvasState, closeState, diagram, draft, fileDirectory, fileDocument, fileSaving, layout, scope, search, tabs, viewModes, isMobile, runtime, t, visible }: {
  canvasState: Pick<ReturnType<typeof useFileCanvasState>, 'setCanvasDirty'>;
  closeState: Pick<ReturnType<typeof useFileCloseState>, 'pendingSelectFileRef' | 'setConfirmDiscardOpen' | 'skipDirtyOnceRef'>;
  diagram: Pick<ReturnType<typeof useFileDiagram>, 'diagramSavedXmlRef' | 'diagramXmlRef'>;
  draft: Pick<ReturnType<typeof useFileDraft>, 'setDraftContent'>;
  fileDirectory: Pick<ReturnType<typeof useFileDirectory>, 'loadDirectory' | 'loadedDirsRef'>;
  fileDocument: Pick<ReturnType<typeof useFileDocument>, 'activeFileLoadIdRef' | 'editorDocumentPath' | 'fileContentRevision' | 'lastLoadedFileStatRef' | 'loadedFilePath' | 'loadedFilePathRef' | 'loadingFilePathRef' | 'missingSeenPathRef' | 'pendingPathMoveRef' | 'setContentDetectedBinary' | 'setDesktopImageSrc' | 'setDocumentPathAlias' | 'setFailedFilePath' | 'setFileContent' | 'setFileError' | 'setFileLoading' | 'setLoadedFilePath'>;
  fileSaving: Pick<ReturnType<typeof useFileSaving>, 'applyLoadedTextContent' | 'isDirty' | 'readFile' | 'readFileStat'>;
  layout: Pick<ReturnType<typeof useFileLayout>, 'setShowMobilePageContent'>;
  scope: Pick<ReturnType<typeof useFileScope>, 'fileScopeRef' | 'root' | 'treeActive'>;
  search: Pick<ReturnType<typeof useFileSearch>, 'searchQuery' | 'setSearchQuery'>;
  tabs: Pick<ReturnType<typeof useFileTabs>, 'expandPaths' | 'selectedFile' | 'setSelectedPath'>;
  viewModes: Pick<ReturnType<typeof useFileViewModes>, 'canvasViewModeByPathRef' | 'drawioViewModeByPathRef' | 'htmlViewModeByPathRef' | 'mdViewModeByPathRef' | 'mermaidViewModeByPathRef' | 'setTextViewMode' | 'svgViewModeByPathRef' | 'tableViewModeByPathRef' | 'textViewModeByPathRef'>;
  isMobile: boolean;
  runtime: ReturnType<typeof useRuntimeAPIs>['runtime'];
  t: ReturnType<typeof useI18n>['t'];
  visible: boolean;
}) {
  const { setCanvasDirty } = canvasState;
  const { pendingSelectFileRef, setConfirmDiscardOpen, skipDirtyOnceRef } = closeState;
  const { diagramSavedXmlRef, diagramXmlRef } = diagram;
  const { setDraftContent } = draft;
  const { loadDirectory, loadedDirsRef } = fileDirectory;
  const { activeFileLoadIdRef, editorDocumentPath, fileContentRevision, lastLoadedFileStatRef, loadedFilePath, loadedFilePathRef, loadingFilePathRef, missingSeenPathRef, pendingPathMoveRef, setContentDetectedBinary, setDesktopImageSrc, setDocumentPathAlias, setFailedFilePath, setFileContent, setFileError, setFileLoading, setLoadedFilePath } = fileDocument;
  const { applyLoadedTextContent, isDirty, readFile, readFileStat } = fileSaving;
  const { setShowMobilePageContent } = layout;
  const { fileScopeRef, root, treeActive } = scope;
  const { searchQuery, setSearchQuery } = search;
  const { expandPaths, selectedFile, setSelectedPath } = tabs;
  const { canvasViewModeByPathRef, drawioViewModeByPathRef, htmlViewModeByPathRef, mdViewModeByPathRef, mermaidViewModeByPathRef, setTextViewMode, svgViewModeByPathRef, tableViewModeByPathRef, textViewModeByPathRef } = viewModes;

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

    if (runtime.isDesktop && selectedIsImage && !isSvg) {
      setFileContent('');
      setDraftContent('');
      return;
    }

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

    if (selectedIsBinary) {
      setFileContent('');
      setDraftContent('');
      setLoadedFilePath(node.path);
      setFileLoading(false);
      return;
    }

    const sizeStat = await readFileStat(node.path).catch(() => null);
    if (!isCurrentLoad()) {
      return;
    }
    if (sizeStat && sizeStat.size > MAX_OPEN_FILE_BYTES && isDelimitedTableFile(node.path)) {
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
    const pendingMove = pendingPathMoveRef.current;
    if (pendingMove && selectedFile?.path === pendingMove.to) {
      pendingPathMoveRef.current = null;
      if (loadedFilePath === pendingMove.from) {
        setDocumentPathAlias({ path: pendingMove.to, documentPath: editorDocumentPath ?? pendingMove.from });
        setLoadedFilePath(pendingMove.to);
        return;
      }
    } else if (pendingMove && loadedFilePath !== pendingMove.from) {
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
