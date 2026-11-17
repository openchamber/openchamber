import React from 'react';
import { useInputStore } from '@/sync/input-store';
import type { AttachedFile } from '@/stores/types/sessionTypes';
import { getChatDraftIdentityKey } from '@/lib/chatDraftPersistence';
import { withMissingCitations } from '@/lib/attachmentIdentity';
import { useUnconfirmedSendRecovery } from '@/hooks/useUnconfirmedSendRecovery';
import { useMessageHistory, type MessageHistoryValue } from '../../composer/state/useMessageHistory';
import { useComposerDraft } from '../../composer/state/useComposerDraft';
import { useSessionDraftPublishing } from '../../composer/state/useSessionDraftPublishing';
import { createInputHistoryIdentity, selectInputHistoryEntries, useInputHistoryStore } from '@/stores/useInputHistoryStore';
import { buildInputHistoryNavigatorIdentity, mapInputHistoryEntriesToValues, mergeSessionInputHistory } from '../../inputHistory';
import { useUserMessageHistory } from '@/sync/sync-context';
import type { useComposerSessionScope } from './useComposerSessionScope';
import type { useComposerInlineContext } from './useComposerInlineContext';
import type { useComposerInputState } from './useComposerInputState';

type Dependencies = Pick<ReturnType<typeof useComposerSessionScope>, 'activeRuntimeKey' | 'currentSessionDirectoryForSync' | 'currentDirectory' | 'isBtwActive' | 'btwSessionId' | 'currentSessionId' | 'chatDraftIdentity' | 'inputMode' | 'isBtwPanelVisible' | 'newSessionDraftOpen' | 'newSessionDraft' | 'draftCaretModeRef'>
    & Pick<ReturnType<typeof useComposerInlineContext>, 'inlineDraftSessionKey'>
    & Pick<ReturnType<typeof useComposerInputState>, 'promptHistorySearch' | 'setPromptHistorySearch' | 'setHistoryFocusPending' | 'setMessage' | 'composerRef' | 'currentChatDraftIdentityRef' | 'composerText' | 'confirmedMentionsRef' | 'columnPinned' | 'initialDraftRef' | 'initialDraftIdentityRef' | 'mentionCompletion' | 'closeAutocomplete' | 'setInputMode'>;

