import type { SourceControlProviderDescriptor } from '@/lib/source-control/providers/descriptor';

type BranchAction = 'update' | 'rebase';

type BranchFeatures = Pick<SourceControlProviderDescriptor['features'], 'updateBranch' | 'rebase'>;

export const branchActionFor = (
    pull: { state: string; draft: boolean } | null,
    features: BranchFeatures,
    options: { writeAccess?: boolean; waitingMerge?: boolean } = {},
): BranchAction | null => {
    if (!pull || pull.state !== 'open' || pull.draft) return null;
    if (options.writeAccess === false || options.waitingMerge === true) return null;
    return features.updateBranch ? 'update' : features.rebase ? 'rebase' : null;
};
