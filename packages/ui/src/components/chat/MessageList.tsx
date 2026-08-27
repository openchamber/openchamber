import React from 'react';
import type { Part } from '@opencode-ai/sdk/v2';
import { LegendList, type LegendListRef } from '@legendapp/list/react';

import ChatMessage from './ChatMessage';
import { areOptionalRenderRelevantMessagesEqual, areRelevantTurnGroupingContextsEqual, areRenderRelevantMessagesEqual } from './message/renderCompare';
import TurnItem from './components/TurnItem';
import type { ChatMessageEntry, TurnRecord, TurnGroupingContext } from './lib/turns/types';
import { useTurnRecords } from './hooks/useTurnRecords';
import { applyRetryOverlay } from './lib/turns/applyRetryOverlay';
import { buildLiveStreamingEntry } from './lib/turns/streamingTailEntry';
import { getNormalizedMessageForDisplay, hasCompactionPart } from './lib/messageDisplayNormalization';
import { useUIStore } from '@/stores/useUIStore';
import { useFeatureFlagsStore } from '@/stores/useFeatureFlagsStore';
import { isHiddenUserMessage } from './message/hiddenUserMessage';
import { FadeInDisabledProvider } from './message/FadeInOnReveal';
import { hasPendingUserSendAnimation, consumePendingUserSendAnimation } from '@/lib/userSendAnimation';
import { streamPerfCount, streamPerfMark, streamPerfMeasure } from '@/stores/utils/streamDebug';
import type { StreamPhase } from './message/types';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useSessionPartsForMessages } from '@/sync/sync-context';
import type { ReviewTransferDirection } from '@/lib/reviewFlow';
import { resolveChatListAnchoredEndSpace, resolveTimelineIsAtEnd } from './lib/scroll/timelineScrollAnchoring';
import {
    USER_SHELL_MARKER,
    isUserShellMarkerMessage,
    getShellBridgeAssistantDetails,
    type ShellBridgeDetails,
} from './lib/shellBridge';

const EMPTY_STATIC_ENTRY_MESSAGES: ChatMessageEntry[] = [];
const EMPTY_UNGROUPED_MESSAGE_IDS = new Set<string>();

// --- Timeline virtualization (@legendapp/list) -----------------------------
// The timeline is a single virtualized list on every surface: history turns
// AND the live streaming tail are rows of the same list, so the list owns one
// coherent scroll position instead of arbitrating between a virtualizer and a
// separately-rendered tail.
//
// Scroll behavior the list owns natively, which is why none of it exists here
// any more:
//   • `maintainScrollAtEnd` keeps the live edge pinned as rows grow.
//   • `maintainVisibleContentPosition` preserves the read position when older
//     history is prepended, replacing the manual anchor-hold and the mobile
//     quiet-window prepend deferral.
//   • `anchoredEndSpace` reserves the tail space that parks a just-sent
//     message near the top of the viewport.
const TIMELINE_ESTIMATED_ENTRY_SIZE = 320;

// Anchor hold for an explicit viewport restore (session re-entry): row
// measurements settle over several frames, so a single restore can be
// invalidated by the next measurement pass. Re-assert until it holds still for
// STABLE_FRAMES consecutive frames, giving up at MAX_FRAMES.
const ANCHOR_HOLD_STABLE_FRAMES = 30;
const ANCHOR_HOLD_MAX_FRAMES = 180;

// Reserved tail space that parks an anchored row near the top of the viewport.
// `onReady` fires once the list has measured the anchor, `onSizeChanged` when
// the reserved size is recomputed.
// Presentation-only props forwarded to the scroll container the list renders.
// Deliberately narrow: the list owns scroll and layout callbacks on that
// element, so only styling, focus and click-through are caller-controlled.
type TimelineScrollContainerProps = {
    className?: string;
    style?: React.CSSProperties;
    tabIndex?: number;
    onClick?: React.MouseEventHandler<HTMLDivElement>;
    'data-scrollbar'?: string;
    'data-scroll-shadow'?: string;
};

type TimelineAnchoredEndSpace = {
    anchorIndex: number;
    anchorOffset?: number;
    onReady?: (info: { anchorIndex: number | undefined; anchorKey: string | undefined; size: number }) => void;
    onSizeChanged?: (size: number) => void;
};

const useStableEvent = <TArgs extends unknown[], TResult>(handler: (...args: TArgs) => TResult) => {
    const handlerRef = React.useRef(handler);
    React.useEffect(() => {
        handlerRef.current = handler;
    }, [handler]);

    return React.useCallback((...args: TArgs) => handlerRef.current(...args), []);
};

