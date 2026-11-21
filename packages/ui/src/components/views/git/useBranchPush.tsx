import React from 'react';

import { toast } from '@/components/ui';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { GitPushReviewIntent } from '@/lib/api/types';
import { BoundGitNetworkOperationError, GitOperationResultError, runBoundReviewPush } from '@/lib/boundGitNetworkOperation';
import { useI18n } from '@/lib/i18n';
import { PendingGitOperationError } from '@/lib/source-control/git-operation-recovery';

import { ContributorDestinationDialog } from './ContributorDestinationDialog';
import { useContributorDestinationChooser } from './contributorDestination';
import { gitRequestErrorMessage } from './gitRequestErrorMessage';
import { PublishDialog } from './PublishDialog';
import { useGitOperationRecovery } from './useGitOperationRecovery';
import { useGitPublishChooser } from './useGitPublishChooser';

export function useBranchPush(directory: string | null, branch: string | undefined) {
    const { git, sourceControl } = useRuntimeAPIs();
    const { t } = useI18n();
    const contributor = useContributorDestinationChooser();
    const chooser = useGitPublishChooser({ directory, branch, chooseContributor: contributor.choose });
    const recovery = useGitOperationRecovery(directory, git, sourceControl);

    type Operation = NonNullable<ReturnType<typeof recovery.start>>;
    const run = async (failed: string, transfer: (operation: Operation) => Promise<void>): Promise<boolean> => {
        const operation = recovery.start();
        if (!operation) {
            toast.info(t('gitView.pr.toast.gitBusy'));
            return false;
        }
        try {
            await transfer(operation);
            return operation.isCurrent();
        } catch (error) {
            if (error instanceof BoundGitNetworkOperationError) {
                if (error.code === 'stale-runtime') return false;
                const message = error.code === 'review-option-invalid'
                    ? t('gitView.change.push.invalidOption')
                    : chooser.errorMessage(error);
                if (message) toast.info(message);
                else toast.error(failed);
                return false;
            }
            if (error instanceof GitOperationResultError || error instanceof PendingGitOperationError) {
                toast.error(failed, { description: error.message || undefined });
                return false;
            }
            toast.error(failed, { description: error instanceof Error ? gitRequestErrorMessage(error, t) : String(error) });
            return false;
        } finally {
            operation.finish();
        }
    };

    const push = (): Promise<boolean> => run(
        t('gitView.toast.syncActionFailed', { action: t('gitView.publish.title') }),
        async (operation) => {
            const execute = await chooser.prepare('push', { onOperation: operation.onOperation });
            await execute();
        },
    );

    const pushForReview = (review: GitPushReviewIntent): Promise<boolean> => {
        if (!directory) return Promise.resolve(false);
        return run(t('gitView.change.push.toast.failed'), async (operation) => {
            await runBoundReviewPush({ directory, git, sourceControl, review, onOperation: operation.onOperation });
        });
    };

    const dialogs = (
        <>
            {chooser.context ? <PublishDialog context={chooser.context} onSelect={chooser.settle} /> : null}
            {chooser.confirmDialog}
            <ContributorDestinationDialog candidates={contributor.candidates} onSelect={contributor.settle} />
        </>
    );

    return { push, pushForReview, dialogs };
}
