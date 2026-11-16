const DRAFT_LIMIT = 20;

const commentDrafts = new Map<string, string>();

export const commentDraftScope = (runtimeKey: string, directory: string | null, account: string, itemUrl: string) =>
    [runtimeKey, directory ?? '', account, itemUrl].join('\u0000');

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
