import React from 'react';
import { createPortal } from 'react-dom';
import type { Session } from '@/lib/opencode/model';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useGlobalSyncStore } from '@/sync/global-sync-store';
import { useSessionSelector } from '@/sync/sync-context';
import ChatEmptyState from './ChatEmptyState';
import { type MessageListHandle } from './MessageList';
import { useScrollShadow } from '@/components/ui/useScrollShadow';
import { useMobileCommentComposerOwner } from './composer/comment/MobileCommentComposerContext';
import { ChatQuoteHighlightLayer } from './message/ChatQuoteHighlightLayer';
import { useChatSurfaceMode } from './useChatSurfaceMode';
import { useDeviceInfo } from '@/lib/device';
import { useI18n } from '@/lib/i18n';
import { isVSCodeRuntime } from '@/lib/desktop';
import { SEMANTIC_TYPOGRAPHY, VSCODE_TYPOGRAPHY, getScaledTypographyStyle } from '@/lib/typography';
import { ChatSearchBar } from './search/ChatSearchBar';
import { WorkStatusPanel } from './work-status/WorkStatusPanel';
import { TimelineDialog } from './TimelineDialog';
import { FormDockModeContext, resolveFormDockMode, resolveFormsInChat } from './formsInChat';
import { ChatColumnProviders } from './column/ChatColumnProviders';
import { ChatViewport } from './column/ChatViewport';
import { ComposerSlot } from './column/ComposerSlot';
import { HoistedUiPageSelection } from './column/HoistedUiPageSelection';
import { ReturnToParentButton } from './column/ReturnToParentButton';
import { LeadDigestRow } from './column/LeadDigestRow';
import { resolveSessionPlaceholder } from './column/sessionPlaceholder';
import { useAutoOpenDraft, useChatColumnSelection } from './column/useChatColumnSelection';
import { useChatColumnScope } from './column/useChatColumnScope';
import { useChatColumnControls } from './column/useChatColumnControls';
import { useChatSearch } from './column/useChatSearch';
import { useColumnAutoReadAloud } from './column/useColumnAutoReadAloud';
import { useColumnHistory } from './column/useColumnHistory';
import { useColumnMessages } from './column/useColumnMessages';
import { useColumnPromptReadOnly } from './column/useColumnPromptReadOnly';
import { useColumnQuoteNavigation } from './column/useColumnQuoteNavigation';
import { useColumnSessionActivity, useRetryOverlay } from './column/useColumnSessionActivity';
import { useColumnSessionLoad } from './column/useColumnSessionLoad';
import { useColumnTimelineScroll } from './column/useColumnTimelineScroll';
import { useColumnTurnNavigation } from './column/useColumnTurnNavigation';
import { useComposerPresentation } from './column/useComposerPresentation';
import { useStatusOverlayHeight } from './column/useStatusOverlayHeight';
import { useWorkStatusPlacement } from './column/useWorkStatusPlacement';

type ChatContainerProps = {
    active?: boolean;
    autoOpenDraft?: boolean;
    readOnly?: boolean;
    pinnedSession?: { sessionId: string; directory: string | null };
    registerParentSessionBack?: (handler: (() => void) | null) => void;
};

const selectSessionLastIdleAt = (session: Session | undefined): number | null => session?.time.idle ?? null;

