import React from 'react';

import { messageSelectionKey, useMessageSelectionStore } from '@/stores/useMessageSelectionStore';
import { useChatSessionSelection } from '../chatColumnSession';
import { useChatSurfaceMode } from '../useChatSurfaceMode';

type MessageSelectionEntryInput = {
    sessionId: string;
    messageId: string;
    isUser: boolean;
    turnId: string | undefined;
    hasTextContent: boolean;
};

export const useMessageSelectionEntry = ({ sessionId, messageId, isUser, turnId, hasTextContent }: MessageSelectionEntryInput) => {
    const columnSessionId = useChatSessionSelection().sessionId;
    const surfaceMode = useChatSurfaceMode();
    const key = isUser ? messageSelectionKey('prompt', messageId) : (turnId ? messageSelectionKey('answer', turnId) : null);
    const enabled = Boolean(key) && hasTextContent && columnSessionId === sessionId && surfaceMode !== 'peek' && surfaceMode !== 'mini-chat';
    const begin = React.useCallback(() => {
        if (key) useMessageSelectionStore.getState().begin(sessionId, key);
    }, [key, sessionId]);
    return {
        onSelectMessages: enabled ? begin : undefined,
        promptUnitKey: enabled && isUser ? key : null,
    };
};
