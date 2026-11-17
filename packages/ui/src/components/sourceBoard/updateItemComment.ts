import type { RepositoryReference, SourceControlAPI, SourceControlExistingMutationTarget, SourceControlReadContext } from '@/lib/api/types';

import { newMutationKey } from './mutationKey';

export type ItemCommentWriteAPI = Pick<SourceControlAPI,
    | 'issueCommentUpdate' | 'issueCommentDelete'
    | 'changeRequestCommentUpdate' | 'changeRequestCommentDelete'
    | 'discussionCommentUpdate' | 'discussionCommentDelete'
>;

const mutationTarget = (reference: RepositoryReference): SourceControlExistingMutationTarget => {
    const project = { owner: reference.sourceRepo.owner, name: reference.sourceRepo.repo };
    if (reference.kind !== 'pull') return { project, number: reference.number };
    return { project, number: reference.number, head: reference.head, base: reference.base, headSha: reference.headSha };
};

export const updateRepositoryComment = async (
    sourceControl: ItemCommentWriteAPI,
    context: SourceControlReadContext,
    reference: RepositoryReference,
    comment: { id: string },
    body: string,
): Promise<void> => {
    const payload = { ...context, idempotencyKey: newMutationKey(), target: mutationTarget(reference), commentId: comment.id, body };
    if (reference.kind === 'pull') await sourceControl.changeRequestCommentUpdate(payload);
    else if (reference.kind === 'discussion') await sourceControl.discussionCommentUpdate(payload);
    else await sourceControl.issueCommentUpdate(payload);
};

export const deleteRepositoryComment = async (
    sourceControl: ItemCommentWriteAPI,
    context: SourceControlReadContext,
    reference: RepositoryReference,
    comment: { id: string },
): Promise<void> => {
    const payload = { ...context, idempotencyKey: newMutationKey(), target: mutationTarget(reference), commentId: comment.id };
    if (reference.kind === 'pull') await sourceControl.changeRequestCommentDelete(payload);
    else if (reference.kind === 'discussion') await sourceControl.discussionCommentDelete(payload);
    else await sourceControl.issueCommentDelete(payload);
};
