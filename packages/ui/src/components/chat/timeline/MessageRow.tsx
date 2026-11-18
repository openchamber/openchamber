import React from 'react';

import ChatMessage from '../ChatMessage';
import { TimelineNotice } from '../message/TimelineNotice';
import { readSessionNotice } from '@/lib/opencode/session-notices';
import { isSkippedTimelineMessage, isBackgroundReportEntry, isTimelineNoticeRole } from '../lib/timelineRoles';
import { areOptionalRenderRelevantMessagesEqual, areRelevantTurnGroupingContextsEqual, areRenderRelevantMessagesEqual } from '../message/renderCompare';
import type { ChatMessageEntry, TurnGroupingContext } from '../lib/turns/types';
import type { ReviewTransferDirection } from '@/lib/reviewFlow';
import type { StreamPhase } from '../message/types';
import { resolveMessageRole } from './messageRole';

interface MessageRowProps {
    message: ChatMessageEntry;
    nextMessage?: ChatMessageEntry;
    turnGroupingContext?: TurnGroupingContext;
    assistantHeaderMessageId?: string;
    isInActiveTurn?: boolean;
    activeStreamingPhase?: StreamPhase | null;
    animateUserOnMount?: boolean;
    onUserAnimationConsumed?: (messageId: string) => void;
    scrollToBottom?: () => void;
    reviewTransferDirection?: ReviewTransferDirection | null;
    isFirstRow?: boolean;
}

export const MessageRow = React.memo<MessageRowProps>(({ 
    message,
    nextMessage,
    turnGroupingContext,
    assistantHeaderMessageId,
    isInActiveTurn,
    activeStreamingPhase,
    animateUserOnMount,
    onUserAnimationConsumed,
    scrollToBottom,
    reviewTransferDirection,
    isFirstRow,
}) => {
    const role = message.info.role;
    if (readSessionNotice(message.info)) return <TimelineNotice message={message.info} />;
    if (isSkippedTimelineMessage(message.info)) return null;
    if (isTimelineNoticeRole(role) || isBackgroundReportEntry(message.info)) {
        return <TimelineNotice message={message.info} isFirstRow={isFirstRow} />;
    }

    return (
        <ChatMessage
            message={message}
            nextMessage={nextMessage}
            animateUserOnMount={animateUserOnMount}
            onUserAnimationConsumed={onUserAnimationConsumed}
            scrollToBottom={scrollToBottom}
            turnGroupingContext={turnGroupingContext}
            assistantHeaderMessageId={assistantHeaderMessageId}
            isInActiveTurn={isInActiveTurn}
            activeStreamingPhase={activeStreamingPhase}
            reviewTransferDirection={reviewTransferDirection}
        />
    );
}, (prev, next) => {
    const prevTurn = prev.turnGroupingContext;
    const nextTurn = next.turnGroupingContext;

    return areRenderRelevantMessagesEqual(prev.message, next.message)
        && areOptionalRenderRelevantMessagesEqual(prev.nextMessage, next.nextMessage)
        && prev.animateUserOnMount === next.animateUserOnMount
        && prev.onUserAnimationConsumed === next.onUserAnimationConsumed
        && prev.scrollToBottom === next.scrollToBottom
        && areRelevantTurnGroupingContextsEqual(prevTurn, nextTurn, prev.message.info.id, resolveMessageRole(prev.message) === 'user')
        && prev.assistantHeaderMessageId === next.assistantHeaderMessageId
        && prev.isInActiveTurn === next.isInActiveTurn
        && prev.activeStreamingPhase === next.activeStreamingPhase
        && prev.reviewTransferDirection === next.reviewTransferDirection
        && prev.isFirstRow === next.isFirstRow;
});

MessageRow.displayName = 'MessageRow';
