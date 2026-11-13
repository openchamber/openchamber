import * as React from 'react';

import type { ComposerReference } from '@/components/chat/composer/composerReferences';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useI18n } from '@/lib/i18n';

import type { ReferencePickerConfirmFailure } from './ReferencePickerDialog';
import type { ReferencePickerSelection } from './referencePickerItems';
import { readTrackerItemDetail, useRepositoryReadContext } from './referenceSources';
import { resolveComposerReferences } from './resolveComposerReferences';
import { readTrackerDescriptor } from '@/lib/trackers/registry';

/**
 * The composer's confirm handler for the reference picker: resolve what was
 * chosen, hand every success to `onAttach`, and keep the picker open on the
 * ones that failed, with the host's or the tracker's reason.
 */
export function useAttachReferences(
    directory: string | null,
    onAttach: (references: ComposerReference[]) => void,
): (selections: ReferencePickerSelection[]) => Promise<ReferencePickerConfirmFailure | null> {
    const { sourceControl, trackers } = useRuntimeAPIs();
    const repositoryContext = useRepositoryReadContext(directory);
    const { t } = useI18n();
    return React.useCallback(async (selections) => {
        const resolved = await resolveComposerReferences(selections, {
            sourceControl,
            context: repositoryContext && repositoryContext !== 'missing' ? repositoryContext : null,
            readTrackerDetail: (provider, itemId) => (trackers
                ? readTrackerItemDetail(trackers, provider, itemId)
                : Promise.reject(new Error('Trackers are not available here'))),
            trackerName: (provider) => readTrackerDescriptor(provider).name,
        });
        if (resolved.references.length > 0) onAttach(resolved.references);
        if (resolved.failures.length === 0) return null;
        return {
            failedKeys: resolved.failures.map((failure) => failure.key),
            message: t('references.picker.error.attachFailed', {
                items: resolved.failures.map((failure) => failure.label).join(', '),
                error: resolved.failures[0]?.error ?? '',
            }),
        };
    }, [repositoryContext, trackers, onAttach, sourceControl, t]);
}
