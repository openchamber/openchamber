import type { useI18n } from '@/lib/i18n';
import type { useComposerEditorState } from './useComposerEditorState';
import type { useComposerDraftText } from './useComposerDraftText';
import type { useComposerDraftHistory } from './useComposerDraftHistory';
import type { useComposerDictationState } from './useComposerDictationState';
import type { ComposerSendHandlers } from './composerSendHandlers';
import React from 'react';
import { toast } from '@/components/ui';
import { appendInlineText } from '../../composer/text';
import { useDictationOrigin } from '../../composer/state/useDictationOrigin';

type Dependencies = {
    draftText: Pick<ReturnType<typeof useComposerDraftText>, 'currentChatDraftIdentityRef' | 'setMessage' | 'composerText'>;
    i18n: Pick<ReturnType<typeof useI18n>, 't'>;
    dictationState: Pick<ReturnType<typeof useComposerDictationState>, 'dictationSendEndRef' | 'dictationSendInFlightRef'>;
    editorState: Pick<ReturnType<typeof useComposerEditorState>, 'composerRef'>;
    draftHistory: Pick<ReturnType<typeof useComposerDraftHistory>, 'restoreDraft'>;
    sendHandlers: Pick<ComposerSendHandlers, 'handleSubmitRef'>;
};

export function useComposerDictation({
    draftText, i18n, dictationState, editorState, draftHistory, sendHandlers,
}: Dependencies) {
    const { currentChatDraftIdentityRef, setMessage, composerText } = draftText;
    const { t } = i18n;
    const { dictationSendEndRef, dictationSendInFlightRef } = dictationState;
    const { composerRef } = editorState;
    const { restoreDraft } = draftHistory;
    const { handleSubmitRef } = sendHandlers;

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

    return {
        handleDictationInsert, handleDictationInsertAndSend, markDictationStart,
    };
}
