import { getRuntimeKey } from '@/lib/runtime-switch';

/**
 * Unsaved title and description text, kept while the item is left. The board
 * shows the next item in the same preview, and on a phone the list is one back
 * gesture away, so a half-typed edit would otherwise be gone without a word. Save and cancel
 * drop it; nothing else does, and the oldest draft goes once there are twenty.
 */
interface ReferenceTextDraft {
    title: string;
    body: string;
}

const DRAFT_LIMIT = 20;
const drafts = new Map<string, ReferenceTextDraft>();

/**
 * One draft per host item on one runtime: the same number in another
 * repository, or the same item seen through another server, is another draft.
 */
export const referenceTextDraftKey = (reference: { provider: string; url: string }) =>
    JSON.stringify([getRuntimeKey(), reference.provider, reference.url]);

export const referenceTextDraft = (key: string) => drafts.get(key);

export const rememberReferenceTextDraft = (key: string, draft: ReferenceTextDraft) => {
    drafts.delete(key);
    drafts.set(key, draft);
    const oldest = drafts.keys().next();
    if (drafts.size > DRAFT_LIMIT && !oldest.done) drafts.delete(oldest.value);
};

export const forgetReferenceTextDraft = (key: string) => { drafts.delete(key); };
