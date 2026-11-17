import type { RepositoryReference, SourceControlAPI, SourceControlExistingMutationTarget, SourceControlReadContext } from '@/lib/api/types';

import { newMutationKey } from './mutationKey';

export type ItemTextWriteAPI = Pick<SourceControlAPI, 'issueUpdate' | 'changeRequestUpdate' | 'discussionUpdate'>;

const repositoryMutationTarget = (reference: RepositoryReference): SourceControlExistingMutationTarget => {
    const project = { owner: reference.sourceRepo.owner, name: reference.sourceRepo.repo };
    if (reference.kind !== 'pull') return { project, number: reference.number };
    return { project, number: reference.number, head: reference.head, base: reference.base, headSha: reference.headSha };
};

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
