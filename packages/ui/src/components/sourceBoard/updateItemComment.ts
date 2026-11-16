import type { RepositoryReference, SourceControlAPI, SourceControlExistingMutationTarget, SourceControlReadContext } from '@/lib/api/types';

import { newMutationKey } from './mutationKey';

/** The six comment writes this helper makes; the whole runtime API satisfies it. */
export type ItemCommentWriteAPI = Pick<SourceControlAPI,
    | 'issueCommentUpdate' | 'issueCommentDelete'
    | 'changeRequestCommentUpdate' | 'changeRequestCommentDelete'
    | 'discussionCommentUpdate' | 'discussionCommentDelete'
>;

/** What a write names: the item's project and number, and a pull request's head and base. */
const mutationTarget = (reference: RepositoryReference): SourceControlExistingMutationTarget => {
    const project = { owner: reference.sourceRepo.owner, name: reference.sourceRepo.repo };
    if (reference.kind !== 'pull') return { project, number: reference.number };
    // The head the preview shows: a push since refuses the write.
    return { project, number: reference.number, head: reference.head, base: reference.base, headSha: reference.headSha };
};

/**
 * Replaces one conversation comment's text on its host, through the provider's
 * own edit: an issue's, a discussion's or a change request's.
 */
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

/** Removes one conversation comment from its host. */
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
