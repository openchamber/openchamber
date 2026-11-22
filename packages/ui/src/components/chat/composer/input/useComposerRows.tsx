import type { useI18n } from '@/lib/i18n';
import type { useComposerSessionScope } from './useComposerSessionScope';
import type { useComposerSessionLifecycle } from './useComposerSessionLifecycle';
import type { useComposerSendAvailability } from './useComposerSendAvailability';
import type { useComposerSelection } from './useComposerSelection';
import type { useComposerReferencePicker } from './useComposerReferencePicker';
import type { useComposerReferenceActions } from './useComposerReferenceActions';
import type { useComposerQueueState } from './useComposerQueueState';
import type { useComposerQueueActions } from './useComposerQueueActions';
import type { useComposerPreferences } from './useComposerPreferences';
import type { useComposerMobileShell } from './useComposerMobileShell';
import type { useComposerInlineContext } from './useComposerInlineContext';
import type { useComposerEditorState } from './useComposerEditorState';
import type { useComposerEditorActions } from './useComposerEditorActions';
import type { useComposerDraftText } from './useComposerDraftText';
import type { useComposerDraftTarget } from './useComposerDraftTarget';
import type { ChatInputProps } from './chatInputProps';
import React from 'react';
import { QueuedMessagesStrip } from '../../QueuedMessagesStrip';
import { AutoReviewStrip } from '../../AutoReviewStrip';
import { PullRequestWatchStrip } from '../../PullRequestWatchStrip';
import { ExtensionWaitStrip } from '../../ExtensionWaitStrip';
import { ModelControls } from '../../ModelControls';
import { ComposerContextRows } from '../../composer/ui/ComposerContextRows';
import { RevertedMessagesStrip } from '../../RevertedMessagesStrip';
import { SessionFolderMissingRow } from '../../SessionFolderMissingRow';
import { SessionTrustPausedRow } from '../../SessionTrustPausedRow';
import { SessionSuggestionChip } from '@/components/chat/SessionSuggestionChip';
import { SessionDoneHintRow } from '@/components/chat/SessionDoneHintRow';
import { SessionReviewHintRow } from '@/components/chat/SessionReviewHintRow';
import { BackgroundShellsStrip } from '@/components/chat/BackgroundShellsStrip';
import { PersistentTerminalsStrip } from '@/components/chat/PersistentTerminalsStrip';
import { useHasSessionTerminals, useSessionTerminalsLoaded } from '@/hooks/usePersistentTerminals';
import { GoalEditStrip } from '@/components/chat/GoalEditStrip';
import { useRunParentHint } from '@/components/multirun/RunParentHint';
import CurrentModelIndicator from '../../CurrentModelIndicator';
import { ComposerStatusStrip } from '@/components/chat/ComposerStatusStrip';
import { useWorktreeBootstrapPending } from '@/hooks/useWorktreeBootstrapPending';
import { useShownAfter } from '@/hooks/useShownAfter';
import { SessionGoalRow } from '@/components/chat/SessionGoalRow';
import { MemoMobileModelButton, MemoMobileEffortButton, MemoMobileAgentButton } from './memoComposerControls';

const CREATING_SESSION_LINE_DELAY_MS = 300;

type Dependencies = {
    props: Pick<ChatInputProps, 'active'>;
    draftText: Pick<ReturnType<typeof useComposerDraftText>, 'setMessage'>;
    editorState: Pick<ReturnType<typeof useComposerEditorState>, 'composerRef'>;
    i18n: Pick<ReturnType<typeof useI18n>, 't'>;
    preferences: Pick<ReturnType<typeof useComposerPreferences>, 'isMobile'>;
    mobileShell: Pick<ReturnType<typeof useComposerMobileShell>, 'mobileComposerExpanded' | 'mobileShell'>;
    inlineContext: Pick<ReturnType<typeof useComposerInlineContext>, 'hasDrafts' | 'inlineDraftTarget'>;
    referenceActions: Pick<ReturnType<typeof useComposerReferenceActions>, 'openAttachmentByName'>;
    sendAvailability: Pick<ReturnType<typeof useComposerSendAvailability>, 'hasContent' | 'pendingFirstSend'>;
    sessionScope: Pick<ReturnType<typeof useComposerSessionScope>, 'newSessionDraftOpen' | 'isBtwActive' | 'isBtwPanelVisible' | 'hasPendingForm' | 'currentSessionId' | 'currentSessionDirectoryForSync' | 'currentDirectory' | 'setReviewDialogOpen' | 'sessionFolder' | 'trustPausedDirectory' | 'btwComposerSessionId'>;
    queueState: Pick<ReturnType<typeof useComposerQueueState>, 'queuedMessages' | 'parentMessageQueueTarget'>;
    draftTarget: Pick<ReturnType<typeof useComposerDraftTarget>, 'showDraftTargetSelectors' | 'messageWaitsForSpace'>;
    selection: Pick<ReturnType<typeof useComposerSelection>, 'currentAgentName' | 'effectiveBtwSelection'>;
    queueActions: Pick<ReturnType<typeof useComposerQueueActions>, 'handleQueuedMessageEdit' | 'handleQueuedMessageSend'>;
    sessionLifecycle: Pick<ReturnType<typeof useComposerSessionLifecycle>, 'sessionPhase' | 'handleOpenMobilePanel'>;
    editorActions: Pick<ReturnType<typeof useComposerEditorActions>, 'handleCycleThinking' | 'handleOpenThinkingPanel' | 'handleCycleAgent'>;
    referencePicker: Pick<ReturnType<typeof useComposerReferencePicker>, 'handleOpenAgentPanel'>;
};

