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

    const handleDictationInsert = React.useCallback((text: string) => {
        if (keepTranscriptForOrigin(text)) return;
        dictationSendEndRef.current?.();
        setMessage(appendInlineText(composerText.get(), text));
        setTimeout(() => {
            composerRef.current?.focus();
        }, 0);
    }, [composerText, keepTranscriptForOrigin, setMessage, dictationSendEndRef, composerRef]);

    // Each capture path marks and keeps against its OWN dictation origin, so
    // an overlapping streaming and facade capture cannot consume each other's
    // origin and land a transcript in the wrong draft.
    const markStreamingDictationStart = React.useCallback(() => { markDictationStart('streaming'); }, [markDictationStart]);
    const markFacadeDictationStart = React.useCallback(() => { markDictationStart('facade'); }, [markDictationStart]);

    const handleFacadeDictationInsert = React.useCallback((text: string) => {
        if (keepTranscriptForOrigin(text, 'facade')) return;
        dictationSendEndRef.current?.();
        setMessage(appendInlineText(composerText.get(), text));
        setTimeout(() => {
            composerRef.current?.focus();
        }, 0);
    }, [composerText, keepTranscriptForOrigin, setMessage, dictationSendEndRef, composerRef]);

    const handleDictationInsertAndSend = React.useCallback((text: string) => {
        if (keepTranscriptForOrigin(text)) return;
        const next = appendInlineText(composerText.get(), text);
        setMessage(next);
        dictationSendInFlightRef.current = true;
        void handleSubmitRef.current({ presetText: next }).finally(() => {
            dictationSendEndRef.current?.();
        });
    }, [keepTranscriptForOrigin, setMessage, composerText, handleSubmitRef, dictationSendEndRef, dictationSendInFlightRef]);

    return {
        handleDictationInsert, handleDictationInsertAndSend, markStreamingDictationStart,
        markFacadeDictationStart, handleFacadeDictationInsert,
    };
}
