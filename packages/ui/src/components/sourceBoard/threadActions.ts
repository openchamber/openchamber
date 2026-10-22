import * as React from 'react';

import type { ReferenceThreadActions } from '@/components/references/ReferenceComments';
import { referenceNumberLabel } from '@/components/references/referencePickerItems';
import { toast } from '@/components/ui';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { RepositoryReference, SourceControlReadContext } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';
import { useSourceControlProvider } from '@/lib/source-control/providers/registry';

import { newMutationKey } from './mutationKey';

/**
 * Answering and resolving the previewed PR's review threads. Each write reads
 * the PR again afterwards, a refused one too, since a refusal most often means
 * the thread changed since it was read. Undefined for an issue or without a
 * repository context: its threads are then read only.
 */
export function useThreadActions(
    reference: RepositoryReference | null,
    context: SourceControlReadContext | null,
    onChanged: () => void,
): ReferenceThreadActions | undefined {
    const { t } = useI18n();
    const { sourceControl } = useRuntimeAPIs();
    const descriptor = useSourceControlProvider(reference?.provider);
    return React.useMemo(() => {
        if (!reference || reference.kind !== 'pull' || !context) return undefined;
        const label = referenceNumberLabel(reference, descriptor);
        const target = { project: { owner: reference.sourceRepo.owner, name: reference.sourceRepo.repo }, number: reference.number };
        const failed = (
            key: 'sourceBoard.thread.toast.replyFailed' | 'sourceBoard.thread.toast.resolveFailed' | 'sourceBoard.thread.toast.unresolveFailed',
            error: Error | string,
        ) => {
            toast.error(t(key, { reference: label }), { description: error instanceof Error ? error.message : error });
            onChanged();
        };
        return {
            reply: async (threadId, body) => {
                try {
                    await sourceControl.changeRequestReplyToThread({ ...context, idempotencyKey: newMutationKey(), target, threadId, body });
                    onChanged();
                    return true;
                } catch (error) {
                    failed('sourceBoard.thread.toast.replyFailed', error instanceof Error ? error : String(error));
                    return false;
                }
            },
            setResolved: async (threadId, resolved) => {
                try {
                    await sourceControl.changeRequestResolveThread({ ...context, idempotencyKey: newMutationKey(), target, threadId, resolved });
                    onChanged();
                    return true;
                } catch (error) {
                    failed(resolved ? 'sourceBoard.thread.toast.resolveFailed' : 'sourceBoard.thread.toast.unresolveFailed', error instanceof Error ? error : String(error));
                    return false;
                }
            },
        };
    }, [context, descriptor, onChanged, reference, sourceControl, t]);
}
