import type { ChatQuoteAnchor } from '@/lib/chatQuoteAnchor';

export interface SelectionCommentHandoff {
    plainText: string;
    markdownText: string;
    messageId: string | null;
    anchor: ChatQuoteAnchor;
    commentText: string;
    pastedImages: ReadonlyMap<string, File>;
}

const HANDOFF_TTL_MS = 2000;

const handoffs = new Map<string, { draft: SelectionCommentHandoff; owner: symbol; expires: number }>();

const dropExpired = (now: number): void => {
    for (const [key, entry] of handoffs) {
        if (entry.expires < now) handoffs.delete(key);
    }
};

export const leaveSelectionComment = (key: string, owner: symbol, draft: SelectionCommentHandoff): void => {
    const now = Date.now();
    dropExpired(now);
    handoffs.set(key, { draft, owner, expires: now + HANDOFF_TTL_MS });
};

export const takeSelectionComment = <T>(
    key: string,
    owner: symbol,
    place: (draft: SelectionCommentHandoff) => T | null,
): { draft: SelectionCommentHandoff; placed: T } | null => {
    dropExpired(Date.now());
    const entry = handoffs.get(key);
    if (!entry || entry.owner === owner) return null;
    const placed = place(entry.draft);
    if (placed === null) return null;
    handoffs.delete(key);
    return { draft: entry.draft, placed };
};
