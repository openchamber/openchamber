import type { RepositoryReference, SourceControlAPI, SourceControlReadContext } from '@/lib/api/types';

import { newMutationKey } from './mutationKey';
import { repositoryMutationTarget } from './updateItemText';

/** The six comment writes this helper makes; the whole runtime API satisfies it. */
export type ItemCommentWriteAPI = Pick<SourceControlAPI,
    | 'issueCommentUpdate' | 'issueCommentDelete'
    | 'changeRequestCommentUpdate' | 'changeRequestCommentDelete'
    | 'discussionCommentUpdate' | 'discussionCommentDelete'
>;

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
    const payload = { ...context, idempotencyKey: newMutationKey(), target: repositoryMutationTarget(reference), commentId: comment.id, body };
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
    const payload = { ...context, idempotencyKey: newMutationKey(), target: repositoryMutationTarget(reference), commentId: comment.id };
    if (reference.kind === 'pull') await sourceControl.changeRequestCommentDelete(payload);
    else if (reference.kind === 'discussion') await sourceControl.discussionCommentDelete(payload);
    else await sourceControl.issueCommentDelete(payload);
};
