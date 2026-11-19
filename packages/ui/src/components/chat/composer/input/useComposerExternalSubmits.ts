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

type Dependencies = {
    draftText: Pick<ReturnType<typeof useComposerDraftText>, 'setMessage' | 'composerText'>;
    column: Pick<ReturnType<typeof useComposerColumn>, 'columnPinned'>;
    sendHandlers: Pick<ComposerSendHandlers, 'handleSubmitRef'>;
    sendAvailability: Pick<ReturnType<typeof useComposerSendAvailability>, 'getCurrentInputSnapshot'>;
    sessionScope: Pick<ReturnType<typeof useComposerSessionScope>, 'immediateBtwSubmitRef' | 'isBtwActive' | 'chatDraftIdentity' | 'pendingPresetSubmit' | 'newSessionDraftOpen' | 'newSessionDraft' | 'pendingDraftSubmit'>;
    submission: Pick<ReturnType<typeof useComposerSubmission>, 'handleSubmit'>;
    sendActions: Pick<ReturnType<typeof useComposerSendActions>, 'submitPresetPrompt'>;
    selection: Pick<ReturnType<typeof useComposerSelection>, 'configCatalogLoaded' | 'currentProviderId' | 'currentModelId' | 'mailboxTarget'>;
};

export function useComposerExternalSubmits({
    draftText, column, sendHandlers, sendAvailability, sessionScope, submission, sendActions, selection,
}: Dependencies) {
    const { setMessage, composerText } = draftText;
    const { columnPinned } = column;
    const { handleSubmitRef } = sendHandlers;
    const { getCurrentInputSnapshot } = sendAvailability;
    const {
        immediateBtwSubmitRef, isBtwActive, chatDraftIdentity, pendingPresetSubmit, newSessionDraftOpen,
        newSessionDraft, pendingDraftSubmit,
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

}
