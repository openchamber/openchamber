import { useUIStore } from '@/stores/useUIStore';
import { shouldSubmitEnter } from '../../composer/keyboardPolicy';
import { getDropdownNavigationKey } from '@/components/ui/dropdown-navigation';
import { isIMECompositionEvent } from '@/lib/ime';
import { eventMatchesShortcut, getEffectiveShortcutCombo, normalizeCombo } from '@/lib/shortcuts';
import { getMarkdownAutoPairEdit, getOrderedListContinuationEdit } from '../../composer/text';
import type { useComposerInputState } from './useComposerInputState';
import type { useComposerEnvironment } from './useComposerEnvironment';
import type { useComposerMobileActions } from './useComposerMobileActions';
import type { useComposerSessionScope } from './useComposerSessionScope';
import type { useComposerSessionLifecycle } from './useComposerSessionLifecycle';
import type { useComposerEditorActions } from './useComposerEditorActions';
import type { useComposerQueueState } from './useComposerQueueState';
import type { useComposerQueueActions } from './useComposerQueueActions';
import type { useComposerDraftHistory } from './useComposerDraftHistory';
import type { useComposerSendAvailability } from './useComposerSendAvailability';
import type { useComposerSubmission } from './useComposerSubmission';

type Dependencies = Pick<ReturnType<typeof useComposerInputState>, 'largeTextPasteGesture' | 'composerRef' | 'setInputMode' | 'closeAutocomplete' | 'composerText' | 'openAutocomplete' | 'commandRef' | 'skillRef' | 'snippetRef' | 'mentionRef' | 'emojiRef'>
    & Pick<ReturnType<typeof useComposerEnvironment>, 'largeTextPasteBehavior' | 'isDesktopExpanded' | 'setExpandedInput' | 'cycleAgentShortcut' | 'isMobile' | 'enterToSend' | 'enterToSendConfigured' | 'mobileReturnKeySends'>
    & Pick<ReturnType<typeof useComposerMobileActions>, 'handlePromptHistoryShortcut'>
    & Pick<ReturnType<typeof useComposerSessionScope>, 'isBtwActive' | 'inputMode' | 'currentSessionId' | 'attachedFiles'>
    & Pick<ReturnType<typeof useComposerSessionLifecycle>, 'handleExitBtw' | 'currentSessionPhase' | 'autoReviewRunning'>
    & Pick<ReturnType<typeof useComposerEditorActions>, 'handleCycleAgent'>
    & Pick<ReturnType<typeof useComposerQueueState>, 'queuedMessages' | 'followUpBehavior'>
    & Pick<ReturnType<typeof useComposerQueueActions>, 'handleQueuedMessageEdit' | 'handleQueueMessage'>
    & Pick<ReturnType<typeof useComposerDraftHistory>, 'messageHistory' | 'applyHistoryValue'>
    & Pick<ReturnType<typeof useComposerSendAvailability>, 'pendingFirstSend' | 'isPageWaiting' | 'getCurrentInputSnapshot'>
    & Pick<ReturnType<typeof useComposerSubmission>, 'handleSubmit'>;

export function createComposerKeyHandler({
    largeTextPasteGesture, largeTextPasteBehavior, handlePromptHistoryShortcut, isBtwActive, inputMode,
    composerRef, setInputMode, closeAutocomplete, composerText, openAutocomplete, commandRef, skillRef,
    snippetRef, mentionRef, emojiRef, currentSessionId, handleExitBtw, isDesktopExpanded, setExpandedInput,
    cycleAgentShortcut, handleCycleAgent, queuedMessages, attachedFiles, handleQueuedMessageEdit,
    messageHistory, applyHistoryValue, isMobile, enterToSend, enterToSendConfigured, mobileReturnKeySends,
    pendingFirstSend, isPageWaiting, getCurrentInputSnapshot, currentSessionPhase, autoReviewRunning,
    followUpBehavior, handleSubmit, handleQueueMessage,
}: Dependencies) {
    const handleKeyDown = (e: KeyboardEvent) => {
        // Early return during IME composition to prevent interference with autocomplete.
        // Uses keyCode === 229 fallback for WebKit where compositionend fires before keydown.
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

        // Enter shell mode before CodeMirror inserts the trigger. Keeping the
        // document unchanged also keeps the caret at the start for the first
        // command character.
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

        // The text as it is now: a key can arrive before the render that
        // follows the previous one.
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
                        // An emoji list takes keys only once it shows something.
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

        // Handle ArrowUp/ArrowDown for message history navigation
        // ArrowUp: only when cursor at start (position 0) or input is empty
        // ArrowDown: also works when cursor at end (to cycle forward through history)
        const isAnyAutocompleteOpen = openAutocomplete !== null;
        const cursorAtStart = composerRef.current?.getSelection().start === 0 && composerRef.current?.getSelection().end === 0;
        const cursorAtEnd = composerRef.current?.getSelection().start === message.length && composerRef.current?.getSelection().end === message.length;
        const canNavigateHistoryUp = !isAnyAutocompleteOpen && (message.length === 0 || cursorAtStart);
        const canNavigateHistoryDown = !isAnyAutocompleteOpen && (message.length === 0 || cursorAtEnd);

        // Markdown-aware auto-pairing (source mode), normal input only.
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
            // An empty composer over a queue edits the newest queued message, as
            // its Edit button does; recalling its text from history and sending
            // it would queue a duplicate.
            const lastQueued = queuedMessages[queuedMessages.length - 1];
            if (lastQueued && message.length === 0 && attachedFiles.length === 0) {
                handleQueuedMessageEdit(lastQueued.id);
                return;
            }
            const recalled = messageHistory.older({ text: message, attachments: attachedFiles });
            if (recalled !== null) {
                // Caret to the start, so the recalled message reads from its
                // beginning rather than from wherever the draft's caret was.
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

        // Mobile and expanded desktop require Ctrl/Cmd+Enter to send from the
        // keyboard. The standard desktop composer follows the setting.
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

            // An empty composer with a queue sends the whole queue now. While
            // a turn runs Stop replaces the send button, so only Enter does it.

            // Queueing / steering only works when there's an existing busy
            // session (or an active auto-review run).
            const canQueue = !isBtwActive && !isPageWaiting && inputMode === 'normal' && getCurrentInputSnapshot().hasContent && currentSessionId && (currentSessionPhase !== 'idle' || autoReviewRunning);

            if (followUpBehavior === 'queue') {
                if (isCtrlEnter || !canQueue) {
                    handleSubmit();
                } else {
                    void handleQueueMessage();
                }
            } else {
                // steer: Enter steers into the running turn, Ctrl+Enter sends now.
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
