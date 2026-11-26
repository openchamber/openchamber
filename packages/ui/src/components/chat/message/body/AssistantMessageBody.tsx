import React from 'react';
import { MessageFilesDisplay } from '../../FileAttachment';
import type { StreamPhase } from '../types';
import { cn } from '@/lib/utils';
import { isEmptyTextPart } from '../partUtils';
import { ErrorResponseDetails } from '@/components/chat/ErrorResponseDetails';
import { SaveProjectPlanDialog } from '@/components/session/SaveProjectPlanDialog';
import { ForkSessionDialog } from '@/components/session/ForkSessionDialog';
import { SimpleMarkdownRenderer } from '../../MarkdownRenderer';
import { LongErrorText } from '../../LongErrorText';
import { flattenAssistantTextParts } from '@/lib/messages/messageText';
import { useMessageTTS } from '@/hooks/useMessageTTS';
import { useFactsFit } from '../useFactsFit';
import { useConfigStore } from '@/stores/useConfigStore';
import { TextSelectionMenu } from '../TextSelectionMenu';
import { useChatSurfaceMode } from '@/components/chat/useChatSurfaceMode';
import { isVSCodeRuntime } from '@/lib/desktop';
import { Icon } from '@/components/icon/Icon';
import { formatTimestampForDisplay } from '../timeFormat';
import { FadeInOnReveal } from '../FadeInOnReveal';
import { MessageSliceContext } from '../messageSliceContext';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useI18n } from '@/lib/i18n';
import { messageSelectionKey } from '@/stores/useMessageSelectionStore';
import { useUIStore } from '@/stores/useUIStore';
import type { MessageBodyProps } from './messageBodyProps';
import { CONTAIN_LAYOUT_STYLE, INLINE_MESSAGE_ACTIONS_CLASS_NAME } from './messageBodyStyles';
import { AssistantMessageActionButtons } from './AssistantMessageActionButtons';
import { AssistantTurnActionButtons } from './AssistantTurnActionButtons';
import { AssistantTurnFooter } from './AssistantTurnFooter';
import { useAssistantForkActions } from './useAssistantForkActions';
import { useAssistantImageShare } from './useAssistantImageShare';
import { useAssistantPlanActions } from './useAssistantPlanActions';
import { useAssistantRenderedParts } from './useAssistantRenderedParts';
import { useFooterSheetActions } from './useFooterSheetActions';
import { useReviewTransferAction } from './useReviewTransferAction';
import { useSessionProjectRef } from './useSessionProjectRef';

