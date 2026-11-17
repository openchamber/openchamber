import React from 'react';
import type { AttachedFile } from '@/stores/types/sessionTypes';
import { shortcutRegistry } from '@/lib/shortcuts';
import type { PromptHistoryCandidate } from '../../composer/state/promptHistorySearch';
import { registerPromptHistorySearchRoute } from '../../composer/state/promptHistorySearchRoute';
import { useMobileCommentComposerMode } from '../../composer/comment/useMobileCommentComposerMode';
import type { useComposerInputState } from './useComposerInputState';
import type { useComposerMobileShell } from './useComposerMobileShell';
import type { useComposerEnvironment } from './useComposerEnvironment';
import type { useComposerSessionScope } from './useComposerSessionScope';
import type { useComposerInlineContext } from './useComposerInlineContext';
import type { useComposerDraftHistory } from './useComposerDraftHistory';

type Dependencies = Pick<ReturnType<typeof useComposerInputState>, 'dictationSendEndRef' | 'dictationSendInFlightRef' | 'openAutocomplete' | 'largeTextPasteOffer' | 'setPromptHistorySearch' | 'composerRef' | 'promptHistorySearchOwner' | 'composerText'>
    & Pick<ReturnType<typeof useComposerMobileShell>, 'mobileShell'>
    & Pick<ReturnType<typeof useComposerEnvironment>, 'isMobile'>
    & Pick<ReturnType<typeof useComposerSessionScope>, 'activeRuntimeKey' | 'inputMode' | 'isBtwActive' | 'isBtwPanelVisible' | 'attachedFiles'>
    & Pick<ReturnType<typeof useComposerInlineContext>, 'inlineDraftDirectory' | 'inlineDraftSessionKey' | 'attachMobileCommentRef'>
    & Pick<ReturnType<typeof useComposerDraftHistory>, 'isPromptHistorySearchOpen' | 'promptHistorySearchIdentity' | 'cancelHistoryFocusFrame' | 'promptHistorySearchIdentityRef' | 'scheduleHistoryFocusFrame' | 'messageHistory' | 'applyHistoryValue'>;

export function useComposerMobileActions({
    dictationSendEndRef, dictationSendInFlightRef, mobileShell, isMobile, activeRuntimeKey,
    inlineDraftDirectory, inlineDraftSessionKey, inputMode, isBtwActive, isBtwPanelVisible, openAutocomplete,
    largeTextPasteOffer, isPromptHistorySearchOpen, setPromptHistorySearch, promptHistorySearchIdentity,
    composerRef, cancelHistoryFocusFrame, promptHistorySearchOwner, promptHistorySearchIdentityRef,
    scheduleHistoryFocusFrame, messageHistory, composerText, attachedFiles, applyHistoryValue,
    attachMobileCommentRef,
}: Dependencies) {
    dictationSendEndRef.current = () => {
        dictationSendInFlightRef.current = false;
        mobileShell.holdDictationSend(false);
    };

    const handleDictationSendStart = React.useCallback(() => {
        // Only the mobile shell collapses on dictation end, and only its
        // dictation reports when it ends, which is what releases a hold
        // that never reaches a submit.
        if (isMobile) mobileShell.holdDictationSend(true);
    }, [isMobile, mobileShell]);

    // A record-and-send that never reaches a submit (failed or empty
    // transcript, cancel, a transcript kept for another draft) still releases
    // the hold once dictation ends. The transcript callback runs in the same
    // tick the status turns idle, so a real send is already in flight here.
    const { onDictationActiveChange } = mobileShell;

    const handleDictationActiveChange = React.useCallback((active: boolean) => {
        onDictationActiveChange(active);
        if (!active && !dictationSendInFlightRef.current) dictationSendEndRef.current?.();
    }, [onDictationActiveChange, dictationSendEndRef, dictationSendInFlightRef]);

    // Mobile comment mode: subscription, scope ownership and the attach/cancel
    // transitions live in the hook; ChatInput only renders from it.
    const mobileComment = useMobileCommentComposerMode({
        isMobile,
        runtimeKey: activeRuntimeKey,
        directory: inlineDraftDirectory,
        sessionKey: inlineDraftSessionKey,
        mobileShell,
    });

    const mobileCommentActive = mobileComment.active;

    const handlePromptHistoryShortcut = React.useCallback((event: KeyboardEvent) => {
        if (
            shortcutRegistry.isSuspended()
            || event.defaultPrevented
            || inputMode !== 'normal'
            || isBtwActive
            || isBtwPanelVisible
            || openAutocomplete !== null
            || mobileCommentActive
            || largeTextPasteOffer !== null
        ) return false;

        if (isPromptHistorySearchOpen) {
            setPromptHistorySearch((current) => current && current.identity === promptHistorySearchIdentity
                ? { ...current, olderRequest: current.olderRequest + 1 }
                : current);
            return true;
        }

        const target = event.target;
        if (!(target instanceof Element) || !target.closest('[data-chat-input="true"], [data-prompt-history-search-input]')) return false;
        const editor = composerRef.current;
        const selection = editor?.getSelection();
        const initialQuery = editor && selection && selection.start !== selection.end
            ? editor.getValue().slice(selection.start, selection.end)
            : '';
        cancelHistoryFocusFrame();
        setPromptHistorySearch({ identity: promptHistorySearchIdentity, initialQuery, olderRequest: 0 });
        return true;
    }, [cancelHistoryFocusFrame, inputMode, isBtwActive, isBtwPanelVisible, isPromptHistorySearchOpen, largeTextPasteOffer, mobileCommentActive, openAutocomplete, promptHistorySearchIdentity, setPromptHistorySearch, composerRef]);

    React.useEffect(() => {
        if (!promptHistorySearchOwner) return;
        return registerPromptHistorySearchRoute(promptHistorySearchOwner, handlePromptHistoryShortcut);
    }, [handlePromptHistoryShortcut, promptHistorySearchOwner]);

    const closePromptHistorySearch = React.useCallback((reason: 'dismiss' | 'blur') => {
        const identity = promptHistorySearchIdentityRef.current;
        setPromptHistorySearch(null);
        if (reason !== 'dismiss') return;
        scheduleHistoryFocusFrame(() => {
            if (promptHistorySearchIdentityRef.current === identity) composerRef.current?.focus();
        });
    }, [scheduleHistoryFocusFrame, setPromptHistorySearch, promptHistorySearchIdentityRef, composerRef]);

    const pickPromptHistoryCandidate = React.useCallback((candidate: PromptHistoryCandidate<AttachedFile>) => {
        if (!isPromptHistorySearchOpen || promptHistorySearchIdentityRef.current !== promptHistorySearchIdentity) return;
        const recalled = messageHistory.jumpTo(candidate.index, { text: composerText.get(), attachments: attachedFiles }, candidate.value);
        if (!recalled) return;
        setPromptHistorySearch(null);
        applyHistoryValue(recalled, 'end');
    }, [applyHistoryValue, attachedFiles, isPromptHistorySearchOpen, messageHistory, promptHistorySearchIdentity, composerText, setPromptHistorySearch, promptHistorySearchIdentityRef]);

    attachMobileCommentRef.current = mobileComment.submit;

    return {
        handlePromptHistoryShortcut, mobileCommentActive, mobileComment, pickPromptHistoryCandidate,
        closePromptHistorySearch, handleDictationSendStart, handleDictationActiveChange,
    };
}
