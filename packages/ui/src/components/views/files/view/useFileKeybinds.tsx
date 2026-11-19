import { useKeybinds, useKeybind } from '@/hooks/useKeybind';
import { type useFileSaving } from './useFileSaving';
import { type useFileCanvasState, type useFileFullscreen } from './useFileCanvas';
import { type useFileEditor } from './useFileEditorExtensions';
import { type useFileMarkdownPreview } from './useFileMarkdownPreview';
import { type useFileKinds } from './useFileKinds';
import { type useFileViewModes } from './useFilePreviewModes';

export function useFileKeybinds({ canvasState, editor, fileSaving, fullscreen, markdownPreview, isMarkdownPreview, isMobile }: {
  canvasState: Pick<ReturnType<typeof useFileCanvasState>, 'canvasWrapperRef'>;
  editor: Pick<ReturnType<typeof useFileEditor>, 'editorWrapperRef' | 'setIsSearchOpen'>;
  fileSaving: Pick<ReturnType<typeof useFileSaving>, 'saveNow'>;
  fullscreen: Pick<ReturnType<typeof useFileFullscreen>, 'isFullscreen'>;
  markdownPreview: Pick<ReturnType<typeof useFileMarkdownPreview>, 'mdFullscreenPreviewContainerRef' | 'mdPreviewContainerRef' | 'setMdPreviewFindFocusNonce' | 'setMdPreviewFindOpen'>;
  isMarkdownPreview: () => boolean;
  isMobile: boolean;
}) {
  const { canvasWrapperRef } = canvasState;
  const { editorWrapperRef, setIsSearchOpen } = editor;
  const { saveNow } = fileSaving;
  const { isFullscreen } = fullscreen;
  const { mdFullscreenPreviewContainerRef, mdPreviewContainerRef, setMdPreviewFindFocusNonce, setMdPreviewFindOpen } = markdownPreview;

  useKeybinds({
    save_file: (event) => {
      if (!(event.target instanceof Node)) return false;
      if (!editorWrapperRef.current?.contains(event.target) && !canvasWrapperRef.current?.contains(event.target)) return false;
      saveNow();
    },
    find_in_file: (event) => {
      if (!(event.target instanceof Node)) return false;

      if (isMarkdownPreview()) {
        if (isMobile) return false;
        const previewContainer = isFullscreen
          ? mdFullscreenPreviewContainerRef.current
          : mdPreviewContainerRef.current;
        if (!previewContainer?.contains(event.target)) return false;
        setMdPreviewFindOpen(true);
        setMdPreviewFindFocusNonce((value) => value + 1);
        return;
      }

      if (!editorWrapperRef.current?.contains(event.target)) return false;
      setIsSearchOpen(true);
    },
  });
}

export function useFileEditorKeybinds({ editor, fileKinds, viewModes, isMobile }: {
  editor: Pick<ReturnType<typeof useFileEditor>, 'editorWrapperRef' | 'setIsGoToLineOpen' | 'setIsSymbolsOpen'>;
  fileKinds: Pick<ReturnType<typeof useFileKinds>, 'canEdit'>;
  viewModes: Pick<ReturnType<typeof useFileViewModes>, 'textViewMode'>;
  isMobile: boolean;
}) {
  const { editorWrapperRef, setIsGoToLineOpen, setIsSymbolsOpen } = editor;
  const { canEdit } = fileKinds;
  const { textViewMode } = viewModes;
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

  return {  };
}
