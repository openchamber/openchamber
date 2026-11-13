import type { RepositoryReference, SourceControlAPI, SourceControlExistingMutationTarget, SourceControlReadContext } from '@/lib/api/types';

/** The three edits this helper makes; the whole runtime API satisfies it. */
export type ItemTextWriteAPI = Pick<SourceControlAPI, 'issueUpdate' | 'changeRequestUpdate' | 'discussionUpdate'>;

import { newMutationKey } from './mutationKey';

/** The host target a write names, with a change request's head as the preview shows it. */
export const repositoryMutationTarget = (reference: RepositoryReference): SourceControlExistingMutationTarget => {
    const project = { owner: reference.sourceRepo.owner, name: reference.sourceRepo.repo };
    if (reference.kind !== 'pull') return { project, number: reference.number };
    // The head the preview shows: a push since refuses the write.
    return { project, number: reference.number, head: reference.head, base: reference.base, headSha: reference.headSha };
};

/**
 * Replaces a repository item's title and description on its host, through the
 * provider's own edit: an issue's, a discussion's or a change request's.
 */
export const updateRepositoryItemText = async (
    sourceControl: ItemTextWriteAPI,
    context: SourceControlReadContext,
    reference: RepositoryReference,
    text: { title: string; body: string },
): Promise<void> => {
    const payload = { ...context, idempotencyKey: newMutationKey(), target: repositoryMutationTarget(reference), ...text };
    if (reference.kind === 'pull') await sourceControl.changeRequestUpdate(payload);
    else if (reference.kind === 'discussion') await sourceControl.discussionUpdate(payload);
    else await sourceControl.issueUpdate(payload);
};
