/**
 * Unsaved title and description text, kept while the item is left. The preview
 * is remounted per item, and on a phone the list is one back gesture away, so
 * a half-typed edit would otherwise be gone without a word. Save and cancel
 * drop it; nothing else does, and the oldest draft goes once there are twenty.
 */
interface ReferenceTextDraft {
    title: string;
    body: string;
}

const DRAFT_LIMIT = 20;
const drafts = new Map<string, ReferenceTextDraft>();

/** One draft per host item: the same number in another repository is another draft. */
export const referenceTextDraftKey = (reference: { provider: string; url: string }) =>
    `${reference.provider}\u0000${reference.url}`;

export const referenceTextDraft = (key: string) => drafts.get(key);

export const rememberReferenceTextDraft = (key: string, draft: ReferenceTextDraft) => {
    drafts.delete(key);
    drafts.set(key, draft);
    const oldest = drafts.keys().next();
    if (drafts.size > DRAFT_LIMIT && !oldest.done) drafts.delete(oldest.value);
};

export const forgetReferenceTextDraft = (key: string) => { drafts.delete(key); };

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
