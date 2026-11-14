import { create } from 'zustand';

import { getChatDraftIdentityKey, subscribeChatDraftDeletion, type ChatDraftIdentity } from '@/lib/chatDraftPersistence';

import { withComposerReferences, type ComposerReference } from './composerReferences';
import { readStoredSharedPageChips, storeSharedPageChips } from './sharedPageChipDrafts';

type LinkedReferenceDraftsState = {
    drafts: Map<string, ComposerReference[]>;
    set: (references: readonly ComposerReference[], target: ChatDraftIdentity | null) => void;
    clear: (target: ChatDraftIdentity | null) => void;
    move: (from: ChatDraftIdentity | null, to: ChatDraftIdentity | null) => void;
};

const NO_REFERENCES: ComposerReference[] = [];

/**
 * Chips outlive composer switches and remounts, under the same identity as text
 * and files. They stay in memory because resolved context can be large and is
 * an attach-time snapshot; reloading does not restore it. A shared page's chip
 * is the exception (`sharedPageChipDrafts.ts`): its link left the text, so the
 * chip is all the draft has of it, and it names the page without its content.
 */
export const useLinkedReferenceDrafts = create<LinkedReferenceDraftsState>()((set) => ({
    drafts: new Map<string, ComposerReference[]>(readStoredSharedPageChips()),
    move: (from, to) => {
        if (!from || !to) return;
        const fromKey = getChatDraftIdentityKey(from);
        const toKey = getChatDraftIdentityKey(to);
        if (fromKey === toKey) return;
        set((state) => {
            const source = state.drafts.get(fromKey);
            if (!source) return state;
            const drafts = new Map(state.drafts);
            drafts.set(toKey, withComposerReferences(source, drafts.get(toKey) ?? []));
            drafts.delete(fromKey);
            return { drafts };
        });
    },
    set: (references, target) => {
        if (!target) return;
        const key = getChatDraftIdentityKey(target);
        set((state) => {
            const drafts = new Map(state.drafts);
            if (references.length > 0) drafts.set(key, [...references]);
            else drafts.delete(key);
            return { drafts };
        });
    },
    clear: (target) => {
        if (!target) return;
        const key = getChatDraftIdentityKey(target);
        set((state) => {
            if (!state.drafts.has(key)) return state;
            const drafts = new Map(state.drafts);
            drafts.delete(key);
            return { drafts };
        });
    },
}));

/** A draft's chips, read outside React (a send resolving after a session switch). */
export const readLinkedReferences = (target: ChatDraftIdentity | null): ComposerReference[] => {
    if (!target) return NO_REFERENCES;
    return useLinkedReferenceDrafts.getState().drafts.get(getChatDraftIdentityKey(target)) ?? NO_REFERENCES;
};

export const useDraftLinkedReferences = (target: ChatDraftIdentity | null): ComposerReference[] => {
    const key = target ? getChatDraftIdentityKey(target) : null;
    return useLinkedReferenceDrafts((state) => (key ? state.drafts.get(key) ?? NO_REFERENCES : NO_REFERENCES));
};

subscribeChatDraftDeletion((identity) => useLinkedReferenceDrafts.getState().clear(identity));
useLinkedReferenceDrafts.subscribe((state) => storeSharedPageChips(state.drafts));
