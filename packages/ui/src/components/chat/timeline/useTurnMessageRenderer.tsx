import React from 'react';

import { earlierAssistantText } from '../lib/turns/earlierAssistantText';
import { isEmptyTextPart } from '../message/partUtils';
import type { ChatMessageEntry, TurnRecord, TurnGroupingContext } from '../lib/turns/types';
import type { ReviewTransferDirection } from '@/lib/reviewFlow';
import type { StreamPhase } from '../message/types';
import { MessageRow } from './MessageRow';

const isAssistantMessageCompleted = (message: ChatMessageEntry): boolean => {
    const info = message.info as { time?: { completed?: unknown }; status?: unknown };
    const completed = info.time?.completed;
    const status = info.status;
    if (typeof completed !== 'number' || completed <= 0) {
        return false;
    }
    if (typeof status === 'string') {
        return status === 'completed';
    }
    return true;
};

const turnContainsMessageId = (turn: TurnRecord, messageId: string | null | undefined): boolean => {
    if (!messageId) {
        return false;
    }

    if (turn.userMessage.info.id === messageId) {
        return true;
    }

    return turn.assistantMessages.some((assistant) => assistant.info.id === messageId);
};

export interface TurnRendererInput {
    turn: TurnRecord;
    isLastTurn: boolean;
    nextEntryFirstMessage?: ChatMessageEntry;
    sessionIsWorking: boolean;
    scrollToBottom?: () => void;
    shouldAnimateUserMessage: (message: ChatMessageEntry) => boolean;
    onUserAnimationConsumed: (messageId: string) => void;
    activeStreamingMessageId?: string | null;
    activeStreamingPhase?: StreamPhase | null;
    reviewTransferDirection?: ReviewTransferDirection | null;
}

