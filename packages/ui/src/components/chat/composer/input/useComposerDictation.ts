import React from 'react';
import { useInputStore } from '@/sync/input-store';
import { getChatDraftIdentityKey } from '@/lib/chatDraftPersistence';
import { toast } from '@/components/ui';
import { appendInlineText, appendWithLineBreaks } from '../../composer/text';
import { useDictationOrigin } from '../../composer/state/useDictationOrigin';
import type { useComposerInputState } from './useComposerInputState';
import type { useComposerDraftHistory } from './useComposerDraftHistory';
import type { useComposerSendAvailability } from './useComposerSendAvailability';
import type { useComposerSessionScope } from './useComposerSessionScope';
import type { useComposerSubmission } from './useComposerSubmission';
import type { useComposerSendActions } from './useComposerSendActions';
import type { useComposerSelection } from './useComposerSelection';

type Dependencies = Pick<ReturnType<typeof useComposerInputState>, 'currentChatDraftIdentityRef' | 't' | 'dictationSendEndRef' | 'setMessage' | 'composerText' | 'composerRef' | 'dictationSendInFlightRef' | 'columnPinned'>
    & Pick<ReturnType<typeof useComposerDraftHistory>, 'restoreDraft'>
    & Pick<ReturnType<typeof useComposerSendAvailability>, 'handleSubmitRef' | 'getCurrentInputSnapshot'>
    & Pick<ReturnType<typeof useComposerSessionScope>, 'immediateBtwSubmitRef' | 'isBtwActive' | 'chatDraftIdentity' | 'pendingPresetSubmit' | 'newSessionDraftOpen' | 'newSessionDraft' | 'pendingDraftSubmit'>
    & Pick<ReturnType<typeof useComposerSubmission>, 'handleSubmit'>
    & Pick<ReturnType<typeof useComposerSendActions>, 'submitPresetPrompt'>
    & Pick<ReturnType<typeof useComposerSelection>, 'configCatalogLoaded' | 'currentProviderId' | 'currentModelId' | 'mailboxTarget'>;

export function useComposerDictation({
    currentChatDraftIdentityRef, restoreDraft, t, dictationSendEndRef, setMessage, composerText, composerRef,
    dictationSendInFlightRef, handleSubmitRef, immediateBtwSubmitRef, isBtwActive, chatDraftIdentity,
    handleSubmit, pendingPresetSubmit, columnPinned, submitPresetPrompt, newSessionDraftOpen,
    newSessionDraft, pendingDraftSubmit, configCatalogLoaded, currentProviderId, currentModelId,
    getCurrentInputSnapshot, mailboxTarget,
}: Dependencies) {
    const { markDictationStart, keepTranscriptForOrigin } = useDictationOrigin({
        identityRef: currentChatDraftIdentityRef,
        restoreDraft,
        onKeptForOrigin: () => {
            toast.info(t('chat.chatInput.toast.dictationKeptForOriginalSession'));
        },
    });

    // Dictation: insert the transcript inline; optionally submit immediately.
    // getCurrentInputSnapshot reads composerRef.current.getValue() first, so setting
    // it synchronously lets handleSubmit pick up the text in the same tick.
    // A transcript belongs to the draft that was on screen when recording
    // started. After a session switch it is kept for that draft and must not
    // be inserted or sent here.
    const handleDictationInsert = React.useCallback((text: string) => {
        if (keepTranscriptForOrigin(text)) return;
        dictationSendEndRef.current?.();
        // The editor writes the new text on the render setMessage causes, so
        // no imperative write is needed.
        setMessage(appendInlineText(composerText.get(), text));
        setTimeout(() => {
            composerRef.current?.focus();
        }, 0);
    }, [composerText, keepTranscriptForOrigin, setMessage, dictationSendEndRef, composerRef]);

    const handleDictationInsertAndSend = React.useCallback((text: string) => {
        if (keepTranscriptForOrigin(text)) return;
        // Read the pending draft from the ref, NOT from the editor: the
        // transcript resolves asynchronously, and on mobile the shell may have
        // already collapsed into the pill by then, so the editor is unmounted
        // and getValue() returns '' — which silently dropped the user's typed
        // text and (once the composer cleared) the transcript with it.
        const next = appendInlineText(composerText.get(), text);
        // Land the composed text in the composer state first, so a failed send
        // restores exactly what the user dictated, then submit it as an
        // explicit override (the textarea may be unmounted at this point).
        setMessage(next);
        dictationSendInFlightRef.current = true;
        void handleSubmitRef.current({ presetText: next }).finally(() => {
            dictationSendEndRef.current?.();
        });
    }, [keepTranscriptForOrigin, setMessage, composerText, handleSubmitRef, dictationSendEndRef, dictationSendInFlightRef]);

    // A command with an argument sends once the isolated composer owns its draft.
    React.useEffect(() => {
        const pending = immediateBtwSubmitRef.current;
        if (!pending || !isBtwActive || !chatDraftIdentity) return;
        if (getChatDraftIdentityKey(pending.identity) !== getChatDraftIdentityKey(chatDraftIdentity)) {
            immediateBtwSubmitRef.current = null;
            return;
        }
        immediateBtwSubmitRef.current = null;
        void handleSubmit({ presetText: pending.text });
    });

    // Preset chips rendered outside this component (e.g. under the welcome
    // message on narrow surfaces) request a submit via the input store; consume
    // it here so it routes through the same command-aware submit path.
    React.useEffect(() => {
        if (pendingPresetSubmit == null || columnPinned) return;
        const text = useInputStore.getState().consumePendingPresetSubmit();
        if (text) submitPresetPrompt(text.text, text.type);
    }, [columnPinned, pendingPresetSubmit, submitPresetPrompt]);

    // A first message a native Shortcuts request left for this draft goes out
    // once the draft's project has its models and agents and one is selected,
    // so it is sent with the project's defaults, the way a typed first message
    // would be. A request for another draft is dropped, never sent from here.
    // The text goes into the composer before the send, so a send that stops
    // early (a stopped space, no model) leaves it there. A draft that already
    // holds something (text, files, comments, references, context) gets the
    // text appended and nothing is sent: the shortcut never sends or clears
    // what the user put there.
    const draftSubmitDraftId = newSessionDraftOpen ? newSessionDraft.draftId : null;

    React.useEffect(() => {
        if (pendingDraftSubmit == null || columnPinned) return;
        if (draftSubmitDraftId === pendingDraftSubmit.draftId && (!configCatalogLoaded || !currentProviderId || !currentModelId)) return;
        const text = useInputStore.getState().consumePendingDraftSubmit(draftSubmitDraftId);
        if (!text) return;
        const composerHolds = getCurrentInputSnapshot().hasContent
            || (useInputStore.getState().getPendingSyntheticParts(mailboxTarget)?.length ?? 0) > 0;
        if (composerHolds) {
            setMessage(appendWithLineBreaks(composerText.get(), text));
            return;
        }
        setMessage(text);
        void handleSubmitRef.current({ presetText: text });
    }, [columnPinned, composerText, configCatalogLoaded, currentModelId, currentProviderId, draftSubmitDraftId, getCurrentInputSnapshot, mailboxTarget, pendingDraftSubmit, setMessage, handleSubmitRef]);

    return {
        handleDictationInsert, handleDictationInsertAndSend, markDictationStart,
    };
}
