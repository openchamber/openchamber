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

}
