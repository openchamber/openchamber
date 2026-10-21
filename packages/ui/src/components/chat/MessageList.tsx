import React from 'react';
import { LegendList, type LegendListRef } from '@legendapp/list/react';

import ChatMessage from './ChatMessage';
import { TimelineNotice } from './message/TimelineNotice';
import { readSessionNotice } from '@/lib/opencode/session-notices';
import { useRunningSubagentRuns, withRunningSubagentRuns } from './lib/runningSubagentRuns';
import { isSkippedTimelineMessage, isBackgroundReportEntry, isTimelineNoticeRole } from './lib/timelineRoles';
import { earlierAssistantText } from './lib/turns/earlierAssistantText';
import { areOptionalRenderRelevantMessagesEqual, areRelevantTurnGroupingContextsEqual, areRenderRelevantMessagesEqual } from './message/renderCompare';
import TurnItem from './components/TurnItem';
import { LiveTurnActivity } from './components/LiveTurnActivity';
import { getTurnsWithLaterAssistant, hasLiveActivity } from './lib/turns/liveActivity';
import type { ChatMessageEntry, TurnRecord, TurnGroupingContext } from './lib/turns/types';
import { useTurnRecords } from './hooks/useTurnRecords';
import { buildHistoryEntries, findFirstVisibleMessageId, type TimelineEntry } from './lib/turns/timelineEntries';
import { applyRetryOverlay } from './lib/turns/applyRetryOverlay';
import { buildLiveStreamingEntry } from './lib/turns/streamingTailEntry';
import { FULL_MESSAGE_WINDOW, TurnMessageWindowContext, createTurnMessageWindowStore } from './lib/turns/turnMessageWindow';
import { getNormalizedMessageForDisplay } from './lib/messageDisplayNormalization';
import { attachSyntheticContext } from './lib/attachSyntheticContext';
import { useUIStore } from '@/stores/useUIStore';
import { FadeInDisabledProvider } from './message/FadeInOnReveal';
import { hasPendingUserSendAnimation, consumePendingUserSendAnimation } from '@/lib/userSendAnimation';
import { streamPerfCount, streamPerfMark, streamPerfMeasure } from '@/stores/utils/streamDebug';
import type { StreamPhase } from './message/types';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useSessionPartsForMessages } from '@/sync/sync-context';
import type { ReviewTransferDirection } from '@/lib/reviewFlow';
import { resolveTimelineIsAtEnd } from './lib/scroll/timelineScrollAnchoring';
import { isReasoningRevealTarget } from './search/reasoningReveal';
import {
    ANCHOR_HOLD_MAX_FRAMES,
    ANCHOR_HOLD_STABLE_FRAMES,
    captureMessageViewportAnchor,
    type MessageViewportAnchor,
    type ViewportAnchorAlignment,
} from './lib/scroll/messageViewportAnchor';

const EMPTY_STATIC_ENTRY_MESSAGES: ChatMessageEntry[] = [];
const EMPTY_UNGROUPED_MESSAGE_IDS = new Set<string>();
const EMPTY_ROW_MESSAGE_IDS: readonly string[] = [];

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
const TIMELINE_ESTIMATED_ENTRY_SIZE = 320;

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
    composerOverlayHeight?: number;
    onIsAtEndChange?: (isAtEnd: boolean) => void;
    onListMetricsChange?: (metrics: { readonly footerSize: number }) => void;
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
    captureViewportAnchor: () => MessageViewportAnchor | null;
    restoreViewportAnchor: (anchor: MessageViewportAnchor) => boolean;
    // One step toward showing the anchor at its offset: `moved` when the
    // viewport had to scroll (the row may still be positioned from an
    // estimate), `aligned` when it already sits there, `missing` when the
    // message is not in the loaded timeline.
    alignViewportAnchor: (anchor: MessageViewportAnchor) => ViewportAnchorAlignment;
    holdViewportAnchor: (anchor: { messageId: string; offsetTop: number }) => void;
    isHistoryVirtualized: () => boolean;
    scrollToBottom: () => void;
}

type RenderEntry = TimelineEntry;

