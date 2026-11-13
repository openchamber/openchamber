import type { InlineCommentDraft } from '@/stores/useInlineCommentDraftStore';

/** A whole-file comment is a diff comment with no lines: start and end 0. */
export const isWholeFileComment = (draft: Pick<InlineCommentDraft, 'startLine' | 'endLine'>): boolean => (
  draft.startLine === 0 && draft.endLine === 0
);