export function useComposerRows({
    props, draftText, editorState, i18n, preferences, mobileShell: mobile, inlineContext, referenceActions,
    sendAvailability, sessionScope, queueState, draftTarget, selection, queueActions, sessionLifecycle,
    editorActions, referencePicker,
}: Dependencies) {
    const { setMessage } = draftText;
    const { composerRef } = editorState;
    const { t } = i18n;
    const { isMobile } = preferences;
    const { mobileComposerExpanded, mobileShell } = mobile;
    const { hasDrafts, inlineDraftTarget } = inlineContext;
    const { openAttachmentByName } = referenceActions;
    const { hasContent, pendingFirstSend } = sendAvailability;
    const {
        newSessionDraftOpen, isBtwActive, isBtwPanelVisible, hasPendingForm, currentSessionId,
        currentSessionDirectoryForSync, currentDirectory, setReviewDialogOpen, sessionFolder,
        trustPausedDirectory, btwComposerSessionId,
    } = sessionScope;
    const { queuedMessages, parentMessageQueueTarget } = queueState;
    const { showDraftTargetSelectors, messageWaitsForSpace } = draftTarget;
    const { currentAgentName, effectiveBtwSelection } = selection;
    const { handleQueuedMessageEdit, handleQueuedMessageSend } = queueActions;
    const { sessionPhase, handleOpenMobilePanel } = sessionLifecycle;
    const { handleCycleThinking, handleOpenThinkingPanel, handleCycleAgent } = editorActions;
    const { handleOpenAgentPanel } = referencePicker;

    const applyAssistSuggestion = React.useCallback((text: string) => {
        setMessage(text);
        if (isMobile && !mobileComposerExpanded) {
            mobileShell.expand();
        } else {
            requestAnimationFrame(() => composerRef.current?.focus());
        }
    }, [isMobile, mobileComposerExpanded, mobileShell, setMessage, composerRef]);

    const contextRows = hasDrafts ? (
        <ComposerContextRows draftTarget={inlineDraftTarget} isMobile={isMobile} onOpenAttachment={openAttachmentByName} surfaceActive={props.active ?? true} />
    ) : null;

    const suggestionHidden = hasContent || newSessionDraftOpen || isBtwActive || isBtwPanelVisible || queuedMessages.length > 0 || hasPendingForm;

    const suggestionRow = !isBtwActive ? (
        <SessionSuggestionChip
            sessionId={currentSessionId}
            directory={currentSessionDirectoryForSync ?? currentDirectory}
            hidden={suggestionHidden}
            onApply={applyAssistSuggestion}
        />
    ) : null;

    const doneHintRow = !isBtwActive && !newSessionDraftOpen ? (
        <SessionDoneHintRow
            sessionId={currentSessionId}
            directory={currentSessionDirectoryForSync ?? currentDirectory}
        />
    ) : null;

    const openReviewDialog = React.useCallback(() => setReviewDialogOpen(true), [setReviewDialogOpen]);

    const reviewHintRow = !isBtwActive && !newSessionDraftOpen && !isMobile ? (
        <SessionReviewHintRow
            sessionId={currentSessionId}
            directory={currentSessionDirectoryForSync ?? currentDirectory}
            onAIReview={openReviewDialog}
        />
    ) : null;

    // The top rows are siblings, so each strip's key names the strip too: two
    // siblings with one key make React leave a frozen copy of a strip behind
    // on every render.
    const backgroundShellsRow = !isBtwActive && !newSessionDraftOpen ? (
        <BackgroundShellsStrip
            key={`background-shells:${currentSessionId ?? ''}`}
            sessionId={currentSessionId}
            directory={currentSessionDirectoryForSync ?? currentDirectory}
        />
    ) : null;

    // Terminals the agent started with the pty tool share the slot, after the commands.
    const terminalsDirectory = currentSessionDirectoryForSync ?? currentDirectory;
    useSessionTerminalsLoaded(currentSessionId, terminalsDirectory);
    const hasSessionTerminals = useHasSessionTerminals(currentSessionId);
    const persistentTerminalsRow = !isBtwActive && !newSessionDraftOpen && hasSessionTerminals ? (
        <PersistentTerminalsStrip
            key={`agent-terminals:${currentSessionId ?? ''}`}
            sessionId={currentSessionId}
            directory={terminalsDirectory}
        />
    ) : null;

    const worktreeSetupDirectory = currentSessionDirectoryForSync ?? currentDirectory ?? null;

    const worktreeSetupPending = useWorktreeBootstrapPending(isBtwActive ? null : worktreeSetupDirectory);

    const worktreeSetupRow = worktreeSetupPending
        ? <ComposerStatusStrip icon="loader-4" spin text={t('chat.worktreeSetup.running')} />
        : null;

    const creatingSession = Boolean(pendingFirstSend && !pendingFirstSend.sessionCreated && !worktreeSetupPending);

    const creatingSessionRow = useShownAfter(creatingSession, CREATING_SESSION_LINE_DELAY_MS)
        ? <ComposerStatusStrip icon="loader-4" spin text={t('chat.draft.creatingSession')} />
        : null;

    const spaceWaitRow = showDraftTargetSelectors && messageWaitsForSpace
        ? <ComposerStatusStrip icon="time" text={t('spaces.draft.queued')} />
        : null;

    const parentHint = useRunParentHint(currentSessionId, currentSessionDirectoryForSync ?? currentDirectory);
    const parentHintRow = !isBtwActive && !newSessionDraftOpen ? parentHint : null;

    const autoReviewRow = !isBtwActive && !newSessionDraftOpen ? <AutoReviewStrip /> : null;

    const prWatchRow = !isBtwActive && !newSessionDraftOpen ? <PullRequestWatchStrip key={`pr-watch:${currentSessionId ?? ''}`} sessionId={currentSessionId} /> : null;

    const extensionWaitRow = !isBtwActive && !newSessionDraftOpen ? <ExtensionWaitStrip sessionId={currentSessionId} /> : null;

    const goalRow = !isBtwActive ? (
        <SessionGoalRow
            sessionId={currentSessionId}
            directory={currentSessionDirectoryForSync ?? currentDirectory}
        />
    ) : null;

    // A goal edit still being written, or one that did not land, under the goal.
    const goalEditRow = !isBtwActive ? (
        <GoalEditStrip
            sessionId={currentSessionId}
            directory={currentSessionDirectoryForSync ?? currentDirectory}
        />
    ) : null;

    const revertRow = !isBtwActive && !newSessionDraftOpen ? (
        <RevertedMessagesStrip
            sessionId={currentSessionId}
            directory={currentSessionDirectoryForSync ?? currentDirectory}
        />
    ) : null;

    const queueRow = !isBtwActive && !newSessionDraftOpen ? (
        <QueuedMessagesStrip
            target={parentMessageQueueTarget}
            composerAgentName={currentAgentName}
            onEditMessage={handleQueuedMessageEdit}
            onSendMessage={handleQueuedMessageSend}
        />
    ) : null;

    const folderMissingRow = sessionFolder.missing && currentSessionId && currentSessionDirectoryForSync && !isBtwActive && !newSessionDraftOpen
        ? <SessionFolderMissingRow sessionId={currentSessionId} directory={currentSessionDirectoryForSync} busy={sessionPhase !== 'idle'} />
        : null;

    const trustPausedRow = trustPausedDirectory && !folderMissingRow && !isBtwActive
        ? <SessionTrustPausedRow directory={trustPausedDirectory} />
        : null;

    const composerTopRows = folderMissingRow || trustPausedRow || worktreeSetupRow || creatingSessionRow || spaceWaitRow || parentHintRow || goalRow || goalEditRow || autoReviewRow || prWatchRow || extensionWaitRow || backgroundShellsRow || persistentTerminalsRow || revertRow || queueRow || doneHintRow || reviewHintRow || suggestionRow ? (
        <>
            {folderMissingRow}
            {trustPausedRow}
            {worktreeSetupRow}
            {creatingSessionRow}
            {spaceWaitRow}
            {parentHintRow}
            {goalRow}
            {goalEditRow}
            {autoReviewRow}
            {prWatchRow}
            {extensionWaitRow}
            {backgroundShellsRow}
            {persistentTerminalsRow}
            {revertRow}
            {queueRow}
            {doneHintRow}
            {reviewHintRow}
            {suggestionRow}
        </>
    ) : null;

    const mobileModelAgentRow = isMobile ? (
        <div className="flex flex-col gap-0.5 px-3.5 pb-2 pt-0.5">
            {!isBtwActive ? (
                <CurrentModelIndicator
                    sessionId={currentSessionId}
                    directory={currentSessionDirectoryForSync ?? currentDirectory}
                />
            ) : null}
            <div className="flex items-center justify-between gap-x-2">
            {isBtwActive ? (
                <ModelControls
                    sessionId={btwComposerSessionId}
                    selection={effectiveBtwSelection}
                    rememberVariantPicks={false}
                />
            ) : (
                <>
                    <div className="flex min-w-0 items-center gap-0.5">
                        <MemoMobileModelButton onOpenModel={() => handleOpenMobilePanel('model')} className="min-w-0 px-0" />
                        <MemoMobileEffortButton onCycleThinking={handleCycleThinking} onOpenThinking={handleOpenThinkingPanel} />
                    </div>
                    <MemoMobileAgentButton
                        onOpenAgentPanel={handleOpenAgentPanel}
                        onCycleAgent={handleCycleAgent}
                        className="flex-shrink-0 px-0"
                    />
                </>
            )}
            </div>
        </div>
    ) : null;

    return {
        composerTopRows, contextRows, mobileModelAgentRow,
    };
}
