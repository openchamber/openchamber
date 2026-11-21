import React from 'react';
import { SessionRecapNote } from '@/components/chat/SessionRecapSpacer';
import type { Message, Part } from '@/lib/opencode/model';
import { ChatColumnSessionContext, type ChatColumnSession } from '../chatColumnSession';
import { ChatTranscriptContext } from './ChatTranscriptContext';
import { Button } from '@/components/ui/button';
import { KeepAlive } from '@/components/ui/KeepAlive';
import MessageList, { type MessageListHandle } from '../MessageList';
import type { TimelineRevealGate } from '../timelineRevealGate';
import {
    FLOATING_COMPOSER_DEFAULT_TAIL_INSET_PX,
    FLOATING_COMPOSER_GAP_PX,
} from '@/components/chat/composer/state/composerTailInset';
import { registerComposerInsetReader } from '@/components/chat/composer/state/composerInsetReaders';
import { SessionErrorNotice } from '@/components/chat/SessionErrorNotice';
import { PromptNavigatorRail } from '../components/PromptNavigatorRail';
import type { TimelineListHandle } from '@/hooks/useChatTimelineScroll';
import { OverlayScrollbar } from '@/components/ui/OverlayScrollbar';
import { Icon } from "@/components/icon/Icon";
import { cn } from '@/lib/utils';
import { TranscriptForms } from '../TranscriptForms';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { isMobileSurfaceRuntime } from '@/lib/runtimeSurface';
import { useMessageSelectionClicks } from '../messageSelection/useMessageSelectionClicks';
import { useI18n } from '@/lib/i18n';
import { CHAT_SCROLL_STYLE } from './chatScrollStyle';
import { shouldIgnoreChatNavigationTarget } from './chatKeyboardNavigation';
import { usePromptRail } from './usePromptRail';
import { useTimelineReveal } from './useTimelineReveal';
import type { RetryOverlay } from '../timeline/types';

type SessionMessageRecord = { info: Message; parts: Part[] };

type ChatViewportProps = {
    placeholder: React.ReactNode;
    currentSessionId: string;
    currentSessionKey: string;
    isDesktopExpandedInput: boolean;
    isMobile: boolean;
    formsInChat: boolean;
    tableExpansion: boolean;
    floatingComposer: boolean;
    statusRowClearance: number;
    directory?: string;
    scrollRef: React.RefObject<HTMLDivElement | null>;
    messageListRef: React.RefObject<MessageListHandle | null>;
    registerList: (list: TimelineListHandle | null, sessionKey?: string) => void;
    captureOutgoingPosition: () => void;
    onIsAtEndChange: (isAtEnd: boolean) => void;
    onListMetricsChange: (metrics: { readonly headerSize: number; readonly footerSize: number }) => void;
    onTimelineDataChange: () => void;
    renderedMessages: SessionMessageRecord[];
    isLoadingOlder: boolean;
    sessionIsWorking: boolean;
    streamingMessageId: string | null;
    activeStreamingPhase: import('../message/types').StreamPhase | null;
    retryOverlay: RetryOverlay | null;
    scrollToBottom: () => void;
    onScrollbarDrag: () => void;
    endPinningReleased: boolean;
    revealGate: TimelineRevealGate;
    isProgrammaticFollowActive: boolean;
    showLoadOlderButton: boolean;
    onLoadOlder: () => void;
    turnIds: string[];
    activeTurnId: string | null;
    onSelectTurn: (turnId: string) => void;
    showPromptNavigator: boolean;
    canLoadEarlierPrompts: boolean;
    isLoadingOlderPrompts: boolean;
    onLoadEarlierPrompts: () => void;
};

const retainedTimelines = () => (isMobileSurfaceRuntime() ? 1 : 4);

