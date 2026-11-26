import type { SourceControlProviderDescriptor } from '@/lib/source-control/providers/descriptor';

type BranchAction = 'update' | 'rebase';

type BranchFeatures = Pick<SourceControlProviderDescriptor['features'], 'updateBranch' | 'rebase'>;

export const branchActionsFor = (
    pull: { state: string; draft: boolean } | null,
    features: BranchFeatures,
    options: { waitingMerge?: boolean; branchWriteAccess?: boolean } = {},
): BranchAction[] => {
    if (!pull || pull.state !== 'open' || pull.draft) return [];
    if (options.waitingMerge === true || options.branchWriteAccess === false) return [];
    return [
        ...(features.updateBranch ? ['update' as const] : []),
        ...(features.rebase ? ['rebase' as const] : []),
    ];
};

export const branchActionPayload = (pull: { number: number; base: string; headSha: string; sourceRepo: { owner: string; repo: string } }) => ({
    target: { project: { owner: pull.sourceRepo.owner, name: pull.sourceRepo.repo }, number: pull.number, base: pull.base, headSha: pull.headSha },
    expectedHeadSha: pull.headSha,
});
