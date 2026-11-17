import React from 'react';
import { getLanguageFromExtension } from '@/lib/toolHelpers';
import { textLineSource } from '@/lib/commentAnchor';
import { isWholeFileComment, normalizeLineRange, useInlineCommentController, useLineNumberDragSelection, useWholeFileComment } from '@/components/comments';
import type { SelectedLineRange } from './fileViewTypes';
import type { useFilesViewState } from './useFilesViewState';

type DragLineNumbersConfig = ReturnType<typeof useLineNumberDragSelection>['lineNumbersConfig'];
interface LineNumbersConfig extends DragLineNumbersConfig {
  formatNumber?: DragLineNumbersConfig['formatNumber'];
}

export function useFileComments({
  isMobile, selectedFile, fileContent, fileLoading, loadedFilePath, pendingPathMoveRef, setDraftContent,
  setIsSaving, editorViewRef, lineSelection, setLineSelection,
}: Pick<ReturnType<typeof useFilesViewState>,
  'isMobile' | 'selectedFile' | 'fileContent' | 'fileLoading' | 'loadedFilePath' | 'pendingPathMoveRef' |
  'setDraftContent' | 'setIsSaving' | 'editorViewRef' | 'lineSelection' | 'setLineSelection'>) {
  // Extract selected code
  const extractSelectedCode = React.useCallback((content: string, range: SelectedLineRange): string => {
    const lines = content.split('\n');
    const startLine = Math.max(1, range.start);
    const endLine = Math.min(lines.length, range.end);
    if (startLine > endLine) return '';
    return lines.slice(startLine - 1, endLine).join('\n');
  }, []);

  const markdownPreviewRef = React.useRef<HTMLDivElement | null>(null);

  // Comments follow their code when the file changes on disk. Only a loaded
  // text counts: an empty or half-loaded file would read as every commented
  // line being gone.
  const commentLineSource = React.useMemo(
    () => (fileContent && !fileLoading && loadedFilePath === selectedFile?.path ? textLineSource(fileContent) : null),
    [fileContent, fileLoading, loadedFilePath, selectedFile?.path],
  );
  const fileCommentController = useInlineCommentController<SelectedLineRange>({
    source: 'file',
    fileLabel: selectedFile?.path ?? null,
    language: selectedFile?.path ? getLanguageFromExtension(selectedFile.path) || 'text' : 'text',
    getCodeForRange: (range) => extractSelectedCode(fileContent, normalizeLineRange(range)),
    toStoreRange: (range) => ({ startLine: range.start, endLine: range.end }),
    fromDraftRange: (draft) => ({ start: draft.startLine, end: draft.endLine }),
    lineSource: () => commentLineSource,
    contentVersion: commentLineSource,
    onSelectionMoved: setLineSelection,
  });

  const {
    drafts: filesFileDrafts,
    commentText,
    setCommentText,
    editingDraftId,
    setSelection: setCommentSelection,
    saveComment,
    cancel,
    reset,
    startEdit,
    deleteDraft,
  } = fileCommentController;
  // Whole-file comments show under the toolbar, never between the lines.
  const filesLineDrafts = React.useMemo(() => filesFileDrafts.filter((draft) => !isWholeFileComment(draft)), [filesFileDrafts]);
  const wholeFileComment = useWholeFileComment({ fileLabel: selectedFile?.path ?? '', source: 'file' });

  const { isDragging, lineNumbersConfig: dragLineNumbersConfig, isDragReleaseClick } = useLineNumberDragSelection({
    lineSelection,
    setLineSelection,
    onClear: cancel,
    isMobile,
  });
  const lineNumbersConfig: LineNumbersConfig = dragLineNumbersConfig;

  React.useEffect(() => {
    // A moved file is the same document under a new path: it keeps its draft.
    if (pendingPathMoveRef.current?.to === selectedFile?.path) return;
    setLineSelection(null);
    reset();
    setDraftContent('');
    setIsSaving(false);
  }, [selectedFile?.path, reset]);

  React.useEffect(() => {
    setCommentSelection(lineSelection);
  }, [lineSelection, setCommentSelection]);

  React.useEffect(() => {
    if (!lineSelection && !editingDraftId) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (isDragReleaseClick()) return;
      const target = e.target as HTMLElement;

      if (target.closest('[data-comment-input="true"]') || target.closest('[data-comment-card="true"]')) return;
      if (target.closest('.cm-gutterElement')) return;
      if (target.closest('[data-sonner-toast]') || target.closest('[data-sonner-toaster]')) return;

      if (!commentText.trim()) {
        setLineSelection(null);
        cancel();
      }
    };

    const timeoutId = setTimeout(() => {
      document.addEventListener('click', handleClickOutside);
    }, 100);

    return () => {
      clearTimeout(timeoutId);
      document.removeEventListener('click', handleClickOutside);
    };
  }, [cancel, commentText, editingDraftId, isDragReleaseClick, lineSelection]);

  // Touch devices: while the comment bar is open, the line range is shown by
  // the highlightLines decoration. Any native text selection left in the
  // editor makes Android/iOS draw their copy/paste toolbar right over the bar,
  // so collapse it. Desktop keeps its selection untouched.
  React.useEffect(() => {
    if (!isMobile || !lineSelection) return;
    const view = editorViewRef.current;
    if (!view) return;

    const main = view.state.selection.main;
    if (!main.empty) {
      view.dispatch({ selection: { anchor: main.head } });
    }

    const domSelection = document.getSelection();
    if (domSelection && !domSelection.isCollapsed && domSelection.anchorNode && view.contentDOM.contains(domSelection.anchorNode)) {
      domSelection.removeAllRanges();
    }
  }, [isMobile, lineSelection]);

  const handleSaveComment = React.useCallback((text: string, range?: { start: number; end: number }) => {
    const finalRange = range ?? lineSelection ?? undefined;
    if (range) {
      setLineSelection(range);
    }
    const saved = saveComment(text, finalRange);
    if (saved) setLineSelection(null);
    return saved;
  }, [lineSelection, saveComment]);
  return {
  markdownPreviewRef, commentText, setCommentText, editingDraftId, cancel, startEdit, deleteDraft, filesLineDrafts,
  wholeFileComment, isDragging, lineNumbersConfig, handleSaveComment,
  };
}
