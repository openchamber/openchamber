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
