import type { useComposerSessionScope } from './useComposerSessionScope';
import type { useComposerPreferences } from './useComposerPreferences';
import type { useComposerMobileShell } from './useComposerMobileShell';
import type { useComposerLargePasteState } from './useComposerLargePasteState';
import type { useComposerInlineContext } from './useComposerInlineContext';
import type { useComposerHistorySearchState } from './useComposerHistorySearchState';
import type { useComposerEditorState } from './useComposerEditorState';
import type { useComposerDraftText } from './useComposerDraftText';
import type { useComposerDraftHistory } from './useComposerDraftHistory';
import type { useComposerDictationState } from './useComposerDictationState';
import type { useComposerAutocompleteState } from './useComposerAutocompleteState';
import React from 'react';
import type { AttachedFile } from '@/stores/types/sessionTypes';
import { shortcutRegistry } from '@/lib/shortcuts';
import type { PromptHistoryCandidate } from '../../composer/state/promptHistorySearch';
import { registerPromptHistorySearchRoute } from '../../composer/state/promptHistorySearchRoute';
import { useMobileCommentComposerMode } from '../../composer/comment/useMobileCommentComposerMode';

type Dependencies = {
    dictationState: Pick<ReturnType<typeof useComposerDictationState>, 'dictationSendEndRef' | 'dictationSendInFlightRef'>;
    autocompleteState: Pick<ReturnType<typeof useComposerAutocompleteState>, 'openAutocomplete'>;
    largePasteState: Pick<ReturnType<typeof useComposerLargePasteState>, 'largeTextPasteOffer'>;
    historySearchState: Pick<ReturnType<typeof useComposerHistorySearchState>, 'setPromptHistorySearch' | 'promptHistorySearchOwner'>;
    editorState: Pick<ReturnType<typeof useComposerEditorState>, 'composerRef'>;
    draftText: Pick<ReturnType<typeof useComposerDraftText>, 'composerText'>;
    mobileShell: Pick<ReturnType<typeof useComposerMobileShell>, 'mobileShell'>;
    preferences: Pick<ReturnType<typeof useComposerPreferences>, 'isMobile'>;
    sessionScope: Pick<ReturnType<typeof useComposerSessionScope>, 'activeRuntimeKey' | 'inputMode' | 'isBtwActive' | 'isBtwPanelVisible' | 'attachedFiles'>;
    inlineContext: Pick<ReturnType<typeof useComposerInlineContext>, 'inlineDraftDirectory' | 'inlineDraftSessionKey' | 'attachMobileCommentRef'>;
    draftHistory: Pick<ReturnType<typeof useComposerDraftHistory>, 'isPromptHistorySearchOpen' | 'promptHistorySearchIdentity' | 'cancelHistoryFocusFrame' | 'promptHistorySearchIdentityRef' | 'scheduleHistoryFocusFrame' | 'messageHistory' | 'applyHistoryValue'>;
};

export function useComposerMobileActions({
    dictationState, autocompleteState, largePasteState, historySearchState, editorState, draftText,
    mobileShell: mobile, preferences, sessionScope, inlineContext, draftHistory,
}: Dependencies) {
    const { dictationSendEndRef, dictationSendInFlightRef } = dictationState;
    const { openAutocomplete } = autocompleteState;
    const { largeTextPasteOffer } = largePasteState;
    const { setPromptHistorySearch, promptHistorySearchOwner } = historySearchState;
    const { composerRef } = editorState;
    const { composerText } = draftText;
    const { mobileShell } = mobile;
    const { isMobile } = preferences;
    const { activeRuntimeKey, inputMode, isBtwActive, isBtwPanelVisible, attachedFiles } = sessionScope;
    const { inlineDraftDirectory, inlineDraftSessionKey, attachMobileCommentRef } = inlineContext;
    const {
        isPromptHistorySearchOpen, promptHistorySearchIdentity, cancelHistoryFocusFrame,
        promptHistorySearchIdentityRef, scheduleHistoryFocusFrame, messageHistory, applyHistoryValue,
    } = draftHistory;

    dictationSendEndRef.current = () => {
        dictationSendInFlightRef.current = false;
        mobileShell.holdDictationSend(false);
    };

    const handleDictationSendStart = React.useCallback(() => {
        if (isMobile) mobileShell.holdDictationSend(true);
    }, [isMobile, mobileShell]);

    const { onDictationActiveChange } = mobileShell;

    const handleDictationActiveChange = React.useCallback((active: boolean) => {
        onDictationActiveChange(active);
        if (!active && !dictationSendInFlightRef.current) dictationSendEndRef.current?.();
    }, [onDictationActiveChange, dictationSendEndRef, dictationSendInFlightRef]);

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
