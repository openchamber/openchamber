import React from 'react';
import { cn, formatDirectoryName } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { isOperatorChildSession } from '@/lib/sessionOperatorChild';
import { resolveGlobalSessionDirectory, useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useProjectFolderMissing } from '@/components/session/sidebar/projects/useProjectFolderMissing';
import { isSessionDirectoryAdmitted } from '@/sync/session-admission-rule';
import { useSelectedNestedSessionFolder } from '@/sync/session-admission';
import { abortCurrentOperation } from '@/sync/session-actions';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSession } from '@/sync/sync-context';
import { registerFloatingPanelClearanceReader } from '@/components/chat/composer/state/composerInsetReaders';
import ScrollToBottomButton from '../components/ScrollToBottomButton';
import { StatusRowContainer } from '../StatusRowContainer';
import { ChatInput } from '../ChatInput';
import { PermissionDock } from '../PermissionDock';
import { FormDock } from '../FormDock';
import { MessageSelectionBar } from '../messageSelection/MessageSelectionBar';
import { ReadOnlyPromptBanner } from './ReadOnlyPromptBanner';
import { DictationStatusControls } from '@/components/dictation/DictationStatusControls';
import { buttonVariants } from '@/components/ui/button-variants';
import { ComposerPromptReadOnlyContext, ComposerRecordingSlotContext, useSlotComposerRecording, useSlotHasComposerRecording } from '@/lib/dictation/composerRecording';

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
        <div
            ref={registerFloatingPanelClearanceReader}
            className={cn(
                'pointer-events-none absolute bottom-full inset-x-0 mb-2 transition-opacity duration-100',
                userOwnsScroll && 'opacity-0',
            )}
            style={{ transform: 'translateY(calc(-1 * var(--chat-floating-panel-clearance, 0px)))' }}
        >
            <div className="chat-input-column">
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

const ReadOnlyComposer: React.FC<{
    sessionId: string | null;
    directory: string | undefined;
    permissionCount: number;
    spaceArchiveName: string | null;
    sessionStatusType: string;
    recordingSlot: string;
}> = ({ sessionId, directory, permissionCount, spaceArchiveName, sessionStatusType, recordingSlot }) => {
    const { t } = useI18n();
    const recording = useSlotComposerRecording(recordingSlot);
    const listedSession = useGlobalSessionsStore((state) => (sessionId ? state.entityById.get(sessionId) : undefined));
    const session = useSession(sessionId, directory) ?? listedSession;
    const projects = useProjectsStore((state) => state.projects);
    const worktrees = useSessionUIStore((state) => state.availableWorktreesByProject);
    const ownDirectory = session ? resolveGlobalSessionDirectory(session) : null;
    const selectedNestedFolder = useSelectedNestedSessionFolder(sessionId, ownDirectory);
    const outsideFolder = ownDirectory && !selectedNestedFolder && !isSessionDirectoryAdmitted(ownDirectory, projects, worktrees) ? ownDirectory : null;
    const folderMissing = useProjectFolderMissing(outsideFolder ?? undefined);
    const sessionText = outsideFolder
        ? t(folderMissing ? 'chat.container.readOnlyFolderMissingBanner' : 'chat.container.readOnlyFolderOutsideBanner', { name: formatDirectoryName(outsideFolder) })
        : isOperatorChildSession(session)
            ? t('chat.container.readOnlyOperatorChildPromptBanner')
            : t('chat.container.readOnlySubagentPromptBanner');
    return (
        <>
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
                    : sessionText}
                onStop={spaceArchiveName === null && sessionId && sessionStatusType !== 'idle'
                    ? () => void abortCurrentOperation(sessionId)
                    : undefined}
                stopLabel={t('chat.chatInput.actions.stopGeneratingAria')}
                leading={recording ? (
                    <DictationStatusControls
                        view={recording.view}
                        actions={recording.actions}
                        buttonClassName={buttonVariants({ variant: 'ghost', size: 'icon', className: '-my-1.5 text-muted-foreground hover:text-foreground' })}
                    />
                ) : null}
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
}) => {
    const recordingSlot = React.useId();
    const keepComposerMounted = useSlotHasComposerRecording(recordingSlot);
    return (
        <div
            ref={attachComposerSlot}
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
                    <ComposerRecordingSlotContext.Provider value={recordingSlot}>
                        <MessageSelectionBar
                            sessionId={currentSessionId}
                            directory={directory ?? null}
                            isMobile={isMobile}
                            radius={isMobile ? '1.25rem' : 'var(--radius-xl)'}
                        />
                    </ComposerRecordingSlotContext.Provider>
                </div>
            ) : promptReadOnly ? (
                <ReadOnlyComposer
                    sessionId={currentSessionId}
                    directory={directory}
                    permissionCount={permissionCount}
                    spaceArchiveName={spaceArchiveName}
                    sessionStatusType={sessionStatusType}
                    recordingSlot={recordingSlot}
                />
            ) : null}
            {!promptReadOnly || keepComposerMounted ? (
                <ComposerRecordingSlotContext.Provider value={recordingSlot}>
                    <ComposerPromptReadOnlyContext.Provider value={promptReadOnly}>
                        <div className={promptReadOnly ? 'hidden' : 'contents'}>
                            <ChatInput
                                active={active}
                                scrollToBottom={scrollToBottomOnSend}
                                scrollToLatest={resumeToLatestInstant}
                                draftPresentationExiting={draftPresentationExiting}
                            />
                        </div>
                    </ComposerPromptReadOnlyContext.Provider>
                </ComposerRecordingSlotContext.Provider>
            ) : null}
        </div>
    );
};
