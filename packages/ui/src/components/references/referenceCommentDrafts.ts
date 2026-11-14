/**
 * Unsaved comment text, kept while the preview is left. A half-typed rewrite
 * would otherwise be gone without a word when the item is left. Save and
 * cancel drop it; nothing else does, and the oldest draft goes once there are
 * twenty.
 */
const DRAFT_LIMIT = 20;

const commentDrafts = new Map<string, string>();

/** One draft per host comment; `body` is the whole text being rewritten. */
export const commentDraftKey = (comment: { id?: string; url?: string }) =>
    `comment\u0000${comment.url ?? ''}\u0000${comment.id ?? ''}`;

export const commentDraft = (key: string) => commentDrafts.get(key);

export const rememberCommentDraft = (key: string, body: string) => {
    commentDrafts.delete(key);
    commentDrafts.set(key, body);
    const oldest = commentDrafts.keys().next();
    if (commentDrafts.size > DRAFT_LIMIT && !oldest.done) commentDrafts.delete(oldest.value);
};

export const forgetCommentDraft = (key: string) => { commentDrafts.delete(key); };