type ToggleTurnActivity = (turnId: string) => void;

// Which settled Activity folds the reader opened. It outlives the list, like
// tool expansion in ChatMessage: returning to a session shows its folds as they
// were left, which a restored reading position inside an open fold depends on.
// Turn IDs are message IDs, unique across sessions. The folds only exist in
// the collapsed activity mode, so a mode switch drops everything.
const TURN_EXPANSION_CACHE_MAX = 4000;
const turnExpansionCache = new Map<string, boolean>();
let turnExpansionCacheMode: string | null = null;

const readTurnExpansionCache = (activityRenderMode: string): Map<string, boolean> => {
    if (turnExpansionCacheMode !== activityRenderMode) {
        turnExpansionCache.clear();
        turnExpansionCacheMode = activityRenderMode;
    }
    return new Map(turnExpansionCache);
};

const writeTurnExpansionCache = (turnId: string, expanded: boolean): void => {
    turnExpansionCache.delete(turnId);
    turnExpansionCache.set(turnId, expanded);
    if (turnExpansionCache.size > TURN_EXPANSION_CACHE_MAX) {
        const oldest = turnExpansionCache.keys().next().value;
        if (oldest !== undefined) turnExpansionCache.delete(oldest);
    }
};



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

const MessageRow = React.memo<MessageRowProps>(({ 
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
    // Roles that are not a conversation turn render as their own timeline row
    // (or as nothing); only user and assistant go through ChatMessage.
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

interface TurnBlockProps {
    turn: TurnRecord;
    hasLaterAssistant?: boolean;
    isLastTurn: boolean;
    nextEntryFirstMessage?: ChatMessageEntry;
    sessionIsWorking: boolean;
    defaultActivityExpanded: boolean;
    turnExpansion: Map<string, boolean>;
    onToggleTurnActivity: ToggleTurnActivity;
    scrollToBottom?: () => void;
    shouldAnimateUserMessage: (message: ChatMessageEntry) => boolean;
    onUserAnimationConsumed: (messageId: string) => void;
    activeStreamingMessageId?: string | null;
    activeStreamingPhase?: StreamPhase | null;
    reviewTransferDirection?: ReviewTransferDirection | null;
}

const TurnBlock = React.memo(({
    turn,
    hasLaterAssistant = false,
    isLastTurn,
    nextEntryFirstMessage,
    sessionIsWorking,
    defaultActivityExpanded,
    turnExpansion,
    onToggleTurnActivity,
    scrollToBottom,
    shouldAnimateUserMessage,
    onUserAnimationConsumed,
    activeStreamingMessageId,
    activeStreamingPhase,
    reviewTransferDirection,
}: TurnBlockProps) => {

    const showReasoningTraces = useUIStore((state) => state.showReasoningTraces);
    const isActivityExpanded = turnExpansion.get(turn.turnId) === true;
    const handleToggleActivity = React.useCallback(() => {
        onToggleTurnActivity(turn.turnId);
    }, [onToggleTurnActivity, turn.turnId]);

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

    // Besides the first and the last message, the step streaming right now
    // also gets the turn-wide context.
    const activityOwnerMessageId = React.useMemo(() => {
        if (turnIsInActiveStream && streamingAssistantMessageId) {
            return streamingAssistantMessageId;
        }
        return turn.assistantMessages[0]?.info.id;
    }, [streamingAssistantMessageId, turnIsInActiveStream, turn.assistantMessages]);

    const turnGroupingContextBase = React.useMemo(() => {
        const userCreatedAt = (turn.userMessage.info.time as { created?: number } | undefined)?.created;
        // The variant lives on the assistant message that ran with it, not on
        // the prompt. Take the turn's first assistant step: later steps of the
        // same turn run with the same selection, and it is available before
        // the final answer exists.
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

    const renderMessage = React.useCallback(
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

    return (
        <TurnItem
            turn={turn}
            renderMessage={renderMessage}
            assistantContent={!defaultActivityExpanded && hasLiveActivity(turn, showReasoningTraces) ? (
                <LiveTurnActivity
                    turn={turn}
                    hasLaterAssistant={hasLaterAssistant}
                    expanded={isActivityExpanded}
                    onToggle={handleToggleActivity}
                    renderMessage={renderMessage}
                />
            ) : undefined}
        />
    );
});

TurnBlock.displayName = 'TurnBlock';

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

const UngroupedMessageRow = React.memo(({
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

interface MessageListEntryProps {
    entry: RenderEntry;
    scrollToBottom?: () => void;
    sessionIsWorking: boolean;
    defaultActivityExpanded: boolean;
    turnExpansion: Map<string, boolean>;
    onToggleTurnActivity: ToggleTurnActivity;
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
    sessionIsWorking,
    defaultActivityExpanded,
    turnExpansion,
    onToggleTurnActivity,
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
                nextMessage={entry.nextMessage}
                isFirstRow={entry.isFirstRow}
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
            hasLaterAssistant={entry.hasLaterAssistant}
            isLastTurn={entry.isLastTurn}
            nextEntryFirstMessage={entry.nextEntryFirstMessage}
            sessionIsWorking={sessionIsWorking}
            defaultActivityExpanded={defaultActivityExpanded}
            turnExpansion={turnExpansion}
            onToggleTurnActivity={onToggleTurnActivity}
            shouldAnimateUserMessage={shouldAnimateUserMessage}
            onUserAnimationConsumed={onUserAnimationConsumed}
            activeStreamingMessageId={activeStreamingMessageId}
            activeStreamingPhase={activeStreamingPhase}
            reviewTransferDirection={reviewTransferDirection}
            scrollToBottom={scrollToBottom}
        />
    );
});

MessageListEntry.displayName = 'MessageListEntry';

// Shared row state. Passed through context rather than closed over by
// `renderItem` so the render callback keeps a stable identity — a changing
// `renderItem` makes the list re-render every mounted row on every commit.
type TimelineRowContextValue = {
    scrollToBottom?: () => void;
    defaultActivityExpanded: boolean;
    turnExpansion: Map<string, boolean>;
    onToggleTurnActivity: ToggleTurnActivity;
    showTurnChangedFiles: boolean;
    shouldAnimateUserMessage: (message: ChatMessageEntry) => boolean;
    onUserAnimationConsumed: (messageId: string) => void;
    reviewTransferDirection?: ReviewTransferDirection | null;
    // The live tail row subscribes to streaming parts; every other row renders
    // statically (see TimelineRowContent).
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

    const live = context.streamingTailKey === entry.key;
    return (
        <TimelineRowContent
            entry={entry}
            live={live}
            directory={context.directory}
            scrollToBottom={context.scrollToBottom}
            sessionIsWorking={live && context.sessionIsWorking}
            defaultActivityExpanded={context.defaultActivityExpanded}
            turnExpansion={context.turnExpansion}
            onToggleTurnActivity={context.onToggleTurnActivity}
            showTurnChangedFiles={context.showTurnChangedFiles}
            shouldAnimateUserMessage={context.shouldAnimateUserMessage}
            onUserAnimationConsumed={context.onUserAnimationConsumed}
            activeStreamingMessageId={live ? context.activeStreamingMessageId : null}
            activeStreamingPhase={live ? context.activeStreamingPhase : null}
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
    composerOverlayHeight: number;
    onIsAtEndChange: (isAtEnd: boolean) => void;
    onListMetricsChange: (metrics: { readonly footerSize: number }) => void;
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
    composerOverlayHeight,
    onIsAtEndChange,
    onListMetricsChange,
    onTimelineDataChange,
    listHeader,
    listFooter,
    scrollContainerProps,
    rowContext,
}: TimelineListProps) => {
    const listRef = React.useRef<LegendListRef | null>(null);
    const isAtEndRef = React.useRef(true);

    const setListRef = React.useCallback((list: LegendListRef | null) => {
        listRef.current = list;
        registerList(list);
    }, [registerList]);

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
                contentInsetEndAdjustment={composerOverlayHeight}
                // Off: the owning hook (useChatTimelineScroll) is the only
                // writer that keeps the end in view, instantly at rest and as
                // a glide while output streams. With the list following too,
                // two writers issued competing scrolls for every growth step,
                // one of them against a content length the list had not
                // settled yet.
                maintainScrollAtEnd={false}
                // A prepend first positions rows using estimated heights;
                // later measurements must preserve the same visible row too.
                // Keep size compensation active while reading history, including
                // when scrolling mounts older rows above the viewport. A pinned
                // reader is held on the end by the owning hook instead.
                maintainVisibleContentPosition={{ data: true, size: endPinningReleased }}
                onScroll={handleScroll}
                onMetricsChange={onListMetricsChange}
                ListHeaderComponent={header}
                ListFooterComponent={footer}
                {...scrollContainerProps}
            />
        </TimelineRowContext.Provider>
    );
});

TimelineList.displayName = 'TimelineList';

// Every row renders through this one component, live tail or history, so a
// row keeps its React tree when it moves between the two. The live tail
// changes on every send and on a revert; with a different component per role
// the row remounted, its state reset for a commit (a long user message lost
// its "show full message" link), and the list measured that frame as the
// row's height. The next row then sat that much too high until a later
// re-measure.
const TimelineRowContent: React.FC<{
    entry: RenderEntry;
    live: boolean;
    directory?: string;
    scrollToBottom?: () => void;
    sessionIsWorking: boolean;
    defaultActivityExpanded: boolean;
    turnExpansion: Map<string, boolean>;
    onToggleTurnActivity: ToggleTurnActivity;
    showTurnChangedFiles: boolean;
    shouldAnimateUserMessage: (message: ChatMessageEntry) => boolean;
    onUserAnimationConsumed: (messageId: string) => void;
    activeStreamingMessageId?: string | null;
    activeStreamingPhase?: StreamPhase | null;
    reviewTransferDirection?: ReviewTransferDirection | null;
}> = ({
    entry,
    live,
    directory,
    scrollToBottom,
    sessionIsWorking,
    defaultActivityExpanded,
    turnExpansion,
    onToggleTurnActivity,
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
    // A history row subscribes to nothing.
    const tailMessageIds = React.useMemo(() => {
        if (!live) return EMPTY_ROW_MESSAGE_IDS;
        if (entry.kind === 'turn') return entry.turn.assistantMessageIds;
        return [entry.message.info.id];
    }, [entry, live]);
    const livePartsByMessageId = useSessionPartsForMessages(tailMessageIds, directory);
    const rowEntry = React.useMemo(() => (live ? buildLiveStreamingEntry(entry, {
        livePartsByMessageId,
        showTurnChangedFiles,
        mergeHiddenUserTurns: true,
    }) : entry), [entry, live, livePartsByMessageId, showTurnChangedFiles]);

    return (
        <MessageListEntry
            entry={rowEntry}
            scrollToBottom={scrollToBottom}
            sessionIsWorking={sessionIsWorking}
            defaultActivityExpanded={defaultActivityExpanded}
            turnExpansion={turnExpansion}
            onToggleTurnActivity={onToggleTurnActivity}
            shouldAnimateUserMessage={shouldAnimateUserMessage}
            onUserAnimationConsumed={onUserAnimationConsumed}
            activeStreamingMessageId={activeStreamingMessageId}
            activeStreamingPhase={activeStreamingPhase}
            reviewTransferDirection={reviewTransferDirection}
        />
    );
};

TimelineRowContent.displayName = 'TimelineRowContent';

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
    composerOverlayHeight = 0,
    onIsAtEndChange,
    onListMetricsChange,
    onTimelineDataChange,
    listHeader,
    listFooter,
    scrollContainerProps,
}, ref) => {
    streamPerfMark('react.message_list_render');
    streamPerfCount('ui.message_list.render');
    const activityRenderMode = useUIStore((state) => state.activityRenderMode);
    const showTurnChangedFiles = useUIStore((state) => state.showTurnChangedFiles);
    const defaultActivityExpanded = activityRenderMode === 'summary';
    const reviewTransferDirection = useGlobalSessionsStore((state) => {
        return state.reviewTransferBySessionId.get(sessionKey) ?? null;
    });
    const [turnExpansion, setTurnExpansion] = React.useState<Map<string, boolean>>(() => readTurnExpansionCache(activityRenderMode));
    const userAnimationRef = React.useRef<{
        sessionKey: string | undefined;
        previousOrder: string[];
        animatedIds: Set<string>;
    }>({ sessionKey: undefined, previousOrder: [], animatedIds: new Set() });
    const stableScrollToBottom = useStableEvent(() => {
        scrollToBottom?.();
    });

    const turnExpansionModeRef = React.useRef(activityRenderMode);
    React.useEffect(() => {
        if (turnExpansionModeRef.current === activityRenderMode) return;
        turnExpansionModeRef.current = activityRenderMode;
        setTurnExpansion(readTurnExpansionCache(activityRenderMode));
    }, [activityRenderMode]);

    const toggleTurnActivity = React.useCallback((turnId: string) => {
        setTurnExpansion((previous) => {
            const expanded = previous.get(turnId) !== true;
            writeTurnExpansionCache(turnId, expanded);
            return new Map(previous).set(turnId, expanded);
        });
    }, []);


    const runningSubagentRuns = useRunningSubagentRuns(sessionKey, directory);

    const baseDisplayMessages = React.useMemo(() => streamPerfMeasure('ui.message_list.base_display_ms', () => {
        const timeline = withRunningSubagentRuns(messages, runningSubagentRuns);
        const seenIds = new Set<string>();
        const latestById = new Map<string, ChatMessageEntry>();
        const dedupedMessages: ChatMessageEntry[] = [];
        for (const message of timeline) {
            const messageId = message.info?.id;
            if (typeof messageId === 'string') latestById.set(messageId, message);
        }

        // Preserve the first occurrence's chronological position, but use the last
        // value because prepended history can overlap with newer live store data.
        for (let index = 0; index < timeline.length; index += 1) {
            const message = timeline[index];
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

        // v2 gives compaction, shell commands and subtasks their own message
        // roles and tool parts, so the timeline needs no bridge-message
        // stitching. What is left is folding the messages injected around a
        // prompt back where they belong: composer context onto its user
        // message, plumbing out of the list entirely.
        return attachSyntheticContext(dedupedMessages);
    }), [messages, runningSubagentRuns]);

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

    const { projection, staticTurns, streamingTurn } = useTurnRecords(displayMessages, {
        sessionKey,
        showTurnChangedFiles,
    });
    const hasUngroupedStaticEntries = projection.ungroupedMessageIds.size > 0;
    const tailHasAssistant = Boolean(streamingTurn?.assistantMessages.length);
    const turnsWithLaterAssistant = React.useMemo(() => {
        if (defaultActivityExpanded) return new Set<string>();
        const retired = getTurnsWithLaterAssistant(staticTurns);
        if (tailHasAssistant) {
            for (const turn of staticTurns) retired.add(turn.turnId);
        }
        return retired;
    }, [defaultActivityExpanded, staticTurns, tailHasAssistant]);
    const staticEntryMessages = hasUngroupedStaticEntries ? displayMessages : EMPTY_STATIC_ENTRY_MESSAGES;
    const staticEntryUngroupedIds = hasUngroupedStaticEntries ? projection.ungroupedMessageIds : EMPTY_UNGROUPED_MESSAGE_IDS;
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
            nextMessage: undefined,
            isFirstRow: findFirstVisibleMessageId(displayMessages) === lastMessage.info.id,
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
    const previousHistoryEntriesRef = React.useRef<RenderEntry[]>([]);
    const hasStreamingTurn = Boolean(streamingTurn);
    const historyEntries = React.useMemo(() => streamPerfMeasure('ui.message_list.render_entries_ms', () => {
        const entries = buildHistoryEntries({
            staticTurns,
            lastTurnId: projection.lastTurnId,
            turnsWithLaterAssistant,
            messages: staticEntryMessages,
            ungroupedMessageIds: staticEntryUngroupedIds,
            hasStreamingTurn,
            trailingEntryFirstMessage,
        }, previousHistoryEntriesRef.current);
        previousHistoryEntriesRef.current = entries;
        return entries;
    }), [hasStreamingTurn, projection.lastTurnId, staticEntryMessages, staticEntryUngroupedIds, staticTurns, trailingEntryFirstMessage, turnsWithLaterAssistant]);
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

    const stableListMetricsChange = useStableEvent((metrics: { readonly footerSize: number }) => {
        onListMetricsChange?.(metrics);
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

    // Row lookups for navigation, built in one pass over the rows. Assistant
    // messages before a turn's last one are collapsible: in a collapsed turn
    // their text sits inside the folded activity and has no row of its own.
    // Reasoning of any of a turn's messages, the last one included, sits in
    // that fold too.
    const {
        messageIndexMap,
        turnIndexMap,
        collapsibleTurnByMessageId,
        turnByAssistantMessageId,
    } = React.useMemo(() => {
        const messageIndexes = new Map<string, number>();
        const turnIndexes = new Map<string, number>();
        const collapsible = new Map<string, string>();
        const all = new Map<string, string>();
        allEntries.forEach((entry, index) => {
            if (entry.kind === 'ungrouped') {
                messageIndexes.set(entry.message.info.id, index);
                return;
            }
            const { turnId, userMessage, assistantMessages } = entry.turn;
            turnIndexes.set(turnId, index);
            messageIndexes.set(userMessage.info.id, index);
            assistantMessages.forEach((message, assistantIndex) => {
                const messageId = message.info.id;
                messageIndexes.set(messageId, index);
                all.set(messageId, turnId);
                if (assistantIndex < assistantMessages.length - 1) collapsible.set(messageId, turnId);
            });
        });
        return {
            messageIndexMap: messageIndexes,
            turnIndexMap: turnIndexes,
            collapsibleTurnByMessageId: collapsible,
            turnByAssistantMessageId: all,
        };
    }, [allEntries]);
    const turnExpansionRef = React.useRef(turnExpansion);
    turnExpansionRef.current = turnExpansion;

    // The list remounts per session, so entering a session again mounts only
    // the newest messages of its long turns.
    const [turnMessageWindow] = React.useState(createTurnMessageWindowStore);

    /**
     * Mounts the whole turn holding a message that navigation is about to
     * reach but that its turn has not mounted yet (see TurnMessageWindow).
     */
    const mountWindowedMessage = React.useCallback((messageId: string): void => {
        const turnId = turnByAssistantMessageId.get(messageId);
        if (turnId) turnMessageWindow.setRange(turnId, FULL_MESSAGE_WINDOW);
    }, [turnByAssistantMessageId, turnMessageWindow]);

    /**
     * Opens the turn a linked or searched message is folded into, the way a
     * browser's find opens a closed <details>. True when it had to open it:
     * the row renders the message on a later frame.
     */
    const revealFoldedMessage = React.useCallback((messageId: string): boolean => {
        const turnId = isReasoningRevealTarget(messageId)
            ? turnByAssistantMessageId.get(messageId)
            : collapsibleTurnByMessageId.get(messageId);
        if (!turnId) return false;
        if (turnExpansionRef.current.get(turnId) === true) return false;
        writeTurnExpansionCache(turnId, true);
        setTurnExpansion((previous) => new Map(previous).set(turnId, true));
        return true;
    }, [collapsibleTurnByMessageId, turnByAssistantMessageId]);

    const findMessageElement = React.useCallback((messageId: string): HTMLElement | null => {
        const container = resolveScrollContainer();
        if (!container) {
            return null;
        }
        // A search hit in reasoning lands on the reasoning block itself rather
        // than the top of its message.
        if (isReasoningRevealTarget(messageId)) {
            const reasoning = container.querySelector<HTMLElement>(`[data-reasoning-message-id="${messageId}"]`);
            if (reasoning) return reasoning;
        }
        return container.querySelector(`[data-message-id="${messageId}"]`);
    }, [resolveScrollContainer]);

    // A message the head of its turn's window cuts into is mounted from a
    // later row on: its element's top is not the message's start.
    const isMessageCut = React.useCallback((messageId: string): boolean => (
        Boolean(resolveScrollContainer()?.querySelector(`[data-turn-message-cut="${messageId}"]`))
    ), [resolveScrollContainer]);

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

    const alignViewportAnchor = React.useCallback((anchor: MessageViewportAnchor): ViewportAnchorAlignment => {
        const index = messageIndexMap.get(anchor.messageId);
        const container = resolveScrollContainer();
        if (index === undefined || !container) {
            return 'missing';
        }
        if (revealFoldedMessage(anchor.messageId)) {
            scrollHistoryIndexIntoView(index);
            return 'moved';
        }

        const element = isMessageCut(anchor.messageId) ? null : findMessageElement(anchor.messageId);
        if (!element) {
            // Not mounted, or mounted from a later row: bring its row in from
            // the estimate; the next step measures the real position.
            mountWindowedMessage(anchor.messageId);
            return scrollHistoryIndexIntoView(index) ? 'moved' : 'missing';
        }
        const delta = element.getBoundingClientRect().top
            - container.getBoundingClientRect().top
            - anchor.offsetTop;
        if (Math.abs(delta) <= 0.5) {
            return 'aligned';
        }
        const before = container.scrollTop;
        container.scrollTop += delta;
        // A message near either end of the timeline cannot reach the offset:
        // the scroll is clamped, and where it stopped is as close as it gets.
        return Math.abs(container.scrollTop - before) < 0.5 ? 'aligned' : 'moved';
    }, [findMessageElement, isMessageCut, messageIndexMap, mountWindowedMessage, resolveScrollContainer, revealFoldedMessage, scrollHistoryIndexIntoView]);

    // Installed during layout so a parent's layout effect (session entry
    // restore) already reaches this list, not the one it replaced.
    React.useLayoutEffect(() => {
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

                if (!findMessageElement(messageId) || isMessageCut(messageId)) mountWindowedMessage(messageId);
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
                return container ? captureMessageViewportAnchor(container) : null;
            },

            restoreViewportAnchor: (anchor) => alignViewportAnchor(anchor) !== 'missing',

            alignViewportAnchor,

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
    }, [alignViewportAnchor, findMessageElement, isMessageCut, messageIndexMap, mountWindowedMessage, resolveScrollContainer, scrollHistoryIndexIntoView, scrollMessageElementIntoView, settleNavigationTarget, turnIndexMap, ref]);

    const rowContext = React.useMemo(() => ({
        scrollToBottom: stableScrollToBottom,
        defaultActivityExpanded,
        turnExpansion,
        onToggleTurnActivity: toggleTurnActivity,
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
        defaultActivityExpanded,
        directory,
        onUserAnimationConsumed,
        reviewTransferDirection,
        sessionIsWorking,
        shouldAnimateUserMessage,
        showTurnChangedFiles,
        stableScrollToBottom,
        toggleTurnActivity,
        trailingStreamingEntry?.key,
        turnExpansion,
    ]);

    return (
        // Virtualized rows unmount/remount during scroll; re-running the reveal
        // fade on every remount reads as blinking. Rows are never "new" from the
        // list's point of view, so fade-in is disabled for them — content
        // arriving inside the streaming tail keeps its own animations.
        <FadeInDisabledProvider disabled>
            <TurnMessageWindowContext.Provider value={turnMessageWindow}>
                <TimelineList
                    key={sessionKey}
                    entries={allEntries}
                    streamingTailKey={trailingStreamingEntry?.key ?? null}
                    registerList={handleRegisterList}
                    composerOverlayHeight={composerOverlayHeight}
                    onIsAtEndChange={stableIsAtEndChange}
                    onListMetricsChange={stableListMetricsChange}
                    onTimelineDataChange={stableTimelineDataChange}
                    listHeader={listHeader}
                    listFooter={listFooter}
                    scrollContainerProps={scrollContainerProps}
                    rowContext={rowContext}
                    endPinningReleased={endPinningReleased}
                />
            </TurnMessageWindowContext.Provider>
        </FadeInDisabledProvider>
    );
});

MessageList.displayName = 'MessageList';

export default React.memo(MessageList);
