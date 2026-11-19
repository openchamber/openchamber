import React from 'react';
import { pendingFileNavigationStep } from '../../pendingFileNavigation';
import { EditorView } from '@codemirror/view';
import { normalizePath } from './fileViewPaths';
import { type useFileOpening } from './useFileOpening';
import { type useFileKinds } from './useFileKinds';
import { type useFileCloseState } from './useFileClosing';
import { type useFileDraft } from './useFileSaving';
import { type useFileEditor } from './useFileEditorExtensions';
import { type useFileDocument } from './useFileDocument';
import { type useFileScope } from './useFileScope';
import { type useFileTabs } from './useFileTabs';
import { type useFileViewModes } from './useFilePreviewModes';
import { useUIStore } from '@/stores/useUIStore';

export function useFileNavigation({ closeState, draft, editor, fileDocument, fileKinds, fileOpening, navigationRequests, scope, tabs, viewModes }: {
  closeState: Pick<ReturnType<typeof useFileCloseState>, 'confirmDiscardOpen'>;
  draft: Pick<ReturnType<typeof useFileDraft>, 'draftContent'>;
  editor: Pick<ReturnType<typeof useFileEditor>, 'editorViewReadyNonce' | 'editorViewRef' | 'setEditorViewReadyNonce'>;
  fileDocument: Pick<ReturnType<typeof useFileDocument>, 'failedFilePath' | 'fileError' | 'fileLoading' | 'loadedFilePath'>;
  fileKinds: Pick<ReturnType<typeof useFileKinds>, 'canEdit' | 'isSelectedImage' | 'isSelectedPdf' | 'isUnsupportedBinary'>;
  fileOpening: Pick<ReturnType<typeof useFileOpening>, 'handleSelectFile'>;
  navigationRequests: Pick<ReturnType<typeof useFileNavigationRequests>, 'pendingFileFocusPath' | 'pendingFileNavigation' | 'pendingNavigationCycleRef' | 'pendingNavigationRafRef' | 'setPendingFileFocusPath' | 'setPendingFileNavigation'>;
  scope: Pick<ReturnType<typeof useFileScope>, 'root' | 'zoneInteractive'>;
  tabs: Pick<ReturnType<typeof useFileTabs>, 'selectedFile' | 'toFileNode'>;
  viewModes: Pick<ReturnType<typeof useFileViewModes>, 'setTextViewMode' | 'textViewMode'>;
}) {
  const { confirmDiscardOpen } = closeState;
  const { draftContent } = draft;
  const { editorViewReadyNonce, editorViewRef, setEditorViewReadyNonce } = editor;
  const { failedFilePath, fileError, fileLoading, loadedFilePath } = fileDocument;
  const { canEdit, isSelectedImage, isSelectedPdf, isUnsupportedBinary } = fileKinds;
  const { handleSelectFile } = fileOpening;
  const { pendingFileFocusPath, pendingFileNavigation, pendingNavigationCycleRef, pendingNavigationRafRef, setPendingFileFocusPath, setPendingFileNavigation } = navigationRequests;
  const { root, zoneInteractive } = scope;
  const { selectedFile, toFileNode } = tabs;
  const { setTextViewMode, textViewMode } = viewModes;

  React.useEffect(() => {
    if (!pendingFileNavigation || !root) {
      return;
    }

    const scheduleNavigationRetry = () => {
      if (typeof window === 'undefined') {
        return;
      }
      if (pendingNavigationRafRef.current !== null) {
        return;
      }

      pendingNavigationRafRef.current = window.requestAnimationFrame(() => {
        pendingNavigationRafRef.current = null;
        setEditorViewReadyNonce((value) => value + 1);
      });
    };

    const isEditorSyncedWithDraft = (view: EditorView, expectedContent: string): boolean => {
      if (view.state.doc.length !== expectedContent.length) {
        return false;
      }

      if (expectedContent.length === 0) {
        return true;
      }

      const sampleSize = Math.min(128, expectedContent.length);
      const startSample = view.state.sliceDoc(0, sampleSize);
      if (startSample !== expectedContent.slice(0, sampleSize)) {
        return false;
      }

      const endFrom = Math.max(0, expectedContent.length - sampleSize);
      const endSample = view.state.sliceDoc(endFrom, expectedContent.length);
      return endSample === expectedContent.slice(endFrom);
    };

    const targetPath = normalizePath(pendingFileNavigation.path);
    if (!targetPath) {
      setPendingFileNavigation(null);
      pendingNavigationCycleRef.current = { key: '', attempts: 0, targetShown: false };
      return;
    }

    const navigationKey = `${targetPath}:${pendingFileNavigation.line}:${pendingFileNavigation.column ?? 1}`;
    if (pendingNavigationCycleRef.current.key !== navigationKey) {
      pendingNavigationCycleRef.current = { key: navigationKey, attempts: 0, targetShown: false };
    }
    const selectedPath = selectedFile?.path ?? null;
    if (selectedPath === targetPath) {
      pendingNavigationCycleRef.current.targetShown = true;
    }

    const step = pendingFileNavigationStep({
      selectedPath,
      targetPath,
      targetShown: pendingNavigationCycleRef.current.targetShown,
      targetSettled: !fileLoading && (loadedFilePath === targetPath || failedFilePath === targetPath),
      showsText: failedFilePath !== targetPath && !fileError && !isSelectedImage && !isSelectedPdf && !isUnsupportedBinary,
      canEdit,
      textViewMode,
    });

    if (step === 'select-target') {
      if (!confirmDiscardOpen) {
        void handleSelectFile(toFileNode(targetPath));
      }
      return;
    }

    if (step === 'wait') {
      return;
    }

    if (step === 'end') {
      setPendingFileNavigation(null);
      pendingNavigationCycleRef.current = { key: '', attempts: 0, targetShown: false };
      return;
    }

    if (step === 'show-editor') {
      setTextViewMode('edit');
      return;
    }

    if (!zoneInteractive) {
      return;
    }

    const view = editorViewRef.current;
    if (!view) {
      scheduleNavigationRetry();
      return;
    }

    if (!isEditorSyncedWithDraft(view, draftContent)) {
      scheduleNavigationRetry();
      return;
    }

    const targetLineNumber = Math.max(1, Math.min(pendingFileNavigation.line, view.state.doc.lines));
    const targetLine = view.state.doc.line(targetLineNumber);
    const targetColumn = Math.max(1, pendingFileNavigation.column || 1);
    const lineLength = Math.max(0, targetLine.to - targetLine.from);
    const clampedColumnOffset = Math.min(lineLength, targetColumn - 1);
    const targetPosition = targetLine.from + clampedColumnOffset;
    const isAtTarget = view.state.selection.main.head === targetPosition;
    const shouldDispatch = !isAtTarget || pendingNavigationCycleRef.current.attempts === 0;

    if (shouldDispatch) {
      pendingNavigationCycleRef.current.attempts += 1;
      view.dispatch({
        selection: { anchor: targetPosition },
        effects: EditorView.scrollIntoView(targetPosition, { y: 'center' }),
      });
      view.focus();
      scheduleNavigationRetry();
      return;
    }

    if (typeof window !== 'undefined') {
      window.requestAnimationFrame(() => {
        const syncedView = editorViewRef.current;
        if (!syncedView) {
          return;
        }

        syncedView.dispatch({
          selection: { anchor: targetPosition },
          effects: EditorView.scrollIntoView(targetPosition, { y: 'center' }),
        });
        syncedView.focus();
      });
    }

    setPendingFileNavigation(null);
    pendingNavigationCycleRef.current = { key: '', attempts: 0, targetShown: false };
  }, [
    canEdit,
    confirmDiscardOpen,
    draftContent,
    editorViewReadyNonce,
    failedFilePath,
    fileError,
    fileLoading,
    isSelectedImage,
    isSelectedPdf,
    isUnsupportedBinary,
    loadedFilePath,
    handleSelectFile,
    pendingFileNavigation,
    root,
    selectedFile?.path,
    setPendingFileNavigation,
    textViewMode,
    toFileNode,
    zoneInteractive,
  ]);

  React.useEffect(() => {
    if (!pendingFileFocusPath || !root || !zoneInteractive) {
      return;
    }

    const targetPath = normalizePath(pendingFileFocusPath);
    if (!targetPath) {
      setPendingFileFocusPath(null);
      return;
    }

    if (selectedFile?.path !== targetPath) {
      return;
    }

    if (fileLoading || (loadedFilePath !== targetPath && failedFilePath !== targetPath)) {
      return;
    }

    if (failedFilePath !== targetPath && !fileError && !isSelectedImage && !isSelectedPdf && !isUnsupportedBinary && canEdit && textViewMode === 'edit') {
      editorViewRef.current?.focus();
    }

    setPendingFileFocusPath(null);
  }, [
    canEdit,
    failedFilePath,
    fileError,
    fileLoading,
    isSelectedImage,
    isSelectedPdf,
    isUnsupportedBinary,
    loadedFilePath,
    pendingFileFocusPath,
    root,
    selectedFile?.path,
    setPendingFileFocusPath,
    textViewMode,
    zoneInteractive,
  ]);

  return {
  };
}

