import React from 'react';

import type { ChatMessageEntry } from '../lib/turns/types';
import type { ReviewTransferDirection } from '@/lib/reviewFlow';
import type { StreamPhase } from '../message/types';
import { MessageRow } from './MessageRow';

interface UngroupedMessageRowProps {
    message: ChatMessageEntry;
    nextMessage?: ChatMessageEntry;
    isFirstRow?: boolean;
    scrollToBottom?: () => void;
    shouldAnimateUserMessage: (message: ChatMessageEntry) => boolean;
    onUserAnimationConsumed: (messageId: string) => void;
    activeStreamingMessageId?: string | null;
    activeStreamingPhase?: StreamPhase | null;
    reviewTransferDirection?: ReviewTransferDirection | null;
}

export const UngroupedMessageRow = React.memo(({
    message,
    nextMessage,
    isFirstRow,
    scrollToBottom,
    shouldAnimateUserMessage,
    onUserAnimationConsumed,
    activeStreamingMessageId,
    activeStreamingPhase,
    reviewTransferDirection,
}: UngroupedMessageRowProps) => {
    return (
        <MessageRow
            message={message}
            nextMessage={nextMessage}
            animateUserOnMount={shouldAnimateUserMessage(message)}
            onUserAnimationConsumed={onUserAnimationConsumed}
            scrollToBottom={scrollToBottom}
            isInActiveTurn={Boolean(activeStreamingMessageId) && message.info.id === activeStreamingMessageId}
            activeStreamingPhase={message.info.id === activeStreamingMessageId ? activeStreamingPhase : null}
            reviewTransferDirection={reviewTransferDirection}
            isFirstRow={isFirstRow}
        />
    );
});

UngroupedMessageRow.displayName = 'UngroupedMessageRow';
