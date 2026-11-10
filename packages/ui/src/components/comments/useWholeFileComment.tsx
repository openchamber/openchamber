import React from 'react';
import type { DiffCommentOrigin } from '@/lib/diffCommentOrigin';
import { ReviewDraftCard, ReviewThreadCard } from '@/components/review/ReviewCards';
import { useChangeRequestReviewContext } from '@/components/review/useChangeRequestReview';
import { InlineCommentCard } from './InlineCommentCard';
import { InlineCommentInput } from './InlineCommentInput';
import { useInlineCommentController } from './useInlineCommentController';
import { isWholeFileComment } from './wholeFileComment';

const WHOLE_FILE_RANGE = { start: 0, end: 0 };

/**
 * Comments on a file as a whole, written from its header. The header shows the
 * trigger. The saved comments render under the header, where the line
 * comments' editor would, so the file's own diff never moves. The editor goes
 * inside a sticky header: opened from a file scrolled far down, it shows under
 * the header on screen instead of at the file's top out of view.
 * Files view passes `source: 'file'`, so its comments sit with its line comments.
 */
export function useWholeFileComment({
  fileLabel,
  origin,
  source = 'diff',
}: {
  fileLabel: string;
  origin?: DiffCommentOrigin;
  source?: 'diff' | 'file';
}) {
  const controller = useInlineCommentController<{ start: number; end: number }>({
    source,
    fileLabel,
    language: '',
    origin,
    getCodeForRange: () => '',
    toStoreRange: () => ({ startLine: 0, endLine: 0 }),
    fromDraftRange: () => WHOLE_FILE_RANGE,
  });
  const { drafts, selection, setSelection, commentText, setCommentText, editingDraftId, saveComment, cancel, startEdit, deleteDraft } = controller;
  const fileDrafts = React.useMemo(() => drafts.filter(isWholeFileComment), [drafts]);
  const review = useChangeRequestReviewContext();
  const reviewDrafts = (review?.state?.draft?.comments ?? []).filter((comment) => comment.path === fileLabel && comment.line === null);
  const reviewThreads = (review?.state?.threads ?? []).filter((thread) => thread.path === fileLabel && thread.line === null);

  // Files view keeps one instance across files: an open editor belongs to the file it was opened on.
  React.useEffect(() => {
    cancel();
  }, [fileLabel, cancel]);

  // The header button opens the editor and, pressed again, closes it unsaved.
  const toggle = React.useCallback(() => {
    if (selection) cancel();
    else setSelection(WHOLE_FILE_RANGE);
  }, [selection, cancel, setSelection]);

  const shownDrafts = fileDrafts.filter((draft) => draft.id !== editingDraftId);
  const cards = shownDrafts.length + reviewDrafts.length + reviewThreads.length > 0 ? (
    <div className="flex flex-col gap-2 px-3 py-2">
      {shownDrafts.map((draft) => (
        <InlineCommentCard
          key={draft.id}
          draft={draft}
          onEdit={() => startEdit(draft)}
          onDelete={() => deleteDraft(draft)}
          forAgent={review !== null}
        />
      ))}
      {review ? reviewDrafts.map((comment) => (
        <ReviewDraftCard key={comment.id} comment={comment} review={review} excerpt={null} fileLabel={fileLabel} />
      )) : null}
      {review ? reviewThreads.map((thread) => (
        <ReviewThreadCard key={thread.id} thread={thread} review={review} excerpt={null} />
      )) : null}
    </div>
  ) : null;

  const reviewField = review?.fileComments && editingDraftId === null ? {
    add: async (text: string) => {
      const added = await review.addComment({ path: fileLabel }, text);
      if (added) cancel();
      return added;
    },
  } : undefined;

  const editor = selection ? (
    <div className="px-3 py-2">
      <InlineCommentInput
        initialText={commentText}
        onTextChange={setCommentText}
        onSave={(text) => saveComment(text, WHOLE_FILE_RANGE)}
        onCancel={cancel}
        fileLabel={fileLabel}
        isEditing={editingDraftId !== null}
        band={false}
        wholeFile
        review={reviewField}
      />
    </div>
  ) : null;

  return { toggle, isOpen: selection !== null, cards, editor };
}
