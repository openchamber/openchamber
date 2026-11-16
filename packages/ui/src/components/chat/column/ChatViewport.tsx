import React from 'react';
import { SessionRecapNote } from '@/components/chat/SessionRecapSpacer';
import type { Message, Part } from '@/lib/opencode/model';
import { ChatColumnSessionContext, type ChatColumnSession } from '../chatColumnSession';
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

type SessionMessageRecord = { info: Message; parts: Part[] };

type ChatViewportProps = {
    /** Loading, error, draft or empty content; undefined shows the transcript. */
    placeholder: React.ReactNode;
    currentSessionId: string;
    currentSessionKey: string;
    isDesktopExpandedInput: boolean;
    isMobile: boolean;
    /** Waiting questions show as cards at the end of the transcript, not in the composer's dock. */
    formsInChat: boolean;
    /** The composer floats over the transcript and reserves its band via
        `--chat-composer-tail-inset` on the tail spacer (composerInsetReaders). */
    floatingComposer: boolean;
    /** Height the floating status row takes above the composer while the
        session works, px; 0 when there is no row. */
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
    retryOverlay: {
        sessionId: string;
        message: string;
        confirmedAt?: number;
        fallbackTimestamp?: number;
    } | null;
    scrollToBottom: () => void;
    /** A drag on the overlay scrollbar's thumb takes the scroll from auto-follow. */
    onScrollbarDrag: () => void;
    endPinningReleased: boolean;
    /** The user waited for this session (held or fetched); reveal it with a fade. */
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

// Sessions kept mounted per chat column, the open one included, so returning
// to a recent one reuses its timeline. Each retained timeline costs a few MB
// of DOM, and a phone's web view is killed under memory pressure, so the
// mobile surface keeps only the open session.
const retainedTimelines = () => (isMobileSurfaceRuntime() ? 1 : 4);

export const ChatViewport = React.memo(({
    placeholder,
    currentSessionId,
    currentSessionKey,
    isDesktopExpandedInput,
    isMobile,
    formsInChat,
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

    // Everything that used to sit beside the list inside the scroll container
    // now renders as the list's header/footer, so it keeps scrolling with the
    // rows exactly as before.
    //
    // The header is a fixed-height slot that is always there, button or not.
    // A header that came and went with history coverage changed the height
    // above the rows, and a reader on the end saw the whole transcript jump
    // by it (after a revert, mid-send). Only the button inside it toggles.
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
            {/* Permissions dock above the composer (`PermissionDock`); forms
                too (`FormDock`) unless questions are set to show in the chat. */}
            <SessionErrorNotice sessionId={currentSessionId} directory={directory} />
            {formsInChat && currentSessionId ? <TranscriptForms sessionId={currentSessionId} directory={directory} /> : null}

            {/* Tail spacer. With a floating composer it reserves the band the
                composer covers, plus any panel docked above it (queue, BTW),
                so the end of the transcript stays readable above them; the
                extra gap is the breathing room between the last row and the
                top edge of whatever floats. Both heights come from CSS
                variables written straight by observers (the composer's onto
                this element itself, see composerInsetReaders), so a growing
                composer or panel resizes the footer without a list re-render;
                the list's own footer observer then extends the content.
                While the session works, the composer gets no growth
                allowance: the status row and the live end fade sit in the
                gap, so a composer grown into it (a background command, a
                queued message) left the last line under the row. */}
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
                {/* The recap of the latest answer lies at the top of this band,
                    right under the answer's footer: it takes no room, so its
                    arrival and leaving move nothing. Rows of the list paint
                    only inside their own box (`contain: paint`), so it lives
                    here rather than in the answer's row. It goes once a new
                    prompt makes the session busy, and while the composer grows
                    into the band or a panel docks over it (design-system.css). */}
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
                    {/* Retained by session ID: the session key also holds the
                        directory, which settles after the session opens, and
                        a key change left a hidden second copy of the open
                        session. The list still remounts on a key change. */}
                    <KeepAlive
                        key={getRuntimeKey()}
                        cacheKey={showingTranscript ? currentSessionId : null}
                        capacity={retainedTimelines()}
                        onBeforeHide={captureOutgoingPosition}
                    >
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
                                // The footer already reserves the composer's band.
                                composerOverlayHeight={0}
                                onIsAtEndChange={onIsAtEndChange}
                                onListMetricsChange={onListMetricsChange}
                                onTimelineDataChange={onTimelineDataChange}
                                listHeader={listHeader}
                                listFooter={listFooter}
                                scrollContainerProps={scrollContainerProps}
                            />
                        </ChatColumnSessionContext.Provider>
                    </KeepAlive>
                    {/* The transcript's edge fades must follow the scroller. */}
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
                    {/* From three turns: with one or two its mark read as a stray dash. */}
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