export function useComposerDraftHistory({
    activeRuntimeKey, currentSessionDirectoryForSync, currentDirectory, inlineDraftSessionKey, isBtwActive,
    btwSessionId, currentSessionId, chatDraftIdentity, inputMode, isBtwPanelVisible, promptHistorySearch,
    setPromptHistorySearch, setHistoryFocusPending, setMessage, composerRef, currentChatDraftIdentityRef,
    composerText, confirmedMentionsRef, columnPinned, initialDraftRef, initialDraftIdentityRef,
    newSessionDraftOpen, newSessionDraft, mentionCompletion, closeAutocomplete, setInputMode,
    draftCaretModeRef,
}: Dependencies) {
    const inputHistoryScope = useInputHistoryStore((state) => state.scope);

    const inputHistoryIdentity = React.useMemo(
        () => createInputHistoryIdentity(
            activeRuntimeKey,
            currentSessionDirectoryForSync ?? currentDirectory ?? '',
            inlineDraftSessionKey || 'draft',
        ),
        [activeRuntimeKey, currentDirectory, currentSessionDirectoryForSync, inlineDraftSessionKey],
    );

    const inputHistoryEntries = useInputHistoryStore(React.useCallback(
        (state) => selectInputHistoryEntries(state, inputHistoryIdentity),
        [inputHistoryIdentity],
    ));

    // Session scope also reads the visible transcript, so sessions older than
    // the persisted history still recall their prompts.
    const transcriptPrompts = useUserMessageHistory((isBtwActive ? btwSessionId : currentSessionId) ?? '');

    const historyValues = React.useMemo(
        () => (inputHistoryScope === 'session'
            ? mergeSessionInputHistory(transcriptPrompts, inputHistoryEntries)
            : mapInputHistoryEntriesToValues(inputHistoryEntries)),
        [inputHistoryEntries, inputHistoryScope, transcriptPrompts],
    );

    const messageHistoryIdentity = React.useMemo(
        () => buildInputHistoryNavigatorIdentity(inputHistoryScope, inputHistoryIdentity),
        [inputHistoryIdentity, inputHistoryScope],
    );

    const messageHistory = useMessageHistory<AttachedFile>(historyValues, messageHistoryIdentity);

    const promptHistorySearchIdentity = `${chatDraftIdentity ? getChatDraftIdentityKey(chatDraftIdentity) : 'none'}:${messageHistoryIdentity}:${inputMode}:${isBtwActive}:${isBtwPanelVisible}`;

    const isPromptHistorySearchOpen = promptHistorySearch?.identity === promptHistorySearchIdentity;

    const promptHistorySearchIdentityRef = React.useRef(promptHistorySearchIdentity);

    promptHistorySearchIdentityRef.current = promptHistorySearchIdentity;

    React.useEffect(() => {
        if (!isPromptHistorySearchOpen && promptHistorySearch) setPromptHistorySearch(null);
    }, [isPromptHistorySearchOpen, promptHistorySearch, setPromptHistorySearch]);

    // The one deferred composer focus that history work may have pending. A
    // newer schedule replaces it; opening the search or unmounting cancels it,
    // so a stale frame cannot pull focus out of a search that opened since.
    const historyFocusFrameRef = React.useRef<number | null>(null);

    const cancelHistoryFocusFrame = React.useCallback(() => {
        if (historyFocusFrameRef.current === null) return;
        window.cancelAnimationFrame(historyFocusFrameRef.current);
        historyFocusFrameRef.current = null;
        setHistoryFocusPending(false);
    }, [setHistoryFocusPending]);

    const scheduleHistoryFocusFrame = React.useCallback((run: () => void) => {
        cancelHistoryFocusFrame();
        setHistoryFocusPending(true);
        historyFocusFrameRef.current = window.requestAnimationFrame(() => {
            historyFocusFrameRef.current = null;
            run();
            setHistoryFocusPending(false);
        });
    }, [cancelHistoryFocusFrame, setHistoryFocusPending]);

    React.useEffect(() => cancelHistoryFocusFrame, [cancelHistoryFocusFrame]);

    const applyHistoryValue = React.useCallback((value: MessageHistoryValue<AttachedFile>, selection: 'start' | 'end') => {
        const identity = promptHistorySearchIdentityRef.current;
        // A prompt sent before every attachment had a chip gets one for each.
        setMessage(withMissingCitations(value.text, value.attachments));
        useInputStore.getState().setAttachedFiles([...value.attachments], chatDraftIdentity);
        scheduleHistoryFocusFrame(() => {
            if (promptHistorySearchIdentityRef.current !== identity) return;
            const editor = composerRef.current;
            if (!editor) return;
            const position = selection === 'start' ? 0 : editor.getValue().length;
            editor.focus();
            editor.setSelection(position, position);
        });
    }, [chatDraftIdentity, scheduleHistoryFocusFrame, setMessage, composerRef]);

    React.useEffect(() => {
        currentChatDraftIdentityRef.current = chatDraftIdentity;
    }, [chatDraftIdentity, currentChatDraftIdentityRef]);

    // Draft persistence: identity switching, debounced writes and the
    // flush-on-hide edges live in the hook.
    const {
        persistNow: persistDraftImmediately,
        handoffDraft,
        restoreDraft,
        migrateDraft,
    } = useComposerDraft({
        text: composerText,
        setMessage,
        confirmedMentionsRef,
        identity: chatDraftIdentity,
        selectAttachmentsOnIdentityChange: !columnPinned,
        initialDraft: {
            text: initialDraftRef.current ?? '',
            identity: initialDraftIdentityRef.current,
        },
        newSessionDraftId: newSessionDraftOpen ? newSessionDraft.draftId : null,
        onIdentityChange: () => {
            mentionCompletion.clear();
            closeAutocomplete();
            setInputMode('normal');
            draftCaretModeRef.current.atEnd = isBtwActive || draftCaretModeRef.current.btw;
            draftCaretModeRef.current.btw = isBtwActive;
        },
        onDraftRestored: (source) => {
            const editor = composerRef.current;
            if (!editor) return;
            if (source === 'fork') editor.focus();
            if (source !== 'fork' && draftCaretModeRef.current.atEnd) {
                editor.setSelection(editor.getValue().length);
            } else {
                editor.selectAll();
            }
        },
    });

    useUnconfirmedSendRecovery(columnPinned ? null : activeRuntimeKey, restoreDraft, currentChatDraftIdentityRef);

    // A project's new draft is shared with the server, which lists it in the
    // sidebar once the user leaves it (the chat identity carries its key only
    // while it is the one on screen).
    useSessionDraftPublishing({
        identity: isBtwActive ? null : chatDraftIdentity,
        text: composerText,
        confirmedMentionsRef,
        projectId: newSessionDraftOpen ? newSessionDraft.selectedProjectId ?? null : null,
        enabled: newSessionDraftOpen && !currentSessionId,
    });

    return {
        restoreDraft, handoffDraft, persistDraftImmediately, messageHistory, migrateDraft, applyHistoryValue,
        isPromptHistorySearchOpen, promptHistorySearchIdentity, cancelHistoryFocusFrame,
        promptHistorySearchIdentityRef, scheduleHistoryFocusFrame, historyValues,
    };
}
