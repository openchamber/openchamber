import type { useComposerSubmission } from './useComposerSubmission';
import type { useComposerSessionScope } from './useComposerSessionScope';
import type { useComposerSendAvailability } from './useComposerSendAvailability';
import type { useComposerSendActions } from './useComposerSendActions';
import type { useComposerSelection } from './useComposerSelection';
import type { useComposerDraftText } from './useComposerDraftText';
import type { useComposerColumn } from './useComposerColumn';
import type { ComposerSendHandlers } from './composerSendHandlers';
import React from 'react';
import { useInputStore } from '@/sync/input-store';
import { getChatDraftIdentityKey } from '@/lib/chatDraftPersistence';
import { appendWithLineBreaks } from '../../composer/text';
import { toast } from '@/components/ui';
import type { useI18n } from '@/lib/i18n';

type Dependencies = {
    draftText: Pick<ReturnType<typeof useComposerDraftText>, 'setMessage' | 'composerText' | 'hasText' | 'setInputMode'>;
    i18n: Pick<ReturnType<typeof useI18n>, 't'>;
    column: Pick<ReturnType<typeof useComposerColumn>, 'columnPinned'>;
    sendHandlers: Pick<ComposerSendHandlers, 'handleSubmitRef'>;
    sendAvailability: Pick<ReturnType<typeof useComposerSendAvailability>, 'getCurrentInputSnapshot'>;
    sessionScope: Pick<ReturnType<typeof useComposerSessionScope>, 'immediateBtwSubmitRef' | 'isBtwActive' | 'chatDraftIdentity' | 'pendingPresetSubmit' | 'newSessionDraftOpen' | 'newSessionDraft' | 'pendingDraftSubmit' | 'pendingSessionSubmits' | 'inputMode' | 'currentSessionId'>;
    submission: Pick<ReturnType<typeof useComposerSubmission>, 'handleSubmit'>;
    sendActions: Pick<ReturnType<typeof useComposerSendActions>, 'submitPresetPrompt'>;
    selection: Pick<ReturnType<typeof useComposerSelection>, 'configCatalogLoaded' | 'currentProviderId' | 'currentModelId' | 'mailboxTarget'>;
};

export function useComposerExternalSubmits({
    draftText, column, sendHandlers, sendAvailability, sessionScope, submission, sendActions, selection, i18n,
}: Dependencies) {
    const { setMessage, composerText, hasText, setInputMode } = draftText;
    const { t } = i18n;
    const { columnPinned } = column;
    const { handleSubmitRef } = sendHandlers;
    const { getCurrentInputSnapshot } = sendAvailability;
    const {
        immediateBtwSubmitRef, isBtwActive, chatDraftIdentity, pendingPresetSubmit, newSessionDraftOpen,
        newSessionDraft, pendingDraftSubmit, pendingSessionSubmits, inputMode, currentSessionId,
    } = sessionScope;
    const { handleSubmit } = submission;
    const { submitPresetPrompt } = sendActions;
    const { configCatalogLoaded, currentProviderId, currentModelId, mailboxTarget } = selection;

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

    React.useEffect(() => {
        if (pendingPresetSubmit == null || columnPinned) return;
        const text = useInputStore.getState().consumePendingPresetSubmit();
        if (text) submitPresetPrompt(text.text, text.type);
    }, [columnPinned, pendingPresetSubmit, submitPresetPrompt]);

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

    // Text this chat's transcript asked to send (answers to an agent's
    // question, given from its tool row) goes out like a typed message, so a
    // busy session queues or steers it as usual. It waits while a BTW holds
    // the composer, which would send it to the side question instead. A
    // composer that already holds something gets the text appended and sends
    // nothing. Shell mode never sends the answers as a shell command: with
    // text in the box the request waits, and with an empty box the mode is
    // switched back to normal first and the effect runs again to send.
    React.useEffect(() => {
        if (pendingSessionSubmits.length === 0 || isBtwActive) return;
        if (inputMode === 'shell') {
            if (hasText) return;
            setInputMode('normal');
            return;
        }
        const text = useInputStore.getState().consumePendingSessionSubmit(mailboxTarget, currentSessionId);
        if (!text) return;
        const composerHolds = getCurrentInputSnapshot().hasContent
            || (useInputStore.getState().getPendingSyntheticParts(mailboxTarget)?.length ?? 0) > 0;
        if (composerHolds) {
            setMessage(appendWithLineBreaks(composerText.get(), text));
            toast.info(t('chat.questionAnswers.addedToDraft'));
            return;
        }
        setMessage(text);
        void handleSubmitRef.current({ presetText: text });
    }, [composerText, currentSessionId, getCurrentInputSnapshot, handleSubmitRef, hasText, inputMode, isBtwActive, mailboxTarget, pendingSessionSubmits, setInputMode, setMessage, t]);

}
