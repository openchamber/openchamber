import React from 'react';

import { toast } from '@/components/ui';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { BoundGitNetworkOperationError, GitOperationResultError } from '@/lib/boundGitNetworkOperation';
import { useI18n } from '@/lib/i18n';
import { PendingGitOperationError } from '@/lib/source-control/git-operation-recovery';

import { ContributorDestinationDialog } from './ContributorDestinationDialog';
import { useContributorDestinationChooser } from './contributorDestination';
import { PublishDialog } from './PublishDialog';
import { useGitOperationRecovery } from './useGitOperationRecovery';
import { useGitPublishChooser } from './useGitPublishChooser';

/**
 * Pushes the current branch the way the Git view's Publish does: to its own
 * remote, or through the publish and contributor choosers when that is not
 * obvious, as a tracked network operation. `dialogs` renders those choosers.
 */
export function useBranchPush(directory: string | null, branch: string | undefined) {
    const { git, sourceControl } = useRuntimeAPIs();
    const { t } = useI18n();
    const contributor = useContributorDestinationChooser();
    const chooser = useGitPublishChooser({ directory, branch, chooseContributor: contributor.choose });
    const recovery = useGitOperationRecovery(directory, git, sourceControl);

    /** True once the branch is on its remote; false after a failure the user was told about. */
    const push = async (): Promise<boolean> => {
        const operation = recovery.start();
        if (!operation) {
            toast.info(t('gitView.pr.toast.gitBusy'));
            return false;
        }
        const failed = t('gitView.toast.syncActionFailed', { action: t('gitView.publish.title') });
        try {
            const execute = await chooser.prepare('push', { onOperation: operation.onOperation });
            await execute();
            return operation.isCurrent();
        } catch (error) {
            if (error instanceof BoundGitNetworkOperationError) {
                if (error.code === 'stale-runtime') return false;
                const message = chooser.errorMessage(error);
                if (message) toast.info(message);
                else toast.error(failed);
                return false;
            }
            if (error instanceof GitOperationResultError || error instanceof PendingGitOperationError) {
                toast.error(failed, { description: error.message || undefined });
                return false;
            }
            toast.error(failed, { description: error instanceof Error ? error.message : String(error) });
            return false;
        } finally {
            operation.finish();
        }
    };

    const dialogs = (
        <>
            {chooser.context ? <PublishDialog context={chooser.context} onSelect={chooser.settle} /> : null}
            {chooser.confirmDialog}
            <ContributorDestinationDialog candidates={contributor.candidates} onSelect={contributor.settle} />
        </>
    );

    return { push, dialogs };
}
