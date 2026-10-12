import { createStore } from 'zustand/vanilla';

type SelectionState = {
    active: boolean;
    selected: ReadonlySet<string>;
    begin: (key: string) => void;
    toggle: (key: string) => void;
    cancel: () => void;
};

/** Local to one chat column and one runtime/directory/session selection. */
export const createConversationSelectionStore = () => createStore<SelectionState>((set) => ({
    active: false,
    selected: new Set(),
    begin: (key) => set({ active: true, selected: new Set([key]) }),
    toggle: (key) => set((state) => {
        if (!state.active) return state;
        const selected = new Set(state.selected);
        if (selected.has(key)) selected.delete(key);
        else selected.add(key);
        return { selected };
    }),
    cancel: () => set({ active: false, selected: new Set() }),
}));

export type ConversationSelectionStore = ReturnType<typeof createConversationSelectionStore>;

export const conversationSelectionKey = (role: 'user' | 'assistant', id: string): string => `${role}:${id}`;
