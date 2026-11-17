
import React from 'react';

import type { ChatQuoteAnchor } from '@/lib/chatQuoteAnchor';

export type ChatQuoteMark = {
    id: string;
    messageId: string;
    anchor: ChatQuoteAnchor;
    comment: string;
    updateComment: (text: string) => boolean;
    remove: () => void;
};

export interface ChatQuoteHighlightApi {
    publishMarks: (publisher: string, marks: ChatQuoteMark[]) => void;
    focusMark: (markId: string | null) => void;
    reveal: (messageId: string, anchor: ChatQuoteAnchor) => void;
}

type Listener = () => void;

export interface ChatQuoteHighlightStore extends ChatQuoteHighlightApi {
    subscribe: (listener: Listener) => () => void;
    getMarks: () => ChatQuoteMark[];
    getChipFocus: () => string | null;
    setRevealHandler: (handler: ChatQuoteHighlightApi['reveal'] | null) => void;
}

function createChatQuoteHighlightStore(): ChatQuoteHighlightStore {
    const marksByPublisher = new Map<string, ChatQuoteMark[]>();
    let marks: ChatQuoteMark[] = [];
    let chipFocus: string | null = null;
    let revealHandler: ChatQuoteHighlightApi['reveal'] | null = null;
    const listeners = new Set<Listener>();
    const emit = () => {
        for (const listener of listeners) listener();
    };

    return {
        publishMarks(publisher, next) {
            if (next.length === 0) {
                if (!marksByPublisher.delete(publisher)) return;
            } else {
                marksByPublisher.set(publisher, next);
            }
            marks = [...marksByPublisher.values()].flat();
            emit();
        },
        focusMark(markId) {
            if (chipFocus === markId) return;
            chipFocus = markId;
            emit();
        },
        reveal(messageId, anchor) {
            revealHandler?.(messageId, anchor);
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        getMarks: () => marks,
        getChipFocus: () => chipFocus,
        setRevealHandler(handler) {
            revealHandler = handler;
        },
    };
}

export function useChatQuoteHighlightStore(): ChatQuoteHighlightStore {
    const [store] = React.useState(createChatQuoteHighlightStore);
    return store;
}

export const ChatQuoteHighlightContext = React.createContext<ChatQuoteHighlightApi | null>(null);

export const useChatQuoteHighlightApi = (): ChatQuoteHighlightApi | null => React.useContext(ChatQuoteHighlightContext);