const resolveMessageRole = (message: ChatMessageEntry): string | null => {
    const info = message.info as unknown as { clientRole?: string | null | undefined; role?: string | null | undefined };
    return (typeof info.clientRole === 'string' ? info.clientRole : null)
        ?? (typeof info.role === 'string' ? info.role : null)
        ?? null;
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

const isInsideStuckSticky = (node: HTMLElement, container: HTMLElement, containerTop: number): boolean => {
    if (typeof window === 'undefined') return false;

    let current: HTMLElement | null = node;
    while (current && current !== container) {
        const computed = window.getComputedStyle(current);
        if (computed.position === 'sticky' && current.getBoundingClientRect().top <= containerTop + 1) {
            return true;
        }
        current = current.parentElement;
    }

    return false;
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
    } | null | undefined;

    if (onlyPart?.type !== 'tool') {
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

interface MessageListProps {
    sessionKey: string;
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
    isLoadingOlder: boolean;
    scrollToBottom?: () => void;
    directory?: string;
    // The list owns its scroll container; the timeline scroll hook drives it
    // through this ref and observes it through the callbacks below.
    registerList?: (list: LegendListRef | null) => void;
    // True while a real gesture owns the scroll; releases the list's own
    // end pinning so the state machine, not the library heuristic, decides.
    endPinningReleased?: boolean;
    // The anchored row is identified by message id; the index it maps to is a
    // property of the row model, which only this component knows.
    anchorMessageId?: string | null;
    onAnchorReady?: (messageId: string, anchorIndex: number) => void;
    onAnchorSizeChanged?: (messageId: string) => void;
    composerOverlayHeight?: number;
    onIsAtEndChange?: (isAtEnd: boolean) => void;
    onTimelineDataChange?: () => void;
    // Content that used to sit as siblings of the list inside the scroll
    // container. The list owns that container now, so they render as its
    // header/footer and scroll with the rows exactly as before.
    listHeader?: React.ReactNode;
    listFooter?: React.ReactNode;
    scrollContainerProps?: TimelineScrollContainerProps;
}

export interface MessageListHandle {
    scrollToTurnId: (turnId: string, options?: { behavior?: ScrollBehavior }) => boolean;
    scrollToMessageId: (messageId: string, options?: { behavior?: ScrollBehavior }) => boolean;
    captureViewportAnchor: () => { messageId: string; offsetTop: number } | null;
    restoreViewportAnchor: (anchor: { messageId: string; offsetTop: number }) => boolean;
    holdViewportAnchor: (anchor: { messageId: string; offsetTop: number }) => void;
    isHistoryVirtualized: () => boolean;
    scrollToBottom: () => void;
}

type RenderEntry =
    | {
        kind: 'ungrouped';
        key: string;
        message: ChatMessageEntry;
        previousMessage?: ChatMessageEntry;
        nextMessage?: ChatMessageEntry;
    }
    | { kind: 'turn'; key: string; turn: TurnRecord; isLastTurn: boolean; nextEntryFirstMessage?: ChatMessageEntry };

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
    scrollToBottom?: () => void;
    reviewTransferDirection?: ReviewTransferDirection | null;
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
    scrollToBottom,
    reviewTransferDirection,
}) => {
    return (
        <ChatMessage
            message={message}
            previousMessage={previousMessage}
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
        && areOptionalRenderRelevantMessagesEqual(prev.previousMessage, next.previousMessage)
        && areOptionalRenderRelevantMessagesEqual(prev.nextMessage, next.nextMessage)
        && prev.animateUserOnMount === next.animateUserOnMount
        && prev.onUserAnimationConsumed === next.onUserAnimationConsumed
        && prev.scrollToBottom === next.scrollToBottom
        && areRelevantTurnGroupingContextsEqual(prevTurn, nextTurn, prev.message.info.id, resolveMessageRole(prev.message) === 'user')
        && prev.assistantHeaderMessageId === next.assistantHeaderMessageId
        && prev.isInActiveTurn === next.isInActiveTurn
        && prev.activeStreamingPhase === next.activeStreamingPhase
        && prev.reviewTransferDirection === next.reviewTransferDirection;
});

MessageRow.displayName = 'MessageRow';

interface TurnBlockProps {
    turn: TurnRecord;
    isLastTurn: boolean;
    nextEntryFirstMessage?: ChatMessageEntry;
    sessionIsWorking: boolean;
    defaultActivityExpanded: boolean;
    turnUiStates: Map<string, TurnUiState>;
    onToggleTurnGroup: (turnId: string) => void;
    chatRenderMode: 'sorted' | 'live';
    scrollToBottom?: () => void;
    stickyUserHeader?: boolean;
    shouldAnimateUserMessage: (message: ChatMessageEntry) => boolean;
    onUserAnimationConsumed: (messageId: string) => void;
    activeStreamingMessageId?: string | null;
    activeStreamingPhase?: StreamPhase | null;
    reviewTransferDirection?: ReviewTransferDirection | null;
}