export const ChatViewport = React.memo(({
    placeholder,
    currentSessionId,
    currentSessionKey,
    isDesktopExpandedInput,
    isMobile,
    formsInChat,
    tableExpansion,
    floatingComposer,
    statusRowClearance,
    directory,
    scrollRef,
    messageListRef,
    registerList,
    captureOutgoingPosition,
    onIsAtEndChange,
    onListMetricsChange,
    onTimelineDataChange,
    renderedMessages,
    isLoadingOlder,
    sessionIsWorking,
    streamingMessageId,
    activeStreamingPhase,
    retryOverlay,
    scrollToBottom,
    onScrollbarDrag,
    endPinningReleased,
    revealGate,
    isProgrammaticFollowActive,
    showLoadOlderButton,
    onLoadOlder,
    turnIds,
    activeTurnId,
    onSelectTurn,
    showPromptNavigator,
    canLoadEarlierPrompts,
    isLoadingOlderPrompts,
    onLoadEarlierPrompts,
}: ChatViewportProps) => {
    const { t } = useI18n();
    const messageSelection = useMessageSelectionClicks(currentSessionId, directory);
    const session = React.useMemo<ChatColumnSession>(() => ({
        sessionId: currentSessionId,
        directory: directory ?? null,
    }), [currentSessionId, directory]);
    const registerSessionList = React.useCallback((list: TimelineListHandle | null) => {
        registerList(list, currentSessionKey);
    }, [currentSessionKey, registerList]);
    const showingTranscript = placeholder === undefined;
    const { promptPreviewsByTurnId, promptTurnIds, railActiveTurnId } = usePromptRail({ renderedMessages, turnIds, activeTurnId });
    const focusScrollContainer = React.useCallback((event: React.MouseEvent<HTMLElement>) => {
        if (event.defaultPrevented || shouldIgnoreChatNavigationTarget(event.target)) {
            return;
        }

        if (typeof window !== 'undefined' && window.getSelection()?.type === 'Range') {
            return;
        }

        scrollRef.current?.focus({ preventScroll: true });
    }, [scrollRef]);

    const listHeader = React.useMemo(() => (
        <div className="flex h-12 justify-center pt-3 pb-1">
            {showLoadOlderButton ? (
                <Button
                    variant="secondary"
                    size="sm"
                    onClick={onLoadOlder}
                    disabled={isLoadingOlder}
                >
                    {isLoadingOlder && (
                        <Icon name="loader-4" className="size-4 animate-spin" />
                    )}
                    {t('chat.history.loadOlder')}
                </Button>
            ) : null}
        </div>
    ), [isLoadingOlder, onLoadOlder, showLoadOlderButton, t]);

    const listFooter = React.useMemo(() => (
        <>
            <SessionErrorNotice sessionId={currentSessionId} directory={directory} />
            {formsInChat && currentSessionId ? <TranscriptForms sessionId={currentSessionId} directory={directory} /> : null}

            <div
                ref={registerComposerInsetReader}
                className="relative flex-shrink-0"
                style={{
                    height: floatingComposer
                        ? `calc(${sessionIsWorking
                            ? `max(var(--chat-composer-tail-inset, ${FLOATING_COMPOSER_DEFAULT_TAIL_INSET_PX}px), var(--chat-composer-inset, 0px) + ${FLOATING_COMPOSER_GAP_PX}px)`
                            : `var(--chat-composer-tail-inset, ${FLOATING_COMPOSER_DEFAULT_TAIL_INSET_PX}px)`} + var(--chat-floating-panel-reserve, 0px))`
                        : (isMobile ? '40px' : '10vh'),
                }}
            >
                {floatingComposer && currentSessionId ? (
                    <div className="oc-recap-hint pointer-events-none absolute inset-x-0 top-0 transition-opacity duration-300 ease-out">
                        <div className="chat-message-column">
                            <SessionRecapNote sessionId={currentSessionId} directory={directory} isMobile={isMobile} />
                        </div>
                    </div>
                ) : null}
            </div>
        </>
    ), [currentSessionId, directory, floatingComposer, formsInChat, isMobile, sessionIsWorking]);

    const endFadeStyle: React.CSSProperties & Record<'--chat-status-row-clearance', string> = {
        '--chat-status-row-clearance': `${statusRowClearance}px`,
    };

    const timelineRootRef = React.useRef<HTMLDivElement | null>(null);
    useTimelineReveal({ timelineRootRef, scrollRef, revealGate, showingTranscript, endPinningReleased });

    const scrollContainerProps = React.useMemo(() => ({
        className: 'absolute inset-0 overflow-y-auto overflow-x-hidden z-0 chat-scroll overlay-scrollbar-target',
        style: CHAT_SCROLL_STYLE,
        tabIndex: 0,
        onClick: focusScrollContainer,
        'data-scrollbar': 'chat',
        'data-scroll-shadow': 'true',
        'data-orientation': 'vertical',
    }), [focusScrollContainer]);

    return (
        <>
            {placeholder}
            <div
                className={cn(
                    'relative min-h-0',
                    isDesktopExpandedInput
                        ? 'absolute inset-0 opacity-0 pointer-events-none'
                        : 'flex-1',
                )}
                ref={timelineRootRef}
                style={showingTranscript ? undefined : { display: 'none' }}
                aria-hidden={isDesktopExpandedInput}
                data-message-selecting={messageSelection.selecting ? '' : undefined}
                onClickCapture={messageSelection.onClickCapture}
            >
                <div className="absolute inset-0">
                    <KeepAlive
                        key={getRuntimeKey()}
                        cacheKey={showingTranscript ? currentSessionId : null}
                        capacity={retainedTimelines()}
                        onBeforeHide={captureOutgoingPosition}
                    >
                        <ChatTranscriptContext.Provider value={tableExpansion}>
                            <ChatColumnSessionContext.Provider value={session}>
                                <MessageList
                                    key={currentSessionKey}
                                    ref={messageListRef}
                                    sessionKey={currentSessionId}
                                    messages={renderedMessages}
                                    sessionIsWorking={sessionIsWorking}
                                    activeStreamingMessageId={streamingMessageId}
                                    activeStreamingPhase={activeStreamingPhase}
                                    retryOverlay={retryOverlay}
                                    isLoadingOlder={isLoadingOlder}
                                    scrollToBottom={scrollToBottom}
                                    endPinningReleased={endPinningReleased}
                                    directory={directory}
                                    registerList={registerSessionList}
                                    composerOverlayHeight={0}
                                    onIsAtEndChange={onIsAtEndChange}
                                    onListMetricsChange={onListMetricsChange}
                                    onTimelineDataChange={onTimelineDataChange}
                                    listHeader={listHeader}
                                    listFooter={listFooter}
                                    scrollContainerProps={scrollContainerProps}
                                />
                            </ChatColumnSessionContext.Provider>
                        </ChatTranscriptContext.Provider>
                    </KeepAlive>
                    <div aria-hidden="true" className="chat-scroll-fade chat-scroll-fade--top" />
                    <div
                        ref={registerComposerInsetReader}
                        aria-hidden="true"
                        className="chat-scroll-fade chat-scroll-fade--end"
                        style={endFadeStyle}
                    />
                    <OverlayScrollbar
                        containerRef={scrollRef}
                        disableHorizontal
                        suppressVisibility={isProgrammaticFollowActive}
                        userIntentOnly
                        observeMutations={false}
                        onThumbDragStart={onScrollbarDrag}
                    />
                    {showPromptNavigator && promptTurnIds.length >= 3 ? (
                        <PromptNavigatorRail
                            sessionId={currentSessionId}
                            directory={directory}
                            turnIds={promptTurnIds}
                            previewsByTurnId={promptPreviewsByTurnId}
                            activeTurnId={railActiveTurnId}
                            onSelectTurn={onSelectTurn}
                            canLoadEarlier={canLoadEarlierPrompts}
                            isLoadingOlder={isLoadingOlderPrompts}
                            onLoadEarlier={onLoadEarlierPrompts}
                        />
                    ) : null}
                </div>
            </div>
        </>
    );
}, (prev, next) => {
    return prev.currentSessionId === next.currentSessionId
        && prev.placeholder === next.placeholder
        && prev.currentSessionKey === next.currentSessionKey
        && prev.isDesktopExpandedInput === next.isDesktopExpandedInput
        && prev.isMobile === next.isMobile
        && prev.formsInChat === next.formsInChat
        && prev.tableExpansion === next.tableExpansion
        && prev.floatingComposer === next.floatingComposer
        && prev.statusRowClearance === next.statusRowClearance
        && prev.directory === next.directory
        && prev.scrollRef === next.scrollRef
        && prev.messageListRef === next.messageListRef
        && prev.renderedMessages === next.renderedMessages
        && prev.isLoadingOlder === next.isLoadingOlder
        && prev.sessionIsWorking === next.sessionIsWorking
        && prev.streamingMessageId === next.streamingMessageId
        && prev.activeStreamingPhase === next.activeStreamingPhase
        && prev.retryOverlay === next.retryOverlay
        && prev.scrollToBottom === next.scrollToBottom
        && prev.onScrollbarDrag === next.onScrollbarDrag
        && prev.onListMetricsChange === next.onListMetricsChange
        && prev.endPinningReleased === next.endPinningReleased
        && prev.revealGate === next.revealGate
        && prev.isProgrammaticFollowActive === next.isProgrammaticFollowActive
        && prev.showLoadOlderButton === next.showLoadOlderButton
        && prev.onLoadOlder === next.onLoadOlder
        && prev.turnIds === next.turnIds
        && prev.activeTurnId === next.activeTurnId
        && prev.onSelectTurn === next.onSelectTurn
        && prev.showPromptNavigator === next.showPromptNavigator
        && prev.canLoadEarlierPrompts === next.canLoadEarlierPrompts
        && prev.isLoadingOlderPrompts === next.isLoadingOlderPrompts
        && prev.onLoadEarlierPrompts === next.onLoadEarlierPrompts;
});

ChatViewport.displayName = 'ChatViewport';
