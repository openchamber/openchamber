import React from 'react';
import { getLanguageFromExtension } from '@/lib/toolHelpers';
import { textLineSource } from '@/lib/commentAnchor';
import { isWholeFileComment, normalizeLineRange, useInlineCommentController, useLineNumberDragSelection, useWholeFileComment } from '@/components/comments';
import { type SelectedLineRange } from './fileViewTypes';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { type useFileDraft } from './useFileSaving';
import { type useFileEditor } from './useFileEditorExtensions';
import { type useFileDocument } from './useFileDocument';
import { type useFileTabs } from './useFileTabs';

type CommentController = ReturnType<typeof useInlineCommentController<SelectedLineRange>>;
type FileComments = Pick<CommentController, 'commentText' | 'setCommentText' | 'editingDraftId' | 'cancel' | 'startEdit' | 'deleteDraft'>
  & Pick<ReturnType<typeof useLineNumberDragSelection>, 'isDragging' | 'lineNumbersConfig'>
  & {
    lineSelection: SelectedLineRange | null;
    setLineSelection: React.Dispatch<React.SetStateAction<SelectedLineRange | null>>;
    wholeFileCommentPanel: React.ReactNode;
    markdownPreviewRef: React.RefObject<HTMLDivElement | null>;
    filesLineDrafts: CommentController['drafts'];
    wholeFileComment: ReturnType<typeof useWholeFileComment>;
    handleSaveComment: CommentController['saveComment'];
  };

export function useFileComments({ draft, editor, fileDocument, tabs, isMobile }: {
  draft: Pick<ReturnType<typeof useFileDraft>, 'setDraftContent' | 'setIsSaving'>;
  editor: Pick<ReturnType<typeof useFileEditor>, 'editorViewRef'>;
  fileDocument: Pick<ReturnType<typeof useFileDocument>, 'fileContent' | 'fileLoading' | 'loadedFilePath' | 'pendingPathMoveRef'>;
  tabs: Pick<ReturnType<typeof useFileTabs>, 'selectedFile'>;
  isMobile: boolean;
}): FileComments {
  const { setDraftContent, setIsSaving } = draft;
  const { editorViewRef } = editor;
  const { fileContent, fileLoading, loadedFilePath, pendingPathMoveRef } = fileDocument;
  const { selectedFile } = tabs;
  const [lineSelection, setLineSelection] = React.useState<SelectedLineRange | null>(null);

  const extractSelectedCode = React.useCallback((content: string, range: SelectedLineRange): string => {
    const lines = content.split('\n');
    const startLine = Math.max(1, range.start);
    const endLine = Math.min(lines.length, range.end);
    if (startLine > endLine) return '';
    return lines.slice(startLine - 1, endLine).join('\n');
  }, []);

  const markdownPreviewRef = React.useRef<HTMLDivElement | null>(null);

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
  const filesLineDrafts = React.useMemo(() => filesFileDrafts.filter((draft) => !isWholeFileComment(draft)), [filesFileDrafts]);
  const wholeFileComment = useWholeFileComment({ fileLabel: selectedFile?.path ?? '', source: 'file' });

  const { isDragging, lineNumbersConfig, isDragReleaseClick } = useLineNumberDragSelection({
    lineSelection,
    setLineSelection,
    onClear: cancel,
    isMobile,
  });

  React.useEffect(() => {
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
  const wholeFileCommentPanel = wholeFileComment.editor || wholeFileComment.cards ? (
    <ScrollableOverlay outerClassName="max-h-[50%] shrink-0 border-b border-edge-muted" disableHorizontal>
      {wholeFileComment.editor}
      {wholeFileComment.cards}
    </ScrollableOverlay>
  ) : null;
  return {
  lineSelection, setLineSelection, wholeFileCommentPanel,
  markdownPreviewRef, commentText, setCommentText, editingDraftId, cancel, startEdit, deleteDraft, filesLineDrafts,
  wholeFileComment, isDragging, lineNumbersConfig, handleSaveComment,
  };
}
