import * as React from 'react';

import type { ComposerReference } from '@/components/chat/composer/composerReferences';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useI18n } from '@/lib/i18n';

import type { ReferencePickerConfirmFailure } from './ReferencePickerDialog';
import type { ReferencePickerSelection } from './referencePickerItems';
import { readLinearIssueDetail } from './referenceSources';
import { resolveComposerReferences } from './resolveComposerReferences';

/**
 * The composer's confirm handler for the reference picker: resolve what was
 * chosen, hand every success to `onAttach`, and keep the picker open on the
 * ones that failed, with GitHub's or Linear's reason.
 */
export function useAttachReferences(
    directory: string | null,
    onAttach: (references: ComposerReference[]) => void,
): (selections: ReferencePickerSelection[]) => Promise<ReferencePickerConfirmFailure | null> {
    const { github, linear } = useRuntimeAPIs();
    const { t } = useI18n();
    return React.useCallback(async (selections) => {
        const resolved = await resolveComposerReferences(selections, {
            github,
            directory,
            readLinearDetail: (issueId) => (linear
                ? readLinearIssueDetail(linear, issueId)
                : Promise.reject(new Error('Linear is not available here'))),
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
    }, [directory, github, linear, onAttach, t]);
}
