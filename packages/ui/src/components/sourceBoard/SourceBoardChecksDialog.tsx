import * as React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { referenceNumberLabel } from '@/components/references/referencePickerItems';
import { ChecksSummaryLine } from '@/components/references/ReferencePreview';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { CheckRunList } from '@/components/views/git/CheckRunList';
import { isFailedConclusion, useCheckRunExpansion } from '@/components/views/git/checkRunState';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { GitHubPullReference, SourceControlReadContext } from '@/lib/api/types';
import type { CIRun } from '@/lib/source-control/types';
import { useI18n } from '@/lib/i18n';
import { formatDateTimeForPreference } from '@/lib/timeFormat';
import { getChangeRequestContextKey, useChangeRequestContextStore } from '@/stores/useChangeRequestContextStore';
import { useUIStore } from '@/stores/useUIStore';

// The PR panel's pace for running checks.
const RUNNING_REFRESH_MS = 35_000;

/**
 * A pull request's check runs, read when the dialog opens: the board's lists
 * ask only for each PR's totals, the runs and their steps come one PR at a
 * time. The same cache the PR panel reads, so either fills the other.
 */
export const SourceBoardChecksDialog: React.FC<{
    pull: GitHubPullReference;
    context: SourceControlReadContext;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** Pins the failed runs, with their steps and annotations, above the composer. */
    onAttachFailed?: (runs: CIRun[]) => void;
}> = ({ pull, context, open, onOpenChange, onAttachFailed }) => {
    const { t } = useI18n();
    const { sourceControl } = useRuntimeAPIs();
    const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);
    const expansion = useCheckRunExpansion();
    const project = React.useMemo(() => ({ owner: pull.sourceRepo.owner, name: pull.sourceRepo.repo }), [pull.sourceRepo.owner, pull.sourceRepo.repo]);
    const key = getChangeRequestContextKey(context, pull.number, project);
    const entry = useChangeRequestContextStore((state) => state.entries[key]);
    const ci = entry?.hasCIDetails ? entry.result?.ci ?? null : null;
    const runs = ci?.runs ?? [];
    const running = runs.some((run) => run.status === 'in_progress' || run.status === 'queued');
    const [now, setNow] = React.useState(() => Date.now());

    // Fresh on every open; again while checks still run, as the PR panel does.
    React.useEffect(() => {
        if (!open) return;
        const load = () => {
            setNow(Date.now());
            void useChangeRequestContextStore.getState().ensure(sourceControl, context, pull.number, { includeCIDetails: true, project, force: true });
        };
        load();
        if (!running) return;
        const interval = window.setInterval(load, RUNNING_REFRESH_MS);
        return () => window.clearInterval(interval);
    }, [context, open, project, pull.number, running, sourceControl]);

    const formatTimestamp = React.useCallback((value?: string) => {
        if (!value) return '';
        const timestamp = Date.parse(value);
        if (!Number.isFinite(timestamp)) return value;
        return formatDateTimeForPreference(timestamp, timeFormatPreference, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    }, [timeFormatPreference]);

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-h-[min(80vh,48rem)] w-[min(40rem,calc(100vw-1.5rem))] max-w-2xl">
                <DialogHeader>
                    <DialogTitle>{t('sourceBoard.checks.title', { reference: referenceNumberLabel(pull) })}</DialogTitle>
                    {ci ? (
                        <span className="flex items-center gap-1.5 typography-meta text-muted-foreground">
                            <ChecksSummaryLine checks={ci.summary} />
                            {onAttachFailed && runs.some((run) => isFailedConclusion(run.conclusion)) ? (
                                <Button variant="outline" size="xs" className="ml-auto" onClick={() => onAttachFailed(runs)}>
                                    <Icon name="attachment-2" className="size-3.5" />
                                    {t('gitView.pr.actions.resolveFailedChecks')}
                                </Button>
                            ) : null}
                        </span>
                    ) : null}
                </DialogHeader>
                {runs.length > 0 ? (
                    <CheckRunList runs={runs} now={now} expansion={expansion} formatTimestamp={formatTimestamp} />
                ) : entry?.error ? (
                    <p role="alert" className="typography-meta text-[var(--status-error-text)]">
                        {t('sourceBoard.checks.loadFailed', { error: entry.error })}
                    </p>
                ) : !ci || entry?.isLoading ? (
                    <div role="status" className="flex justify-center py-8">
                        <Icon name="loader-4" className="size-5 animate-spin text-muted-foreground" />
                    </div>
                ) : (
                    <p className="py-6 text-center typography-meta text-muted-foreground">{t('sourceBoard.checks.empty')}</p>
                )}
            </DialogContent>
        </Dialog>
    );
};
