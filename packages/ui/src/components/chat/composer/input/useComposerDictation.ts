import type { useI18n } from '@/lib/i18n';
import type { useComposerSessionScope } from './useComposerSessionScope';
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
    draftText: Pick<ReturnType<typeof useComposerDraftText>, 'setMessage' | 'composerText'>;
    i18n: Pick<ReturnType<typeof useI18n>, 't'>;
    dictationState: Pick<ReturnType<typeof useComposerDictationState>, 'dictationOriginRef' | 'dictationSendEndRef' | 'dictationSendInFlightRef'>;
    editorState: Pick<ReturnType<typeof useComposerEditorState>, 'composerRef'>;
    draftHistory: Pick<ReturnType<typeof useComposerDraftHistory>, 'restoreDraft'>;
    sendHandlers: Pick<ComposerSendHandlers, 'handleSubmitRef'>;
    sessionScope: Pick<ReturnType<typeof useComposerSessionScope>, 'chatDraftIdentity' | 'currentSessionId' | 'isBtwActive' | 'newSessionDraft' | 'newSessionDraftOpen'>;
};

export function useComposerDictation({
    draftText, i18n, dictationState, editorState, draftHistory, sendHandlers, sessionScope,
}: Dependencies) {
    const { setMessage, composerText } = draftText;
    const { t } = i18n;
    const { dictationOriginRef, dictationSendEndRef, dictationSendInFlightRef } = dictationState;
    const { composerRef } = editorState;
    const { restoreDraft } = draftHistory;
    const { handleSubmitRef } = sendHandlers;
    const { chatDraftIdentity, currentSessionId, isBtwActive, newSessionDraft, newSessionDraftOpen } = sessionScope;

    const { markDictationStart, markDictationSendConfirmed, keepTranscriptForOrigin, hasSendTargetMoved } = useDictationOrigin({
        originRef: dictationOriginRef,
        newSessionDraftId: newSessionDraftOpen && !currentSessionId && !isBtwActive ? newSessionDraft.draftId : null,
        identity: chatDraftIdentity,
        restoreDraft,
        onKeptForOrigin: () => {
            toast.info(t('chat.chatInput.toast.dictationKeptForOriginalSession'));
        },
    });

    const insertTranscript = React.useCallback((text: string) => {
        dictationSendEndRef.current?.();
        setMessage(appendInlineText(composerText.get(), text));
        setTimeout(() => {
            composerRef.current?.focus();
        }, 0);
    }, [composerText, setMessage, dictationSendEndRef, composerRef]);

    const handleDictationInsert = React.useCallback((text: string) => {
        if (keepTranscriptForOrigin(text)) return;
        insertTranscript(text);
    }, [insertTranscript, keepTranscriptForOrigin]);

    const handleDictationInsertAndSend = React.useCallback((text: string) => {
        const targetMoved = hasSendTargetMoved();
        if (keepTranscriptForOrigin(text)) return;
        if (targetMoved) {
            insertTranscript(text);
            return;
        }
        const next = appendInlineText(composerText.get(), text);
        setMessage(next);
        dictationSendInFlightRef.current = true;
        void handleSubmitRef.current({ presetText: next }).finally(() => {
            dictationSendEndRef.current?.();
        });
    }, [keepTranscriptForOrigin, hasSendTargetMoved, insertTranscript, setMessage, composerText, handleSubmitRef, dictationSendEndRef, dictationSendInFlightRef]);

    return {
        handleDictationInsert, handleDictationInsertAndSend, markDictationStart, markDictationSendConfirmed,
    };
}