const TurnBlock = React.memo(({
    turn,
    isLastTurn,
    nextEntryFirstMessage,
    sessionIsWorking,
    defaultActivityExpanded,
    turnUiStates,
    onToggleTurnGroup,
    chatRenderMode,
    scrollToBottom,
    stickyUserHeader = true,
    shouldAnimateUserMessage,
    onUserAnimationConsumed,
    activeStreamingMessageId,
    activeStreamingPhase,
    reviewTransferDirection,
}: TurnBlockProps) => {

    const planModeEnabled = useFeatureFlagsStore((state) => state.planModeEnabled);
    const userMessageHidden = React.useMemo(
        () => isHiddenUserMessage(turn.userMessage, { planModeEnabled }),
        [planModeEnabled, turn.userMessage]
    );
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
            changedFiles: turn.changedFiles,
            userMessageCreatedAt: typeof userCreatedAt === 'number' ? userCreatedAt : undefined,
            userMessageVariant,
        };
    }, [turn.changedFiles, turn.diffStats, turn.hasReasoning, turn.hasTools, turn.headerMessageId, turn.summaryText, turn.turnId, turn.userMessage.info, visibleActivityParts, visibleActivitySegments]);

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
            const hasAnchoredActivitySegment = visibleActivitySegments.some((segment) => segment.anchorMessageId === message.info.id);
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
            const nextMessage = isAssistantMessage && isLastAssistant ? nextEntryFirstMessage : undefined;

            const turnGroupingContext = isAssistantMessage
                ? {
                    turnId: turn.turnId,
                    activityOwnerMessageId,
                    isFirstAssistantInTurn: isFirstAssistant,
                    isLastAssistantInTurn: isLastAssistant,
                    isLatestTurn: isLastTurn,
                    isWorking: isLastTurn && sessionIsWorking && (
                        chatRenderMode === 'sorted'
                            ? hasAnchoredActivitySegment
                            : message.info.id === streamingAssistantMessageId
                    ),
                    hasTools: turn.hasTools,
                    hasReasoning: turn.hasReasoning,
                    ...(shouldAttachFullTurnContext ? {
                        summaryBody: turnGroupingContextBase.summaryBody,
                        activityParts: turnGroupingContextBase.activityParts,
                        activityGroupSegments: turnGroupingContextBase.activityGroupSegments,
                        headerMessageId: turnGroupingContextBase.headerMessageId,
                        diffStats: turnGroupingContextBase.diffStats,
                        changedFiles: turnGroupingContextBase.changedFiles,
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
            messageOrder.lookup,
            messageOrder.ordered,
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
            reviewTransferDirection,
            visibleAssistantMessages,
            visibleAssistantIds,
            visibleActivitySegments,
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
        <TurnItem
            turn={renderableTurn}
            stickyUserHeader={stickyUserHeader && !userMessageHidden}
            renderMessage={renderMessage}
        />
    );
});

TurnBlock.displayName = 'TurnBlock';

interface UngroupedMessageRowProps {
    message: ChatMessageEntry;
    previousMessage?: ChatMessageEntry;
    nextMessage?: ChatMessageEntry;
    scrollToBottom?: () => void;
    shouldAnimateUserMessage: (message: ChatMessageEntry) => boolean;
    onUserAnimationConsumed: (messageId: string) => void;
    activeStreamingMessageId?: string | null;
    activeStreamingPhase?: StreamPhase | null;
    reviewTransferDirection?: ReviewTransferDirection | null;
}

const UngroupedMessageRow = React.memo(({
    message,
    previousMessage,
    nextMessage,
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
            previousMessage={previousMessage}
            nextMessage={nextMessage}
            animateUserOnMount={shouldAnimateUserMessage(message)}
            onUserAnimationConsumed={onUserAnimationConsumed}
            scrollToBottom={scrollToBottom}
            isInActiveTurn={Boolean(activeStreamingMessageId) && message.info.id === activeStreamingMessageId}
            activeStreamingPhase={message.info.id === activeStreamingMessageId ? activeStreamingPhase : null}
            reviewTransferDirection={reviewTransferDirection}
        />
    );
});

UngroupedMessageRow.displayName = 'UngroupedMessageRow';

interface MessageListEntryProps {
    entry: RenderEntry;
    scrollToBottom?: () => void;
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
    reviewTransferDirection?: ReviewTransferDirection | null;
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
    reviewTransferDirection,
}: MessageListEntryProps) => {
    streamPerfCount('ui.message_list_entry.render');
    if (entry.kind === 'ungrouped') {
        return (
            <UngroupedMessageRow
                message={entry.message}
                previousMessage={entry.previousMessage}
                nextMessage={entry.nextMessage}
                scrollToBottom={scrollToBottom}
                shouldAnimateUserMessage={shouldAnimateUserMessage}
                onUserAnimationConsumed={onUserAnimationConsumed}
                activeStreamingMessageId={activeStreamingMessageId}
                activeStreamingPhase={activeStreamingPhase}
                reviewTransferDirection={reviewTransferDirection}
            />
        );
    }

    return (
        <TurnBlock
            turn={entry.turn}
            isLastTurn={entry.isLastTurn}
            nextEntryFirstMessage={entry.nextEntryFirstMessage}
            sessionIsWorking={sessionIsWorking}
            defaultActivityExpanded={defaultActivityExpanded}
            turnUiStates={turnUiStates}
            onToggleTurnGroup={onToggleTurnGroup}
            chatRenderMode={chatRenderMode}
            shouldAnimateUserMessage={shouldAnimateUserMessage}
            onUserAnimationConsumed={onUserAnimationConsumed}
            activeStreamingMessageId={activeStreamingMessageId}
            activeStreamingPhase={activeStreamingPhase}
            reviewTransferDirection={reviewTransferDirection}
            scrollToBottom={scrollToBottom}
            stickyUserHeader={stickyUserHeader}
        />
    );
});

MessageListEntry.displayName = 'MessageListEntry';

// Shared row state. Passed through context rather than closed over by
// `renderItem` so the render callback keeps a stable identity — a changing
// `renderItem` makes the list re-render every mounted row on every commit.
type TimelineRowContextValue = {
    scrollToBottom?: () => void;
    stickyUserHeader: boolean;
    defaultActivityExpanded: boolean;
    turnUiStates: Map<string, TurnUiState>;
    onToggleTurnGroup: (turnId: string) => void;
    chatRenderMode: 'sorted' | 'live';
    showTurnChangedFiles: boolean;
    shouldAnimateUserMessage: (message: ChatMessageEntry) => boolean;
    onUserAnimationConsumed: (messageId: string) => void;
    reviewTransferDirection?: ReviewTransferDirection | null;
    // The live tail row renders through StreamingTailContent, which subscribes
    // to streaming parts; every other row renders statically.
    streamingTailKey: string | null;
    directory?: string;
    sessionIsWorking: boolean;
    activeStreamingMessageId: string | null;
    activeStreamingPhase: StreamPhase | null;
};

