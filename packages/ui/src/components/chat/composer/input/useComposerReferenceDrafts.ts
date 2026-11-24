import type { useComposerSessionScope } from './useComposerSessionScope';
import type { useComposerDraftText } from './useComposerDraftText';
import React from 'react';
import type { AttachIssueRequest } from '@openchamber/sdk';
import { type ChatDraftIdentity } from '@/lib/chatDraftPersistence';
import { withComposerReferences, type ComposerReference } from '../../composer/composerReferences';
import { readLinkedReferences, useLinkedReferenceDrafts } from '../../composer/linkedReferenceDrafts';
import { guestAttachContextText } from '@/lib/guests/attach-text';
import { useGuestDialogStore } from '@/lib/guests/dialog-store';
import { useReceivedPageBases } from '../../sharePages/received/useReceivedPage';

type Dependencies = {
    draftText: Pick<ReturnType<typeof useComposerDraftText>, 'currentChatDraftIdentityRef'>;
    sessionScope: Pick<ReturnType<typeof useComposerSessionScope>, 'isBtwActive'>;
};

export function useComposerReferenceDrafts({
    draftText, sessionScope,
}: Dependencies) {
    const { currentChatDraftIdentityRef } = draftText;
    const { isBtwActive } = sessionScope;

    const receivedPageBases = useReceivedPageBases();

    const setLinkedReferencesFor = React.useCallback((
        target: ChatDraftIdentity | null,
        references: ComposerReference[],
    ) => {
        useLinkedReferenceDrafts.getState().set(references, target);
    }, []);

    const updateLinkedReferencesFor = React.useCallback((
        target: ChatDraftIdentity | null,
        update: (current: ComposerReference[]) => ComposerReference[],
    ) => {
        useLinkedReferenceDrafts.getState().set(update(readLinkedReferences(target)), target);
    }, []);

    const updateLinkedReferences = React.useCallback((update: (current: ComposerReference[]) => ComposerReference[]) => {
        updateLinkedReferencesFor(currentChatDraftIdentityRef.current, update);
    }, [updateLinkedReferencesFor, currentChatDraftIdentityRef]);

    const [attachDialogGuestId, setAttachDialogGuestId] = React.useState<string | null>(null);

    const [attachDialogItem, setAttachDialogItem] = React.useState<AttachIssueRequest | null>(null);

    const handleGuestAttach = React.useCallback((issue: AttachIssueRequest) => {
        if (isBtwActive) return;
        const contextText = guestAttachContextText(issue);
        const reference: ComposerReference = {
            kind: 'guest',
            providerId: issue.providerId,
            id: issue.id,
            title: issue.title,
            url: issue.url,
            contextText,
            thread: issue.kind === 'pull' ? 'pull' : 'issue',
            author: issue.author,
            head: issue.branches?.head,
            base: issue.branches?.base,
            data: issue.data,
        };
        updateLinkedReferences((current) => withComposerReferences(current, [reference]));
        setAttachDialogGuestId(null);
        setAttachDialogItem(null);
        useGuestDialogStore.getState().close();
    }, [isBtwActive, updateLinkedReferences]);

    return {
        setLinkedReferencesFor, updateLinkedReferencesFor, updateLinkedReferences, receivedPageBases,
        handleGuestAttach, setAttachDialogItem, setAttachDialogGuestId, attachDialogGuestId,
        attachDialogItem,
    };
}
