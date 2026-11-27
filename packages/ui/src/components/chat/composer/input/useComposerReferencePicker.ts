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
import { useRepositoryAcrossProvider, useRepositoryReferenceProvider } from '@/components/references/referenceSources';
import { composerReferenceKey, withComposerReferences, type ComposerReference } from '../../composer/composerReferences';
import { readLinkedReferences } from '../../composer/linkedReferenceDrafts';
import { withMissingReferenceLinks } from '../../composer/referenceLinks';
import { useTrackerSources } from '@/lib/trackers/sources';

type Dependencies = {
    mobilePanels: Pick<ReturnType<typeof useComposerMobilePanels>, 'setMobileControlsPanel'>;
    referencePickerState: Pick<ReturnType<typeof useComposerReferencePickerState>, 'setReferencePicker'>;
    language: Pick<ReturnType<typeof useComposerLanguage>, 'referencePickerDirectory' | 'referenceScope' | 'chatDraftIdentityKeyRef'>;
    sessionScope: Pick<ReturnType<typeof useComposerSessionScope>, 'isBtwActive' | 'chatDraftIdentity'>;
    referenceDrafts: Pick<ReturnType<typeof useComposerReferenceDrafts>, 'updateLinkedReferencesFor'>;
};

export function useComposerReferencePicker({
    mobilePanels, referencePickerState, language, sessionScope, referenceDrafts,
}: Dependencies) {
    const { setMobileControlsPanel } = mobilePanels;
    const { setReferencePicker } = referencePickerState;
    const { referencePickerDirectory, referenceScope, chatDraftIdentityKeyRef } = language;
    const { isBtwActive, chatDraftIdentity } = sessionScope;
    const { updateLinkedReferencesFor } = referenceDrafts;

    const handleOpenAgentPanel = React.useCallback(() => {
        setMobileControlsPanel('agent');
    }, [setMobileControlsPanel]);

    const openGitHubPicker = React.useCallback(() => {
        setReferencePicker({ source: 'repository' });
    }, [setReferencePicker]);

    const folderProvider = useRepositoryReferenceProvider(isVSCodeRuntime() ? null : referencePickerDirectory);

    const acrossProvider = useRepositoryAcrossProvider(isVSCodeRuntime() ? null : referenceScope.directories);

    const repositoryProvider = acrossProvider ?? folderProvider;

    const repositoryDescriptor = useSourceControlProvider(repositoryProvider);

    const addLinkedReferences = React.useCallback((references: ComposerReference[]) => {
        if (isBtwActive) return;
        updateLinkedReferencesFor(chatDraftIdentity, (current) => withComposerReferences(current, references));
        const onScreen = chatDraftIdentityKeyRef.current;
        if (chatDraftIdentity && getChatDraftIdentityKey(chatDraftIdentity) !== onScreen) {
            const saved = readChatDraft(chatDraftIdentity);
            const addedKeys = new Set(references.map(composerReferenceKey));
            const merged = readLinkedReferences(chatDraftIdentity).filter((reference) => addedKeys.has(composerReferenceKey(reference)));
            writeChatDraft(chatDraftIdentity, withMissingReferenceLinks(saved.text, merged), saved.confirmedMentions);
        }
    }, [chatDraftIdentity, isBtwActive, updateLinkedReferencesFor, chatDraftIdentityKeyRef]);

    const attachReferences = useAttachReferences(referenceScope.folders, addLinkedReferences);

    const trackerSources = useTrackerSources();

    return {
        trackerSources, handleOpenAgentPanel, openGitHubPicker, repositoryProvider, attachReferences,
        repositoryDescriptor,
    };
}