const TimelineRowContext = React.createContext<TimelineRowContextValue | null>(null);

const TimelineRow = React.memo(({ entry }: { entry: RenderEntry }) => {
    const context = React.useContext(TimelineRowContext);
    if (!context) return null;

    if (context.streamingTailKey === entry.key) {
        return (
            <StreamingTailContent
                entry={entry}
                directory={context.directory}
                scrollToBottom={context.scrollToBottom}
                stickyUserHeader={context.stickyUserHeader}
                sessionIsWorking={context.sessionIsWorking}
                defaultActivityExpanded={context.defaultActivityExpanded}
                turnUiStates={context.turnUiStates}
                onToggleTurnGroup={context.onToggleTurnGroup}
                chatRenderMode={context.chatRenderMode}
                showTurnChangedFiles={context.showTurnChangedFiles}
                shouldAnimateUserMessage={context.shouldAnimateUserMessage}
                onUserAnimationConsumed={context.onUserAnimationConsumed}
                activeStreamingMessageId={context.activeStreamingMessageId}
                activeStreamingPhase={context.activeStreamingPhase}
                reviewTransferDirection={context.reviewTransferDirection}
            />
        );
    }

    return (
        <MessageListEntry
            entry={entry}
            scrollToBottom={context.scrollToBottom}
            stickyUserHeader={context.stickyUserHeader}
            sessionIsWorking={false}
            defaultActivityExpanded={context.defaultActivityExpanded}
            turnUiStates={context.turnUiStates}
            onToggleTurnGroup={context.onToggleTurnGroup}
            chatRenderMode={context.chatRenderMode}
            shouldAnimateUserMessage={context.shouldAnimateUserMessage}
            onUserAnimationConsumed={context.onUserAnimationConsumed}
            activeStreamingMessageId={null}
            activeStreamingPhase={null}
            reviewTransferDirection={context.reviewTransferDirection}
        />
    );
});

TimelineRow.displayName = 'TimelineRow';

const timelineKeyExtractor = (item: RenderEntry): string => item.key;

// Row type drives container reuse. Turn blocks and ungrouped messages have very
// different shapes, so keeping them in separate pools avoids re-measuring a
// container every time one replaces the other.
const timelineItemType = (item: RenderEntry): string => item.kind;

const renderTimelineItem = ({ item }: { item: RenderEntry }) => <TimelineRow entry={item} />;

type TimelineListProps = {
    entries: RenderEntry[];
    streamingTailKey: string | null;
    registerList: (list: LegendListRef | null) => void;
    endPinningReleased: boolean;
    anchoredEndSpace?: {
        anchorIndex: number;
        anchorOffset?: number;
        onReady?: (info: { anchorIndex: number | undefined; anchorKey: string | undefined; size: number }) => void;
        onSizeChanged?: (size: number) => void;
    };
    composerOverlayHeight: number;
    onIsAtEndChange: (isAtEnd: boolean) => void;
    onTimelineDataChange: () => void;
    listHeader?: React.ReactNode;
    listFooter?: React.ReactNode;
    scrollContainerProps?: TimelineScrollContainerProps;
    rowContext: TimelineRowContextValue;
};

