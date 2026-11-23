import * as React from 'react';

import type { ComposerReference } from '@/components/chat/composer/composerReferences';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useI18n } from '@/lib/i18n';

import type { ReferencePickerConfirmFailure } from './ReferencePickerDialog';
import type { ReferencePickerSelection } from './referencePickerItems';
import { readTrackerItemDetail, useRepositoryReadContext } from './referenceSources';
import { resolveComposerReferences, resolveReferenceLink, type ReferenceLinkTarget, type ReferenceResolveDeps } from './resolveComposerReferences';
import { readTrackerDescriptor } from '@/lib/trackers/registry';

function useReferenceResolveDeps(directory: string | null): ReferenceResolveDeps {
    const { sourceControl, trackers } = useRuntimeAPIs();
    const repositoryContext = useRepositoryReadContext(directory);
    return React.useMemo(() => ({
        sourceControl,
        context: repositoryContext && repositoryContext !== 'missing' ? repositoryContext : null,
        readTrackerDetail: (provider, itemId) => (trackers
            ? readTrackerItemDetail(trackers, provider, itemId)
            : Promise.reject(new Error('Trackers are not available here'))),
        trackerName: (provider) => readTrackerDescriptor(provider).name,
    }), [repositoryContext, sourceControl, trackers]);
}

export function useAttachReferences(
    directory: string | null,
    onAttach: (references: ComposerReference[]) => void,
): (selections: ReferencePickerSelection[]) => Promise<ReferencePickerConfirmFailure | null> {
    const deps = useReferenceResolveDeps(directory);
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

export function useReadReferenceLink(directory: string | null): (target: ReferenceLinkTarget) => Promise<ComposerReference | null> {
    const deps = useReferenceResolveDeps(directory);
    return React.useCallback((target) => resolveReferenceLink(target, deps), [deps]);
}
