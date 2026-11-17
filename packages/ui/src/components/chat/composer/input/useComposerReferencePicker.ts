import React from 'react';
import { useSourceControlProvider } from '@/lib/source-control/providers/registry';
import { readChatDraft, getChatDraftIdentityKey, writeChatDraft } from '@/lib/chatDraftPersistence';
import { isVSCodeRuntime } from '@/lib/desktop';
import { useAttachReferences } from '@/components/references/useAttachReferences';
import { useRepositoryReferenceProvider } from '@/components/references/referenceSources';
import { withComposerReferences, type ComposerReference } from '../../composer/composerReferences';
import { withMissingReferenceLinks } from '../../composer/referenceLinks';
import { useTrackerSources } from '@/lib/trackers/sources';
import type { useComposerInputState } from './useComposerInputState';
import type { useComposerMobileShell } from './useComposerMobileShell';
import type { useComposerLanguage } from './useComposerLanguage';
import type { useComposerSessionScope } from './useComposerSessionScope';
import type { useComposerReferenceDrafts } from './useComposerReferenceDrafts';

type Dependencies = Pick<ReturnType<typeof useComposerInputState>, 'setMobileControlsPanel'>
    & Pick<ReturnType<typeof useComposerMobileShell>, 'setReferencePicker'>
    & Pick<ReturnType<typeof useComposerLanguage>, 'referencePickerDirectory' | 'chatDraftIdentityKeyRef'>
    & Pick<ReturnType<typeof useComposerSessionScope>, 'isBtwActive' | 'chatDraftIdentity'>
    & Pick<ReturnType<typeof useComposerReferenceDrafts>, 'updateLinkedReferencesFor'>;

export function useComposerReferencePicker({
    setMobileControlsPanel, setReferencePicker, referencePickerDirectory, isBtwActive,
    updateLinkedReferencesFor, chatDraftIdentity, chatDraftIdentityKeyRef,
}: Dependencies) {
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
        // The picker keeps this callback while context loads, including across a session switch.
        updateLinkedReferencesFor(chatDraftIdentity, (current) => withComposerReferences(current, references));
        // A draft no longer on screen gets the links in its saved text; the one
        // on screen gets them at the caret (the effect on the draft's items).
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
