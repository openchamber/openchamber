import React from 'react';
import type { Part } from '@opencode-ai/sdk/v2';
import { measureElement as measureVirtualElement, type VirtualItem, useVirtualizer } from '@tanstack/react-virtual';

import ChatMessage from './ChatMessage';
import { areOptionalRenderRelevantMessagesEqual, areRelevantTurnGroupingContextsEqual, areRenderRelevantMessagesEqual } from './message/renderCompare';
import TurnItem from './components/TurnItem';
import type { AnimationHandlers, ContentChangeReason } from '@/hooks/useChatScrollManager';
import { filterSyntheticParts } from '@/lib/messages/synthetic';
import type { ChatMessageEntry, TurnRecord, TurnGroupingContext } from './lib/turns/types';
import { useTurnRecords } from './hooks/useTurnRecords';
import { applyRetryOverlay } from './lib/turns/applyRetryOverlay';
import { useUIStore } from '@/stores/useUIStore';
import { FadeInDisabledProvider } from './message/FadeInOnReveal';
import { hasPendingUserSendAnimation, consumePendingUserSendAnimation } from '@/lib/userSendAnimation';
import { streamPerfCount, streamPerfMeasure } from '@/stores/utils/streamDebug';
import type { StreamPhase } from './message/types';

const MESSAGE_LIST_VIRTUALIZE_THRESHOLD = Number.POSITIVE_INFINITY;
const MESSAGE_LIST_OVERSCAN = 6;

const estimateHistoryEntryHeight = (entry: RenderEntry | undefined): number => {
    if (!entry) {
        return 160;
    }

    if (entry.kind === 'turn') {
        return 180 + Math.min(entry.turn.assistantMessages.length, 4) * 100;
    }

    return 140;
};

const useStableEvent = <TArgs extends unknown[], TResult>(handler: (...args: TArgs) => TResult) => {
    const handlerRef = React.useRef(handler);
    React.useEffect(() => {
        handlerRef.current = handler;
    }, [handler]);

    return React.useCallback((...args: TArgs) => handlerRef.current(...args), []);
};

const USER_SHELL_MARKER = 'The following tool was executed by the user';

const resolveMessageRole = (message: ChatMessageEntry): string | null => {
    const info = message.info as unknown as { clientRole?: string | null | undefined; role?: string | null | undefined };
    return (typeof info.clientRole === 'string' ? info.clientRole : null)
        ?? (typeof info.role === 'string' ? info.role : null)
        ?? null;
};

const hasCompactionPart = (message: ChatMessageEntry): boolean => {
    return message.parts.some((part) => {
        const type = (part as { type?: unknown }).type;
        return type === 'compaction';
    });
};

const getPartText = (part: Part): string => {
    const text = (part as { text?: unknown }).text;
    if (typeof text === 'string') {
        return text;
    }
    const content = (part as { content?: unknown }).content;
    if (typeof content === 'string') {
        return content;
    }
    return '';
};

const normalizeCompactionCommandMessage = (message: ChatMessageEntry): ChatMessageEntry => {
    if (!hasCompactionPart(message)) {
        return message;
    }

    let changedParts = false;
    const nextParts = message.parts.map((part) => {
        const type = (part as { type?: unknown }).type;
        if (type !== 'compaction') {
            return part;
        }
        changedParts = true;
        return { type: 'text', text: '/compact' } as Part;
    });

    const info = message.info as unknown as { clientRole?: string | null | undefined };
    const needsClientRole = info.clientRole !== 'user';

    if (!changedParts && !needsClientRole) {
        return message;
    }

    return {
        ...message,
        info: needsClientRole
            ? ({
                ...(message.info as unknown as Record<string, unknown>),
                clientRole: 'user',
            } as unknown as typeof message.info)
            : message.info,
        parts: changedParts ? nextParts : message.parts,
    };
};

const normalizeCompactionSummaryMessage = (
    message: ChatMessageEntry,
    compactionCommandIds: Set<string>,
): ChatMessageEntry => {
    const role = resolveMessageRole(message);
    if (role !== 'system') {
        return message;
    }

    const parentID = getMessageParentId(message);
    if (!parentID || !compactionCommandIds.has(parentID)) {
        return message;
    }

    const info = message.info as unknown as { clientRole?: string | null | undefined };
    if (info.clientRole === 'assistant') {
        return message;
    }

    return {
        ...message,
        info: ({
            ...(message.info as unknown as Record<string, unknown>),
            clientRole: 'assistant',
        } as unknown as typeof message.info),
    };
};

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

const isUserSubtaskMessage = (message: ChatMessageEntry | undefined): boolean => {
    if (!message) return false;
    if (resolveMessageRole(message) !== 'user') return false;
    return message.parts.some((part) => part?.type === 'subtask');
};

const getMessageId = (message: ChatMessageEntry | undefined): string | null => {
    if (!message) return null;
    const id = (message.info as unknown as { id?: unknown }).id;
    return typeof id === 'string' && id.trim().length > 0 ? id : null;
};

const getMessageParentId = (message: ChatMessageEntry): string | null => {
    const parentID = (message.info as unknown as { parentID?: unknown }).parentID;
    return typeof parentID === 'string' && parentID.trim().length > 0 ? parentID : null;
};

const isUserShellMarkerMessage = (message: ChatMessageEntry | undefined): boolean => {
    if (!message) return false;
    if (resolveMessageRole(message) !== 'user') return false;

    return message.parts.some((part) => {
        if (part?.type !== 'text') return false;
        const text = (part as unknown as { text?: unknown }).text;
        const synthetic = (part as unknown as { synthetic?: unknown }).synthetic;
        return synthetic === true && typeof text === 'string' && text.trim().startsWith(USER_SHELL_MARKER);
    });
};

type ShellBridgeDetails = {
    command?: string;
    output?: string;
    status?: string;
};

const getShellBridgeAssistantDetails = (message: ChatMessageEntry, expectedParentId: string | null): { hide: boolean; details: ShellBridgeDetails | null } => {
    if (resolveMessageRole(message) !== 'assistant') {
        return { hide: false, details: null };
    }

    if (expectedParentId && getMessageParentId(message) !== expectedParentId) {
        return { hide: false, details: null };
    }

    if (message.parts.length !== 1) {
        return { hide: false, details: null };
    }

    const part = message.parts[0] as unknown as {
        type?: unknown;
        tool?: unknown;
        state?: {
            status?: unknown;
            input?: { command?: unknown };
            output?: unknown;
            metadata?: { output?: unknown };
        };
    };

    if (part.type !== 'tool') {
        return { hide: false, details: null };
    }

    const toolName = typeof part.tool === 'string' ? part.tool.toLowerCase() : '';
    if (toolName !== 'bash') {
        return { hide: false, details: null };
    }

    const command = typeof part.state?.input?.command === 'string' ? part.state.input.command : undefined;
    const output =
        (typeof part.state?.output === 'string' ? part.state.output : undefined)
        ?? (typeof part.state?.metadata?.output === 'string' ? part.state.metadata.output : undefined);
    const status = typeof part.state?.status === 'string' ? part.state.status : undefined;

    return {
        hide: true,
        details: {
            command,
            output,
            status,
        },
    };
};

