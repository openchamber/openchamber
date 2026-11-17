import React from 'react';
import { registerCloseTabTarget } from '@/lib/closeTabTarget';
import type { FileNode } from './fileViewTypes';
import type { FilesViewOptions } from './fileViewTypes';
import type { useFilesViewState } from './useFilesViewState';
import type { useFileSaving } from './useFileSaving';
import type { useFileOpening } from './useFileOpening';

export function useFileClosing({
  visible, onCloseFile, isMobile, root, setShowMobilePageContent, setCanvasRemountNonce, removeOpenPath,
  setSelectedPath, openFiles, selectedFile, fileContent, setFileContent, setFileError, setDesktopImageSrc,
  setLoadedFilePath, setDraftContent, setCanvasDirty, setConfirmDiscardOpen, pendingSelectFileRef,
  pendingClosePathRef, skipDirtyOnceRef, isDirty, saveDraft, getNextOpenFile, handleSelectFile,
}: Pick<FilesViewOptions, 'visible' | 'onCloseFile'> &
Pick<ReturnType<typeof useFilesViewState>,
  'isMobile' | 'root' | 'setShowMobilePageContent' | 'setCanvasRemountNonce' | 'removeOpenPath' |
  'setSelectedPath' | 'openFiles' | 'selectedFile' | 'fileContent' | 'setFileContent' | 'setFileError' |
  'setDesktopImageSrc' | 'setLoadedFilePath' | 'setDraftContent' | 'setCanvasDirty' | 'setConfirmDiscardOpen' |
  'pendingSelectFileRef' | 'pendingClosePathRef' | 'skipDirtyOnceRef'> &
Pick<ReturnType<typeof useFileSaving>,
  'isDirty' | 'saveDraft'> &
Pick<ReturnType<typeof useFileOpening>,
  'getNextOpenFile' | 'handleSelectFile'>) {
  // Closes `path` once nothing stands in the way (no unsaved edits, or the
  // prompt was answered), moving to `nextFile` when it was the one on screen.
  const closeOpenFile = React.useCallback((path: string, nextFile: FileNode | null) => {
    if (onCloseFile) {
      onCloseFile(path);
      return;
    }

    if (root) {
      removeOpenPath(root, path);
    }

    if (selectedFile?.path !== path) {
      return;
    }

    if (nextFile) {
      void handleSelectFile(nextFile);
      return;
    }

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
  }, [handleSelectFile, isMobile, onCloseFile, removeOpenPath, root, selectedFile?.path, setSelectedPath]);

  const discardAndContinue = React.useCallback(() => {
    const nextFile = pendingSelectFileRef.current;
    const closePath = pendingClosePathRef.current;

    pendingSelectFileRef.current = null;
    pendingClosePathRef.current = null;

    // Allow one guarded navigation (tab/file) without re-opening dialog.
    skipDirtyOnceRef.current = true;

    setConfirmDiscardOpen(false);

    // Discard draft by reverting back to last loaded content
    setCanvasDirty(false);
    setCanvasRemountNonce((nonce) => nonce + 1);
    setDraftContent(fileContent);

    if (closePath) {
      closeOpenFile(closePath, nextFile);
      return;
    }

    if (nextFile) {
      void handleSelectFile(nextFile);
      return;
    }

  }, [closeOpenFile, fileContent, handleSelectFile]);

  const saveAndContinue = React.useCallback(async () => {
    const nextFile = pendingSelectFileRef.current;
    const closePath = pendingClosePathRef.current;

    const saved = await saveDraft();
    if (!saved) {
      skipDirtyOnceRef.current = false;
      return;
    }

    pendingSelectFileRef.current = null;
    pendingClosePathRef.current = null;

    // We'll proceed after saving; suppress guard reopening.
    skipDirtyOnceRef.current = true;

    setConfirmDiscardOpen(false);

    if (closePath) {
      closeOpenFile(closePath, nextFile);
      return;
    }

    if (nextFile) {
      await handleSelectFile(nextFile);
      return;
    }

  }, [closeOpenFile, handleSelectFile, saveDraft]);

  const handleCloseFile = React.useCallback((path: string) => {
    const isActive = selectedFile?.path === path;
    const nextFile = getNextOpenFile(path, openFiles);

    if (isActive && isDirty) {
      setConfirmDiscardOpen(true);
      pendingSelectFileRef.current = nextFile;
      pendingClosePathRef.current = path;
      return;
    }

    closeOpenFile(path, nextFile);
  }, [closeOpenFile, getNextOpenFile, isDirty, openFiles, selectedFile?.path]);

  // While a file is open here, Cmd/Ctrl+W closes its tab (asking first when
  // it has unsaved edits) instead of the whole window.
  const handleCloseFileRef = React.useRef(handleCloseFile);
  React.useEffect(() => {
    handleCloseFileRef.current = handleCloseFile;
  }, [handleCloseFile]);
  const closeTargetPath = selectedFile?.path ?? null;
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    if (!visible || !closeTargetPath) return;
    return registerCloseTabTarget(() => handleCloseFileRef.current(closeTargetPath), rootRef);
  }, [closeTargetPath, visible]);
  return {
  discardAndContinue, saveAndContinue, handleCloseFile, rootRef,
  };
}
