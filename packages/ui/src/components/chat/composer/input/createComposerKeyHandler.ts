import type { useComposerSubmission } from './useComposerSubmission';
import type { useComposerSessionScope } from './useComposerSessionScope';
import type { useComposerSessionLifecycle } from './useComposerSessionLifecycle';
import type { useComposerSendAvailability } from './useComposerSendAvailability';
import type { useComposerQueueState } from './useComposerQueueState';
import type { useComposerQueueActions } from './useComposerQueueActions';
import type { useComposerPreferences } from './useComposerPreferences';
import type { useComposerMobileActions } from './useComposerMobileActions';
import type { useComposerLargePasteState } from './useComposerLargePasteState';
import type { useComposerExpansion } from './useComposerExpansion';
import type { useComposerEditorState } from './useComposerEditorState';
import type { useComposerEditorActions } from './useComposerEditorActions';
import type { useComposerDraftText } from './useComposerDraftText';
import type { useComposerDraftHistory } from './useComposerDraftHistory';
import type { useComposerAutocompleteState } from './useComposerAutocompleteState';
import { useUIStore } from '@/stores/useUIStore';
import { shouldSubmitEnter } from '../../composer/keyboardPolicy';
import { getDropdownNavigationKey } from '@/components/ui/dropdown-navigation';
import { isIMECompositionEvent } from '@/lib/ime';
import { eventMatchesShortcut, getEffectiveShortcutCombo, normalizeCombo } from '@/lib/shortcuts';
import { getMarkdownAutoPairEdit, getOrderedListContinuationEdit } from '../../composer/text';

type Dependencies = {
    largePasteState: Pick<ReturnType<typeof useComposerLargePasteState>, 'largeTextPasteGesture'>;
    editorState: Pick<ReturnType<typeof useComposerEditorState>, 'composerRef'>;
    draftText: Pick<ReturnType<typeof useComposerDraftText>, 'setInputMode' | 'composerText'>;
    autocompleteState: Pick<ReturnType<typeof useComposerAutocompleteState>, 'closeAutocomplete' | 'openAutocomplete' | 'commandRef' | 'skillRef' | 'snippetRef' | 'mentionRef' | 'emojiRef'>;
    preferences: Pick<ReturnType<typeof useComposerPreferences>, 'largeTextPasteBehavior' | 'cycleAgentShortcut' | 'isMobile' | 'enterToSend' | 'enterToSendConfigured' | 'mobileReturnKeySends'>;
    expansion: Pick<ReturnType<typeof useComposerExpansion>, 'isDesktopExpanded' | 'setExpandedInput'>;
    mobileActions: Pick<ReturnType<typeof useComposerMobileActions>, 'handlePromptHistoryShortcut'>;
    sessionScope: Pick<ReturnType<typeof useComposerSessionScope>, 'isBtwActive' | 'inputMode' | 'currentSessionId' | 'attachedFiles'>;
    sessionLifecycle: Pick<ReturnType<typeof useComposerSessionLifecycle>, 'handleExitBtw' | 'currentSessionPhase' | 'autoReviewRunning'>;
    editorActions: Pick<ReturnType<typeof useComposerEditorActions>, 'handleCycleAgent'>;
    queueState: Pick<ReturnType<typeof useComposerQueueState>, 'queuedMessages' | 'followUpBehavior'>;
    queueActions: Pick<ReturnType<typeof useComposerQueueActions>, 'handleQueuedMessageEdit' | 'handleQueueMessage'>;
    draftHistory: Pick<ReturnType<typeof useComposerDraftHistory>, 'messageHistory' | 'applyHistoryValue'>;
    sendAvailability: Pick<ReturnType<typeof useComposerSendAvailability>, 'pendingFirstSend' | 'isPageWaiting' | 'getCurrentInputSnapshot'>;
    submission: Pick<ReturnType<typeof useComposerSubmission>, 'handleSubmit'>;
};

