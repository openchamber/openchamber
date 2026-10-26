import { create } from 'zustand';

import type { ComposerReference } from './composerReferences';

type PendingComposerReferences = {
    references: ComposerReference[];
    push: (references: readonly ComposerReference[]) => void;
    consume: () => ComposerReference[];
};

/**
 * Issues and PRs a flow outside the composer hands to the next draft: the New
 * Worktree dialog attaches the item it was created for this way. `ChatInput`
 * consumes them into its chips, like a guest panel's `pendingGuestIssue`.
 */
export const usePendingComposerReferences = create<PendingComposerReferences>()((set, get) => ({
    references: [],
    push: (references) => set((state) => ({ references: [...state.references, ...references] })),
    consume: () => {
        const { references } = get();
        if (references.length > 0) set({ references: [] });
        return references;
    },
}));
