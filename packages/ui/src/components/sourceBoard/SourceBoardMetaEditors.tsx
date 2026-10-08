import * as React from 'react';

import { Icon } from '@/components/icon/Icon';
import type { CachedValue } from '@/components/references/referenceCache';
import { labelColor, referenceNumberLabel } from '@/components/references/referencePickerItems';
import { ReferenceLabelChips } from '@/components/references/ReferencePickerRow';
import { toast } from '@/components/ui';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type {
    GitHubIssueLabel,
    GitHubPullReference,
    GitHubReference,
    GitHubReferenceDetail,
    GitHubReferenceReviewer,
    SourceControlReadContext,
} from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';
import { SourceBoardChoicePicker, type BoardChoice } from './SourceBoardChoicePicker';
import { newMutationKey } from './mutationKey';

const labelChoice = (label: GitHubIssueLabel): BoardChoice => ({
    id: label.name,
    label: label.name,
    content: <ReferenceLabelChips labels={[{ name: label.name, color: labelColor(label.color) }]} />,
});

const Person: React.FC<{ person: GitHubReferenceReviewer }> = ({ person }) => (
    <span className="inline-flex min-w-0 items-center gap-1.5">
        {person.avatarUrl ? <img src={person.avatarUrl} alt="" className="size-4 shrink-0 rounded-full" loading="lazy" /> : null}
        <span className="truncate">{person.login}</span>
    </span>
);

const reviewerChoice = (person: GitHubReferenceReviewer): BoardChoice => ({
    id: person.id,
    label: person.login,
    content: <Person person={person} />,
});

const MetaValue: React.FC<{ empty: boolean; children: React.ReactNode; picker: React.ReactNode }> = ({ empty, children, picker }) => {
    const { t } = useI18n();
    return (
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            {empty ? <span className="text-muted-foreground">{t('sourceBoard.meta.none')}</span> : children}
            {picker}
        </span>
    );
};

/** An issue's or PR's labels, changed as one set from the repository's labels. */
export const SourceBoardLabels: React.FC<{
    reference: GitHubReference;
    context: SourceControlReadContext;
    onChanged: () => void;
}> = ({ reference, context, onChanged }) => {
    const { t } = useI18n();
    const { sourceControl } = useRuntimeAPIs();
    const [busy, setBusy] = React.useState(false);
    const project = { owner: reference.sourceRepo.owner, repo: reference.sourceRepo.repo };

    const commit = async (labels: string[]) => {
        setBusy(true);
        try {
            const payload = {
                ...context,
                idempotencyKey: newMutationKey(),
                target: { project: { owner: project.owner, name: project.repo }, number: reference.number },
                labels,
            };
            if (reference.kind === 'pull') await sourceControl.changeRequestSetLabels(payload);
            else await sourceControl.issueSetLabels(payload);
        } catch (error) {
            toast.error(t('sourceBoard.toast.labelsFailed', { reference: referenceNumberLabel(reference) }), {
                description: error instanceof Error ? error.message : String(error),
            });
        } finally {
            setBusy(false);
            onChanged();
        }
    };

    return (
        <MetaValue
            empty={reference.labels.length === 0}
            picker={(
                <SourceBoardChoicePicker
                    ariaLabel={t('sourceBoard.labels.edit')}
                    searchPlaceholder={t('sourceBoard.labels.search')}
                    emptyText={t('sourceBoard.labels.empty')}
                    selected={reference.labels.map((label) => label.name)}
                    selectedChoices={reference.labels.map(labelChoice)}
                    loadChoices={async () => (await sourceControl.referenceLabels(context, project)).map(labelChoice)}
                    onCommit={(labels) => void commit(labels)}
                    busy={busy}
                />
            )}
        >
            <ReferenceLabelChips labels={reference.labels.map((label) => ({ name: label.name, color: labelColor(label.color) }))} />
        </MetaValue>
    );
};

/** Who an open PR asks to review, changed as one set from the people who can. */
export const SourceBoardReviewers: React.FC<{
    pull: GitHubPullReference;
    detail: CachedValue<GitHubReferenceDetail>;
    context: SourceControlReadContext;
    onChanged: () => void;
}> = ({ pull, detail, context, onChanged }) => {
    const { t } = useI18n();
    const { sourceControl } = useRuntimeAPIs();
    const [busy, setBusy] = React.useState(false);
    const reviewers = detail.status === 'ready' ? detail.value.pull?.reviewers ?? [] : null;
    const project = { owner: pull.sourceRepo.owner, repo: pull.sourceRepo.repo };

    const commit = async (ids: string[]) => {
        setBusy(true);
        try {
            await sourceControl.changeRequestSetReviewers({
                ...context,
                idempotencyKey: newMutationKey(),
                target: { project: { owner: project.owner, name: project.repo }, number: pull.number },
                reviewers: ids,
            });
        } catch (error) {
            toast.error(t('sourceBoard.toast.reviewersFailed', { reference: referenceNumberLabel(pull) }), {
                description: error instanceof Error ? error.message : String(error),
            });
        } finally {
            setBusy(false);
            onChanged();
        }
    };

    // The current set comes with the detail: no picker until it is known.
    if (!reviewers) return <Icon name="loader-4" className="size-3.5 animate-spin text-muted-foreground" />;
    return (
        <MetaValue
            empty={reviewers.length === 0}
            picker={pull.state === 'open' ? (
                <SourceBoardChoicePicker
                    ariaLabel={t('sourceBoard.reviewers.edit')}
                    searchPlaceholder={t('sourceBoard.reviewers.search')}
                    emptyText={t('sourceBoard.reviewers.empty')}
                    selected={reviewers.map((person) => person.id)}
                    selectedChoices={reviewers.map(reviewerChoice)}
                    loadChoices={async () => (await sourceControl.referenceReviewers(context, project))
                        // GitHub refuses to ask a PR's author for its review; GitLab allows it.
                        .filter((person) => pull.provider === 'gitlab' || person.login !== pull.author?.login)
                        .map(reviewerChoice)}
                    onCommit={(ids) => void commit(ids)}
                    busy={busy}
                />
            ) : null}
        >
            {reviewers.map((person) => <Person key={person.id} person={person} />)}
        </MetaValue>
    );
};
