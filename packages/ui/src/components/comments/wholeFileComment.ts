import type { InlineCommentDraft } from '@/stores/useInlineCommentDraftStore';

export const isWholeFileComment = (draft: Pick<InlineCommentDraft, 'startLine' | 'endLine'>): boolean => (
  draft.startLine === 0 && draft.endLine === 0
);