const TimelineList = React.memo(({
    entries,
    registerList,
    endPinningReleased,
    anchoredEndSpace,
    composerOverlayHeight,
    onIsAtEndChange,
    onTimelineDataChange,
    listHeader,
    listFooter,
    scrollContainerProps,
    rowContext,
}: TimelineListProps) => {
    const listRef = React.useRef<LegendListRef | null>(null);
    // With streaming auto-follow off, content growth must never move the
    // viewport; explicit commands (the scroll-to-bottom pill, session open)
    // still scroll through the imperative handle.
    const streamingAutoFollowEnabled = useUIStore((state) => state.streamingAutoFollowEnabled);
    const isAtEndRef = React.useRef(true);

    const setListRef = React.useCallback((list: LegendListRef | null) => {
        listRef.current = list;
        registerList(list);
    }, [registerList]);

    // A width change re-wraps every row, so all content above the viewport
    // changes height at once; without size compensation the accumulated delta
    // throws the read position around. Size restoration stays off otherwise —
    // rows growing in place (a tool result expanding) must grow downward —
    // so compensation is enabled only while the list width is actively
    // resizing, and released shortly after it settles.
    const [isWidthResizing, setIsWidthResizing] = React.useState(false);
    React.useEffect(() => {
        const node = listRef.current?.getScrollableNode();
        if (!node) return;
        let lastWidth: number | null = null;
        let quietTimer: ReturnType<typeof setTimeout> | null = null;
        const observer = new ResizeObserver((observerEntries) => {
            const width = observerEntries[observerEntries.length - 1]?.contentRect.width;
            if (typeof width !== 'number') return;
            if (lastWidth === null) {
                lastWidth = width;
                return;
            }
            if (Math.abs(width - lastWidth) < 1) return;
            lastWidth = width;
            setIsWidthResizing(true);
            if (quietTimer !== null) clearTimeout(quietTimer);
            quietTimer = setTimeout(() => {
                quietTimer = null;
                setIsWidthResizing(false);
            }, 300);
        });
        observer.observe(node);
        return () => {
            observer.disconnect();
            if (quietTimer !== null) clearTimeout(quietTimer);
        };
    }, []);

    // The list reports scroll continuously; only end-crossings are interesting,
    // so the edge is debounced to a state transition here rather than pushing a
    // callback on every frame.
    const handleScroll = React.useCallback(() => {
        const state = listRef.current?.getState();
        if (!state) return;
        const isAtEnd = resolveTimelineIsAtEnd(state);
        if (typeof isAtEnd !== 'boolean' || isAtEnd === isAtEndRef.current) return;
        isAtEndRef.current = isAtEnd;
        onIsAtEndChange(isAtEnd);
    }, [onIsAtEndChange]);

    // Data changes are the only moment an automatic correction can be needed;
    // the owning hook decides whether one actually applies.
    React.useEffect(() => {
        onTimelineDataChange();
    }, [entries, onTimelineDataChange]);

    const header = React.useMemo(() => (listHeader ? <>{listHeader}</> : undefined), [listHeader]);
    const footer = React.useMemo(() => (listFooter ? <>{listFooter}</> : undefined), [listFooter]);

    return (
        <TimelineRowContext.Provider value={rowContext}>
            <LegendList<RenderEntry>
                ref={setListRef}
                data={entries}
                keyExtractor={timelineKeyExtractor}
                getItemType={timelineItemType}
                renderItem={renderTimelineItem}
                estimatedItemSize={TIMELINE_ESTIMATED_ENTRY_SIZE}
                initialScrollAtEnd
                // Chat rows own internal state (expanded tool calls, reveal
                // animations); recycling a container into a different row would
                // carry that state across.
                recycleItems={false}
                {...(anchoredEndSpace ? { anchoredEndSpace } : {})}
                contentInsetEndAdjustment={composerOverlayHeight}
                // While a turn is anchored, the reserved end space — not the
                // live edge — defines where the viewport rests.
                // Also released while the width resizes: re-pinning against
                // rows that are still re-measuring shakes the pinned
                // viewport; the owning hook re-asserts the end once the
                // resize settles.
                maintainScrollAtEnd={anchoredEndSpace || !streamingAutoFollowEnabled || isWidthResizing || endPinningReleased
                    ? false
                    // Animated only while the session actively streams: there
                    // the block-step growth turns each correction into a glide
                    // and reveal + scroll read as one motion. Outside of a live
                    // stream — opening a historical session, late measurements —
                    // corrections must be instant: an animated catch-up scrolls
                    // visibly through the whole conversation on open, and an
                    // in-flight glide can supersede explicit navigation.
                    : {
                        animated: rowContext.sessionIsWorking,
                        on: { dataChange: true, itemLayout: true, layout: true, footerLayout: true },
                    }}
                // Prepending older history must not move what the user is
                // reading. Size restoration applies only during a width
                // resize — see the observer above.
                maintainVisibleContentPosition={{ data: true, size: isWidthResizing }}
                onScroll={handleScroll}
                ListHeaderComponent={header}
                ListFooterComponent={footer}
                {...scrollContainerProps}
            />
        </TimelineRowContext.Provider>
    );
});

TimelineList.displayName = 'TimelineList';

const StreamingTailContent: React.FC<{
    entry: RenderEntry;
    directory?: string;
    scrollToBottom?: () => void;
    stickyUserHeader: boolean;
    sessionIsWorking: boolean;
    defaultActivityExpanded: boolean;
    turnUiStates: Map<string, TurnUiState>;
    onToggleTurnGroup: (turnId: string) => void;
    chatRenderMode: 'sorted' | 'live';
    showTurnChangedFiles: boolean;
    shouldAnimateUserMessage: (message: ChatMessageEntry) => boolean;
    onUserAnimationConsumed: (messageId: string) => void;
    activeStreamingMessageId?: string | null;
    activeStreamingPhase?: StreamPhase | null;
    reviewTransferDirection?: ReviewTransferDirection | null;
}> = ({
    entry,
    directory,
    scrollToBottom,
    stickyUserHeader,
    sessionIsWorking,
    defaultActivityExpanded,
    turnUiStates,
    onToggleTurnGroup,
    chatRenderMode,
    showTurnChangedFiles,
    shouldAnimateUserMessage,
    onUserAnimationConsumed,
    activeStreamingMessageId,
    activeStreamingPhase,
    reviewTransferDirection,
}) => {
    // Overlay live parts on every message of the tail, not only the one
    // currently streaming: a finished step message's base record can lag the
    // part store, and rendering it from that stale snapshot briefly unmounts
    // its completed tool parts when the stream hands off to the next message.
    const tailMessageIds = React.useMemo(() => {
        if (entry.kind === 'turn') return entry.turn.assistantMessageIds;
        return [entry.message.info.id];
    }, [entry]);
    const livePartsByMessageId = useSessionPartsForMessages(tailMessageIds, directory);
    const planModeEnabled = useFeatureFlagsStore((state) => state.planModeEnabled);
    const liveEntry = React.useMemo(() => buildLiveStreamingEntry(entry, {
        livePartsByMessageId,
        showTextJustificationActivity: chatRenderMode === 'sorted',
        showTurnChangedFiles,
        mergeHiddenUserTurns: { planModeEnabled },
    }), [chatRenderMode, entry, livePartsByMessageId, showTurnChangedFiles, planModeEnabled]);

    return (
        <MessageListEntry
            entry={liveEntry}
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
            reviewTransferDirection={reviewTransferDirection}
        />
    );
};

StreamingTailContent.displayName = 'StreamingTailContent';

