import * as React from 'react';

import type { ComposerReference } from '@/components/chat/composer/composerReferences';
import { repositoryUrlOfItemLink } from '@/components/sourceBoard/openTrackerItem';
import { useBoardRepository, useFolderOfRepository, type RepositoryChoice } from '@/components/sourceBoard/boardRepository';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useI18n } from '@/lib/i18n';
import { useRepositoryUrlMatcher } from '@/lib/source-control/repositoryUrlMatcher';

import { linkReadContext } from './acrossRepositories';
import type { ReferencePickerConfirmFailure } from './ReferencePickerDialog';
import type { ReferencePickerSelection } from './referencePickerItems';
import { readTrackerItemDetail, useRepositoryFolderReadContexts } from './referenceSources';
import { resolveComposerReferences, resolveReferenceLink, type ReferenceLinkTarget, type ReferenceResolveDeps } from './resolveComposerReferences';
import { readTrackerDescriptor } from '@/lib/trackers/registry';

const NO_CHOICE: RepositoryChoice = { path: null, all: undefined };
const NO_FOLDERS: readonly string[] = [];

export function useReferenceScope(directory: string | null) {
    const repository = useBoardRepository(directory, NO_CHOICE, { underRepository: false });
    const directories = repository.all ? repository.repositories : null;
    const single = repository.directory;
    const folders = React.useMemo(() => directories ?? (single ? [single] : NO_FOLDERS), [directories, single]);
    return { directory: single, directories, folders };
}

function useReferenceResolveDeps(folders: readonly string[]) {
    const { sourceControl, trackers } = useRuntimeAPIs();
    const contexts = useRepositoryFolderReadContexts(folders);
    const deps = React.useMemo((): ReferenceResolveDeps => ({
        sourceControl,
        context: contexts[0]?.context ?? null,
        contextOf: (directory) => contexts.find((entry) => entry.directory === directory)?.context ?? null,
        readTrackerDetail: (provider, itemId) => (trackers
            ? readTrackerItemDetail(trackers, provider, itemId)
            : Promise.reject(new Error('Trackers are not available here'))),
        trackerName: (provider) => readTrackerDescriptor(provider).name,
    }), [contexts, sourceControl, trackers]);
    return { deps, contexts };
}

export function useAttachReferences(
    folders: readonly string[],
    onAttach: (references: ComposerReference[]) => void,
): (selections: ReferencePickerSelection[]) => Promise<ReferencePickerConfirmFailure | null> {
    const { deps } = useReferenceResolveDeps(folders);
    const { t } = useI18n();
    return React.useCallback(async (selections) => {
        const resolved = await resolveComposerReferences(selections, deps);
        if (resolved.references.length > 0) onAttach(resolved.references);
        if (resolved.failures.length === 0) return null;
        return {
            failedKeys: resolved.failures.map((failure) => failure.key),
            message: t('references.picker.error.attachFailed', {
                items: resolved.failures.map((failure) => failure.label).join(', '),
                error: resolved.failures[0]?.error ?? '',
            }),
        };
    }, [deps, onAttach, t]);
}

export function useReadReferenceLink(folders: readonly string[]): (target: ReferenceLinkTarget, link: string) => Promise<ComposerReference | null> {
    const { deps, contexts } = useReferenceResolveDeps(folders);
    const folderOf = useFolderOfRepository(folders);
    const urls = useRepositoryUrlMatcher();
    return React.useCallback((target, link) => {
        if (target.source === 'tracker') return resolveReferenceLink(target, deps);
        const repositoryUrl = repositoryUrlOfItemLink(link, urls);
        const repositoryFolder = repositoryUrl ? folderOf(repositoryUrl) : null;
        const context = linkReadContext(contexts, repositoryFolder === 'none' ? null : repositoryFolder, target);
        return resolveReferenceLink(target, { ...deps, context });
    }, [contexts, deps, folderOf, urls]);
}
