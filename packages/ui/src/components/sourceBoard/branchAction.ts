import type { SourceControlProviderDescriptor } from '@/lib/source-control/providers/descriptor';

type BranchAction = 'update' | 'rebase';

type BranchFeatures = Pick<SourceControlProviderDescriptor['features'], 'updateBranch' | 'rebase'>;

export const branchActionsFor = (
    pull: { state: string; draft: boolean } | null,
    features: BranchFeatures,
    options: { writeAccess?: boolean; waitingMerge?: boolean } = {},
): BranchAction[] => {
    if (!pull || pull.state !== 'open' || pull.draft) return [];
    if (options.writeAccess === false || options.waitingMerge === true) return [];
    return [
        ...(features.updateBranch ? ['update' as const] : []),
        ...(features.rebase ? ['rebase' as const] : []),
    ];
};

export const branchActionPayload = (pull: { number: number; headSha: string; sourceRepo: { owner: string; repo: string } }) => ({
    target: { project: { owner: pull.sourceRepo.owner, name: pull.sourceRepo.repo }, number: pull.number },
    expectedHeadSha: pull.headSha,
});
