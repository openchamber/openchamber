/**
 * Unsaved comment text, kept while the preview is left. A half-typed rewrite
 * would otherwise be gone without a word when the item is left. Save and
 * cancel drop it; nothing else does, and the oldest draft goes once there are
 * twenty.
 */
const DRAFT_LIMIT = 20;

const commentDrafts = new Map<string, string>();

/**
 * Where a preview's comments live and who writes them: the OpenChamber
 * instance, the folder, the account its binding names (provider, instance and
 * account id; '' while unknown), and the item. A comment id is unique on one
 * host only, and another account must never get this one's unsaved text.
 */
export const commentDraftScope = (runtimeKey: string, directory: string | null, account: string, itemUrl: string) =>
    [runtimeKey, directory ?? '', account, itemUrl].join('\u0000');

/** One draft per host comment; `body` is the whole text being rewritten. */
export const commentDraftKey = (scope: string, commentId: string | undefined) =>
    `${scope}\u0000${commentId ?? ''}`;

export const commentDraft = (key: string) => commentDrafts.get(key);

export const rememberCommentDraft = (key: string, body: string) => {
    commentDrafts.delete(key);
    commentDrafts.set(key, body);
    const oldest = commentDrafts.keys().next();
    if (commentDrafts.size > DRAFT_LIMIT && !oldest.done) commentDrafts.delete(oldest.value);
};

export const forgetCommentDraft = (key: string) => { commentDrafts.delete(key); };
