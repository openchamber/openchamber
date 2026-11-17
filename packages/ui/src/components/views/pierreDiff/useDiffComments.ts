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
  const commentLineSources = useMemo(() => (incomingFileDiff
    ? { additions: diffLineSource(incomingFileDiff, 'additions'), deletions: diffLineSource(incomingFileDiff, 'deletions') }
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
  const fileDrafts = useMemo(() => diffDrafts.filter((draft) => !isWholeFileComment(draft)), [diffDrafts]);

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

    if (isApplyingSelectionRef.current) {
      return;
    }

    const prevSelection = selectionRef.current;

    if (!range && prevSelection && commentTextRef.current.trim()) {
      return;
    }

    if (isMobile && prevSelection && range && range.side === prevSelection.side) {
      const start = Math.min(prevSelection.start, range.start);
      const end = Math.max(prevSelection.end, range.end);
      setSelection({ ...range, start, end });
    } else {
      setSelection(range);
    }
    lastAppliedSelectionRef.current = range;

    if (range) {
      if (!editingDraftIdRef.current) {
        setCommentText('');
      }
    }
  }, [enableComments, isMobile, setCommentText, setSelection]);

  const handleCancelComment = useCallback(() => {
    cancel();
  }, [cancel]);

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