export const useTurnMessageRenderer = ({
    turn,
    isLastTurn,
    nextEntryFirstMessage,
    sessionIsWorking,
    scrollToBottom,
    shouldAnimateUserMessage,
    onUserAnimationConsumed,
    activeStreamingMessageId,
    activeStreamingPhase,
    reviewTransferDirection,
}: TurnRendererInput) => {
    const streamingAssistantMessageId = React.useMemo(() => {
        if (activeStreamingMessageId && turn.assistantMessages.some((assistant) => assistant.info.id === activeStreamingMessageId)) {
            return activeStreamingMessageId;
        }

        for (let index = turn.assistantMessages.length - 1; index >= 0; index -= 1) {
            const assistant = turn.assistantMessages[index];
            if (!isAssistantMessageCompleted(assistant)) {
                return assistant.info.id;
            }
        }

        return null;
    }, [activeStreamingMessageId, turn.assistantMessages]);

    const turnEarlierAssistantText = React.useMemo(
        () => earlierAssistantText(turn.assistantMessages),
        [turn.assistantMessages]
    );

    const assistantIndexById = React.useMemo(() => {
        const ids = new Map<string, number>();
        turn.assistantMessages.forEach((assistant, index) => {
            ids.set(assistant.info.id, index);
        });
        return ids;
    }, [turn.assistantMessages]);

    const turnIsInActiveStream = React.useMemo(() => {
        return turnContainsMessageId(turn, streamingAssistantMessageId);
    }, [turn, streamingAssistantMessageId]);

    const activityOwnerMessageId = React.useMemo(() => {
        if (turnIsInActiveStream && streamingAssistantMessageId) {
            return streamingAssistantMessageId;
        }
        return turn.assistantMessages[0]?.info.id;
    }, [streamingAssistantMessageId, turnIsInActiveStream, turn.assistantMessages]);

    const answerTextOpenerId = React.useMemo(() => turn.assistantMessages.find((entry) => (
        entry.parts.some((part) => part.type === 'text' && !isEmptyTextPart(part))
    ))?.info.id, [turn.assistantMessages]);

    const turnGroupingContextBase = React.useMemo(() => {
        const userCreatedAt = (turn.userMessage.info.time as { created?: number } | undefined)?.created;
        let assistantVariant: string | undefined;
        for (const entry of turn.assistantMessages) {
            const variant = entry.info.role === 'assistant' ? entry.info.variant?.trim() : undefined;
            if (variant) {
                assistantVariant = variant;
                break;
            }
        }
        return {
            turnId: turn.turnId,
            summaryBody: turn.summaryText,
            activityParts: turn.activityParts,
            headerMessageId: turn.headerMessageId,
            hasTools: turn.hasTools,
            hasReasoning: turn.hasReasoning,
            changedFiles: turn.changedFiles,
            userMessageCreatedAt: typeof userCreatedAt === 'number' ? userCreatedAt : undefined,
            assistantVariant,
        };
    }, [turn.activityParts, turn.changedFiles, turn.hasReasoning, turn.hasTools, turn.headerMessageId, turn.summaryText, turn.turnId, turn.assistantMessages, turn.userMessage.info]);

    return React.useCallback(
        (message: ChatMessageEntry) => {
            const assistantIndex = assistantIndexById.get(message.info.id) ?? -1;
            const isAssistantMessage = assistantIndex >= 0;
            const isFirstAssistant = assistantIndex === 0;
            const isLastAssistant = assistantIndex === turn.assistantMessages.length - 1;
            const isActivityOwner = Boolean(activityOwnerMessageId) && message.info.id === activityOwnerMessageId;
            const shouldAttachFullTurnContext = isActivityOwner || isFirstAssistant || isLastAssistant;
            const assistantHeaderMessageId = turn.assistantMessages[0]?.info.id ?? turn.headerMessageId;

            const nextMessage = isAssistantMessage && isLastAssistant ? nextEntryFirstMessage : undefined;

            const turnGroupingContext = isAssistantMessage
                ? {
                    turnId: turn.turnId,
                    isFirstAssistantInTurn: isFirstAssistant,
                    isLastAssistantInTurn: isLastAssistant,
                    opensAnswerText: message.info.id === answerTextOpenerId,
                    earlierAssistantText: isLastAssistant && turnEarlierAssistantText.length > 0 ? turnEarlierAssistantText : undefined,
                    isLatestTurn: isLastTurn,
                    isWorking: isLastTurn && sessionIsWorking && message.info.id === streamingAssistantMessageId,
                    hasTools: turn.hasTools,
                    hasReasoning: turn.hasReasoning,
                    ...(shouldAttachFullTurnContext ? {
                        summaryBody: turnGroupingContextBase.summaryBody,
                        activityParts: turnGroupingContextBase.activityParts,
                        headerMessageId: turnGroupingContextBase.headerMessageId,
                        changedFiles: turnGroupingContextBase.changedFiles,
                        userMessageCreatedAt: turnGroupingContextBase.userMessageCreatedAt,
                        assistantVariant: turnGroupingContextBase.assistantVariant,
                    } : {}),
                } satisfies TurnGroupingContext
                : undefined;

            return (
                <MessageRow
                    key={message.info.id}
                    message={message}
                    nextMessage={nextMessage}
                    turnGroupingContext={turnGroupingContext}
                    assistantHeaderMessageId={assistantHeaderMessageId}
                    isInActiveTurn={Boolean(streamingAssistantMessageId) && message.info.id === streamingAssistantMessageId}
                    activeStreamingPhase={message.info.id === streamingAssistantMessageId ? activeStreamingPhase : null}
                    reviewTransferDirection={reviewTransferDirection}
                    animateUserOnMount={shouldAnimateUserMessage(message)}
                    onUserAnimationConsumed={onUserAnimationConsumed}
                    scrollToBottom={scrollToBottom}
                />
            );
        },
        [
            isLastTurn,
            nextEntryFirstMessage,
            scrollToBottom,
            sessionIsWorking,
            turn.assistantMessages,
            turn.headerMessageId,
            turn.hasReasoning,
            turn.hasTools,
            turn.turnId,
            turnGroupingContextBase,
            streamingAssistantMessageId,
            activeStreamingPhase,
            reviewTransferDirection,
            assistantIndexById,
            turnEarlierAssistantText,
            activityOwnerMessageId,
            shouldAnimateUserMessage,
            onUserAnimationConsumed,
        ]
    );
};