const formatTurnDuration = (durationMs: number): string => {
    if (durationMs < 60_000) {
        return `${(durationMs / 1000).toFixed(1)}s`;
    }
    const totalSeconds = Math.round(durationMs / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}m ${seconds}s`;
};

export const AssistantMessageBody = React.memo(({
    sessionId,
    messageId,
    parts,
    isMessageCompleted,
    messageFinish,
    messageCompletedAt,
    messageCreatedAt,

    isMobile,
    alwaysShowActions,
    hasTouchInput,
    expandedTools,
    onToggleTool,
    onShowPopup,
    streamPhase: _streamPhase,
    allowAnimation: _allowAnimation,
    hasTextContent = false,
    onCopyMessage,
    onCopyTurn,
    onCopyLink,
    showReasoningTraces = false,
    turnGroupingContext,
    errorMessage,
    errorResponseBody,
    reviewTransferDirection = null,
    contextPinned,
    contextPinPending,
    onToggleContextPin,
    footerProviderID,
    footerModelName,
    footerAgentName,
    footerVariant,
    extraActions,
    onSelectMessages,
}: Omit<MessageBodyProps, 'isUser'>) => {
    const { locale } = useI18n();
    const answerSelectionKey = turnGroupingContext?.turnId ? messageSelectionKey('answer', turnGroupingContext.turnId) : null;
    const chatSurfaceMode = useChatSurfaceMode();
    const streamPhase = _streamPhase;
    void _allowAnimation;
    const messageContentRef = React.useRef<HTMLDivElement>(null);
    const messageTextContentRef = React.useRef<HTMLDivElement>(null);
    const isTouchContext = Boolean(hasTouchInput ?? isMobile);
    const alwaysShowMessageActions = Boolean(alwaysShowActions ?? isMobile);
    const awaitingMessageCompletion = !isMessageCompleted;

    const visibleParts = React.useMemo(() => {
        return parts.filter((part) => !isEmptyTextPart(part));
    }, [parts]);

    const assistantTextParts = React.useMemo(() => {
        return visibleParts.filter((part) => part.type === 'text');
    }, [visibleParts]);
    const assistantPlanText = React.useMemo(() => flattenAssistantTextParts(assistantTextParts), [assistantTextParts]);


    const isVSCode = isVSCodeRuntime();
    const isMiniChatSurface = chatSurfaceMode === 'mini-chat';
    const canUseProjectPlanActions = !isVSCode && !isMiniChatSurface && !isMobile;
    const canShowMultiRunAction = !isVSCode && !isMiniChatSurface && !isMobile;


    const effectiveDirectory = useEffectiveDirectory();
    const isReviewSessionView = reviewTransferDirection === 'review-to-original';
    const effectiveReviewTransferDirection = (!isMobile && !isVSCode) ? reviewTransferDirection : null;
    const reviewTransferAction = useReviewTransferAction({ sessionId, effectiveDirectory, assistantPlanText, effectiveReviewTransferDirection });
    const showSplitAssistantMessageActions = useUIStore((state) => state.showSplitAssistantMessageActions);
    const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);
    const slice = React.useContext(MessageSliceContext);
    const isSliceEnd = !slice?.to;
    const isLastAssistantInTurn = turnGroupingContext?.isLastAssistantInTurn ?? false;
    const hasStopFinish = messageFinish === 'stop';
    const effectiveStreamPhase: StreamPhase = hasStopFinish ? 'completed' : streamPhase;

    const { sessionProjectRef, currentProjectRef } = useSessionProjectRef({ effectiveDirectory, canUseProjectPlanActions });

    const hasCopyableText = Boolean(hasTextContent) && !awaitingMessageCompletion;

    const {
        isPlanDialogOpen,
        setIsPlanDialogOpen,
        isPlanDialogMounted,
        suggestedPlanTitle,
        isSavingPlan,
        handleSaveAsPlanClick,
        handleConfirmSaveAsPlan,
    } = useAssistantPlanActions({ assistantPlanText, currentProjectRef });
    const {
        isForkDialogOpen,
        setIsForkDialogOpen,
        isForkSubmitting,
        handleForkClick,
        handleConfirmFork,
        handleForkFromHere,
        handleForkMultiRun,
        askOtherModelsSession,
        setAskOtherModelsSession,
        handleAskOtherModels,
    } = useAssistantForkActions({ sessionId, messageId, effectiveDirectory, assistantPlanText });
    const { shareTurnAsImage, shareShownMessageAsImage } = useAssistantImageShare({
        messageId,
        messageContentRef,
        messageTextContentRef,
        assistantTextParts,
        earlierAssistantText: turnGroupingContext?.earlierAssistantText,
    });

    const showErrorMessage = Boolean(errorMessage) && isSliceEnd;
    const isPeekSurface = chatSurfaceMode === 'peek';
    const shouldShowMessageActions = hasCopyableText && !isPeekSurface;
    const hasTurnFooter = isLastAssistantInTurn && hasTextContent && (hasStopFinish || Boolean(errorMessage)) && !isPeekSurface;
    const shouldShowTurnFooter = hasTurnFooter && isSliceEnd;
    const shouldShowStandaloneMessageActions = showSplitAssistantMessageActions && shouldShowMessageActions && !hasTurnFooter;

    const messageActionButtons = React.useMemo(() => (
        <AssistantMessageActionButtons
            hasCopyableText={hasCopyableText}
            isTouchContext={isTouchContext}
            onCopyMessage={onCopyMessage}
            onCopyLink={onCopyLink}
            onShareImage={shareShownMessageAsImage}
            ttsText={assistantPlanText}
            ttsReadingKey={messageId}
            reviewTransferAction={reviewTransferAction}
            extraActions={extraActions}
        />
    ), [assistantPlanText, extraActions, hasCopyableText, isTouchContext, messageId, onCopyLink, onCopyMessage, reviewTransferAction, shareShownMessageAsImage]);

    const onCopyFooter = onCopyTurn ?? onCopyMessage;

    const lastRenderableTextPartIndex = React.useMemo(() => {
        if (!shouldShowStandaloneMessageActions) {
            return -1;
        }

        let lastIndex = -1;
        for (let index = 0; index < visibleParts.length; index += 1) {
            const part = visibleParts[index];
            if (!part || part.type !== 'text') {
                continue;
            }
            lastIndex = index;
        }

        return lastIndex;
    }, [shouldShowStandaloneMessageActions, visibleParts]);

    const shouldRenderStandaloneActionsAfterContent = shouldShowStandaloneMessageActions && isSliceEnd && lastRenderableTextPartIndex < 0;

    const renderedParts = useAssistantRenderedParts({
        messageId,
        sessionId,
        visibleParts,
        messageTextContentRef,
        messageActionButtons,
        answerSelectionKey,
        effectiveStreamPhase,
        hasStopFinish,
        isLastAssistantInTurn,
        turnGroupingContext,
        showReasoningTraces,
        expandedTools,
        onToggleTool,
        onShowPopup,
        isMobile,
        alwaysShowMessageActions,
        shouldShowStandaloneMessageActions,
        lastRenderableTextPartIndex,
    });

    const turnDurationText = React.useMemo(() => {
        if (!isLastAssistantInTurn || !hasStopFinish) return undefined;
        const userCreatedAt = turnGroupingContext?.userMessageCreatedAt;
        if (typeof userCreatedAt !== 'number' || typeof messageCompletedAt !== 'number') return undefined;
        if (messageCompletedAt <= userCreatedAt) return undefined;
        return formatTurnDuration(messageCompletedAt - userCreatedAt);
    }, [isLastAssistantInTurn, hasStopFinish, turnGroupingContext?.userMessageCreatedAt, messageCompletedAt]);

    const footerTimestamp = React.useMemo(() => {
        void locale;
        const timestamp = typeof messageCompletedAt === 'number' && messageCompletedAt > 0
            ? messageCompletedAt
            : (typeof messageCreatedAt === 'number' && messageCreatedAt > 0 ? messageCreatedAt : null);
        if (timestamp === null) return null;

        const formatted = formatTimestampForDisplay(timestamp, timeFormatPreference);
        return formatted.length > 0 ? formatted : null;
    }, [messageCompletedAt, messageCreatedAt, timeFormatPreference, locale]);

    const footerEffortLabel = footerVariant && !['default', 'none'].includes(footerVariant.toLowerCase())
        ? footerVariant[0].toLowerCase() + footerVariant.slice(1)
        : null;

    const [actionSheetOpen, setActionSheetOpen] = React.useState(false);
    const footerFactsRef = React.useRef<HTMLDivElement>(null);
    useFactsFit(footerFactsRef);
    const { isPlaying: isFooterTTSPlaying, play: playFooterTTS, stop: stopFooterTTS } = useMessageTTS(messageId);
    const showMessageTTSButtons = useConfigStore((state) => state.showMessageTTSButtons);


    const footerSheetActions = useFooterSheetActions({
        assistantPlanText,
        canUseProjectPlanActions,
        contextPinPending,
        contextPinned,
        currentProjectRef,
        extraActions,
        handleForkClick,
        handleForkFromHere,
        handleSaveAsPlanClick,
        hasCopyableText,
        isFooterTTSPlaying,
        isMiniChatSurface,
        isReviewSessionView,
        onCopyFooter,
        onCopyLink,
        onSelectMessages,
        onToggleContextPin,
        playFooterTTS,
        reviewTransferAction,
        shareTurnAsImage,
        showMessageTTSButtons,
        stopFooterTTS,
    });

    const footerMenuActions = footerSheetActions.filter((action) => !action.onPointerRow);

    const finalTurnActionButtons = (
        <AssistantTurnActionButtons
            onCopyFooter={onCopyFooter}
            hasCopyableText={hasCopyableText}
            isTouchContext={isTouchContext}
            isFooterTTSPlaying={isFooterTTSPlaying}
            stopFooterTTS={stopFooterTTS}
            isMiniChatSurface={isMiniChatSurface}
            isReviewSessionView={isReviewSessionView}
            handleForkFromHere={handleForkFromHere}
            handleForkClick={handleForkClick}
            canShowMultiRunAction={canShowMultiRunAction}
            turnId={turnGroupingContext?.turnId}
            handleAskOtherModels={handleAskOtherModels}
            handleForkMultiRun={handleForkMultiRun}
            onToggleContextPin={onToggleContextPin}
            contextPinned={contextPinned}
            contextPinPending={contextPinPending}
            footerMenuActions={footerMenuActions}
            askOtherModelsSession={askOtherModelsSession}
            setAskOtherModelsSession={setAskOtherModelsSession}
        />
    );
 
      return (

         <div
              ref={messageContentRef}
              data-message-text-export-root="true"
              data-chat-quote-root="true"
              className={cn(
                 'relative w-full group/message'
             )}
              style={CONTAIN_LAYOUT_STYLE}
          >
              <TextSelectionMenu
                  containerRef={messageContentRef}
                  readingKey={messageId}
                  canReadAloud={!isMiniChatSurface && showMessageTTSButtons}
              />
             {canUseProjectPlanActions && isPlanDialogMounted ? (
                 <SaveProjectPlanDialog
                     open={isPlanDialogOpen}
                     onOpenChange={setIsPlanDialogOpen}
                     initialTitle={suggestedPlanTitle}
                     sourceText={assistantPlanText}
                     saving={isSavingPlan}
                     onSave={handleConfirmSaveAsPlan}
                 />
             ) : null}
             {isForkDialogOpen ? (
                 <ForkSessionDialog
                     open={isForkDialogOpen}
                     onOpenChange={setIsForkDialogOpen}
                     projectDirectory={effectiveDirectory ?? null}
                     sourceSessionId={sessionId ?? null}
                     worktreeProjectDirectory={sessionProjectRef?.path ?? null}
                     submitting={isForkSubmitting}
                     onConfirm={handleConfirmFork}
                 />
             ) : null}
              <div>
                 <div
                     className="message-content-text leading-relaxed overflow-hidden text-foreground/90 [&_p:last-child]:mb-0 [&_ul:last-child]:mb-0 [&_ol:last-child]:mb-0"
                 >
                    {renderedParts}
                    {showErrorMessage && (
                        <FadeInOnReveal key="assistant-error">
                            <div className="group/assistant-text relative mt-3 max-w-full break-words rounded-2xl bg-[var(--status-info-background)] px-4 py-3 text-base leading-relaxed">
                                <div className="flex items-center gap-3">
                                    <Icon name="information" className="size-4 shrink-0 text-[var(--status-info)]" />
                                    <div className="min-w-0 flex-1 break-words">
                                        <LongErrorText text={errorMessage ?? ''}>
                                            {(visibleText) => (
                                                <SimpleMarkdownRenderer
                                                    singleTilde={false}
                                                    content={visibleText}
                                                    onShowPopup={onShowPopup}
                                                    className="[&_.markdown-content>*:first-child]:mt-0 [&_.markdown-content>*:last-child]:mb-0"
                                                    enableFileReferences={false}
                                                />
                                            )}
                                        </LongErrorText>
                                    </div>
                                </div>
                                {errorResponseBody ? <ErrorResponseDetails body={errorResponseBody} className="mt-1 ps-7" /> : null}
                            </div>
                        </FadeInOnReveal>
                    )}
                </div>
                {isSliceEnd ? <MessageFilesDisplay files={parts} onShowPopup={onShowPopup} /> : null}
                {shouldRenderStandaloneActionsAfterContent && (
                    <div className={INLINE_MESSAGE_ACTIONS_CLASS_NAME} data-message-actions="true">
                        <div className="flex items-center gap-1.5" data-message-action-group="true">
                            {messageActionButtons}
                        </div>
                    </div>
                )}
                {shouldShowTurnFooter && (
                    <AssistantTurnFooter
                        footerFactsRef={footerFactsRef}
                        footerModelName={footerModelName}
                        footerProviderID={footerProviderID}
                        footerAgentName={footerAgentName}
                        footerEffortLabel={footerEffortLabel}
                        turnDurationText={turnDurationText}
                        footerTimestamp={footerTimestamp}
                        alwaysShowMessageActions={alwaysShowMessageActions}
                        isTouchContext={isTouchContext}
                        actionSheetOpen={actionSheetOpen}
                        setActionSheetOpen={setActionSheetOpen}
                        actionButtons={finalTurnActionButtons}
                        isMiniChatSurface={isMiniChatSurface}
                        isLastAssistantInTurn={isLastAssistantInTurn}
                        hasStopFinish={hasStopFinish}
                        turnGroupingContext={turnGroupingContext}
                        footerSheetActions={footerSheetActions}
                    />
                )}


            </div>
        </div>
    );
});
