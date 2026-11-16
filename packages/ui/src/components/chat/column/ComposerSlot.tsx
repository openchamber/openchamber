import React from 'react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { abortCurrentOperation } from '@/sync/session-actions';
import { registerFloatingPanelClearanceReader } from '@/components/chat/composer/state/composerInsetReaders';
import ScrollToBottomButton from '../components/ScrollToBottomButton';
import { StatusRowContainer } from '../StatusRowContainer';
import { ChatInput } from '../ChatInput';
import { PermissionDock } from '../PermissionDock';
import { FormDock } from '../FormDock';
import { MessageSelectionBar } from '../messageSelection/MessageSelectionBar';
import { ReadOnlyPromptBanner } from './ReadOnlyPromptBanner';

/**
 * One zero-height anchor on the slot's top edge for everything that floats
 * above the composer, so the mobile keyboard slide and the pill morph move
 * them as one rider with the box instead of leaving them to jump when the
 * slot resizes (see mobileComposerMorph).
 */
const ComposerRiders: React.FC<{
    showScrollToBottom: boolean;
    sessionIsWorking: boolean;
    onResumeToLatest: () => void;
    userOwnsScroll: boolean;
    onStatusOverlayNode: (node: HTMLDivElement | null) => void;
}> = ({ showScrollToBottom, sessionIsWorking, onResumeToLatest, userOwnsScroll, onStatusOverlayNode }) => (
    <div className="oc-composer-riders absolute bottom-full inset-x-0" data-composer-riders="true">
        <ScrollToBottomButton
            visible={showScrollToBottom}
            working={sessionIsWorking}
            onClick={onResumeToLatest}
        />
        {/* Same anchor and column as the pill, so the status
            row and the pill it hands off to share the exact
            distance from the input and the same left edge. */}
        <div
            ref={registerFloatingPanelClearanceReader}
            className={cn(
                'pointer-events-none absolute bottom-full inset-x-0 mb-2 transition-opacity duration-100',
                userOwnsScroll && 'opacity-0',
            )}
            style={{ transform: 'translateY(calc(-1 * var(--chat-floating-panel-clearance, 0px)))' }}
        >
            <div className="chat-input-column">
                {/* The glass chip itself is rendered inside
                    StatusRow (its root is a size container
                    that cannot shrink-wrap). */}
                <div
                    ref={onStatusOverlayNode}
                    className={cn(
                        '[&:not(:has(*))]:hidden',
                        userOwnsScroll ? 'pointer-events-none' : 'pointer-events-auto',
                    )}
                >
                    <StatusRowContainer />
                </div>
            </div>
        </div>
    </div>
);

/** A chat that takes no prompts: its docks stay answerable, and a banner says why. */
const ReadOnlyComposer: React.FC<{
    sessionId: string | null;
    directory: string | undefined;
    permissionCount: number;
    spaceArchiveName: string | null;
    sessionStatusType: string;
}> = ({ sessionId, directory, permissionCount, spaceArchiveName, sessionStatusType }) => {
    const { t } = useI18n();
    return (
        <>
            {/* The docks live inside ChatInput, which a read-only
                chat does not mount. A subagent still asks for
                permissions and answers, and they must be answerable
                where the user is looking; the parent shows the same
                requests, and answering one clears it in both. */}
            <PermissionDock
                sessionId={sessionId}
                directory={directory}
                hidden={false}
            />
            <FormDock
                sessionId={sessionId}
                directory={directory}
                hidden={permissionCount > 0}
            />
            <ReadOnlyPromptBanner
                text={spaceArchiveName !== null
                    ? t('spaces.archive.readOnlyBanner', { name: spaceArchiveName })
                    : t('chat.container.readOnlySubagentPromptBanner')}
                onStop={spaceArchiveName === null && sessionId && sessionStatusType !== 'idle'
                    ? () => void abortCurrentOperation(sessionId)
                    : undefined}
                stopLabel={t('chat.chatInput.actions.stopGeneratingAria')}
            />
        </>
    );
};

export const ComposerSlot: React.FC<{
    attachComposerSlot: (node: HTMLDivElement | null) => void;
    floatingComposer: boolean;
    isDesktopExpandedInput: boolean;
    draftLayoutVisible: boolean;
    useCompactDraftLayout: boolean;
    draftPresentationExiting: boolean;
    showRiders: boolean;
    showScrollToBottom: boolean;
    sessionIsWorking: boolean;
    onResumeToLatest: () => void;
    userOwnsScroll: boolean;
    onStatusOverlayNode: (node: HTMLDivElement | null) => void;
    promptReadOnly: boolean;
    messageSelectionActive: boolean;
    currentSessionId: string | null;
    directory: string | undefined;
    isMobile: boolean;
    permissionCount: number;
    spaceArchiveName: string | null;
    sessionStatusType: string;
    active: boolean;
    scrollToBottomOnSend: () => void;
    resumeToLatestInstant: () => void;
}> = ({
    attachComposerSlot,
    floatingComposer,
    isDesktopExpandedInput,
    draftLayoutVisible,
    useCompactDraftLayout,
    draftPresentationExiting,
    showRiders,
    showScrollToBottom,
    sessionIsWorking,
    onResumeToLatest,
    userOwnsScroll,
    onStatusOverlayNode,
    promptReadOnly,
    messageSelectionActive,
    currentSessionId,
    directory,
    isMobile,
    permissionCount,
    spaceArchiveName,
    sessionStatusType,
    active,
    scrollToBottomOnSend,
    resumeToLatestInstant,
}) => (
    <div
        ref={attachComposerSlot}
        // The mobile pill morph pins a floating slot for its tween.
        data-composer-slot={floatingComposer ? 'floating' : 'flow'}
        className={cn(
            'z-10 flex min-h-0',
            floatingComposer
                ? 'absolute inset-x-0 bottom-0'
                : 'relative',
            isDesktopExpandedInput
                ? 'flex-1 min-h-0 bg-background'
                : draftLayoutVisible && !useCompactDraftLayout
                    ? 'flex-1 items-center justify-center bg-background pb-[6vh]'
                : !floatingComposer && 'bg-background'
        )}
    >
        {showRiders && (
            <ComposerRiders
                showScrollToBottom={showScrollToBottom}
                sessionIsWorking={sessionIsWorking}
                onResumeToLatest={onResumeToLatest}
                userOwnsScroll={userOwnsScroll}
                onStatusOverlayNode={onStatusOverlayNode}
            />
        )}
        {promptReadOnly && messageSelectionActive && currentSessionId ? (
            <div className="chat-input-column w-full pb-4">
                <MessageSelectionBar
                    sessionId={currentSessionId}
                    directory={directory ?? null}
                    isMobile={isMobile}
                    radius={isMobile ? '1.25rem' : 'var(--radius-xl)'}
                />
            </div>
        ) : promptReadOnly ? (
            <ReadOnlyComposer
                sessionId={currentSessionId}
                directory={directory}
                permissionCount={permissionCount}
                spaceArchiveName={spaceArchiveName}
                sessionStatusType={sessionStatusType}
            />
        ) : (
            <ChatInput
                active={active}
                scrollToBottom={scrollToBottomOnSend}
                scrollToLatest={resumeToLatestInstant}
                draftPresentationExiting={draftPresentationExiting}
            />
        )}
    </div>
);
