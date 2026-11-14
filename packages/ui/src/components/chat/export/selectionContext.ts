import React from 'react';
import { useStore } from 'zustand';
import { createConversationSelectionStore, type ConversationSelectionStore } from './selectionStore';

export const ConversationSelectionContext = React.createContext<ConversationSelectionStore | null>(null);
const unavailableSelection = createConversationSelectionStore();

export const useConversationSelectionStore = () => React.useContext(ConversationSelectionContext);

export const useConversationSelectionActive = () => {
    const store = useConversationSelectionStore();
    return useStore(store ?? unavailableSelection, (state) => state.active);
};

export const useConversationItemSelected = (key: string) => {
    const store = useConversationSelectionStore();
    return useStore(store ?? unavailableSelection, (state) => state.selected.has(key));
};
