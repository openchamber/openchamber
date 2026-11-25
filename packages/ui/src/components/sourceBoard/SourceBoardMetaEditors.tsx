import * as React from 'react';

import { Icon } from '@/components/icon/Icon';
import { recordLabelWrite } from '@/components/references/labelWrites';
import type { CachedValue } from '@/components/references/referenceCache';
import { labelColor, referenceNumberLabel } from '@/components/references/referencePickerItems';
import { ReferenceLabelChips } from '@/components/references/ReferencePickerRow';
import { toast } from '@/components/ui';
import { useAvatarImage } from '@/hooks/useAvatarImage';
import { useIssueAssigneeCandidates } from '@/hooks/useIssueAssigneeCandidates';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type {
    Label,
    RepositoryChangeRequestReference,
    RepositoryIssueReference,
    RepositoryReference,
    RepositoryReferenceDetail,
    RepositoryReferenceReviewer,
    SourceControlReadContext,
} from '@/lib/api/types';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { useSourceControlProvider } from '@/lib/source-control/providers/registry';
import type { ReviewerStateValue } from '@/lib/source-control/types';
import { cn } from '@/lib/utils';
import { SourceBoardChoicePicker, type BoardChoice } from './SourceBoardChoicePicker';
import { newMutationKey } from './mutationKey';

const labelChoice = (label: Label): BoardChoice => ({
    id: label.name,
    label: label.name,
    content: <ReferenceLabelChips labels={[{ name: label.name, color: labelColor(label.color) }]} />,
});

const Person: React.FC<{ person: RepositoryReferenceReviewer }> = ({ person }) => {
    const { broken, onError } = useAvatarImage(person.avatarUrl);
    return (
        <span className="inline-flex min-w-0 items-center gap-1.5">
            {person.avatarUrl && !broken ? (
                <img src={person.avatarUrl} alt="" className="size-4 shrink-0 rounded-full" loading="lazy" onError={onError} />
            ) : person.avatarUrl ? (
                <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-surface-muted text-[0.625rem] leading-none">
                    {person.login.slice(0, 1).toUpperCase()}
                </span>
            ) : null}
            <span className="truncate">{person.login}</span>
        </span>
    );
};

const reviewerChoice = (person: RepositoryReferenceReviewer): BoardChoice => ({
    id: person.id,
    label: person.login,
    content: <Person person={person} />,
});

const reviewerState = {
    approved: { icon: 'checkbox-circle', color: 'var(--status-success)', label: 'references.picker.preview.reviewer.approved' },
    changes_requested: { icon: 'error-warning', color: 'var(--status-error)', label: 'references.picker.preview.reviewer.changesRequested' },
    commented: { icon: 'chat-3', color: 'var(--status-info)', label: 'references.picker.preview.reviewer.commented' },
    pending: { icon: 'time', color: 'var(--muted-foreground)', label: 'references.picker.preview.reviewer.pending' },
    dismissed: { icon: 'eye-off', color: 'var(--muted-foreground)', label: 'references.picker.preview.reviewer.dismissed' },
} satisfies Record<ReviewerStateValue, { icon: React.ComponentProps<typeof Icon>['name']; color: string; label: I18nKey }>;

const Reviewer: React.FC<{ person: RepositoryReferenceReviewer; state?: ReviewerStateValue }> = ({ person, state }) => {
    const { t } = useI18n();
    if (!state) return <Person person={person} />;
    const marker = reviewerState[state];
    const label = t(marker.label);
    return (
        <span
            className={cn('inline-flex min-w-0 items-center gap-1', state === 'dismissed' && 'text-muted-foreground')}
            title={label}
            data-reviewer-state={state}
        >
            <Person person={person} />
            <span
                className="inline-flex size-4 shrink-0 items-center justify-center rounded-full"
                style={{ color: marker.color, backgroundColor: `color-mix(in srgb, ${marker.color} 16%, transparent)` }}
            >
                <Icon name={marker.icon} className="size-3" />
            </span>
            <span className="sr-only">{label}</span>
        </span>
    );
};

const MetaValue: React.FC<{ empty: boolean; children: React.ReactNode; picker: React.ReactNode }> = ({ empty, children, picker }) => {
    const { t } = useI18n();
    return (
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            {empty ? <span className="text-muted-foreground">{t('sourceBoard.meta.none')}</span> : children}
            {picker}
        </span>
    );
};

const recordUnlistedLabelWrite = (reference: RepositoryReference, labels: Label[]) => recordLabelWrite(reference, labels, null);

export const SourceBoardLabels: React.FC<{
    reference: RepositoryReference;
    context: SourceControlReadContext;
    onWritten?: (reference: RepositoryReference, labels: Label[]) => void;
    onChanged: () => void;
}> = ({ reference, context, onWritten = recordUnlistedLabelWrite, onChanged }) => {
    const { t } = useI18n();
    const { sourceControl } = useRuntimeAPIs();
    const [busy, setBusy] = React.useState(false);
    const descriptor = useSourceControlProvider(reference.provider);
    const project = { owner: reference.sourceRepo.owner, repo: reference.sourceRepo.repo };
    const repositoryLabels = React.useRef<Label[]>([]);

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
            else if (reference.kind === 'discussion') await sourceControl.discussionSetLabels(payload);
            else await sourceControl.issueSetLabels(payload);
            onWritten(reference, labels.map((name) => (
                reference.labels.find((label) => label.name === name)
                    ?? repositoryLabels.current.find((label) => label.name === name)
                    ?? { name }
            )));
        } catch (error) {
            toast.error(t('sourceBoard.toast.labelsFailed', { reference: referenceNumberLabel(reference, descriptor) }), {
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
                    loadChoices={async () => {
                        repositoryLabels.current = await sourceControl.referenceLabels(context, project);
                        return repositoryLabels.current.map(labelChoice);
                    }}
                    onCommit={(labels) => void commit(labels)}
                    busy={busy}
                />
            )}
        >
            <ReferenceLabelChips labels={reference.labels.map((label) => ({ name: label.name, color: labelColor(label.color) }))} />
        </MetaValue>
    );
};

