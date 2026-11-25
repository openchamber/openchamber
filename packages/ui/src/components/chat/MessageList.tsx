import React from 'react';
import type { LegendListRef } from '@legendapp/list/react';

import { useUIStore } from '@/stores/useUIStore';
import { FadeInDisabledProvider } from './message/FadeInOnReveal';
import { streamPerfCount, streamPerfMark } from '@/stores/utils/streamDebug';
import type { StreamPhase } from './message/types';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import type { ChatMessageEntry } from './lib/turns/types';
import { LiveTailSource } from './timeline/LiveTailSource';
import { createLiveTailStore } from './timeline/liveTailStore';
import { RowsSnapshot } from './timeline/RowsSnapshot';
import { TimelineList } from './timeline/TimelineList';
import { useStableEvent } from './timeline/useStableEvent';
import { useTurnExpansion } from './timeline/useTurnExpansion';
import { useDisplayMessages } from './timeline/useDisplayMessages';
import { useTimelineRows } from './timeline/useTimelineRows';
import { useApprovalFooter } from './timeline/useApprovalFooter';
import { useUserSendAnimation } from './timeline/useUserSendAnimation';
import { useTimelineListBinding } from './timeline/useTimelineListBinding';
import { useTimelineRowIndexes } from './timeline/useTimelineRowIndexes';
import { useFoldMotion } from '@/hooks/useFoldMotion';
import { useMessageListHandle } from './timeline/useMessageListHandle';
import type {
    ListMetrics,
    MessageListHandle,
    RetryOverlay,
    TimelineScrollContainerProps,
} from './timeline/types';

export type { MessageListHandle } from './timeline/types';

interface MessageListProps {
    sessionKey: string;
    messages: ChatMessageEntry[];
    sessionIsWorking?: boolean;
    activeStreamingMessageId?: string | null;
    activeStreamingPhase?: StreamPhase | null;
    retryOverlay?: RetryOverlay | null;
    isLoadingOlder: boolean;
    scrollToBottom?: () => void;
    directory?: string;
    registerList?: (list: LegendListRef | null) => void;
    endPinningReleased?: boolean;
    composerOverlayHeight?: number;
    onIsAtEndChange?: (isAtEnd: boolean) => void;
    onListMetricsChange?: (metrics: ListMetrics) => void;
    onTimelineDataChange?: () => void;
    listHeader?: React.ReactNode;
    listFooter?: React.ReactNode;
    scrollContainerProps?: TimelineScrollContainerProps;
}

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
    const showReasoningTraces = useUIStore((state) => state.showReasoningTraces);
    const collapsibleThinkingBlocks = useUIStore((state) => state.collapsibleThinkingBlocks);
    const stickyUserHeader = useUIStore((state) => state.stickyUserHeader);
    const defaultActivityExpanded = activityRenderMode !== 'collapsed';
    const reviewTransferDirection = useGlobalSessionsStore((state) => {
        return state.reviewTransferBySessionId.get(sessionKey) ?? null;
    });
    const stableScrollToBottom = useStableEvent(() => {
        scrollToBottom?.();
    });

    const { turnExpansion, toggleTurnActivity, expandTurnActivity } = useTurnExpansion(activityRenderMode);
    const { baseDisplayMessages, displayMessages } = useDisplayMessages(
        messages,
        sessionKey,
        directory,
        retryOverlay,
    );
    const { projection, allEntries, trailingStreamingEntry, rows, stickyRowIndices } = useTimelineRows(sessionKey, displayMessages, {
        showTurnChangedFiles,
        showReasoningTraces,
        stickyUserHeader,
        defaultActivityExpanded,
        groupedActivity: activityRenderMode === 'grouped',
        sessionIsWorking,
        directory,
        turnExpansion,
    });
    const footerWithApprovals = useApprovalFooter(sessionKey, directory, baseDisplayMessages, trailingStreamingEntry, listFooter);

    const [liveTail] = React.useState(createLiveTailStore);
    const {
        listRef,
        handleRegisterList,
        stableIsAtEndChange,
        stableTimelineDataChange,
        stableListMetricsChange,
    } = useTimelineListBinding({ registerList, onIsAtEndChange, onTimelineDataChange, onListMetricsChange });
    const { shouldAnimateUserMessage, onUserAnimationConsumed } = useUserSendAnimation(sessionKey, messages);

    const indexes = useTimelineRowIndexes(rows, allEntries);
    useMessageListHandle(ref, {
        sessionKey,
        listRef,
        rows,
        projection,
        defaultActivityExpanded,
        indexes,
        expandTurnActivity,
    });

    const { toggle: toggleWithMotion, captureSelfClosing } = useFoldMotion(listRef, sessionKey, rows, turnExpansion, toggleTurnActivity);

    const rowContext = React.useMemo(() => ({
        scrollToBottom: stableScrollToBottom,
        turnExpansion,
        onToggleTurnActivity: toggleWithMotion,
        shouldAnimateUserMessage,
        onUserAnimationConsumed,
        reviewTransferDirection,
        streamingTailKey: trailingStreamingEntry?.key ?? null,
        liveTail,
        sessionIsWorking,
        activeStreamingMessageId,
        activeStreamingPhase,
    }), [
        activeStreamingMessageId,
        activeStreamingPhase,
        liveTail,
        onUserAnimationConsumed,
        reviewTransferDirection,
        sessionIsWorking,
        shouldAnimateUserMessage,
        stableScrollToBottom,
        toggleWithMotion,
        trailingStreamingEntry?.key,
        turnExpansion,
    ]);

    return (
        <FadeInDisabledProvider disabled>
            <RowsSnapshot rows={rows} onBeforeChange={captureSelfClosing} />
            <LiveTailSource entry={trailingStreamingEntry} directory={directory}
                showTurnChangedFiles={showTurnChangedFiles} store={liveTail} />
            <TimelineList
                key={sessionKey}
                rows={rows}
                stickyRowIndices={stickyRowIndices}
                registerList={handleRegisterList}
                composerOverlayHeight={composerOverlayHeight}
                onIsAtEndChange={stableIsAtEndChange}
                onListMetricsChange={stableListMetricsChange}
                onTimelineDataChange={stableTimelineDataChange}
                listHeader={listHeader}
                listFooter={footerWithApprovals}
                scrollContainerProps={scrollContainerProps}
                rowContext={rowContext}
                endPinningReleased={endPinningReleased}
                showReasoningTraces={showReasoningTraces}
                collapsibleThinkingBlocks={collapsibleThinkingBlocks}
            />
        </FadeInDisabledProvider>
    );
});

MessageList.displayName = 'MessageList';

export default React.memo(MessageList);
