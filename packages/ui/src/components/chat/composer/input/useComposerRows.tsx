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
import { ComposerStatusStrip } from '@/components/chat/ComposerStatusStrip';
import { useWorktreeBootstrapPending } from '@/hooks/useWorktreeBootstrapPending';
import { useShownAfter } from '@/hooks/useShownAfter';
import { SessionGoalRow } from '@/components/chat/SessionGoalRow';
import type { useComposerInputState } from './useComposerInputState';
import type { useComposerEnvironment } from './useComposerEnvironment';
import type { useComposerMobileShell } from './useComposerMobileShell';
import type { useComposerInlineContext } from './useComposerInlineContext';
import type { useComposerReferenceActions } from './useComposerReferenceActions';
import type { useComposerSendAvailability } from './useComposerSendAvailability';
import type { useComposerSessionScope } from './useComposerSessionScope';
import type { useComposerQueueState } from './useComposerQueueState';
import type { useComposerDraftTarget } from './useComposerDraftTarget';
import type { useComposerSelection } from './useComposerSelection';
import type { useComposerQueueActions } from './useComposerQueueActions';
import type { useComposerSessionLifecycle } from './useComposerSessionLifecycle';
import type { useComposerEditorActions } from './useComposerEditorActions';
import type { useComposerReferencePicker } from './useComposerReferencePicker';
import { MemoMobileModelButton, MemoMobileEffortButton, MemoMobileAgentButton } from './memoComposerControls';

const CREATING_SESSION_LINE_DELAY_MS = 300;

type Dependencies = Pick<ReturnType<typeof useComposerInputState>, 'setMessage' | 'composerRef' | 't'>
    & Pick<ReturnType<typeof useComposerEnvironment>, 'isMobile'>
    & Pick<ReturnType<typeof useComposerMobileShell>, 'mobileComposerExpanded' | 'mobileShell'>
    & Pick<ReturnType<typeof useComposerInlineContext>, 'hasDrafts' | 'inlineDraftTarget'>
    & Pick<ReturnType<typeof useComposerReferenceActions>, 'openAttachmentByName'>
    & Pick<ReturnType<typeof useComposerSendAvailability>, 'hasContent' | 'pendingFirstSend'>
    & Pick<ReturnType<typeof useComposerSessionScope>, 'newSessionDraftOpen' | 'isBtwActive' | 'isBtwPanelVisible' | 'hasPendingForm' | 'currentSessionId' | 'currentSessionDirectoryForSync' | 'currentDirectory' | 'setReviewDialogOpen' | 'sessionFolder' | 'trustPausedDirectory' | 'btwComposerSessionId'>
    & Pick<ReturnType<typeof useComposerQueueState>, 'queuedMessages' | 'parentMessageQueueTarget'>
    & Pick<ReturnType<typeof useComposerDraftTarget>, 'showDraftTargetSelectors' | 'messageWaitsForSpace'>
    & Pick<ReturnType<typeof useComposerSelection>, 'currentAgentName' | 'effectiveBtwSelection'>
    & Pick<ReturnType<typeof useComposerQueueActions>, 'handleQueuedMessageEdit' | 'handleQueuedMessageSend'>
    & Pick<ReturnType<typeof useComposerSessionLifecycle>, 'sessionPhase' | 'handleOpenMobilePanel'>
    & Pick<ReturnType<typeof useComposerEditorActions>, 'handleCycleThinking' | 'handleOpenThinkingPanel' | 'handleCycleAgent'>
    & Pick<ReturnType<typeof useComposerReferencePicker>, 'handleOpenAgentPanel'>;

