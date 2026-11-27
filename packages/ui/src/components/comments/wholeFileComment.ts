import type { ReviewThread } from '@/lib/source-control/types';
import type { InlineCommentDraft } from '@/stores/useInlineCommentDraftStore';

export const isWholeFileComment = (draft: Pick<InlineCommentDraft, 'startLine' | 'endLine'>): boolean => (
  draft.startLine === 0 && draft.endLine === 0
);

export const isWholeFileReviewThread = (thread: Pick<ReviewThread, 'line' | 'outdated'>): boolean => (
  thread.line === null && thread.outdated !== true
);
