import React from 'react';
import { type FileNode, type FilesViewProps } from './fileViewTypes';
import { registerCloseTabTarget } from '@/lib/closeTabTarget';
import { type useFileSaving, type useFileDraft } from './useFileSaving';
import { type useFileOpening } from './useFileOpening';
import { type useFileCanvasState } from './useFileCanvas';
import { type useFileDocument } from './useFileDocument';
import { type useFileLayout } from './useFileLayout';
import { type useFileScope } from './useFileScope';
import { type useFileTabs } from './useFileTabs';

export function useFileCloseState() {
  const [confirmDiscardOpen, setConfirmDiscardOpen] = React.useState(false);
  const pendingSelectFileRef = React.useRef<FileNode | null>(null);
  const pendingClosePathRef = React.useRef<string | null>(null);
  const skipDirtyOnceRef = React.useRef(false);

  return { confirmDiscardOpen, setConfirmDiscardOpen, pendingSelectFileRef, pendingClosePathRef, skipDirtyOnceRef };
}

export function useFileClosing({ canvasState, closeState, draft, fileDocument, fileOpening, fileSaving, layout, scope, tabs, isMobile, onCloseFile, visible }: {
  canvasState: Pick<ReturnType<typeof useFileCanvasState>, 'setCanvasDirty' | 'setCanvasRemountNonce'>;
  closeState: Pick<ReturnType<typeof useFileCloseState>, 'pendingClosePathRef' | 'pendingSelectFileRef' | 'setConfirmDiscardOpen' | 'skipDirtyOnceRef'>;
  draft: Pick<ReturnType<typeof useFileDraft>, 'setDraftContent'>;
  fileDocument: Pick<ReturnType<typeof useFileDocument>, 'fileContent' | 'setDesktopImageSrc' | 'setFileContent' | 'setFileError' | 'setLoadedFilePath'>;
  fileOpening: Pick<ReturnType<typeof useFileOpening>, 'getNextOpenFile' | 'handleSelectFile'>;
  fileSaving: Pick<ReturnType<typeof useFileSaving>, 'isDirty' | 'saveDraft'>;
  layout: Pick<ReturnType<typeof useFileLayout>, 'setShowMobilePageContent'>;
  scope: Pick<ReturnType<typeof useFileScope>, 'root'>;
  tabs: Pick<ReturnType<typeof useFileTabs>, 'openFiles' | 'removeOpenPath' | 'selectedFile' | 'setSelectedPath'>;
  isMobile: boolean;
  onCloseFile: FilesViewProps['onCloseFile'];
  visible: boolean;
}) {
  const { setCanvasDirty, setCanvasRemountNonce } = canvasState;
  const { pendingClosePathRef, pendingSelectFileRef, setConfirmDiscardOpen, skipDirtyOnceRef } = closeState;
  const { setDraftContent } = draft;
  const { fileContent, setDesktopImageSrc, setFileContent, setFileError, setLoadedFilePath } = fileDocument;
  const { getNextOpenFile, handleSelectFile } = fileOpening;
  const { isDirty, saveDraft } = fileSaving;
  const { setShowMobilePageContent } = layout;
  const { root } = scope;
  const { openFiles, removeOpenPath, selectedFile, setSelectedPath } = tabs;

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

    skipDirtyOnceRef.current = true;

    setConfirmDiscardOpen(false);

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
  discardAndContinue, saveAndContinue, rootRef,
  };
}