export function useFileNavigationMask({ fileDocument, fileKinds, navigationRequests, tabs }: {
  fileDocument: Pick<ReturnType<typeof useFileDocument>, 'fileError' | 'fileLoading'>;
  fileKinds: Pick<ReturnType<typeof useFileKinds>, 'isSelectedNonText'>;
  navigationRequests: Pick<ReturnType<typeof useFileNavigationRequests>, 'pendingFileNavigation'>;
  tabs: Pick<ReturnType<typeof useFileTabs>, 'selectedFilePath'>;
}) {
  const { fileError, fileLoading } = fileDocument;
  const { isSelectedNonText } = fileKinds;
  const { pendingFileNavigation } = navigationRequests;
  const { selectedFilePath } = tabs;
  const pendingNavigationTargetPath = React.useMemo(
    () => normalizePath(pendingFileNavigation?.path ?? ''),
    [pendingFileNavigation?.path],
  );
  const shouldMaskEditorForPendingNavigation = Boolean(
    pendingFileNavigation
      && pendingNavigationTargetPath
      && selectedFilePath
      && selectedFilePath === pendingNavigationTargetPath
      && !fileLoading
      && !fileError
      && !isSelectedNonText,
  );

  return { shouldMaskEditorForPendingNavigation };
}

export function useFileNavigationRequests() {
  const pendingNavigationRafRef = React.useRef<number | null>(null);
  const pendingNavigationCycleRef = React.useRef<{ key: string; attempts: number; targetShown: boolean }>({ key: '', attempts: 0, targetShown: false });

  React.useEffect(() => {
    return () => {
      if (pendingNavigationRafRef.current !== null && typeof window !== 'undefined') {
        window.cancelAnimationFrame(pendingNavigationRafRef.current);
        pendingNavigationRafRef.current = null;
      }
    };
  }, []);
  const pendingFileNavigation = useUIStore((state) => state.pendingFileNavigation);
  const setPendingFileNavigation = useUIStore((state) => state.setPendingFileNavigation);
  const pendingFileFocusPath = useUIStore((state) => state.pendingFileFocusPath);
  const setPendingFileFocusPath = useUIStore((state) => state.setPendingFileFocusPath);

  return { pendingNavigationRafRef, pendingNavigationCycleRef, pendingFileNavigation, setPendingFileNavigation, pendingFileFocusPath, setPendingFileFocusPath };
}
