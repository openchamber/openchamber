import { getRuntimeKey } from '@/lib/runtime-switch';

interface ReferenceTextDraft {
    title: string;
    body: string;
}

const DRAFT_LIMIT = 20;
const drafts = new Map<string, ReferenceTextDraft>();

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
