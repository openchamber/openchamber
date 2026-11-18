import type { useComposerSessionScope } from './useComposerSessionScope';
import type { useComposerReferencePickerState } from './useComposerReferencePickerState';
import type { useComposerReferenceDrafts } from './useComposerReferenceDrafts';
import type { useComposerMobilePanels } from './useComposerMobilePanels';
import type { useComposerLanguage } from './useComposerLanguage';
import React from 'react';
import { useSourceControlProvider } from '@/lib/source-control/providers/registry';
import { readChatDraft, getChatDraftIdentityKey, writeChatDraft } from '@/lib/chatDraftPersistence';
import { isVSCodeRuntime } from '@/lib/desktop';
import { useAttachReferences } from '@/components/references/useAttachReferences';
import { useRepositoryReferenceProvider } from '@/components/references/referenceSources';
import { withComposerReferences, type ComposerReference } from '../../composer/composerReferences';
import { withMissingReferenceLinks } from '../../composer/referenceLinks';
import { useTrackerSources } from '@/lib/trackers/sources';

type Dependencies = {
    mobilePanels: Pick<ReturnType<typeof useComposerMobilePanels>, 'setMobileControlsPanel'>;
    referencePickerState: Pick<ReturnType<typeof useComposerReferencePickerState>, 'setReferencePicker'>;
    language: Pick<ReturnType<typeof useComposerLanguage>, 'referencePickerDirectory' | 'chatDraftIdentityKeyRef'>;
    sessionScope: Pick<ReturnType<typeof useComposerSessionScope>, 'isBtwActive' | 'chatDraftIdentity'>;
    referenceDrafts: Pick<ReturnType<typeof useComposerReferenceDrafts>, 'updateLinkedReferencesFor'>;
};

export function useComposerReferencePicker({
    mobilePanels, referencePickerState, language, sessionScope, referenceDrafts,
}: Dependencies) {
    const { setMobileControlsPanel } = mobilePanels;
    const { setReferencePicker } = referencePickerState;
    const { referencePickerDirectory, chatDraftIdentityKeyRef } = language;
    const { isBtwActive, chatDraftIdentity } = sessionScope;
    const { updateLinkedReferencesFor } = referenceDrafts;

    const handleOpenAgentPanel = React.useCallback(() => {
        setMobileControlsPanel('agent');
    }, [setMobileControlsPanel]);

    const openGitHubPicker = React.useCallback(() => {
        setReferencePicker({ source: 'repository' });
    }, [setReferencePicker]);

    const repositoryProvider = useRepositoryReferenceProvider(isVSCodeRuntime() ? null : referencePickerDirectory);

    const repositoryDescriptor = useSourceControlProvider(repositoryProvider);

    const addLinkedReferences = React.useCallback((references: ComposerReference[]) => {
        if (isBtwActive) return;
        updateLinkedReferencesFor(chatDraftIdentity, (current) => withComposerReferences(current, references));
        const onScreen = chatDraftIdentityKeyRef.current;
        if (chatDraftIdentity && getChatDraftIdentityKey(chatDraftIdentity) !== onScreen) {
            const saved = readChatDraft(chatDraftIdentity);
            writeChatDraft(chatDraftIdentity, withMissingReferenceLinks(saved.text, references), saved.confirmedMentions);
        }
    }, [chatDraftIdentity, isBtwActive, updateLinkedReferencesFor, chatDraftIdentityKeyRef]);

    const attachReferences = useAttachReferences(referencePickerDirectory, addLinkedReferences);

    const trackerSources = useTrackerSources();

    return {
        trackerSources, handleOpenAgentPanel, openGitHubPicker, repositoryProvider, attachReferences,
        repositoryDescriptor,
    };
}
