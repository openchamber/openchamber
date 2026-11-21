import React from 'react';

import { useInlineCommentDraftStore, type InlineCommentDraft } from '@/stores/useInlineCommentDraftStore';
import { useUIStore } from '@/stores/useUIStore';

type DraftBuckets = Record<string, readonly Pick<InlineCommentDraft, 'id' | 'composing'>[]>;

export const takeArrivedComposingDraft = (drafts: DraftBuckets, seen: Set<string>): boolean => {
    let arrived = false;
    for (const bucket of Object.values(drafts)) {
        for (const draft of bucket) {
            if (!draft.composing || seen.has(draft.id)) continue;
            seen.add(draft.id);
            arrived = true;
        }
    }
    return arrived;
};

export const useChatViewReveal = (
    setCurrentView: React.Dispatch<React.SetStateAction<'sessions' | 'chat'>>,
    runOverviewKey: string | null,
): void => {
    React.useEffect(() => {
        if (runOverviewKey) setCurrentView((view) => (view === 'sessions' ? 'chat' : view));
    }, [runOverviewKey, setCurrentView]);
    React.useEffect(() => {
        const seen = new Set<string>();
        takeArrivedComposingDraft(useInlineCommentDraftStore.getState().drafts, seen);
        return useInlineCommentDraftStore.subscribe((state) => {
            const restoring = !useInlineCommentDraftStore.persist.hasHydrated();
            if (!takeArrivedComposingDraft(state.drafts, seen) || restoring) return;
            useUIStore.getState().setRunOverviewKey(null);
            setCurrentView('chat');
        });
    }, [setCurrentView]);
};