export function useComposerRows({
    setMessage, isMobile, mobileComposerExpanded, mobileShell, composerRef, hasDrafts, inlineDraftTarget,
    openAttachmentByName, hasContent, newSessionDraftOpen, isBtwActive, isBtwPanelVisible, queuedMessages,
    hasPendingForm, currentSessionId, currentSessionDirectoryForSync, currentDirectory, setReviewDialogOpen,
    t, pendingFirstSend, showDraftTargetSelectors, messageWaitsForSpace, parentMessageQueueTarget,
    currentAgentName, handleQueuedMessageEdit, handleQueuedMessageSend, sessionFolder, sessionPhase,
    trustPausedDirectory, btwComposerSessionId, effectiveBtwSelection, handleOpenMobilePanel,
    handleCycleThinking, handleOpenThinkingPanel, handleOpenAgentPanel, handleCycleAgent,
}: Dependencies) {
    const applyAssistSuggestion = React.useCallback((text: string) => {
        setMessage(text);
        if (isMobile && !mobileComposerExpanded) {
            mobileShell.expand();
        } else {
            requestAnimationFrame(() => composerRef.current?.focus());
        }
    }, [isMobile, mobileComposerExpanded, mobileShell, setMessage, composerRef]);

    // Pending context (review comments, quotes, annotations, terminal
    // selections) lists as rows right above the input, one per item.
    const contextRows = hasDrafts ? (
        <ComposerContextRows draftTarget={inlineDraftTarget} isMobile={isMobile} onOpenAttachment={openAttachmentByName} />
    ) : null;

    // The suggested follow-up is the composer's own top row on every surface
    // (inside the mobile pill and the box alike); on mobile the model and
    // agent are its bottom row too, so the surface stays one shape.
    const suggestionHidden = hasContent || newSessionDraftOpen || isBtwActive || isBtwPanelVisible || queuedMessages.length > 0 || hasPendingForm;

    const suggestionRow = !isBtwActive ? (
        <SessionSuggestionChip
            sessionId={currentSessionId}
            directory={currentSessionDirectoryForSync ?? currentDirectory}
            hidden={suggestionHidden}
            onApply={applyAssistSuggestion}
        />
    ) : null;

    // Jev's "looks done" hint shares the composer's top row slot, above the
    // suggestion, so nothing below the input moves.
    const doneHintRow = !isBtwActive && !newSessionDraftOpen ? (
        <SessionDoneHintRow
            sessionId={currentSessionId}
            directory={currentSessionDirectoryForSync ?? currentDirectory}
        />
    ) : null;

    // The offer to look over what the last turn changed takes the same slot;
    // the server writes either it or the done hint, never both. Neither the
    // AI review nor the walkthrough is offered on a mobile layout.
    const openReviewDialog = React.useCallback(() => setReviewDialogOpen(true), [setReviewDialogOpen]);

    const reviewHintRow = !isBtwActive && !newSessionDraftOpen && !isMobile ? (
        <SessionReviewHintRow
            sessionId={currentSessionId}
            directory={currentSessionDirectoryForSync ?? currentDirectory}
            onAIReview={openReviewDialog}
        />
    ) : null;

    // Commands the agent left running sit in the same slot, first, so a
    // forgotten dev server is visible without scrolling the chat. Keyed by
    // session so an expanded list collapses on a session switch.
    const backgroundShellsRow = !isBtwActive && !newSessionDraftOpen ? (
        <BackgroundShellsStrip
            key={currentSessionId ?? ''}
            sessionId={currentSessionId}
            directory={currentSessionDirectoryForSync ?? currentDirectory}
        />
    ) : null;

    // A new worktree still running its setup commands, first of all: until it
    // ends, a first prompt can wait with nothing else saying why.
    const worktreeSetupDirectory = currentSessionDirectoryForSync ?? currentDirectory ?? null;

    const worktreeSetupPending = useWorktreeBootstrapPending(isBtwActive ? null : worktreeSetupDirectory);

    const worktreeSetupRow = worktreeSetupPending
        ? <ComposerStatusStrip icon="loader-4" spin text={t('chat.worktreeSetup.running')} />
        : null;

    // The first message is on screen while the server still creates its
    // session; this says why Send waits. A worktree's setup line already does.
    // A fast server answers within the delay, and then nothing flashes.
    const creatingSession = Boolean(pendingFirstSend && !pendingFirstSend.sessionCreated && !worktreeSetupPending);

    const creatingSessionRow = useShownAfter(creatingSession, CREATING_SESSION_LINE_DELAY_MS)
        ? <ComposerStatusStrip icon="loader-4" spin text={t('chat.draft.creatingSession')} />
        : null;

    // A message sent while its space is still being made waits for it; the
    // composer is empty then, so this row is the only sign it was not lost.
    const spaceWaitRow = showDraftTargetSelectors && messageWaitsForSpace
        ? <ComposerStatusStrip icon="time" text={t('spaces.draft.queued')} />
        : null;

    const autoReviewRow = !isBtwActive && !newSessionDraftOpen ? <AutoReviewStrip /> : null;

    // The agent waits on its pull requests; the server wakes it. Keyed by
    // session, as the commands below, so an expanded list collapses on a
    // switch; the prefix keeps the two keys of this fragment apart.
    const prWatchRow = !isBtwActive && !newSessionDraftOpen ? <PullRequestWatchStrip key={`pr-watch:${currentSessionId ?? ''}`} sessionId={currentSessionId} /> : null;

    // The agent waits on a timer or on something an extension follows; the server wakes it.
    const extensionWaitRow = !isBtwActive && !newSessionDraftOpen ? <ExtensionWaitStrip sessionId={currentSessionId} /> : null;

    // The session's goal, then what is still running, then what waits for it.
    const goalRow = !isBtwActive ? (
        <SessionGoalRow
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

    // Null exactly when the suggestion row alone would have been: the mobile
    // pill picks its shape from whether a top row exists.
    const folderMissingRow = sessionFolder.missing && currentSessionId && currentSessionDirectoryForSync && !isBtwActive && !newSessionDraftOpen
        ? <SessionFolderMissingRow sessionId={currentSessionId} directory={currentSessionDirectoryForSync} busy={sessionPhase !== 'idle'} />
        : null;

    // A folder the user declined to trust loads no agent or model; the row
    // brings the prompt back. A missing folder says more, so it wins.
    const trustPausedRow = trustPausedDirectory && !folderMissingRow && !isBtwActive
        ? <SessionTrustPausedRow directory={trustPausedDirectory} />
        : null;

    const composerTopRows = folderMissingRow || trustPausedRow || worktreeSetupRow || creatingSessionRow || spaceWaitRow || goalRow || autoReviewRow || prWatchRow || extensionWaitRow || backgroundShellsRow || revertRow || queueRow || doneHintRow || reviewHintRow || suggestionRow ? (
        <>
            {folderMissingRow}
            {trustPausedRow}
            {worktreeSetupRow}
            {creatingSessionRow}
            {spaceWaitRow}
            {goalRow}
            {autoReviewRow}
            {prWatchRow}
            {extensionWaitRow}
            {backgroundShellsRow}
            {revertRow}
            {queueRow}
            {doneHintRow}
            {reviewHintRow}
            {suggestionRow}
        </>
    ) : null;

    const mobileModelAgentRow = isMobile ? (
        // px-3.5 lines the model logo and the agent label up with the attach
        // and mic icons above them; the buttons drop their own padding so the
        // row alone owns the inset.
        <div className="flex items-center justify-between gap-x-2 px-3.5 pb-2 pt-0.5">
            {isBtwActive ? (
                // `/btw` shows its fork's own model, effort and agent in the same row.
                <ModelControls
                    sessionId={btwComposerSessionId}
                    selection={effectiveBtwSelection}
                    rememberVariantPicks={false}
                />
            ) : (
                <>
                    {/* The effort follows the model as its suffix, as on the desktop. */}
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
    ) : null;

    return {
        composerTopRows, contextRows, mobileModelAgentRow,
    };
}