export function createComposerKeyHandler({
    largePasteState, editorState, draftText, autocompleteState, preferences, expansion, mobileActions,
    sessionScope, sessionLifecycle, editorActions, queueState, queueActions, draftHistory,
    sendAvailability, submission,
}: Dependencies) {
    const { largeTextPasteGesture } = largePasteState;
    const { composerRef } = editorState;
    const { setInputMode, composerText } = draftText;
    const {
        closeAutocomplete, openAutocomplete, commandRef, skillRef, snippetRef, mentionRef, emojiRef,
    } = autocompleteState;
    const {
        largeTextPasteBehavior, cycleAgentShortcut, isMobile, enterToSend, enterToSendConfigured,
        mobileReturnKeySends,
    } = preferences;
    const { isDesktopExpanded, setExpandedInput } = expansion;
    const { handlePromptHistoryShortcut } = mobileActions;
    const { isBtwActive, inputMode, currentSessionId, attachedFiles } = sessionScope;
    const { handleExitBtw, currentSessionPhase, autoReviewRunning } = sessionLifecycle;
    const { handleCycleAgent } = editorActions;
    const { queuedMessages, followUpBehavior } = queueState;
    const { handleQueuedMessageEdit, handleQueueMessage } = queueActions;
    const { messageHistory, applyHistoryValue } = draftHistory;
    const { pendingFirstSend, isPageWaiting, getCurrentInputSnapshot } = sendAvailability;
    const { handleSubmit } = submission;

    const handleKeyDown = (e: KeyboardEvent) => {
        if (isIMECompositionEvent(e)) {
            largeTextPasteGesture.invalidate();
            return;
        }
        if (largeTextPasteBehavior === 'inline-double-paste') largeTextPasteGesture.keyDown(e);

        const promptHistoryShortcut = getEffectiveShortcutCombo('search_prompt_history', useUIStore.getState().shortcutOverrides);
        if (
            promptHistoryShortcut
            && !promptHistoryShortcut.includes(' ')
            && eventMatchesShortcut(e, promptHistoryShortcut)
            && handlePromptHistoryShortcut(e)
        ) {
            e.preventDefault();
            e.stopPropagation();
            return;
        }

        if (!isBtwActive && inputMode === 'normal' && e.key === '!') {
            const selection = composerRef.current?.getSelection();
            if (selection?.start === 0 && selection.end === 0) {
                e.preventDefault();
                setInputMode('shell');
                closeAutocomplete();
                return;
            }
        }

        if (inputMode === 'shell' && e.key === 'Escape') {
            e.preventDefault();
            setInputMode('normal');
            return;
        }

        const message = composerText.get();
        if (inputMode === 'shell' && e.key === 'Backspace' && message.length === 0) {
            e.preventDefault();
            setInputMode('normal');
            return;
        }

        const autocomplete = openAutocomplete === 'command' ? commandRef.current
            : openAutocomplete === 'skill' ? skillRef.current
                : openAutocomplete === 'snippet' ? snippetRef.current
                    : openAutocomplete === 'mention' ? mentionRef.current
                        : openAutocomplete === 'emoji' && emojiRef.current?.hasResults?.() ? emojiRef.current
                            : null;
        const autocompleteKey = getDropdownNavigationKey(e) ?? e.key;
        if (autocomplete && (autocompleteKey === 'Enter' || autocompleteKey === 'ArrowUp' || autocompleteKey === 'ArrowDown' || autocompleteKey === 'Escape' || autocompleteKey === 'Tab')) {
            e.preventDefault();
            e.stopPropagation();
            autocomplete.handleKeyDown(autocompleteKey);
            return;
        }

        if (e.key === 'Enter' && e.altKey && !e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            composerRef.current?.insertText('\n');
            return;
        }

        if (isBtwActive && currentSessionId && e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            handleExitBtw();
            return;
        }

        if (isDesktopExpanded && e.key === 'Escape') {
            e.preventDefault();
            setExpandedInput(false);
            return;
        }

        const cycleAgentBackwardShortcut = cycleAgentShortcut && !cycleAgentShortcut.includes('shift')
            ? normalizeCombo(`shift+${cycleAgentShortcut}`)
            : '';
        const cycleAgentDirection = cycleAgentBackwardShortcut && eventMatchesShortcut(e, cycleAgentBackwardShortcut)
            ? -1
            : eventMatchesShortcut(e, cycleAgentShortcut)
                ? 1
                : 0;

        if (!isBtwActive && cycleAgentDirection !== 0 && openAutocomplete === null) {
            e.preventDefault();
            e.stopPropagation();
            handleCycleAgent(cycleAgentDirection);
            return;
        }

        const isAnyAutocompleteOpen = openAutocomplete !== null;
        const cursorAtStart = composerRef.current?.getSelection().start === 0 && composerRef.current?.getSelection().end === 0;
        const cursorAtEnd = composerRef.current?.getSelection().start === message.length && composerRef.current?.getSelection().end === message.length;
        const canNavigateHistoryUp = !isAnyAutocompleteOpen && (message.length === 0 || cursorAtStart);
        const canNavigateHistoryDown = !isAnyAutocompleteOpen && (message.length === 0 || cursorAtEnd);

        if (inputMode === 'normal' && !isAnyAutocompleteOpen && !e.metaKey && !e.ctrlKey && !e.altKey) {
            const ta = composerRef.current;
            const selStart = ta?.getSelection().start ?? -1;
            const selEnd = ta?.getSelection().end ?? -1;

            if (ta && selStart >= 0) {
                const listEdit = e.key === 'Enter' && e.shiftKey
                    ? getOrderedListContinuationEdit(message, selStart, selEnd)
                    : null;
                if (listEdit) {
                    e.preventDefault();
                    ta.replaceRange(
                        listEdit.from,
                        listEdit.to,
                        listEdit.insert,
                        listEdit.selectionStart,
                        listEdit.selectionEnd,
                    );
                    return;
                }

                const edit = getMarkdownAutoPairEdit(message, e.key, selStart, selEnd);
                if (edit) {
                    e.preventDefault();
                    ta.replaceRange(
                        edit.from,
                        edit.to,
                        edit.insert,
                        edit.selectionStart,
                        edit.selectionEnd,
                    );
                    return;
                }
            }
        }

        if (e.key === 'ArrowUp' && canNavigateHistoryUp) {
            e.preventDefault();
            const lastQueued = queuedMessages[queuedMessages.length - 1];
            if (lastQueued && message.length === 0 && attachedFiles.length === 0) {
                handleQueuedMessageEdit(lastQueued.id);
                return;
            }
            const recalled = messageHistory.older({ text: message, attachments: attachedFiles });
            if (recalled !== null) {
                applyHistoryValue(recalled, 'start');
            }
            return;
        }

        if (e.key === 'ArrowDown' && canNavigateHistoryDown) {
            e.preventDefault();
            const recalled = messageHistory.newer({ text: message, attachments: attachedFiles });
            if (recalled !== null) {
                applyHistoryValue(recalled, 'end');
            }
            return;
        }

        const isCtrlEnter = e.ctrlKey || e.metaKey;
        if (e.key === 'Enter' && shouldSubmitEnter({
            isMobile,
            isDesktopExpanded,
            enterToSend,
            enterToSendConfigured,
            returnKeySends: mobileReturnKeySends,
            shiftKey: e.shiftKey,
            ctrlKey: e.ctrlKey,
            metaKey: e.metaKey,
            altKey: e.altKey,
        })) {
            e.preventDefault();
            if (pendingFirstSend) return;


            const canQueue = !isBtwActive && !isPageWaiting && inputMode === 'normal' && getCurrentInputSnapshot().hasContent && currentSessionId && (currentSessionPhase !== 'idle' || autoReviewRunning);

            if (followUpBehavior === 'queue') {
                if (isCtrlEnter || !canQueue) {
                    handleSubmit();
                } else {
                    void handleQueueMessage();
                }
            } else {
                if (isCtrlEnter || !canQueue) {
                    handleSubmit();
                } else {
                    handleSubmit({ delivery: 'steer' });
                }
            }
        }
    };

    return {
        handleKeyDown,
    };
}