const MessageList = React.forwardRef<MessageListHandle, MessageListProps>(({
    sessionKey,
    messages,
    sessionIsWorking = false,
    activeStreamingMessageId = null,
    activeStreamingPhase = null,
    retryOverlay = null,
    scrollToBottom,
    directory,
    registerList,
    endPinningReleased = false,
    anchorMessageId = null,
    onAnchorReady,
    onAnchorSizeChanged,
    composerOverlayHeight = 0,
    onIsAtEndChange,
    onTimelineDataChange,
    listHeader,
    listFooter,
    scrollContainerProps,
}, ref) => {
    streamPerfMark('react.message_list_render');
    streamPerfCount('ui.message_list.render');
    const stickyUserHeader = useUIStore(state => state.stickyUserHeader);
    const chatRenderMode = useUIStore((state) => state.chatRenderMode);
    const activityRenderMode = useUIStore((state) => state.activityRenderMode);
    const showTurnChangedFiles = useUIStore((state) => state.showTurnChangedFiles);
    const defaultActivityExpanded = activityRenderMode === 'summary';
    const reviewTransferDirection = useGlobalSessionsStore((state) => {
        return state.reviewTransferBySessionId.get(sessionKey) ?? null;
    });
    const [turnUiStates, setTurnUiStates] = React.useState<Map<string, TurnUiState>>(() => new Map());
    const userAnimationRef = React.useRef<{
        sessionKey: string | undefined;
        previousOrder: string[];
        animatedIds: Set<string>;
    }>({ sessionKey: undefined, previousOrder: [], animatedIds: new Set() });
    const stableScrollToBottom = useStableEvent(() => {
        scrollToBottom?.();
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
        const seenIds = new Set<string>();
        const latestById = new Map<string, ChatMessageEntry>();
        const dedupedMessages: ChatMessageEntry[] = [];
        for (const message of messages) {
            const messageId = message.info?.id;
            if (typeof messageId === 'string') latestById.set(messageId, message);
        }

        // Preserve the first occurrence's chronological position, but use the last
        // value because prepended history can overlap with newer live store data.
        for (let index = 0; index < messages.length; index += 1) {
            const message = messages[index];
            const messageId = message.info?.id;
            if (typeof messageId === 'string') {
                if (seenIds.has(messageId)) {
                    continue;
                }
                seenIds.add(messageId);
            }
            dedupedMessages.push(getNormalizedMessageForDisplay(
                typeof messageId === 'string' ? latestById.get(messageId) ?? message : message,
            ));
        }

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

    // The list owns the scroll container. The DOM fallback covers the window
    // between mount and the list handing us its node.
    const resolveScrollContainer = React.useCallback((): HTMLElement | null => {
        const listNode = listRef.current?.getScrollableNode();
        if (listNode) {
            return listNode;
        }
        if (typeof document === 'undefined') {
            return null;
        }
        return document.querySelector<HTMLDivElement>('[data-scrollbar="chat"]');
    }, []);

    const displayMessages = React.useMemo(() => streamPerfMeasure('ui.message_list.retry_overlay_ms', () => {
        return applyRetryOverlay(baseDisplayMessages, {
            sessionId: retryOverlay?.sessionId ?? null,
            message: retryOverlay?.message ?? 'Quota limit reached. Retrying automatically.',
            confirmedAt: retryOverlay?.confirmedAt,
            fallbackTimestamp: retryOverlay?.fallbackTimestamp ?? 0,
        });
    }), [baseDisplayMessages, retryOverlay]);

    const planModeEnabled = useFeatureFlagsStore((state) => state.planModeEnabled);
    const { projection, staticTurns, streamingTurn } = useTurnRecords(displayMessages, {
        sessionKey,
        showTextJustificationActivity: chatRenderMode === 'sorted',
        showTurnChangedFiles,
        planModeEnabled,
    });
    const hasUngroupedStaticEntries = projection.ungroupedMessageIds.size > 0;
    const staticEntryMessages = hasUngroupedStaticEntries ? displayMessages : EMPTY_STATIC_ENTRY_MESSAGES;
    const staticEntryUngroupedIds = hasUngroupedStaticEntries ? projection.ungroupedMessageIds : EMPTY_UNGROUPED_MESSAGE_IDS;
    const staticRenderEntries = React.useMemo<RenderEntry[]>(() => streamPerfMeasure('ui.message_list.render_entries_ms', () => {
        const turnEntries = staticTurns.map((turn) => ({
            kind: 'turn' as const,
            key: `turn:${turn.turnId}`,
            turn,
            isLastTurn: turn.turnId === projection.lastTurnId,
        }));

        if (staticEntryUngroupedIds.size === 0) {
            return turnEntries;
        }

        const turnEntryByUserMessageId = new Map<string, RenderEntry>();
        turnEntries.forEach((entry) => {
            turnEntryByUserMessageId.set(entry.turn.userMessage.info.id, entry);
        });

        const orderedEntries: RenderEntry[] = [];
        staticEntryMessages.forEach((message, index) => {
            const turnEntry = turnEntryByUserMessageId.get(message.info.id);
            if (turnEntry) {
                orderedEntries.push(turnEntry);
                return;
            }

            if (!staticEntryUngroupedIds.has(message.info.id)) {
                return;
            }

            orderedEntries.push({
                kind: 'ungrouped',
                key: `msg:${message.info.id}`,
                message,
                previousMessage: index > 0 ? staticEntryMessages[index - 1] : undefined,
                nextMessage: index < staticEntryMessages.length - 1 ? staticEntryMessages[index + 1] : undefined,
            });
        });

        return orderedEntries;
    }), [projection.lastTurnId, staticEntryMessages, staticEntryUngroupedIds, staticTurns]);

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

    // Depend on the trailing entry's first message (stable while its assistant
    // streams), not the trailing entry itself, so streaming updates do not
    // recreate every static entry and re-render every turn block.
    const trailingEntryFirstMessage = trailingStreamingEntry
        ? (trailingStreamingEntry.kind === 'turn' ? trailingStreamingEntry.turn.userMessage : trailingStreamingEntry.message)
        : undefined;
    const historyEntries = React.useMemo<RenderEntry[]>(() => {
        return staticRenderEntries.map((entry, index) => {
            if (entry.kind !== 'turn') {
                return entry;
            }
            const nextEntryFirstMessage = index < staticRenderEntries.length - 1
                ? (() => {
                    const nextEntry = staticRenderEntries[index + 1];
                    return nextEntry.kind === 'turn' ? nextEntry.turn.userMessage : nextEntry.message;
                })()
                : trailingEntryFirstMessage;
            if (!nextEntryFirstMessage) {
                return entry;
            }
            return { ...entry, nextEntryFirstMessage };
        });
    }, [staticRenderEntries, trailingEntryFirstMessage]);
    // Every surface uses the same virtualized list for the whole timeline —
    // there is no small-list DOM path to transition out of, which is what used
    // to remount the history subtree mid-prepend.
    const listRef = React.useRef<LegendListRef | null>(null);
    const handleRegisterList = React.useCallback((list: LegendListRef | null) => {
        listRef.current = list;
        registerList?.(list);
    }, [registerList]);

    const allEntries = React.useMemo(() => {
        return trailingStreamingEntry ? [...historyEntries, trailingStreamingEntry] : historyEntries;
    }, [historyEntries, trailingStreamingEntry]);

    // Stable identities: these reach the list, where a changing callback would
    // re-render every mounted row.
    const stableIsAtEndChange = useStableEvent((isAtEnd: boolean) => {
        onIsAtEndChange?.(isAtEnd);
    });

    const stableTimelineDataChange = useStableEvent(() => {
        onTimelineDataChange?.();
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

    // Accepts any index the list renders, the trailing streaming entry
    // included — it lives at historyEntries.length and is a legitimate
    // navigation target (the timeline rail's last item).
    const scrollHistoryIndexIntoView = React.useCallback((index: number) => {
        if (index < 0 || index >= allEntries.length) {
            return false;
        }

        const list = listRef.current;
        if (!list) {
            return false;
        }

        // Unanimated: an unmounted target's position is still an estimate, and
        // a smooth scroll would end at that stale offset once the real
        // measurement replaces it. Mounted targets still take the smooth DOM
        // path in scrollMessageElementIntoView.
        void list.scrollToIndex({ index, animated: false, viewPosition: 0 });
        return true;
    }, [allEntries.length]);

    // A navigation scroll lands on estimates: an unmounted target teleports
    // to its estimated offset, and even a mounted one drifts when neighbours
    // finish measuring a frame later. This settle loop re-aligns the target to
    // the requested viewport position until the layout stops moving, and backs
    // off the moment the user touches the scroll.
    const settleNavigationTarget = React.useCallback((
        findElement: () => HTMLElement | null,
        desiredOffsetTop: number,
    ) => {
        const container = resolveScrollContainer();
        if (!container || typeof window === 'undefined') {
            return;
        }
        let frames = 0;
        let stable = 0;
        let cancelled = false;
        const cancelOnUserInput = () => {
            cancelled = true;
            container.removeEventListener('touchstart', cancelOnUserInput);
            container.removeEventListener('wheel', cancelOnUserInput);
        };
        container.addEventListener('touchstart', cancelOnUserInput, { passive: true });
        container.addEventListener('wheel', cancelOnUserInput, { passive: true });
        const step = () => {
            if (cancelled) return;
            const element = findElement();
            if (element) {
                const delta = element.getBoundingClientRect().top
                    - container.getBoundingClientRect().top
                    - desiredOffsetTop;
                if (Math.abs(delta) > 0.5) {
                    container.scrollTop += delta;
                    stable = 0;
                } else {
                    stable += 1;
                }
            }
            frames += 1;
            if (stable >= ANCHOR_HOLD_STABLE_FRAMES || frames >= ANCHOR_HOLD_MAX_FRAMES) {
                container.removeEventListener('touchstart', cancelOnUserInput);
                container.removeEventListener('wheel', cancelOnUserInput);
                return;
            }
            window.requestAnimationFrame(step);
        };
        window.requestAnimationFrame(step);
    }, [resolveScrollContainer]);

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
                const findTurnElement = () => container.querySelector<HTMLElement>(`[data-turn-id="${turnId}"]`);
                const turnElement = findTurnElement();
                if (turnElement) {
                    turnElement.scrollIntoView({ behavior, block: 'start' });
                    if (behavior !== 'smooth') settleNavigationTarget(findTurnElement, 0);
                    return true;
                }

                if (!scrollHistoryIndexIntoView(index)) {
                    return false;
                }
                if (behavior !== 'smooth') settleNavigationTarget(findTurnElement, 0);
                return true;
            },

            scrollToMessageId: (messageId: string, options?: { behavior?: ScrollBehavior }) => {
                const behavior = options?.behavior ?? 'auto';
                const index = messageIndexMap.get(messageId);
                if (index === undefined) {
                    return false;
                }

                const didScroll = scrollMessageElementIntoView(messageId, behavior)
                    || scrollHistoryIndexIntoView(index);
                if (didScroll && behavior !== 'smooth') {
                    settleNavigationTarget(() => findMessageElement(messageId), 50);
                }
                return didScroll;
            },

            holdViewportAnchor: (anchor) => {
                const container = resolveScrollContainer();
                if (!container || typeof window === 'undefined') {
                    return;
                }

                let frames = 0;
                let stable = 0;
                let cancelled = false;
                const cancelOnUserInput = () => {
                    cancelled = true;
                    container.removeEventListener('touchstart', cancelOnUserInput);
                    container.removeEventListener('wheel', cancelOnUserInput);
                };
                container.addEventListener('touchstart', cancelOnUserInput, { passive: true });
                container.addEventListener('wheel', cancelOnUserInput, { passive: true });
                const step = () => {
                    if (cancelled) return;
                    const element = findMessageElement(anchor.messageId);
                    if (element) {
                        const delta = element.getBoundingClientRect().top
                            - container.getBoundingClientRect().top
                            - anchor.offsetTop;
                        if (Math.abs(delta) > 0.5) {
                            container.scrollTop += delta;
                            stable = 0;
                        } else {
                            stable += 1;
                        }
                    }
                    frames += 1;
                    if (stable >= ANCHOR_HOLD_STABLE_FRAMES || frames >= ANCHOR_HOLD_MAX_FRAMES) {
                        container.removeEventListener('touchstart', cancelOnUserInput);
                        container.removeEventListener('wheel', cancelOnUserInput);
                        return;
                    }
                    window.requestAnimationFrame(step);
                };
                window.requestAnimationFrame(step);
            },

            // The timeline is always virtualized now; the flag stays so callers
            // that branch on it keep compiling and take the virtualized path.
            isHistoryVirtualized: () => true,

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

                    return !isInsideStuckSticky(node, container, containerRect.top);
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
                        return scrollHistoryIndexIntoView(index);
                    }
                }

                return applyAnchor();
            },

            scrollToBottom: () => {
                const list = listRef.current;
                if (list) {
                    void list.scrollToEnd({ animated: false });
                    return;
                }
                const container = resolveScrollContainer();
                if (!container) return;
                // Overshoot so the browser clamps to the exact fractional
                // maximum (scrollHeight is integer-rounded).
                container.scrollTop = container.scrollHeight + 4096;
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
    }, [findMessageElement, historyEntries.length, messageIndexMap, resolveScrollContainer, scrollHistoryIndexIntoView, scrollMessageElementIntoView, settleNavigationTarget, turnIndexMap, ref]);

    const anchoredEndSpace = React.useMemo<TimelineAnchoredEndSpace | undefined>(() => {
        const resolved = resolveChatListAnchoredEndSpace(
            allEntries,
            anchorMessageId,
            (entry) => (entry.kind === 'turn' ? entry.turn.userMessage.info.id : entry.message.info.id),
        );
        if (!resolved || !anchorMessageId) {
            return undefined;
        }
        return {
            ...resolved,
            onReady: (info) => {
                if (info.anchorIndex === undefined) return;
                onAnchorReady?.(anchorMessageId, info.anchorIndex);
            },
            onSizeChanged: () => {
                onAnchorSizeChanged?.(anchorMessageId);
            },
        };
    }, [allEntries, anchorMessageId, onAnchorReady, onAnchorSizeChanged]);

    const rowContext = React.useMemo(() => ({
        scrollToBottom: stableScrollToBottom,
        stickyUserHeader,
        defaultActivityExpanded,
        turnUiStates,
        onToggleTurnGroup: toggleTurnGroup,
        chatRenderMode,
        showTurnChangedFiles,
        shouldAnimateUserMessage,
        onUserAnimationConsumed,
        reviewTransferDirection,
        streamingTailKey: trailingStreamingEntry?.key ?? null,
        directory,
        sessionIsWorking,
        activeStreamingMessageId,
        activeStreamingPhase,
    }), [
        activeStreamingMessageId,
        activeStreamingPhase,
        chatRenderMode,
        defaultActivityExpanded,
        directory,
        onUserAnimationConsumed,
        reviewTransferDirection,
        sessionIsWorking,
        shouldAnimateUserMessage,
        showTurnChangedFiles,
        stableScrollToBottom,
        stickyUserHeader,
        toggleTurnGroup,
        trailingStreamingEntry?.key,
        turnUiStates,
    ]);

    return (
        // Virtualized rows unmount/remount during scroll; re-running the reveal
        // fade on every remount reads as blinking. Rows are never "new" from the
        // list's point of view, so fade-in is disabled for them — content
        // arriving inside the streaming tail keeps its own animations.
        <FadeInDisabledProvider disabled>
            <TimelineList
                key={sessionKey}
                entries={allEntries}
                streamingTailKey={trailingStreamingEntry?.key ?? null}
                registerList={handleRegisterList}
                anchoredEndSpace={anchoredEndSpace}
                composerOverlayHeight={composerOverlayHeight}
                onIsAtEndChange={stableIsAtEndChange}
                onTimelineDataChange={stableTimelineDataChange}
                listHeader={listHeader}
                listFooter={listFooter}
                scrollContainerProps={scrollContainerProps}
                rowContext={rowContext}
                endPinningReleased={endPinningReleased}
            />
        </FadeInDisabledProvider>
    );
});

MessageList.displayName = 'MessageList';

export default React.memo(MessageList);
