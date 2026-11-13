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
 * Answering and resolving the previewed PR's review threads, or answering a
 * discussion's comments in their threads and choosing its answer. Each write
 * reads the item again afterwards, a refused one too, since a refusal most
 * often means the thread changed since it was read. Undefined for an issue or
 * without a repository context: its threads are then read only.
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
        if (!reference || reference.kind === 'issue' || !context) return undefined;
        const label = referenceNumberLabel(reference, descriptor);
        const target = { project: { owner: reference.sourceRepo.owner, name: reference.sourceRepo.repo }, number: reference.number };
        const write = async <T,>(
            perform: () => Promise<T>,
            failure: 'sourceBoard.thread.toast.replyFailed' | 'sourceBoard.thread.toast.resolveFailed' | 'sourceBoard.thread.toast.unresolveFailed'
                | 'sourceBoard.discussion.toast.answerFailed' | 'sourceBoard.discussion.toast.unanswerFailed',
        ): Promise<boolean> => {
            try {
                await perform();
                onChanged();
                return true;
            } catch (error) {
                toast.error(t(failure, { reference: label }), { description: error instanceof Error ? error.message : String(error) });
                onChanged();
                return false;
            }
        };
        if (reference.kind === 'discussion') {
            // A discussion's threads take replies and an answer; nothing resolves them.
            return {
                reply: (threadId, body) => write(
                    () => sourceControl.discussionComment({ ...context, idempotencyKey: newMutationKey(), target, replyTo: threadId, body }),
                    'sourceBoard.thread.toast.replyFailed',
                ),
                setResolved: async () => false,
                setAnswer: (threadId, answer) => write(
                    () => sourceControl.discussionSetAnswer({ ...context, idempotencyKey: newMutationKey(), target, commentId: threadId, answer }),
                    answer ? 'sourceBoard.discussion.toast.answerFailed' : 'sourceBoard.discussion.toast.unanswerFailed',
                ),
            };
        }
        return {
            reply: (threadId, body) => write(
                () => sourceControl.changeRequestReplyToThread({ ...context, idempotencyKey: newMutationKey(), target, threadId, body }),
                'sourceBoard.thread.toast.replyFailed',
            ),
            setResolved: (threadId, resolved) => write(
                () => sourceControl.changeRequestResolveThread({ ...context, idempotencyKey: newMutationKey(), target, threadId, resolved }),
                resolved ? 'sourceBoard.thread.toast.resolveFailed' : 'sourceBoard.thread.toast.unresolveFailed',
            ),
        };
    }, [context, descriptor, onChanged, reference, sourceControl, t]);
}