export const SourceBoardReviewers: React.FC<{
    pull: RepositoryChangeRequestReference;
    detail: CachedValue<RepositoryReferenceDetail>;
    context: SourceControlReadContext;
    onChanged: () => void;
}> = ({ pull, detail, context, onChanged }) => {
    const { t } = useI18n();
    const { sourceControl } = useRuntimeAPIs();
    const [busy, setBusy] = React.useState(false);
    const pullDetail = detail.status === 'ready' ? detail.value.pull : null;
    const reviewers = detail.status === 'ready' ? pullDetail?.reviewers ?? [] : null;
    // Absent means the host did not answer, not that nobody was asked.
    const states = pullDetail?.reviewerStates;
    const stated = new Set(states?.map((person) => person.id));
    const rows: { person: RepositoryReferenceReviewer; state?: ReviewerStateValue }[] = [
        ...(states ?? []).map((person) => ({ person, state: person.state })),
        ...(reviewers ?? []).filter((person) => !stated.has(person.id)).map((person) => ({ person })),
    ];
    const descriptor = useSourceControlProvider(pull.provider);
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
            toast.error(t('sourceBoard.toast.reviewersFailed', { reference: referenceNumberLabel(pull, descriptor) }), {
                description: error instanceof Error ? error.message : String(error),
            });
        } finally {
            setBusy(false);
            onChanged();
        }
    };

    if (detail.status === 'error') return null;
    if (!reviewers) return <Icon name="loader-4" className="size-3.5 animate-spin text-muted-foreground" />;
    return (
        <MetaValue
            empty={rows.length === 0}
            picker={pull.state === 'open' ? (
                <SourceBoardChoicePicker
                    ariaLabel={t('sourceBoard.reviewers.edit')}
                    searchPlaceholder={t('sourceBoard.reviewers.search')}
                    emptyText={t('sourceBoard.reviewers.empty')}
                    selected={reviewers.map((person) => person.id)}
                    selectedChoices={reviewers.map(reviewerChoice)}
                    loadChoices={async () => (await sourceControl.referenceReviewers(context, project))
                        // external: https://docs.github.com/en/rest/pulls/review-requests#request-reviewers-for-a-pull-request GitHub refuses review requests to the PR author; GitLab allows them.
                        .filter((person) => descriptor.features.authorCanReview || person.login !== pull.author?.login)
                        .map(reviewerChoice)}
                    onCommit={(ids) => void commit(ids)}
                    busy={busy}
                />
            ) : null}
        >
            {rows.map(({ person, state }) => <Reviewer key={person.id} person={person} state={state} />)}
        </MetaValue>
    );
};

const assigneeChoice = (person: RepositoryReferenceReviewer): BoardChoice => ({
    id: person.id,
    label: person.login,
    content: <Person person={person} />,
});

export const SourceBoardAssignees: React.FC<{
    issue: RepositoryIssueReference;
    detail: CachedValue<RepositoryReferenceDetail>;
    writeAccess?: boolean;
    context: SourceControlReadContext;
    onChanged: () => void | Promise<void>;
    sheet?: boolean;
}> = ({ issue, detail, writeAccess, context, onChanged, sheet = false }) => {
    const { t } = useI18n();
    const { sourceControl } = useRuntimeAPIs();
    const [busy, setBusy] = React.useState(false);
    const assignees = detail.status === 'ready' ? detail.value.assignees ?? null : null;
    const descriptor = useSourceControlProvider(issue.provider);
    const { owner, repo } = issue.sourceRepo;
    const { candidates, setCandidates } = useIssueAssigneeCandidates(context, owner, repo);

    const commit = async (ids: string[]) => {
        setBusy(true);
        try {
            await sourceControl.issueSetAssignees({
                ...context,
                idempotencyKey: newMutationKey(),
                target: { project: { owner, name: repo }, number: issue.number },
                assignees: ids,
            });
        } catch (error) {
            toast.error(t('sourceBoard.assignees.saveFailed', { reference: referenceNumberLabel(issue, descriptor) }), {
                description: error instanceof Error ? error.message : String(error),
            });
        } finally {
            try {
                await onChanged();
            } finally {
                setBusy(false);
            }
        }
    };

    if (detail.status === 'idle' || detail.status === 'loading') return <Icon name="loader-4" className="size-3.5 animate-spin text-muted-foreground" />;
    if (!assignees) return null;
    const editable = descriptor.features.issueAssignees && candidates !== null && writeAccess !== false;
    return (
        <MetaValue
            empty={false}
            picker={editable ? (
                <SourceBoardChoicePicker
                    ariaLabel={t('sourceBoard.assignees.edit')}
                    searchPlaceholder={t('sourceBoard.reviewers.search')}
                    emptyText={t('sourceBoard.reviewers.empty')}
                    selected={assignees.map((person) => person.id)}
                    selectedChoices={assignees.map(assigneeChoice)}
                    loadChoices={async () => {
                        const people = await sourceControl.referenceReviewers(context, { owner, repo }, 'assignee');
                        setCandidates(people);
                        return people.map(assigneeChoice);
                    }}
                    onCommit={(ids) => void commit(ids)}
                    busy={busy}
                    sheet={sheet}
                />
            ) : null}
        >
            {assignees.length === 0
                ? <span className="text-muted-foreground">{t('sourceBoard.assignees.empty')}</span>
                : assignees.map((person) => <Person key={person.id} person={person} />)}
        </MetaValue>
    );
};