const readTaskSessionId = (toolPart: Part): string | null => {
    const partRecord = toolPart as unknown as {
        state?: {
            metadata?: {
                sessionId?: unknown;
                sessionID?: unknown;
            };
            output?: unknown;
        };
    };
    const metadata = partRecord.state?.metadata;
    const fromMetadata =
        (typeof metadata?.sessionID === 'string' && metadata.sessionID.trim().length > 0
            ? metadata.sessionID.trim()
            : null)
        ?? (typeof metadata?.sessionId === 'string' && metadata.sessionId.trim().length > 0
            ? metadata.sessionId.trim()
            : null);
    if (fromMetadata) return fromMetadata;

    const output = partRecord.state?.output;
    if (typeof output === 'string') {
        const match = output.match(/task_id\s*:\s*([^\s<"']+)/i);
        if (match?.[1]) {
            return match[1];
        }
    }

    return null;
};

const isSyntheticSubtaskBridgeAssistant = (message: ChatMessageEntry): { hide: boolean; taskSessionId: string | null } => {
    if (resolveMessageRole(message) !== 'assistant') {
        return { hide: false, taskSessionId: null };
    }

    if (message.parts.length !== 1) {
        return { hide: false, taskSessionId: null };
    }

    const onlyPart = message.parts[0] as unknown as {
        type?: unknown;
        tool?: unknown;
    };

    if (onlyPart.type !== 'tool') {
        return { hide: false, taskSessionId: null };
    }

    const toolName = typeof onlyPart.tool === 'string' ? onlyPart.tool.toLowerCase() : '';
    if (toolName !== 'task') {
        return { hide: false, taskSessionId: null };
    }

    return {
        hide: true,
        taskSessionId: readTaskSessionId(message.parts[0]),
    };
};

const withSubtaskSessionId = (message: ChatMessageEntry, taskSessionId: string | null): ChatMessageEntry => {
    if (!taskSessionId) return message;
    const nextParts = message.parts.map((part) => {
        if (part?.type !== 'subtask') return part;
        const existing = (part as unknown as { taskSessionID?: unknown }).taskSessionID;
        if (typeof existing === 'string' && existing.trim().length > 0) return part;
        return {
            ...part,
            taskSessionID: taskSessionId,
        } as Part;
    });

    return {
        ...message,
        parts: nextParts,
    };
};

const withShellBridgeDetails = (message: ChatMessageEntry, details: ShellBridgeDetails | null): ChatMessageEntry => {
    const command = typeof details?.command === 'string' ? details.command.trim() : '';
    const output = typeof details?.output === 'string' ? details.output : '';
    const status = typeof details?.status === 'string' ? details.status.trim() : '';

    const nextParts: Part[] = [];
    let injected = false;

    for (const part of message.parts) {
        if (!injected && part?.type === 'text') {
            const text = (part as unknown as { text?: unknown }).text;
            const synthetic = (part as unknown as { synthetic?: unknown }).synthetic;
            if (synthetic === true && typeof text === 'string' && text.trim().startsWith(USER_SHELL_MARKER)) {
                nextParts.push({
                    type: 'text',
                    text: '/shell',
                    shellAction: {
                        ...(command ? { command } : {}),
                        ...(output ? { output } : {}),
                        ...(status ? { status } : {}),
                    },
                } as unknown as Part);
                injected = true;
                continue;
            }
        }
        nextParts.push(part);
    }

    if (!injected) {
        nextParts.push({
            type: 'text',
            text: '/shell',
            shellAction: {
                ...(command ? { command } : {}),
                ...(output ? { output } : {}),
                ...(status ? { status } : {}),
            },
        } as unknown as Part);
    }

    return {
        ...message,
        parts: nextParts,
    };
};

const normalizedMessageBySource = new WeakMap<ChatMessageEntry, ChatMessageEntry>();

const getNormalizedMessageForDisplay = (message: ChatMessageEntry): ChatMessageEntry => {
    const cached = normalizedMessageBySource.get(message);
    if (cached) {
        return cached;
    }

    const normalizedCompactionMessage = normalizeCompactionCommandMessage(message);
    const filteredParts = filterSyntheticParts(normalizedCompactionMessage.parts);
    const normalized = filteredParts === normalizedCompactionMessage.parts
        ? normalizedCompactionMessage
        : {
            ...normalizedCompactionMessage,
            parts: filteredParts,
        };

    normalizedMessageBySource.set(message, normalized);
    return normalized;
};

interface MessageListProps {
    sessionKey: string;
    turnStart: number;
    disableStaging?: boolean;
    messages: ChatMessageEntry[];
    sessionIsWorking?: boolean;
    activeStreamingMessageId?: string | null;
    activeStreamingPhase?: StreamPhase | null;
    retryOverlay?: {
        sessionId: string;
        message: string;
        confirmedAt?: number;
        fallbackTimestamp?: number;
    } | null;
    onMessageContentChange: (reason?: ContentChangeReason) => void;
    getAnimationHandlers: (messageId: string) => AnimationHandlers;
    hasMoreAbove: boolean;
    isLoadingOlder: boolean;
    onLoadOlder: () => void;
    scrollToBottom?: (options?: { instant?: boolean; force?: boolean }) => void;
    scrollRef?: React.RefObject<HTMLDivElement | null>;
}

export interface MessageListHandle {
    scrollToTurnId: (turnId: string, options?: { behavior?: ScrollBehavior }) => boolean;
    scrollToMessageId: (messageId: string, options?: { behavior?: ScrollBehavior }) => boolean;
    captureViewportAnchor: () => { messageId: string; offsetTop: number } | null;
    restoreViewportAnchor: (anchor: { messageId: string; offsetTop: number }) => boolean;
}

type RenderEntry =
    | {
        kind: 'ungrouped';
        key: string;
        message: ChatMessageEntry;
        previousMessage?: ChatMessageEntry;
        nextMessage?: ChatMessageEntry;
    }
    | { kind: 'turn'; key: string; turn: TurnRecord; isLastTurn: boolean };

type TurnUiState = { isExpanded: boolean };



interface MessageRowProps {
    message: ChatMessageEntry;
    previousMessage?: ChatMessageEntry;
    nextMessage?: ChatMessageEntry;
    turnGroupingContext?: TurnGroupingContext;
    assistantHeaderMessageId?: string;
    isInActiveTurn?: boolean;
    activeStreamingPhase?: StreamPhase | null;
    animateUserOnMount?: boolean;
    onUserAnimationConsumed?: (messageId: string) => void;
    onContentChange: (reason?: ContentChangeReason) => void;
    animationHandlers: AnimationHandlers;
    scrollToBottom?: (options?: { instant?: boolean; force?: boolean }) => void;
}

const MessageRow = React.memo<MessageRowProps>(({ 
    message,
    previousMessage,
    nextMessage,
    turnGroupingContext,
    assistantHeaderMessageId,
    isInActiveTurn,
    activeStreamingPhase,
    animateUserOnMount,
    onUserAnimationConsumed,
    onContentChange,
    animationHandlers,
    scrollToBottom,
}) => {
    return (
        <ChatMessage
            message={message}
            previousMessage={previousMessage}
            nextMessage={nextMessage}
            animateUserOnMount={animateUserOnMount}
            onUserAnimationConsumed={onUserAnimationConsumed}
            onContentChange={onContentChange}
            animationHandlers={animationHandlers}
            scrollToBottom={scrollToBottom}
            turnGroupingContext={turnGroupingContext}
            assistantHeaderMessageId={assistantHeaderMessageId}
            isInActiveTurn={isInActiveTurn}
            activeStreamingPhase={activeStreamingPhase}
        />
    );
}, (prev, next) => {
    const prevTurn = prev.turnGroupingContext;
    const nextTurn = next.turnGroupingContext;

    return areRenderRelevantMessagesEqual(prev.message, next.message)
        && areOptionalRenderRelevantMessagesEqual(prev.previousMessage, next.previousMessage)
        && areOptionalRenderRelevantMessagesEqual(prev.nextMessage, next.nextMessage)
        && prev.animateUserOnMount === next.animateUserOnMount
        && prev.onUserAnimationConsumed === next.onUserAnimationConsumed
        && prev.onContentChange === next.onContentChange
        && prev.scrollToBottom === next.scrollToBottom
        && areRelevantTurnGroupingContextsEqual(prevTurn, nextTurn, prev.message.info.id, resolveMessageRole(prev.message) === 'user')
        && prev.assistantHeaderMessageId === next.assistantHeaderMessageId
        && prev.isInActiveTurn === next.isInActiveTurn
        && prev.activeStreamingPhase === next.activeStreamingPhase
        && prev.animationHandlers?.onChunk === next.animationHandlers?.onChunk
        && prev.animationHandlers?.onComplete === next.animationHandlers?.onComplete
        && prev.animationHandlers?.onStreamingCandidate === next.animationHandlers?.onStreamingCandidate
        && prev.animationHandlers?.onAnimationStart === next.animationHandlers?.onAnimationStart
        && prev.animationHandlers?.onReservationCancelled === next.animationHandlers?.onReservationCancelled
        && prev.animationHandlers?.onReasoningBlock === next.animationHandlers?.onReasoningBlock
        && prev.animationHandlers?.onAnimatedHeightChange === next.animationHandlers?.onAnimatedHeightChange;
});

MessageRow.displayName = 'MessageRow';

interface TurnBlockProps {
    turn: TurnRecord;
    isLastTurn: boolean;
    sessionIsWorking: boolean;
    defaultActivityExpanded: boolean;
    turnUiStates: Map<string, TurnUiState>;
    onToggleTurnGroup: (turnId: string) => void;
    chatRenderMode: 'sorted' | 'live';
    onMessageContentChange: (reason?: ContentChangeReason) => void;
    getAnimationHandlers: (messageId: string) => AnimationHandlers;
    scrollToBottom?: (options?: { instant?: boolean; force?: boolean }) => void;
    stickyUserHeader?: boolean;
    shouldAnimateUserMessage: (message: ChatMessageEntry) => boolean;
    onUserAnimationConsumed: (messageId: string) => void;
    activeStreamingMessageId?: string | null;
    activeStreamingPhase?: StreamPhase | null;
}

const TurnBlock = React.memo(({
    turn,
    isLastTurn,
    sessionIsWorking,
    defaultActivityExpanded,
    turnUiStates,
    onToggleTurnGroup,
    chatRenderMode,
    onMessageContentChange,
    getAnimationHandlers,
    scrollToBottom,
    stickyUserHeader = true,
    shouldAnimateUserMessage,
    onUserAnimationConsumed,
    activeStreamingMessageId,
    activeStreamingPhase,
}: TurnBlockProps) => {
    const turnUiState = turnUiStates.get(turn.turnId) ?? { isExpanded: defaultActivityExpanded };
    const handleToggleTurnGroup = React.useCallback(() => {
        onToggleTurnGroup(turn.turnId);
    }, [onToggleTurnGroup, turn.turnId]);

    const messageOrder = React.useMemo(() => {
        const ordered = [turn.userMessage, ...turn.assistantMessages];
        const lookup = new Map<string, number>();
        ordered.forEach((message, index) => {
            lookup.set(message.info.id, index);
        });
        return { ordered, lookup };
    }, [turn.assistantMessages, turn.userMessage]);

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

    const visibleAssistantMessages = React.useMemo(() => {
        if (chatRenderMode === 'live') {
            return turn.assistantMessages;
        }

        const completed = turn.assistantMessages.filter(isAssistantMessageCompleted);
        if (completed.length === turn.assistantMessages.length) {
            return turn.assistantMessages;
        }

        if (streamingAssistantMessageId) {
            const completedIds = new Set(completed.map((assistant) => assistant.info.id));
            return turn.assistantMessages.filter((assistant) => (
                completedIds.has(assistant.info.id)
                || assistant.info.id === streamingAssistantMessageId
            ));
        }

        if (completed.length > 0) {
            return completed;
        }
        const firstAssistant = turn.assistantMessages[0];
        return firstAssistant ? [firstAssistant] : [];
    }, [chatRenderMode, streamingAssistantMessageId, turn.assistantMessages]);

    const completedAssistantMessages = React.useMemo(() => {
        if (chatRenderMode !== 'sorted') {
            return turn.assistantMessages;
        }
        return turn.assistantMessages.filter(isAssistantMessageCompleted);
    }, [chatRenderMode, turn.assistantMessages]);

    const visibleAssistantIds = React.useMemo(() => {
        const ids = new Map<string, number>();
        visibleAssistantMessages.forEach((assistant, index) => {
            ids.set(assistant.info.id, index);
        });
        return ids;
    }, [visibleAssistantMessages]);

    const completedAssistantIdSet = React.useMemo(() => {
        return new Set(completedAssistantMessages.map((assistant) => assistant.info.id));
    }, [completedAssistantMessages]);

    const visibleActivityMessageIdSet = React.useMemo(() => {
        const ids = new Set(completedAssistantIdSet);
        if (streamingAssistantMessageId) {
            ids.add(streamingAssistantMessageId);
        }
        return ids;
    }, [completedAssistantIdSet, streamingAssistantMessageId]);

    const turnIsInActiveStream = React.useMemo(() => {
        return turnContainsMessageId(turn, streamingAssistantMessageId);
    }, [turn, streamingAssistantMessageId]);

    const activityOwnerMessageId = React.useMemo(() => {
        if (turnIsInActiveStream && streamingAssistantMessageId) {
            return streamingAssistantMessageId;
        }
        return visibleAssistantMessages[0]?.info.id;
    }, [streamingAssistantMessageId, turnIsInActiveStream, visibleAssistantMessages]);

    const visibleActivityParts = React.useMemo(() => {
        if (chatRenderMode !== 'sorted') {
            return turn.activityParts;
        }
        if (visibleActivityMessageIdSet.size === turn.assistantMessages.length) {
            return turn.activityParts;
        }
        return turn.activityParts.filter((activity) => visibleActivityMessageIdSet.has(activity.messageId));
    }, [chatRenderMode, visibleActivityMessageIdSet, turn.activityParts, turn.assistantMessages.length]);

    const visibleActivitySegments = React.useMemo(() => {
        if (chatRenderMode !== 'sorted') {
            return turn.activitySegments;
        }
        if (visibleActivityMessageIdSet.size === turn.assistantMessages.length) {
            return turn.activitySegments;
        }
        return turn.activitySegments
            .map((segment) => {
                const parts = segment.parts.filter((activity) => visibleActivityMessageIdSet.has(activity.messageId));
                if (parts.length === 0) {
                    return null;
                }
                const anchorMessageId = visibleActivityMessageIdSet.has(segment.anchorMessageId)
                    ? segment.anchorMessageId
                    : parts[0]?.messageId;
                if (!anchorMessageId) {
                    return null;
                }
                return {
                    ...segment,
                    anchorMessageId,
                    parts,
                };
            })
            .filter((segment): segment is NonNullable<typeof segment> => segment !== null);
    }, [chatRenderMode, visibleActivityMessageIdSet, turn.activitySegments, turn.assistantMessages.length]);

    const turnGroupingContextBase = React.useMemo(() => {
        const userCreatedAt = (turn.userMessage.info.time as { created?: number } | undefined)?.created;
        // OpenCode 1.4.0 moved variant from top-level to model.variant on UserMessage.
        // Prefer the new location, fall back to the legacy one for older servers.
        const info = turn.userMessage.info as { variant?: unknown; model?: { variant?: unknown } } | undefined;
        const rawVariant = info?.model?.variant ?? info?.variant;
        const userMessageVariant = typeof rawVariant === 'string' && rawVariant.trim().length > 0
            ? rawVariant
            : undefined;
        return {
            turnId: turn.turnId,
            summaryBody: turn.summaryText,
            activityParts: visibleActivityParts,
            activityGroupSegments: visibleActivitySegments,
            headerMessageId: turn.headerMessageId,
            hasTools: turn.hasTools,
            hasReasoning: turn.hasReasoning,
            diffStats: turn.diffStats,
            userMessageCreatedAt: typeof userCreatedAt === 'number' ? userCreatedAt : undefined,
            userMessageVariant,
        };
    }, [turn.diffStats, turn.hasReasoning, turn.hasTools, turn.headerMessageId, turn.summaryText, turn.turnId, turn.userMessage.info, visibleActivityParts, visibleActivitySegments]);

    const renderMessage = React.useCallback(
        (message: ChatMessageEntry) => {
            const messageRole = resolveMessageRole(message);
            const isUserMessage = messageRole === 'user';
            const messageIndex = messageOrder.lookup.get(message.info.id);
            const assistantIndex = visibleAssistantIds.get(message.info.id) ?? -1;
            const isAssistantMessage = assistantIndex >= 0;
            const isFirstAssistant = assistantIndex === 0;
            const isLastAssistant = assistantIndex === visibleAssistantMessages.length - 1;
            const isActivityOwner = Boolean(activityOwnerMessageId) && message.info.id === activityOwnerMessageId;
            const shouldAttachFullTurnContext = chatRenderMode === 'sorted'
                ? isAssistantMessage
                : (isActivityOwner || isFirstAssistant || isLastAssistant);
            const assistantHeaderMessageId = visibleAssistantMessages[0]?.info.id ?? turn.headerMessageId;

            const previousMessage = isUserMessage
                ? undefined
                : (isAssistantMessage
                    ? (isFirstAssistant
                        ? turn.userMessage
                        : undefined)
                    : (typeof messageIndex === 'number' && messageIndex > 0
                        ? messageOrder.ordered[messageIndex - 1]
                        : undefined));
            const nextMessage = undefined;

            const turnGroupingContext = isAssistantMessage
                ? {
                    turnId: turn.turnId,
                    activityOwnerMessageId,
                    isFirstAssistantInTurn: isFirstAssistant,
                    isLastAssistantInTurn: isLastAssistant,
                    isWorking: isLastTurn && sessionIsWorking && message.info.id === streamingAssistantMessageId,
                    hasTools: turn.hasTools,
                    hasReasoning: turn.hasReasoning,
                    ...(shouldAttachFullTurnContext ? {
                        summaryBody: turnGroupingContextBase.summaryBody,
                        activityParts: turnGroupingContextBase.activityParts,
                        activityGroupSegments: turnGroupingContextBase.activityGroupSegments,
                        headerMessageId: turnGroupingContextBase.headerMessageId,
                        diffStats: turnGroupingContextBase.diffStats,
                        userMessageCreatedAt: turnGroupingContextBase.userMessageCreatedAt,
                        userMessageVariant: turnGroupingContextBase.userMessageVariant,
                        isGroupExpanded: turnUiState.isExpanded,
                        toggleGroup: handleToggleTurnGroup,
                    } : {}),
                } satisfies TurnGroupingContext
                : undefined;

            return (
                <MessageRow
                    key={message.info.id}
                    message={message}
                    previousMessage={previousMessage}
                    nextMessage={nextMessage}
                    turnGroupingContext={turnGroupingContext}
                    assistantHeaderMessageId={assistantHeaderMessageId}
                    isInActiveTurn={Boolean(streamingAssistantMessageId) && message.info.id === streamingAssistantMessageId}
                    activeStreamingPhase={message.info.id === streamingAssistantMessageId ? activeStreamingPhase : null}
                    animateUserOnMount={shouldAnimateUserMessage(message)}
                    onUserAnimationConsumed={onUserAnimationConsumed}
                    onContentChange={onMessageContentChange}
                    animationHandlers={getAnimationHandlers(message.info.id)}
                    scrollToBottom={scrollToBottom}
                />
            );
        },
        [
            getAnimationHandlers,
            isLastTurn,
            messageOrder.lookup,
            messageOrder.ordered,
            onMessageContentChange,
            scrollToBottom,
            sessionIsWorking,
            chatRenderMode,
            turn.headerMessageId,
            turn.hasReasoning,
            turn.hasTools,
            turn.turnId,
            turn.userMessage,
            turnUiState.isExpanded,
            turnGroupingContextBase,
            streamingAssistantMessageId,
            activeStreamingPhase,
            visibleAssistantMessages,
            visibleAssistantIds,
            activityOwnerMessageId,
            shouldAnimateUserMessage,
            onUserAnimationConsumed,
            handleToggleTurnGroup,
        ]
    );

    const renderableTurn = React.useMemo(() => {
        if (visibleAssistantMessages === turn.assistantMessages) {
            return turn;
        }
        return {
            ...turn,
            assistantMessages: visibleAssistantMessages,
        };
    }, [turn, visibleAssistantMessages]);

    return (
        <TurnItem turn={renderableTurn} stickyUserHeader={stickyUserHeader} renderMessage={renderMessage} />
    );
});

TurnBlock.displayName = 'TurnBlock';

interface UngroupedMessageRowProps {
    message: ChatMessageEntry;
    previousMessage?: ChatMessageEntry;
    nextMessage?: ChatMessageEntry;
    onMessageContentChange: (reason?: ContentChangeReason) => void;
    getAnimationHandlers: (messageId: string) => AnimationHandlers;
    scrollToBottom?: (options?: { instant?: boolean; force?: boolean }) => void;
    shouldAnimateUserMessage: (message: ChatMessageEntry) => boolean;
    onUserAnimationConsumed: (messageId: string) => void;
    activeStreamingMessageId?: string | null;
    activeStreamingPhase?: StreamPhase | null;
}

const UngroupedMessageRow = React.memo(({
    message,
    previousMessage,
    nextMessage,
    onMessageContentChange,
    getAnimationHandlers,
    scrollToBottom,
    shouldAnimateUserMessage,
    onUserAnimationConsumed,
    activeStreamingMessageId,
    activeStreamingPhase,
}: UngroupedMessageRowProps) => {
    return (
        <MessageRow
            message={message}
            previousMessage={previousMessage}
            nextMessage={nextMessage}
            animateUserOnMount={shouldAnimateUserMessage(message)}
            onUserAnimationConsumed={onUserAnimationConsumed}
            onContentChange={onMessageContentChange}
            animationHandlers={getAnimationHandlers(message.info.id)}
            scrollToBottom={scrollToBottom}
            isInActiveTurn={Boolean(activeStreamingMessageId) && message.info.id === activeStreamingMessageId}
            activeStreamingPhase={message.info.id === activeStreamingMessageId ? activeStreamingPhase : null}
        />
    );
});

UngroupedMessageRow.displayName = 'UngroupedMessageRow';

interface MessageListEntryProps {
    entry: RenderEntry;
    onMessageContentChange: (reason?: ContentChangeReason) => void;
    getAnimationHandlers: (messageId: string) => AnimationHandlers;
    scrollToBottom?: (options?: { instant?: boolean; force?: boolean }) => void;
    stickyUserHeader?: boolean;
    sessionIsWorking: boolean;
    defaultActivityExpanded: boolean;
    turnUiStates: Map<string, TurnUiState>;
    onToggleTurnGroup: (turnId: string) => void;
    chatRenderMode: 'sorted' | 'live';
    shouldAnimateUserMessage: (message: ChatMessageEntry) => boolean;
    onUserAnimationConsumed: (messageId: string) => void;
    activeStreamingMessageId?: string | null;
    activeStreamingPhase?: StreamPhase | null;
}

const turnContainsMessageId = (turn: TurnRecord, messageId: string | null | undefined): boolean => {
    if (!messageId) {
        return false;
    }

    if (turn.userMessage.info.id === messageId) {
        return true;
    }

    return turn.assistantMessages.some((assistant) => assistant.info.id === messageId);
};

const MessageListEntry = React.memo(({
    entry,
    onMessageContentChange,
    getAnimationHandlers,
    scrollToBottom,
    stickyUserHeader,
    sessionIsWorking,
    defaultActivityExpanded,
    turnUiStates,
    onToggleTurnGroup,
    chatRenderMode,
    shouldAnimateUserMessage,
    onUserAnimationConsumed,
    activeStreamingMessageId,
    activeStreamingPhase,
}: MessageListEntryProps) => {
    if (entry.kind === 'ungrouped') {
        return (
            <UngroupedMessageRow
                message={entry.message}
                previousMessage={entry.previousMessage}
                nextMessage={entry.nextMessage}
                onMessageContentChange={onMessageContentChange}
                getAnimationHandlers={getAnimationHandlers}
                scrollToBottom={scrollToBottom}
                shouldAnimateUserMessage={shouldAnimateUserMessage}
                onUserAnimationConsumed={onUserAnimationConsumed}
                activeStreamingMessageId={activeStreamingMessageId}
                activeStreamingPhase={activeStreamingPhase}
            />
        );
    }

    return (
        <TurnBlock
            turn={entry.turn}
            isLastTurn={entry.isLastTurn}
            sessionIsWorking={sessionIsWorking}
            defaultActivityExpanded={defaultActivityExpanded}
            turnUiStates={turnUiStates}
            onToggleTurnGroup={onToggleTurnGroup}
            chatRenderMode={chatRenderMode}
            shouldAnimateUserMessage={shouldAnimateUserMessage}
            onUserAnimationConsumed={onUserAnimationConsumed}
            activeStreamingMessageId={activeStreamingMessageId}
            activeStreamingPhase={activeStreamingPhase}
            onMessageContentChange={onMessageContentChange}
            getAnimationHandlers={getAnimationHandlers}
            scrollToBottom={scrollToBottom}
            stickyUserHeader={stickyUserHeader}
        />
    );
});

MessageListEntry.displayName = 'MessageListEntry';

// Inner component that renders staged turn entries.
const StaticHistoryList: React.FC<{
    entries: RenderEntry[];
    shouldVirtualize: boolean;
    virtualRows: VirtualItem[];
    totalSize: number;
    measureElement: (element: HTMLDivElement | null) => void;
    contentRef: React.RefObject<HTMLDivElement | null>;
    onMessageContentChange: (reason?: ContentChangeReason) => void;
    getAnimationHandlers: (messageId: string) => AnimationHandlers;
    scrollToBottom?: (options?: { instant?: boolean; force?: boolean }) => void;
    stickyUserHeader: boolean;
    defaultActivityExpanded: boolean;
    turnUiStates: Map<string, TurnUiState>;
    onToggleTurnGroup: (turnId: string) => void;
    chatRenderMode: 'sorted' | 'live';
    shouldAnimateUserMessage: (message: ChatMessageEntry) => boolean;
    onUserAnimationConsumed: (messageId: string) => void;
    activeStreamingPhase?: StreamPhase | null;
}> = ({ entries, shouldVirtualize, virtualRows, totalSize, measureElement, contentRef, onMessageContentChange, getAnimationHandlers, scrollToBottom, stickyUserHeader, defaultActivityExpanded, turnUiStates, onToggleTurnGroup, chatRenderMode, shouldAnimateUserMessage, onUserAnimationConsumed, activeStreamingPhase }) => {
    const renderEntry = React.useCallback((entry: RenderEntry) => {
        return (
            <MessageListEntry
                key={entry.key}
                entry={entry}
                onMessageContentChange={onMessageContentChange}
                getAnimationHandlers={getAnimationHandlers}
                scrollToBottom={scrollToBottom}
                stickyUserHeader={stickyUserHeader}
                sessionIsWorking={false}
                defaultActivityExpanded={defaultActivityExpanded}
                turnUiStates={turnUiStates}
                onToggleTurnGroup={onToggleTurnGroup}
                chatRenderMode={chatRenderMode}
                shouldAnimateUserMessage={shouldAnimateUserMessage}
                onUserAnimationConsumed={onUserAnimationConsumed}
                activeStreamingMessageId={null}
                activeStreamingPhase={activeStreamingPhase}
            />
        );
    }, [activeStreamingPhase, chatRenderMode, defaultActivityExpanded, getAnimationHandlers, onMessageContentChange, onToggleTurnGroup, onUserAnimationConsumed, scrollToBottom, shouldAnimateUserMessage, stickyUserHeader, turnUiStates]);

    const paddingTop = shouldVirtualize && virtualRows.length > 0
        ? virtualRows[0]?.start ?? 0
        : 0;
    const paddingBottom = shouldVirtualize && virtualRows.length > 0
        ? Math.max(0, totalSize - (virtualRows[virtualRows.length - 1]?.end ?? 0))
        : 0;

    if (!shouldVirtualize) {
        return (
            <div ref={contentRef} className="relative w-full">
                {entries.map((entry) => (
                    <div
                        key={entry.key}
                        data-turn-entry={entry.key}
                    >
                        {renderEntry(entry)}
                    </div>
                ))}
            </div>
        );
    }

    return (
        <div ref={contentRef} className="relative w-full">
            {paddingTop > 0 ? <div aria-hidden="true" style={{ height: `${paddingTop}px` }} /> : null}
            {virtualRows.map((virtualRow) => {
                const entry = entries[virtualRow.index];
                if (!entry) {
                    return null;
                }

                return (
                    <div
                        key={virtualRow.key}
                        ref={measureElement}
                        data-index={virtualRow.index}
                        data-turn-entry={entry.key}
                    >
                        {renderEntry(entry)}
                    </div>
                );
            })}
            {paddingBottom > 0 ? <div aria-hidden="true" style={{ height: `${paddingBottom}px` }} /> : null}
        </div>
    );
};

StaticHistoryList.displayName = 'StaticHistoryList';

const StreamingTailContent: React.FC<{
    entry: RenderEntry;
    onMessageContentChange: (reason?: ContentChangeReason) => void;
    getAnimationHandlers: (messageId: string) => AnimationHandlers;
    scrollToBottom?: (options?: { instant?: boolean; force?: boolean }) => void;
    stickyUserHeader: boolean;
    sessionIsWorking: boolean;
    defaultActivityExpanded: boolean;
    turnUiStates: Map<string, TurnUiState>;
    onToggleTurnGroup: (turnId: string) => void;
    chatRenderMode: 'sorted' | 'live';
    shouldAnimateUserMessage: (message: ChatMessageEntry) => boolean;
    onUserAnimationConsumed: (messageId: string) => void;
    activeStreamingMessageId?: string | null;
    activeStreamingPhase?: StreamPhase | null;
}> = ({
    entry,
    onMessageContentChange,
    getAnimationHandlers,
    scrollToBottom,
    stickyUserHeader,
    sessionIsWorking,
    defaultActivityExpanded,
    turnUiStates,
    onToggleTurnGroup,
    chatRenderMode,
    shouldAnimateUserMessage,
    onUserAnimationConsumed,
    activeStreamingMessageId,
    activeStreamingPhase,
}) => {
    return (
        <MessageListEntry
            entry={entry}
            onMessageContentChange={onMessageContentChange}
            getAnimationHandlers={getAnimationHandlers}
            scrollToBottom={scrollToBottom}
            stickyUserHeader={stickyUserHeader}
            sessionIsWorking={sessionIsWorking}
            defaultActivityExpanded={defaultActivityExpanded}
            turnUiStates={turnUiStates}
            onToggleTurnGroup={onToggleTurnGroup}
            chatRenderMode={chatRenderMode}
            shouldAnimateUserMessage={shouldAnimateUserMessage}
            onUserAnimationConsumed={onUserAnimationConsumed}
            activeStreamingMessageId={activeStreamingMessageId}
            activeStreamingPhase={activeStreamingPhase}
        />
    );
};

StreamingTailContent.displayName = 'StreamingTailContent';

const MessageList = React.forwardRef<MessageListHandle, MessageListProps>(({ 
    sessionKey,
    turnStart,
    disableStaging: _disableStaging,
    messages,
    sessionIsWorking = false,
    activeStreamingMessageId = null,
    activeStreamingPhase = null,
    retryOverlay = null,
    onMessageContentChange,
    getAnimationHandlers,
    hasMoreAbove,
    isLoadingOlder,
    onLoadOlder,
    scrollToBottom,
    scrollRef,
}, ref) => {
    streamPerfCount('ui.message_list.render');
    void _disableStaging;
    const stickyUserHeader = useUIStore(state => state.stickyUserHeader);
    const chatRenderMode = useUIStore((state) => state.chatRenderMode);
    const activityRenderMode = useUIStore((state) => state.activityRenderMode);
    const defaultActivityExpanded = activityRenderMode === 'summary';
    const [turnUiStates, setTurnUiStates] = React.useState<Map<string, TurnUiState>>(() => new Map());
    const userAnimationRef = React.useRef<{
        sessionKey: string | undefined;
        previousOrder: string[];
        animatedIds: Set<string>;
    }>({ sessionKey: undefined, previousOrder: [], animatedIds: new Set() });
    const stableGetAnimationHandlers = useStableEvent(getAnimationHandlers);
    const stableOnLoadOlder = useStableEvent(onLoadOlder);
    const stableScrollToBottom = useStableEvent((options?: { instant?: boolean; force?: boolean }) => {
        scrollToBottom?.(options);
    });

    React.useEffect(() => {
        setTurnUiStates(new Map());
    }, [activityRenderMode]);

    const toggleTurnGroup = React.useCallback((turnId: string) => {
        setTurnUiStates((previous) => {
            const next = new Map(previous);
            const current = next.get(turnId) ?? { isExpanded: defaultActivityExpanded };
            next.set(turnId, { isExpanded: !current.isExpanded });
            return next;
        });
    }, [defaultActivityExpanded]);


    const baseDisplayMessages = React.useMemo(() => streamPerfMeasure('ui.message_list.base_display_ms', () => {
        const seenIdsFromTail = new Set<string>();
        const dedupedMessages: ChatMessageEntry[] = [];
        for (let index = messages.length - 1; index >= 0; index -= 1) {
            const message = messages[index];
            const messageId = message.info?.id;
            if (typeof messageId === 'string') {
                if (seenIdsFromTail.has(messageId)) {
                    continue;
                }
                seenIdsFromTail.add(messageId);
            }
            dedupedMessages.push(getNormalizedMessageForDisplay(message));
        }
        dedupedMessages.reverse();

        const output: ChatMessageEntry[] = [];
        const compactionCommandIds = new Set<string>();
        for (let index = 0; index < dedupedMessages.length; index += 1) {
            const current = dedupedMessages[index];
            const currentWithRole = normalizeCompactionSummaryMessage(current, compactionCommandIds);
            if (hasCompactionPart(current) || current.parts.some((part) => part.type === 'text' && getPartText(part).trim() === '/compact')) {
                compactionCommandIds.add(current.info.id);
            }
            const previous = output.length > 0 ? output[output.length - 1] : undefined;

            if (isUserSubtaskMessage(previous)) {
                const bridge = isSyntheticSubtaskBridgeAssistant(currentWithRole);
                if (bridge.hide) {
                    output[output.length - 1] = withSubtaskSessionId(previous as ChatMessageEntry, bridge.taskSessionId);
                    continue;
                }
            }

            if (isUserShellMarkerMessage(previous)) {
                const bridge = getShellBridgeAssistantDetails(currentWithRole, getMessageId(previous));
                if (bridge.hide) {
                    output[output.length - 1] = withShellBridgeDetails(previous as ChatMessageEntry, bridge.details);
                    continue;
                }
            }

            output.push(currentWithRole);
        }

        return output;
    }), [messages]);

    const historyContentRef = React.useRef<HTMLDivElement | null>(null);
    const pendingVirtualMeasureFrameRef = React.useRef<number | null>(null);
    const resolveScrollContainer = React.useCallback((): HTMLDivElement | null => {
        if (scrollRef?.current) {
            return scrollRef.current;
        }
        if (typeof document === 'undefined') {
            return null;
        }
        return document.querySelector<HTMLDivElement>('[data-scrollbar="chat"]');
    }, [scrollRef]);

    const displayMessages = React.useMemo(() => streamPerfMeasure('ui.message_list.retry_overlay_ms', () => {
        return applyRetryOverlay(baseDisplayMessages, {
            sessionId: retryOverlay?.sessionId ?? null,
            message: retryOverlay?.message ?? 'Quota limit reached. Retrying automatically.',
            confirmedAt: retryOverlay?.confirmedAt,
            fallbackTimestamp: retryOverlay?.fallbackTimestamp ?? 0,
        });
    }), [baseDisplayMessages, retryOverlay]);

    const { projection, staticTurns, streamingTurn } = useTurnRecords(displayMessages, {
        sessionKey,
        showTextJustificationActivity: chatRenderMode === 'sorted',
    });
    const staticRenderEntries = React.useMemo<RenderEntry[]>(() => streamPerfMeasure('ui.message_list.render_entries_ms', () => {
        const turnEntries = staticTurns.map((turn) => ({
            kind: 'turn' as const,
            key: `turn:${turn.turnId}`,
            turn,
            isLastTurn: turn.turnId === projection.lastTurnId,
        }));

        if (projection.ungroupedMessageIds.size === 0) {
            return turnEntries;
        }

        const turnEntryByUserMessageId = new Map<string, RenderEntry>();
        turnEntries.forEach((entry) => {
            turnEntryByUserMessageId.set(entry.turn.userMessage.info.id, entry);
        });

        const orderedEntries: RenderEntry[] = [];
        displayMessages.forEach((message, index) => {
            const turnEntry = turnEntryByUserMessageId.get(message.info.id);
            if (turnEntry) {
                orderedEntries.push(turnEntry);
                return;
            }

            if (!projection.ungroupedMessageIds.has(message.info.id)) {
                return;
            }

            orderedEntries.push({
                kind: 'ungrouped',
                key: `msg:${message.info.id}`,
                message,
                previousMessage: index > 0 ? displayMessages[index - 1] : undefined,
                nextMessage: index < displayMessages.length - 1 ? displayMessages[index + 1] : undefined,
            });
        });

        return orderedEntries;
    }), [displayMessages, projection.lastTurnId, projection.ungroupedMessageIds, staticTurns]);

    const trailingStreamingEntry = React.useMemo<RenderEntry | undefined>(() => {
        if (streamingTurn) {
            return {
                kind: 'turn',
                key: `turn:${streamingTurn.turnId}`,
                turn: streamingTurn,
                isLastTurn: streamingTurn.turnId === projection.lastTurnId,
            } satisfies RenderEntry;
        }

        if (projection.ungroupedMessageIds.size === 0) {
            return undefined;
        }

        const lastMessage = displayMessages[displayMessages.length - 1];
        if (!lastMessage || !projection.ungroupedMessageIds.has(lastMessage.info.id)) {
            return undefined;
        }

        return {
            kind: 'ungrouped',
            key: `msg:${lastMessage.info.id}`,
            message: lastMessage,
            previousMessage: displayMessages.length > 1 ? displayMessages[displayMessages.length - 2] : undefined,
            nextMessage: undefined,
        } satisfies RenderEntry;
    }, [displayMessages, projection.lastTurnId, projection.ungroupedMessageIds, streamingTurn]);

    if (trailingStreamingEntry) {
        streamPerfCount('ui.message_list.render.streaming');
    }

    const historyEntries = staticRenderEntries;
    const shouldVirtualizeHistory = historyEntries.length >= MESSAGE_LIST_VIRTUALIZE_THRESHOLD;
    const [historyWidthPx, setHistoryWidthPx] = React.useState<number | null>(null);
    const historyMeasurementScopeKey = historyWidthPx === null ? 'width:unknown' : `width:${Math.round(historyWidthPx)}`;

    React.useLayoutEffect(() => {
        const historyContent = historyContentRef.current;
        if (!historyContent || !shouldVirtualizeHistory) {
            setHistoryWidthPx((previous) => (previous === null ? previous : null));
            return;
        }

        const updateWidth = (nextWidth: number) => {
            setHistoryWidthPx((previous) => {
                if (previous !== null && Math.abs(previous - nextWidth) < 0.5) {
                    return previous;
                }
                return nextWidth;
            });
        };

        updateWidth(historyContent.getBoundingClientRect().width);

        if (typeof ResizeObserver === 'undefined') {
            return;
        }

        const observer = new ResizeObserver(() => {
            updateWidth(historyContent.getBoundingClientRect().width);
        });
        observer.observe(historyContent);
        return () => {
            observer.disconnect();
        };
    }, [historyEntries.length, shouldVirtualizeHistory]);

    const historyVirtualizer = useVirtualizer({
        count: historyEntries.length,
        getScrollElement: resolveScrollContainer,
        estimateSize: (index) => estimateHistoryEntryHeight(historyEntries[index]),
        getItemKey: (index) => `${historyMeasurementScopeKey}:${historyEntries[index]?.key ?? index}`,
        measureElement: measureVirtualElement,
        useAnimationFrameWithResizeObserver: true,
        overscan: MESSAGE_LIST_OVERSCAN,
        enabled: shouldVirtualizeHistory,
    });

    React.useEffect(() => {
        if (!shouldVirtualizeHistory || historyWidthPx === null) {
            return;
        }
        historyVirtualizer.measure();
    }, [historyVirtualizer, historyWidthPx, shouldVirtualizeHistory]);

    const scheduleVirtualMeasure = React.useCallback(() => {
        if (!shouldVirtualizeHistory) {
            return;
        }
        if (typeof window === 'undefined') {
            historyVirtualizer.measure();
            return;
        }
        if (pendingVirtualMeasureFrameRef.current !== null) {
            return;
        }
        pendingVirtualMeasureFrameRef.current = window.requestAnimationFrame(() => {
            pendingVirtualMeasureFrameRef.current = null;
            historyVirtualizer.measure();
        });
    }, [historyVirtualizer, shouldVirtualizeHistory]);

    React.useEffect(() => {
        return () => {
            if (pendingVirtualMeasureFrameRef.current !== null && typeof window !== 'undefined') {
                window.cancelAnimationFrame(pendingVirtualMeasureFrameRef.current);
            }
        };
    }, []);

    const historyVirtualRows = React.useMemo(
        () => (shouldVirtualizeHistory ? historyVirtualizer.getVirtualItems() : []),
        [historyVirtualizer, shouldVirtualizeHistory],
    );

    const allEntries = React.useMemo(() => {
        return trailingStreamingEntry ? [...historyEntries, trailingStreamingEntry] : historyEntries;
    }, [historyEntries, trailingStreamingEntry]);

    const stableHistoryContentChange = useStableEvent((reason?: ContentChangeReason) => {
        scheduleVirtualMeasure();
        onMessageContentChange(reason);
    });

    const stableTailContentChange = useStableEvent((reason?: ContentChangeReason) => {
        onMessageContentChange(reason);
    });

    const currentUserOrder = React.useMemo(() => {
        return messages
            .filter((message) => resolveMessageRole(message) === 'user')
            .map((message) => message.info.id);
    }, [messages]);

    // Detect new user messages SYNCHRONOUSLY during render.
    // Must happen during render (not in useEffect) so that ToolRevealOnMount
    // receives animate=true on the FIRST render of the new message,
    // starting it hidden (opacity 0). An effect-based approach causes
    // the message to flash visible before the animation starts.
    {
        const anim = userAnimationRef.current;

        // Reset on session switch
        if (anim.sessionKey !== sessionKey) {
            anim.sessionKey = sessionKey;
            anim.previousOrder = currentUserOrder;
            anim.animatedIds = new Set();
        }

        // Detect appended user messages
        const prev = anim.previousOrder;
        if (currentUserOrder.length > prev.length) {
            const isAppendOnly = prev.every((id, i) => currentUserOrder[i] === id);
            if (isAppendOnly && hasPendingUserSendAnimation(sessionKey)) {
                for (let i = prev.length; i < currentUserOrder.length; i += 1) {
                    const id = currentUserOrder[i];
                    if (id && !anim.animatedIds.has(id)) {
                        if (!consumePendingUserSendAnimation(sessionKey)) break;
                        anim.animatedIds.add(id);
                    }
                }
            }
        }
        anim.previousOrder = currentUserOrder;
    }

    const shouldAnimateUserMessage = React.useCallback((message: ChatMessageEntry): boolean => {
        if (resolveMessageRole(message) !== 'user') return false;
        return userAnimationRef.current.animatedIds.has(message.info.id);
    }, []);

    const onUserAnimationConsumed = React.useCallback((messageId: string) => {
        userAnimationRef.current.animatedIds.delete(messageId);
    }, []);

    const messageIndexMap = React.useMemo(() => {
        const indexMap = new Map<string, number>();

        allEntries.forEach((entry, index) => {
            if (entry.kind === 'ungrouped') {
                indexMap.set(entry.message.info.id, index);
                return;
            }
            indexMap.set(entry.turn.userMessage.info.id, index);
            entry.turn.assistantMessages.forEach((message) => {
                indexMap.set(message.info.id, index);
            });
        });

        return indexMap;
    }, [allEntries]);

    const turnIndexMap = React.useMemo(() => {
        const indexMap = new Map<string, number>();
        allEntries.forEach((entry, index) => {
            if (entry.kind === 'turn') {
                indexMap.set(entry.turn.turnId, index);
            }
        });
        return indexMap;
    }, [allEntries]);

    const findMessageElement = React.useCallback((messageId: string): HTMLElement | null => {
        const container = resolveScrollContainer();
        if (!container) {
            return null;
        }
        return container.querySelector(`[data-message-id="${messageId}"]`);
    }, [resolveScrollContainer]);

    const scrollHistoryIndexIntoView = React.useCallback((index: number, behavior: ScrollBehavior = 'auto') => {
        if (!shouldVirtualizeHistory || index < 0 || index >= historyEntries.length) {
            return false;
        }

        const virtualizerBehavior = behavior === 'smooth' ? 'smooth' : 'auto';
        historyVirtualizer.scrollToIndex(index, { align: 'start', behavior: virtualizerBehavior });
        return true;
    }, [historyEntries.length, historyVirtualizer, shouldVirtualizeHistory]);

    const scrollMessageElementIntoView = React.useCallback((messageId: string, behavior: ScrollBehavior = 'auto') => {
        const container = resolveScrollContainer();
        if (!container) {
            return false;
        }
        const messageElement = findMessageElement(messageId);
        if (!messageElement) {
            return false;
        }

        const containerRect = container.getBoundingClientRect();
        const messageRect = messageElement.getBoundingClientRect();
        const offset = 50;
        const top = messageRect.top - containerRect.top + container.scrollTop - offset;
        container.scrollTo({ top, behavior });
        return true;
    }, [findMessageElement, resolveScrollContainer]);

    React.useEffect(() => {
        if (!ref) {
            return;
        }

        const handle: MessageListHandle = {
            scrollToTurnId: (turnId: string, options?: { behavior?: ScrollBehavior }) => {
                const behavior = options?.behavior ?? 'auto';
                const index = turnIndexMap.get(turnId);
                if (index === undefined) {
                    return false;
                }

                const container = resolveScrollContainer();
                if (!container) {
                    return false;
                }
                const turnElement = container.querySelector<HTMLElement>(`[data-turn-id="${turnId}"]`);
                if (turnElement) {
                    turnElement.scrollIntoView({ behavior, block: 'start' });
                    return true;
                }

                const targetIsTail = trailingStreamingEntry !== undefined && index >= historyEntries.length;
                if (targetIsTail) {
                    return false;
                }

                return scrollHistoryIndexIntoView(index, behavior);
            },

            scrollToMessageId: (messageId: string, options?: { behavior?: ScrollBehavior }) => {
                const behavior = options?.behavior ?? 'auto';
                const index = messageIndexMap.get(messageId);
                if (index === undefined) {
                    return false;
                }

                return scrollMessageElementIntoView(messageId, behavior)
                    || (
                        trailingStreamingEntry !== undefined && index >= historyEntries.length
                            ? false
                            : scrollHistoryIndexIntoView(index, behavior)
                    );
            },

            captureViewportAnchor: () => {
                const container = resolveScrollContainer();
                if (!container) {
                    return null;
                }

                const containerRect = container.getBoundingClientRect();
                const nodes: HTMLElement[] = Array.from(container.querySelectorAll<HTMLElement>('[data-message-id]'));
                const firstVisible = nodes.find((node) => {
                    const rect = node.getBoundingClientRect();
                    if (rect.bottom <= containerRect.top + 1) {
                        return false;
                    }

                    if (typeof window === 'undefined') {
                        return true;
                    }

                    const computed = window.getComputedStyle(node);
                    const isStuckSticky = computed.position === 'sticky' && rect.top <= containerRect.top + 1;
                    return !isStuckSticky;
                }) ?? nodes.find((node) => node.getBoundingClientRect().bottom > containerRect.top + 1);
                if (!firstVisible) {
                    return null;
                }

                const messageId = firstVisible.dataset.messageId;
                if (!messageId) {
                    return null;
                }

                return {
                    messageId,
                    offsetTop: firstVisible.getBoundingClientRect().top - containerRect.top,
                };
            },

            restoreViewportAnchor: (anchor: { messageId: string; offsetTop: number }) => {
                const container = resolveScrollContainer();
                if (!container) {
                    return false;
                }

                if (!messageIndexMap.has(anchor.messageId)) {
                    return false;
                }

                const applyAnchor = (): boolean => {
                    const element = findMessageElement(anchor.messageId);
                    if (!element) {
                        return false;
                    }
                    const containerRect = container.getBoundingClientRect();
                    const targetTop = element.getBoundingClientRect().top - containerRect.top;
                    const delta = targetTop - anchor.offsetTop;
                    if (delta !== 0) {
                        container.scrollTop += delta;
                    }
                    return true;
                };

                if (!applyAnchor()) {
                    const index = messageIndexMap.get(anchor.messageId);
                    if (typeof index === 'number' && index < historyEntries.length) {
                        scrollHistoryIndexIntoView(index, 'auto');
                    }
                }

                return applyAnchor();
            },
        };

        if (typeof ref === 'function') {
            ref(handle);
            return () => {
                ref(null);
            };
        }

        const objectRef = ref;
        objectRef.current = handle;
        return () => {
            objectRef.current = null;
        };
    }, [findMessageElement, historyEntries.length, messageIndexMap, resolveScrollContainer, scrollHistoryIndexIntoView, scrollMessageElementIntoView, trailingStreamingEntry, turnIndexMap, ref]);

    const disableFadeIn = false;

    return (
        <div>
                {(turnStart > 0 || hasMoreAbove) && (
                    <div className="flex justify-center py-3">
                        {isLoadingOlder ? (
                            <span className="text-xs uppercase tracking-wide text-muted-foreground/80">
                                Loading…
                            </span>
                        ) : (
                            <button
                                type="button"
                                onClick={stableOnLoadOlder}
                                className="text-xs uppercase tracking-wide text-muted-foreground/80 hover:text-foreground"
                            >
                                Load older messages
                            </button>
                        )}
                    </div>
                )}

                <FadeInDisabledProvider disabled={disableFadeIn}>
                    <div className="relative w-full">
                        <StaticHistoryList
                            entries={historyEntries}
                            shouldVirtualize={shouldVirtualizeHistory}
                            virtualRows={historyVirtualRows}
                            totalSize={historyVirtualizer.getTotalSize()}
                            measureElement={historyVirtualizer.measureElement}
                            contentRef={historyContentRef}
                            onMessageContentChange={stableHistoryContentChange}
                            getAnimationHandlers={stableGetAnimationHandlers}
                            scrollToBottom={stableScrollToBottom}
                            stickyUserHeader={stickyUserHeader}
                            defaultActivityExpanded={defaultActivityExpanded}
                            turnUiStates={turnUiStates}
                            onToggleTurnGroup={toggleTurnGroup}
                            chatRenderMode={chatRenderMode}
                            shouldAnimateUserMessage={shouldAnimateUserMessage}
                            onUserAnimationConsumed={onUserAnimationConsumed}
                            activeStreamingPhase={activeStreamingPhase}
                        />
                        {trailingStreamingEntry ? (
                            <StreamingTailContent
                                entry={trailingStreamingEntry}
                                onMessageContentChange={stableTailContentChange}
                                getAnimationHandlers={stableGetAnimationHandlers}
                                scrollToBottom={stableScrollToBottom}
                                stickyUserHeader={stickyUserHeader}
                                sessionIsWorking={sessionIsWorking}
                                defaultActivityExpanded={defaultActivityExpanded}
                                turnUiStates={turnUiStates}
                                onToggleTurnGroup={toggleTurnGroup}
                                chatRenderMode={chatRenderMode}
                                shouldAnimateUserMessage={shouldAnimateUserMessage}
                                onUserAnimationConsumed={onUserAnimationConsumed}
                                activeStreamingMessageId={activeStreamingMessageId}
                                activeStreamingPhase={activeStreamingPhase}
                            />
                        ) : null}
                    </div>
                </FadeInDisabledProvider>

        </div>
    );
});

MessageList.displayName = 'MessageList';

export default React.memo(MessageList);