export const ChatContainer: React.FC<ChatContainerProps> = ({
    active = true,
    autoOpenDraft: autoOpenDraftProp = true,
    readOnly = false,
    pinnedSession,
    registerParentSessionBack,
}) => {
    const { t } = useI18n();
    const {
        pinned,
        autoOpenDraft,
        pinnedOrigin,
        setPinnedSelection,
        liveSessionId,
        materializedDraftSessionId,
        currentSessionId,
        currentSessionDirectory,
    } = useChatColumnSelection({ pinnedSession, autoOpenDraft: autoOpenDraftProp });

    const clearMaterializedDraftSession = useSessionUIStore((s) => s.clearMaterializedDraftSession);
    const newSessionDraft = useSessionUIStore((s) => s.newSessionDraft);

    const {
        sync,
        effectiveSessionDirectory,
        messageLoader,
        currentSessionKey,
        revealGate,
        chatColumnSession,
        ensureSessionRenderable,
        loadMoreMessages,
    } = useChatColumnScope({ pinned, currentSessionId, currentSessionDirectory });
    const mobileCommentComposer = useMobileCommentComposerOwner();

    const isExpandedInput = useUIStore((state) => (pinned ? false : state.isExpandedInput));
    const stickyUserHeader = useUIStore((state) => state.stickyUserHeader);
    const questionsInChat = useUIStore((state) => state.questionsInChat);
    const chatFontSize = useUIStore((state) => state.chatFontSize);
    // SAFETY: CSS custom properties are valid inline styles; React's type lists only standard ones.
    const chatTypographyStyle = React.useMemo(() => getScaledTypographyStyle(
        chatFontSize,
        isVSCodeRuntime() ? VSCODE_TYPOGRAPHY : SEMANTIC_TYPOGRAPHY,
    ) as React.CSSProperties | undefined, [chatFontSize]);
    const { columnRootRef, columnActions, isTimelineDialogOpen, setTimelineDialogOpen } = useChatColumnControls({
        pinned,
        setPinnedSelection,
    });

    const {
        streamingMessageId,
        activeStreamingPhase,
        hasRenderableSessionSnapshot,
        sessionMessages,
        sessionMessageLoadState,
        historyMeta,
    } = useColumnMessages({ active, currentSessionId, currentSessionKey, effectiveSessionDirectory });
    const { sessionStatusForCurrent, sessionPermissions, sessionIsWorking } = useColumnSessionActivity({
        active,
        currentSessionId,
        effectiveSessionDirectory,
        sessionMessages,
        sync,
    });
    const lastIdleAt = useSessionSelector(currentSessionId, effectiveSessionDirectory, selectSessionLastIdleAt);
    useColumnAutoReadAloud({
        pinned,
        currentSessionKey,
        ready: hasRenderableSessionSnapshot && sessionMessageLoadState.status === 'ready',
        sessionIsWorking,
        sessionStatusType: sessionStatusForCurrent.type,
        sessionMessages,
        olderCompletedReplyIds: sessionMessageLoadState.olderCompletedReplyIds,
    });
    const retryOverlay = useRetryOverlay(currentSessionId, sessionStatusForCurrent, lastIdleAt);

    const { isMobile } = useDeviceInfo();
    const isVSCode = isVSCodeRuntime();
    const chatSurfaceMode = useChatSurfaceMode();
    const draftOpen = !pinned && Boolean(newSessionDraft?.open);
    const initError = useGlobalSyncStore((s) => s.error);
    const isDesktopExpandedInput = isExpandedInput;
    const useCompactDraftLayout = isMobile || isVSCode || chatSurfaceMode === 'mini-chat';
    const {
        attachColumnRoot,
        isManagedChatContext,
        workStatusDirectory,
        workStatusPanelMountable,
        showWorkStatusPanel,
        workStatusHost,
        workStatusOverlayMountable,
        showWorkStatusOverlay,
        workStatusReserved,
        workStatusRoomyBesidePanel,
    } = useWorkStatusPlacement({
        pinned,
        isMobile,
        isVSCode,
        chatSurfaceMode,
        draftOpen,
        newSessionDraft,
        effectiveSessionDirectory,
        columnRootRef,
    });
    const messageListRef = React.useRef<MessageListHandle | null>(null);

    const hideReturnToParent = pinned && currentSessionId === pinnedOrigin?.sessionId;
    const { spaceArchive, promptReadOnly, messageSelectionActive } = useColumnPromptReadOnly({
        currentSessionId,
        effectiveSessionDirectory,
        readOnly,
    });
    useAutoOpenDraft({ autoOpenDraft, liveSessionId, draftOpen });

    const { composerOverlayHeight, onStatusOverlayNode } = useStatusOverlayHeight();
    const {
        scrollRef,
        scrollNode,
        registerList,
        captureOutgoingPosition,
        onIsAtEndChange,
        onListMetricsChange,
        onManualNavigation,
        restoreSnapshot,
        onTimelineDataChange,
        goToBottom,
        scrollToBottomOnSend,
        isPinned,
        isFollowingProgrammatically,
        showScrollButton,
        userOwnsScroll,
        nearContentStart,
        activeTurnChangeRef,
        loadHistoryUntilMessageRef,
        currentSessionKeyRef,
        checkLinkedMessage,
        handleLinkedMessageMissing,
    } = useColumnTimelineScroll({
        pinned,
        currentSessionId,
        currentSessionKey,
        effectiveSessionDirectory,
        composerOverlayHeight,
        messageListRef,
        sessionIsWorking,
        revealGate,
    });
    const { chatRootRef, chatSearch, messageSearchEnabled, closeChatSearch } = useChatSearch({ active, currentSessionId });
    const {
        timelineController,
        controllerLoadHistoryUntilMessage,
        resumeToLatestInstant,
        showLoadOlderButton,
        handleLoadOlderClick,
    } = useColumnHistory({
        active,
        currentSessionId,
        currentSessionKey,
        effectiveSessionDirectory,
        messageLoader,
        sessionMessages,
        historyMeta,
        sessionIsWorking,
        scrollRef,
        scrollNode,
        messageListRef,
        loadMoreMessages,
        goToBottom,
        onManualNavigation,
        isPinned,
        showScrollButton,
        nearContentStart,
        activeTurnChangeRef,
        loadHistoryUntilMessageRef,
    });
    const {
        chatQuoteHighlights,
        loadQuoteSource,
        scrollToQuoteSource,
        resolveUiPageMessageId,
        scrollToUiPageRow,
    } = useColumnQuoteNavigation({
        currentSessionKey,
        currentSessionKeyRef,
        messageListRef,
        onManualNavigation,
        controllerLoadHistoryUntilMessage,
        scrollToTimelineMessage: timelineController.scrollToMessage,
        checkLinkedMessage,
        handleLinkedMessageMissing,
    });
    const { navigation, handlePromptNavigatorSelect, canLoadEarlierPrompts, showPromptNavigator } = useColumnTurnNavigation({
        pinned,
        isMobile,
        chatSurfaceMode,
        isDesktopExpandedInput,
        currentSessionId,
        timelineController,
        scrollRef,
    });
    const { authSessionExpired, spaceStopped, isSessionHydrating, retrySessionLoad } = useColumnSessionLoad({
        active,
        currentSessionId,
        effectiveSessionDirectory,
        sync,
        ensureSessionRenderable,
        currentSessionKey,
        onManualNavigation,
        restoreSnapshot,
        hasRenderableSessionSnapshot,
        loadStatus: sessionMessageLoadState.status,
    });

    const { attachComposerSlot, draftPresentationExiting, draftLayoutVisible, floatingComposer } = useComposerPresentation({
        currentSessionId,
        materializedDraftSessionId,
        draftOpen,
        isDesktopExpandedInput,
        useCompactDraftLayout,
        clearMaterializedDraftSession,
    });
    const scrollNodeRef = React.useMemo(() => ({ current: scrollNode }), [scrollNode]);
    useScrollShadow(scrollNodeRef, {
        observeMutations: false,
        hideTopShadow: isMobile && stickyUserHeader,
        hideBottomShadow: floatingComposer,
    });

    if (!currentSessionId && !draftOpen) {
        if (autoOpenDraft && !initError) {
            return <div className="flex h-full flex-col bg-background" />;
        }
        return (
            <div className="flex flex-col h-full bg-background">
                <ChatEmptyState />
            </div>
        );
    }

    const sessionPlaceholder = resolveSessionPlaceholder({
        t,
        draftOpen,
        draftPresentationExiting,
        useCompactDraftLayout,
        isDesktopExpandedInput,
        isSessionHydrating,
        messageCount: sessionMessages.length,
        sessionIsWorking,
        spaceStopped,
        effectiveSessionDirectory,
        loadStatus: sessionMessageLoadState.status,
        authSessionExpired,
        retrySessionLoad,
    });

    const formsInChat = resolveFormsInChat({
        questionsInChat,
        pinned,
        transcriptShown: sessionPlaceholder === undefined && !isDesktopExpandedInput,
    });

    const sessionSurface = (
        <ChatViewport
            placeholder={sessionPlaceholder}
            currentSessionId={currentSessionId ?? ''}
            currentSessionKey={currentSessionKey ?? currentSessionId ?? ''}
            isDesktopExpandedInput={isDesktopExpandedInput}
            isMobile={isMobile}
            formsInChat={formsInChat}
            tableExpansion={!pinned}
            floatingComposer={floatingComposer}
            statusRowClearance={sessionIsWorking ? composerOverlayHeight : 0}
            directory={effectiveSessionDirectory}
            scrollRef={scrollRef}
            registerList={registerList}
            captureOutgoingPosition={captureOutgoingPosition}
            onIsAtEndChange={onIsAtEndChange}
            onListMetricsChange={onListMetricsChange}
            onTimelineDataChange={onTimelineDataChange}
            messageListRef={messageListRef}
            renderedMessages={timelineController.renderedMessages}
            isLoadingOlder={timelineController.isLoadingOlder}
            sessionIsWorking={sessionIsWorking}
            streamingMessageId={streamingMessageId}
            activeStreamingPhase={activeStreamingPhase}
            retryOverlay={retryOverlay}
            scrollToBottom={resumeToLatestInstant}
            onScrollbarDrag={onManualNavigation}
            endPinningReleased={userOwnsScroll}
            revealGate={revealGate}
            isProgrammaticFollowActive={isFollowingProgrammatically}
            showLoadOlderButton={showLoadOlderButton}
            onLoadOlder={handleLoadOlderClick}
            turnIds={timelineController.turnIds}
            activeTurnId={timelineController.activeTurnId}
            onSelectTurn={handlePromptNavigatorSelect}
            showPromptNavigator={showPromptNavigator}
            canLoadEarlierPrompts={canLoadEarlierPrompts}
            isLoadingOlderPrompts={timelineController.isLoadingOlder}
            onLoadEarlierPrompts={handleLoadOlderClick}
        />
    );

    return (
        <div
            ref={attachColumnRoot}
            data-chat-column={pinned ? 'pinned' : 'main'}
            data-chat-session-id={pinned ? currentSessionId ?? undefined : undefined}
            data-chat-working={pinned && sessionIsWorking ? 'true' : undefined}
            className="flex h-full min-h-0 bg-background"
            style={chatTypographyStyle}
        >
            <ChatColumnProviders
                session={chatColumnSession}
                actions={columnActions}
                mobileCommentComposer={mobileCommentComposer}
                quoteHighlights={chatQuoteHighlights}
            >
                <ChatQuoteHighlightLayer
                    store={chatQuoteHighlights}
                    scrollNode={scrollNode}
                    loadHistoryUntilMessage={loadQuoteSource}
                    scrollToMessage={scrollToQuoteSource}
                    resolveUiPageMessageId={resolveUiPageMessageId}
                    scrollToUiPageRow={scrollToUiPageRow}
                />
                {scrollNode && currentSessionId ? <HoistedUiPageSelection key={currentSessionKey ?? currentSessionId} scrollNode={scrollNode} sessionId={currentSessionId} /> : null}
                <div
                    ref={chatRootRef}
                    data-composer-bound
                    data-live-tail={sessionStatusForCurrent.type === 'busy' && isFollowingProgrammatically ? 'true' : undefined}
                    className="relative flex min-w-0 flex-1 flex-col h-full bg-background"
                >
                    <ReturnToParentButton
                        sessionId={currentSessionId}
                        directory={effectiveSessionDirectory}
                        hidden={hideReturnToParent}
                        openSession={columnActions.openSession}
                        registerParentSessionBack={registerParentSessionBack}
                    />
                    {!pinned && !draftOpen ? <LeadDigestRow key={currentSessionId ?? ''} sessionId={currentSessionId} directory={effectiveSessionDirectory} /> : null}
                    {sessionSurface}
                    {chatSearch.open && currentSessionId && messageSearchEnabled ? (
                        <div className="pointer-events-none absolute inset-e-3 top-2 z-20">
                            <ChatSearchBar
                                key={currentSessionId}
                                sessionId={currentSessionId}
                                scrollNode={scrollNode}
                                focusRequest={chatSearch.focusRequest}
                                onClose={closeChatSearch}
                            />
                        </div>
                    ) : null}

                    <FormDockModeContext.Provider value={resolveFormDockMode(formsInChat, showScrollButton)}>
                    <ComposerSlot
                        attachComposerSlot={attachComposerSlot}
                        floatingComposer={floatingComposer}
                        isDesktopExpandedInput={isDesktopExpandedInput}
                        draftLayoutVisible={draftLayoutVisible}
                        useCompactDraftLayout={useCompactDraftLayout}
                        draftPresentationExiting={draftPresentationExiting}
                        showRiders={!draftLayoutVisible && !isDesktopExpandedInput && sessionMessages.length > 0}
                        showScrollToBottom={timelineController.showScrollToBottom}
                        sessionIsWorking={sessionIsWorking}
                        onResumeToLatest={navigation.resumeToLatest}
                        userOwnsScroll={userOwnsScroll}
                        onStatusOverlayNode={onStatusOverlayNode}
                        promptReadOnly={promptReadOnly}
                        messageSelectionActive={messageSelectionActive}
                        currentSessionId={currentSessionId}
                        directory={effectiveSessionDirectory}
                        isMobile={isMobile}
                        permissionCount={sessionPermissions.length}
                        spaceArchiveName={spaceArchive?.name ?? null}
                        sessionStatusType={sessionStatusForCurrent.type}
                        active={active}
                        scrollToBottomOnSend={scrollToBottomOnSend}
                        resumeToLatestInstant={resumeToLatestInstant}
                    />
                    </FormDockModeContext.Provider>

                    {workStatusOverlayMountable ? (
                        <WorkStatusPanel
                            overlay
                            visible={showWorkStatusOverlay}
                            sessionId={currentSessionId ?? null}
                            directory={workStatusDirectory ?? null}
                            repositoryEnabled={!isManagedChatContext}
                        />
                    ) : null}

                    <TimelineDialog
                        open={isTimelineDialogOpen}
                        onOpenChange={setTimelineDialogOpen}
                        onScrollToMessage={timelineController.scrollToMessage}
                        onScrollByTurnOffset={navigation.scrollByTurnOffset}
                        onResumeToLatest={resumeToLatestInstant}
                        canLoadEarlier={timelineController.historySignals.canLoadEarlier}
                        isLoadingEarlier={timelineController.isLoadingOlder}
                        onLoadEarlier={handleLoadOlderClick}
                    />
                </div>
            </ChatColumnProviders>
            {workStatusPanelMountable && workStatusHost ? createPortal(
                <WorkStatusPanel
                    visible={showWorkStatusPanel}
                    reserved={workStatusReserved}
                    besidePanel={workStatusRoomyBesidePanel}
                    sessionId={currentSessionId ?? null}
                    directory={workStatusDirectory ?? null}
                    repositoryEnabled={!isManagedChatContext}
                />,
                workStatusHost,
            ) : null}
        </div>
    );
};
