import React from 'react';
import { pendingFileNavigationStep } from '../../pendingFileNavigation';
import { EditorView } from '@codemirror/view';
import { useKeybind } from '@/hooks/useKeybind';
import { normalizePath } from './fileViewPaths';
import type { useFilesViewState } from './useFilesViewState';
import type { useFileOpening } from './useFileOpening';
import type { useFileKinds } from './useFileKinds';

export function useFileNavigation({
  isMobile, zoneInteractive, root, textViewMode, setTextViewMode, toFileNode, selectedFile, fileLoading, fileError,
  loadedFilePath, failedFilePath, draftContent, confirmDiscardOpen, editorViewRef, editorWrapperRef,
  editorViewReadyNonce, setEditorViewReadyNonce, pendingNavigationRafRef, pendingNavigationCycleRef,
  setIsGoToLineOpen, setIsSymbolsOpen, pendingFileNavigation, setPendingFileNavigation, pendingFileFocusPath,
  setPendingFileFocusPath, handleSelectFile, isSelectedImage, isSelectedPdf, isUnsupportedBinary, canEdit,
}: Pick<ReturnType<typeof useFilesViewState>,
  'isMobile' | 'zoneInteractive' | 'root' | 'textViewMode' | 'setTextViewMode' | 'toFileNode' | 'selectedFile' |
  'fileLoading' | 'fileError' | 'loadedFilePath' | 'failedFilePath' | 'draftContent' | 'confirmDiscardOpen' |
  'editorViewRef' | 'editorWrapperRef' | 'editorViewReadyNonce' | 'setEditorViewReadyNonce' |
  'pendingNavigationRafRef' | 'pendingNavigationCycleRef' | 'setIsGoToLineOpen' | 'setIsSymbolsOpen' |
  'pendingFileNavigation' | 'setPendingFileNavigation' | 'pendingFileFocusPath' | 'setPendingFileFocusPath'> &
Pick<ReturnType<typeof useFileOpening>,
  'handleSelectFile'> &
Pick<ReturnType<typeof useFileKinds>,
  'isSelectedImage' | 'isSelectedPdf' | 'isUnsupportedBinary' | 'canEdit'>) {
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

    // The jump focuses the editor, which does nothing inside a zone that is
    // still opening (inert); it runs once the zone settles.
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
    // Focus inside a zone that is still opening (inert) does nothing.
    if (!pendingFileFocusPath || !root || !zoneInteractive) {
      return;
    }

    const targetPath = normalizePath(pendingFileFocusPath);
    if (!targetPath) {
      setPendingFileFocusPath(null);
      return;
    }

    if (selectedFile?.path !== targetPath) {
      // Selection is owned by the tab sync / user. A pending focus request must
      // not steal selection back (e.g. after the user switched to another tab
      // while this file was still loading). Wait; clear once it loads or the
      // request is superseded.
      return;
    }

    if (fileLoading || (loadedFilePath !== targetPath && failedFilePath !== targetPath)) {
      return;
    }

    // Best-effort focus: preview renderers (markdown/html preview, drawio,
    // JSON tree, images, PDFs) never mount a CodeMirror editor, so the request
    // must clear regardless — otherwise it lingers and replays on every
    // dependency change.
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

  const nudgeEditorSelectionAboveKeyboard = React.useCallback((view: EditorView | null) => {
    if (!isMobile || !view || typeof window === 'undefined') {
      return;
    }

    // The inline comment bar is a block widget inside the editor; once its
    // textarea takes focus the editor itself loses focus, so track the bar.
    const activeElement = document.activeElement;
    const commentInput = !view.hasFocus && activeElement instanceof HTMLElement && view.dom.contains(activeElement)
      ? activeElement.closest<HTMLElement>('[data-comment-input="true"]')
      : null;
    if (!view.hasFocus && !commentInput) {
      return;
    }

    const viewport = window.visualViewport;
    if (!viewport) {
      return;
    }

    const layoutHeight = document.documentElement.clientHeight || window.innerHeight;
    const occludedBottom = Math.max(0, layoutHeight - (viewport.offsetTop + viewport.height));
    if (occludedBottom <= 0) {
      return;
    }

    const cursorRect = commentInput
      ? commentInput.getBoundingClientRect()
      : view.coordsAtPos(view.state.selection.main.head);
    if (!cursorRect) {
      return;
    }

    const visibleBottom = Math.round(viewport.offsetTop + viewport.height);
    const clearance = 20;
    const overlap = cursorRect.bottom + clearance - visibleBottom;
    if (overlap <= 0) {
      return;
    }

    view.scrollDOM.scrollTop += overlap;
  }, [isMobile]);

  React.useEffect(() => {
    if (!isMobile || typeof window === 'undefined') {
      return;
    }

    const runNudge = () => {
      window.requestAnimationFrame(() => {
        nudgeEditorSelectionAboveKeyboard(editorViewRef.current);
      });
    };

    const viewport = window.visualViewport;
    viewport?.addEventListener('resize', runNudge);
    viewport?.addEventListener('scroll', runNudge, { passive: true });
    document.addEventListener('selectionchange', runNudge);

    return () => {
      viewport?.removeEventListener('resize', runNudge);
      viewport?.removeEventListener('scroll', runNudge);
      document.removeEventListener('selectionchange', runNudge);
    };
  }, [isMobile, nudgeEditorSelectionAboveKeyboard]);

  useKeybind('open_go_to_line', (event) => {
    if (!canEdit || textViewMode !== 'edit' || isMobile) {
      return false;
    }

    const target = event.target as Element | null;
    if (target?.closest('[role="dialog"]')) return false;
    if (!(target instanceof Node) || !editorWrapperRef.current?.contains(target)) return false;

    const isEditorTarget = Boolean(target?.closest('.cm-editor'));
    const isTypingTarget = Boolean(target?.closest('input, textarea, [contenteditable="true"], [role="textbox"]'));
    if (isTypingTarget && !isEditorTarget) return false;

    setIsGoToLineOpen(true);
  });

  useKeybind('open_document_symbols', (event) => {
    if (!canEdit || textViewMode !== 'edit' || isMobile) {
      return false;
    }
    const target = event.target as Element | null;
    if (target?.closest('[role="dialog"]')) return false;
    if (!(target instanceof Node) || !editorWrapperRef.current?.contains(target)) return false;
    setIsSymbolsOpen(true);
  });
  return {
  nudgeEditorSelectionAboveKeyboard,
  };
}
