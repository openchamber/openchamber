import { useCallback, useEffect, useMemo, useRef, type RefObject } from 'react';
import type { FileDiff as PierreFileDiff, FileDiffMetadata, SelectedLineRange } from '@pierre/diffs';
import {
  type ReviewLineItem,
  isWholeFileComment,
  useInlineCommentController,
} from '@/components/comments';
import { useChangeRequestReviewContext } from '@/components/review/useChangeRequestReview';
import { diffLineSource } from '@/lib/diff/selectedDiffLines';
import { textLineSource } from '@/lib/commentAnchor';
import type { DiffCommentOrigin } from '@/lib/diffCommentOrigin';
import { extractSelectedCode } from './diffSelection';
import type { DiffAnnotation } from './types';

interface DiffCommentsInput {
  original: string;
  modified: string;
  incomingFileDiff: FileDiffMetadata | undefined;
  fileName: string | undefined;
  language: string;
  commentOrigin: DiffCommentOrigin | undefined;
  enableComments: boolean;
  isMobile: boolean;
  diffInstanceRef: RefObject<PierreFileDiff<DiffAnnotation> | null>;
}

export const useDiffComments = ({
  original,
  modified,
  incomingFileDiff,
  fileName,
  language,
  commentOrigin,
  enableComments,
  isMobile,
  diffInstanceRef,
}: DiffCommentsInput) => {
  // Comments follow their code when the diff changes: each side is the lines
  // a comment on it can be found on.
  const commentLineSources = useMemo(() => (incomingFileDiff
    ? { additions: diffLineSource(incomingFileDiff, 'additions'), deletions: diffLineSource(incomingFileDiff, 'deletions') }
    // An empty side is a file that is absent there, or one not loaded yet:
    // neither says the commented code is gone.
    : { additions: modified ? textLineSource(modified) : null, deletions: original ? textLineSource(original) : null }
  ), [incomingFileDiff, modified, original]);
  const diffCommentController = useInlineCommentController<SelectedLineRange>({
    source: 'diff',
    fileLabel: fileName || 'unknown',
    origin: commentOrigin,
    language,
    getCodeForRange: (range) => extractSelectedCode(original, modified, incomingFileDiff, range),
    toStoreRange: (range) => ({
      startLine: range.start,
      endLine: range.end,
      side: range.side === 'deletions' ? 'original' : 'modified',
    }),
    fromDraftRange: (draft) => ({
      start: draft.startLine,
      end: draft.endLine,
      side: draft.side === 'original' ? 'deletions' : 'additions',
    }),
    // A range across both sides has two sets of line numbers and stays put.
    // A viewer without comments (a commit in History) shows other content
    // under the same path and must not move the working tree's comments.
    lineSource: (range) => (!enableComments || (range.endSide && range.endSide !== range.side)
      ? null
      : commentLineSources[range.side === 'deletions' ? 'deletions' : 'additions']),
    contentVersion: commentLineSources,
    onSelectionMoved: (range) => moveSelectionRef.current(range),
  });

  const {
    drafts: diffDrafts,
    selection,
    setSelection,
    commentText,
    setCommentText,
    editingDraftId,
    saveComment,
    cancel,
    startEdit,
    deleteDraft,
  } = diffCommentController;
  // Whole-file comments have no lines to sit under; the file header shows them.
  const fileDrafts = useMemo(() => diffDrafts.filter((draft) => !isWholeFileComment(draft)), [diffDrafts]);

  // A change request's review: its cards on this file's lines, and the field's way into it.
  const review = useChangeRequestReviewContext();
  const reviewItems = useMemo<ReviewLineItem[]>(() => {
    if (!review?.state || !fileName) return [];
    const onLine = <T extends { path: string; line: number | null }>(entry: T): entry is T & { line: number } => (
      entry.path === fileName && entry.line !== null
    );
    return [
      ...review.state.threads.filter(onLine).map((thread): ReviewLineItem => ({
        id: `thread-${thread.id}`, kind: 'thread', thread, lineNumber: thread.line, side: thread.side === 'old' ? 'deletions' : 'additions',
      })),
      ...(review.state.draft?.comments ?? []).filter(onLine).map((comment): ReviewLineItem => ({
        id: `draft-${comment.id}`, kind: 'draft', comment, lineNumber: comment.line, side: comment.side === 'old' ? 'deletions' : 'additions',
      })),
    ];
  }, [fileName, review?.state]);
  const excerptOf = useCallback((item: ReviewLineItem) => {
    if (item.side === 'deletions') return null;
    const entry = item.kind === 'draft' ? item.comment : item.thread;
    const start = entry.startLine ?? item.lineNumber;
    return {
      startLine: start,
      lines: extractSelectedCode(original, modified, incomingFileDiff, { start, end: item.lineNumber, side: 'additions' }).split('\n'),
    };
  }, [incomingFileDiff, modified, original]);
  const selectionSide = selection?.side;
  // A selection across both sides has two sets of line numbers; a review comment takes one.
  const selectionCrossesSides = Boolean(selection?.endSide && selection.endSide !== selection.side);
  const reviewField = useMemo(() => {
    if (!review || !fileName || selectionCrossesSides) return undefined;
    return {
      add: async (text: string, range?: SelectedLineRange) => {
        const target = range ?? selectionRef.current;
        if (!target) return false;
        const start = Math.min(target.start, target.end);
        const end = Math.max(target.start, target.end);
        const added = await review.addComment({
          path: fileName,
          side: target.side === 'deletions' ? 'old' : 'new',
          line: end,
          startLine: start < end ? start : undefined,
        }, text);
        if (added) cancel();
        return added;
      },
      // A suggestion replaces lines of the new side.
      suggestionCode: selectionSide === 'deletions' ? undefined : () => {
        const target = selectionRef.current;
        return target ? extractSelectedCode(original, modified, incomingFileDiff, target) : '';
      },
    };
  }, [cancel, fileName, incomingFileDiff, modified, original, review, selectionCrossesSides, selectionSide]);

  const selectionRef = useRef<SelectedLineRange | null>(null);
  const moveSelectionRef = useRef<(range: SelectedLineRange) => void>(() => {});
  const editingDraftIdRef = useRef<string | null>(null);
  const commentTextRef = useRef('');
  // Use a ref to track if we're currently applying a selection programmatically
  // to avoid loop with onLineSelected callback
  const isApplyingSelectionRef = useRef(false);
  const lastAppliedSelectionRef = useRef<SelectedLineRange | null>(null);

  useEffect(() => {
    selectionRef.current = selection;
  }, [selection]);

  useEffect(() => {
    editingDraftIdRef.current = editingDraftId;
  }, [editingDraftId]);

  useEffect(() => {
    commentTextRef.current = commentText;
  }, [commentText]);

  const handleSelectionChange = useCallback((range: SelectedLineRange | null) => {
    if (!enableComments) {
      return;
    }

    // Ignore callbacks while we're programmatically applying selection
    if (isApplyingSelectionRef.current) {
      return;
    }

    const prevSelection = selectionRef.current;

    if (!range && prevSelection && commentTextRef.current.trim()) {
      return;
    }

    // Mobile tap-to-extend: if selection exists and new tap is on same side, extend range
    if (isMobile && prevSelection && range && range.side === prevSelection.side) {
      const start = Math.min(prevSelection.start, range.start);
      const end = Math.max(prevSelection.end, range.end);
      setSelection({ ...range, start, end });
    } else {
      setSelection(range);
    }
    // Pierre holds this selection too: closing the field has to clear it there,
    // or the next click on the line would read as taking it back.
    lastAppliedSelectionRef.current = range;

    // Clear editing state when selection changes user-driven
    if (range) {
      if (!editingDraftIdRef.current) {
        setCommentText('');
      }
    }
  }, [enableComments, isMobile, setCommentText, setSelection]);

  const handleCancelComment = useCallback(() => {
    cancel();
  }, [cancel]);

  // Pierre holds its own copy of the selection and paints the selected rows
  // from it. A selection that did not come from a press on the diff is given
  // to it here: one that moved with its code, and the open field's after the
  // diff was rebuilt for new content.
  const paintSelection = useCallback((range: SelectedLineRange) => {
    try {
      isApplyingSelectionRef.current = true;
      diffInstanceRef.current?.setSelectedLines(range);
      lastAppliedSelectionRef.current = range;
    } catch {
      // The rows are not there to paint; the comment field still moves.
    } finally {
      isApplyingSelectionRef.current = false;
    }
  }, [diffInstanceRef]);
  const selectionMovedRef = useRef(false);
  useEffect(() => {
    moveSelectionRef.current = (range) => {
      selectionMovedRef.current = true;
      setSelection(range);
    };
  }, [setSelection]);
  useEffect(() => {
    if (!selectionMovedRef.current || !selection) return;
    selectionMovedRef.current = false;
    paintSelection(selection);
  }, [paintSelection, selection]);

  const handleSaveComment = useCallback((textToSave: string, rangeOverride?: SelectedLineRange) => {
    return saveComment(textToSave, rangeOverride ?? selection ?? undefined);
  }, [saveComment, selection]);

  const applySelection = useCallback((range: SelectedLineRange) => {
    setSelection(range);
    const instance = diffInstanceRef.current;
    if (!instance) return;
    try {
      isApplyingSelectionRef.current = true;
      instance.setSelectedLines(range);
      lastAppliedSelectionRef.current = range;
    } catch {
      // ignore
    } finally {
      isApplyingSelectionRef.current = false;
    }
  }, [diffInstanceRef, setSelection]);

  return {
    selection,
    setSelection,
    commentText,
    setCommentText,
    editingDraftId,
    startEdit,
    deleteDraft,
    fileDrafts,
    review,
    reviewItems,
    reviewField,
    excerptOf,
    selectionRef,
    editingDraftIdRef,
    commentTextRef,
    isApplyingSelectionRef,
    lastAppliedSelectionRef,
    handleSelectionChange,
    handleCancelComment,
    handleSaveComment,
    paintSelection,
    applySelection,
  };
};
