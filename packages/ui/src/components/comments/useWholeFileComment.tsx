import React from 'react';
import type { DiffCommentOrigin } from '@/lib/diffCommentOrigin';
import { useI18n } from '@/lib/i18n';
import { ReviewDraftCard, ReviewThreadCard } from '@/components/review/ReviewCards';
import { useChangeRequestReviewContext } from '@/components/review/useChangeRequestReview';
import { InlineCommentCard } from './InlineCommentCard';
import { InlineCommentInput } from './InlineCommentInput';
import { useInlineCommentController } from './useInlineCommentController';
import { isWholeFileComment, isWholeFileReviewThread } from './wholeFileComment';

const WHOLE_FILE_RANGE = { start: 0, end: 0 };

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
  const { t } = useI18n();
  const fileDrafts = React.useMemo(() => drafts.filter(isWholeFileComment), [drafts]);
  const review = useChangeRequestReviewContext();
  const reviewDrafts = (review?.state?.draft?.comments ?? []).filter((comment) => comment.path === fileLabel && comment.line === null);
  const reviewThreads = (review?.state?.threads ?? []).filter((thread) => thread.path === fileLabel && isWholeFileReviewThread(thread));

  React.useEffect(() => {
    cancel();
  }, [fileLabel, cancel]);

  const toggle = React.useCallback(() => {
    if (selection) cancel();
    else setSelection(WHOLE_FILE_RANGE);
  }, [selection, cancel, setSelection]);

  const shownDrafts = fileDrafts.filter((draft) => draft.id !== editingDraftId);
  const threadsUnavailable = review?.readFailed === true && !review.state;
  const cards = threadsUnavailable || shownDrafts.length + reviewDrafts.length + reviewThreads.length > 0 ? (
    <div className="flex flex-col gap-2 px-3 py-2">
      {threadsUnavailable ? (
        <p className="typography-meta text-muted-foreground">{t('review.threadsUnavailable')}</p>
      ) : null}
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

  const reviewField = review?.fileComments && review.canWrite && editingDraftId === null ? {
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
