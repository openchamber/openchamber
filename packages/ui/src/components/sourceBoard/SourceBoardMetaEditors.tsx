import * as React from 'react';

import { Icon } from '@/components/icon/Icon';
import type { CachedValue } from '@/components/references/referenceCache';
import { labelColor, referenceNumberLabel } from '@/components/references/referencePickerItems';
import { ReferenceLabelChips, RowPerson } from '@/components/references/ReferencePickerRow';
import { toast } from '@/components/ui';
import { useAvatarImage } from '@/hooks/useAvatarImage';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type {
    Label,
    RepositoryChangeRequestReference,
    RepositoryDiscussionCategory,
    RepositoryDiscussionReference,
    RepositoryIssueReference,
    RepositoryReference,
    RepositoryReferenceDetail,
    RepositoryReferenceReviewer,
    SourceControlReadContext,
} from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';
import { useSourceControlProvider } from '@/lib/source-control/providers/registry';
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

const MetaValue: React.FC<{ empty: boolean; children: React.ReactNode; picker: React.ReactNode }> = ({ empty, children, picker }) => {
    const { t } = useI18n();
    return (
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            {empty ? <span className="text-muted-foreground">{t('sourceBoard.meta.none')}</span> : children}
            {picker}
        </span>
    );
};

/** An issue's, discussion's or PR's labels, changed as one set from the repository's labels. */
export const SourceBoardLabels: React.FC<{
    reference: RepositoryReference;
    context: SourceControlReadContext;
    /** Resolves once the surface has re-read the item, so `busy` covers the refresh. */
    onChanged: () => void | Promise<void>;
}> = ({ reference, context, onChanged }) => {
    const { t } = useI18n();
    const { sourceControl } = useRuntimeAPIs();
    const [busy, setBusy] = React.useState(false);
    const descriptor = useSourceControlProvider(reference.provider);
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
            else if (reference.kind === 'discussion') await sourceControl.discussionSetLabels(payload);
            else await sourceControl.issueSetLabels(payload);
        } catch (error) {
            toast.error(t('sourceBoard.toast.labelsFailed', { reference: referenceNumberLabel(reference, descriptor) }), {
                description: error instanceof Error ? error.message : String(error),
            });
        } finally {
            setBusy(false);
            await onChanged();
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
    pull: RepositoryChangeRequestReference;
    detail: CachedValue<RepositoryReferenceDetail>;
    context: SourceControlReadContext;
    /** Resolves once the surface has re-read the item, so `busy` covers the refresh. */
    onChanged: () => void | Promise<void>;
}> = ({ pull, detail, context, onChanged }) => {
    const { t } = useI18n();
    const { sourceControl } = useRuntimeAPIs();
    const [busy, setBusy] = React.useState(false);
    const reviewers = detail.status === 'ready' ? detail.value.pull?.reviewers ?? [] : null;
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
            await onChanged();
        }
    };

    // The current set comes with the detail: no picker until it is known. A
    // detail that failed says so in the rows above, and nothing more comes.
    if (detail.status === 'error') return null;
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
                        // Some hosts refuse to ask a PR's author for its review (GitHub); others allow it (GitLab).
                        .filter((person) => descriptor.features.authorCanReview || person.login !== pull.author?.login)
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

const assigneeChoice = (person: RepositoryReferenceReviewer): BoardChoice => ({
    id: person.id,
    label: person.login,
    content: <RowPerson name={person.login} avatarUrl={person.avatarUrl} />,
});

/**
 * The people an issue is assigned to, changed as one set from the project's
 * people. The list of who can be assigned decides whether the row can be
 * changed at all: a host that will not name them leaves the detail's own
 * assignees shown, as the surface without this control would.
 */
export const SourceBoardAssignees: React.FC<{
    issue: RepositoryIssueReference;
    detail: CachedValue<RepositoryReferenceDetail>;
    context: SourceControlReadContext;
    /** Resolves once the surface has re-read the item, so `busy` covers the refresh. */
    onChanged: () => void | Promise<void>;
}> = ({ issue, detail, context, onChanged }) => {
    const { t } = useI18n();
    const { sourceControl } = useRuntimeAPIs();
    const [busy, setBusy] = React.useState(false);
    // Null while the project has not answered yet: the row stays as the detail
    // has it until the list says there is someone to pick. A host that refuses
    // the read keeps the row read-only; a failed one keeps the pencil, so the
    // picker retries and shows the host's message.
    const [candidates, setCandidates] = React.useState<RepositoryReferenceReviewer[] | null>(null);
    const [candidateReadFailed, setCandidateReadFailed] = React.useState(false);
    const assignees = detail.status === 'ready' ? detail.value.assignees ?? [] : null;
    const descriptor = useSourceControlProvider(issue.provider);
    const { owner, repo } = issue.sourceRepo;

    React.useEffect(() => {
        let active = true;
        void sourceControl.referenceReviewers(context, { owner, repo }).then(
            (people) => { if (active) { setCandidates(people); setCandidateReadFailed(false); } },
            (error) => {
                // A host that does not offer the read has not failed at it: the row stays read-only.
                const refused = typeof error === 'object' && error !== null && 'code' in error && error.code === 'SOURCE_CONTROL_CAPABILITY_UNSUPPORTED';
                if (active) { setCandidates([]); setCandidateReadFailed(!refused); }
            },
        );
        return () => { active = false; };
    }, [context, owner, repo, sourceControl]);

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
            setBusy(false);
            await onChanged();
        }
    };

    if (detail.status === 'error') return null;
    if (!assignees) return <Icon name="loader-4" className="size-3.5 animate-spin text-muted-foreground" />;
    const editable = candidates !== null && (candidates.length > 0 || candidateReadFailed);
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
                        try {
                            const people = await sourceControl.referenceReviewers(context, { owner, repo });
                            setCandidates(people);
                            setCandidateReadFailed(false);
                            return people.map(assigneeChoice);
                        } catch (error) {
                            setCandidateReadFailed(true);
                            throw error;
                        }
                    }}
                    onCommit={(ids) => void commit(ids)}
                    busy={busy}
                />
            ) : null}
        >
            {assignees.length === 0 ? (
                <span className="text-muted-foreground">
                    <span aria-hidden="true">—</span>
                    <span className="sr-only">{t('sourceBoard.assignees.empty')}</span>
                </span>
            ) : assignees.map((person) => <RowPerson key={person.id} name={person.login} avatarUrl={person.avatarUrl} />)}
        </MetaValue>
    );
};

/** A change request's base branch, picked from the repository's branches where the host can point it elsewhere (`baseChange`). One pick is one change; the surface reads the item again rather than showing the pick before the host has it. */
export const SourceBoardBase: React.FC<{
    pull: RepositoryChangeRequestReference;
    context: SourceControlReadContext;
    /** Resolves once the surface has re-read the item, so `busy` covers the refresh. */
    onChanged: () => void | Promise<void>;
}> = ({ pull, context, onChanged }) => {
    const { t } = useI18n();
    const { sourceControl } = useRuntimeAPIs();
    const [busy, setBusy] = React.useState(false);
    const descriptor = useSourceControlProvider(pull.provider);
    const { owner, repo } = pull.sourceRepo;

    const commit = async (base: string) => {
        setBusy(true);
        try {
            await sourceControl.changeRequestSetBase({
                ...context,
                idempotencyKey: newMutationKey(),
                target: { project: { owner, name: repo }, number: pull.number },
                base,
            });
            await onChanged();
        } catch (error) {
            toast.error(t('sourceBoard.base.failed', { reference: referenceNumberLabel(pull, descriptor) }), {
                description: error instanceof Error ? error.message : String(error),
            });
        } finally {
            setBusy(false);
        }
    };

    return (
        <SourceBoardChoicePicker
            single
            ariaLabel={t('sourceBoard.base.edit')}
            searchPlaceholder={t('sourceBoard.base.search')}
            emptyText={t('sourceBoard.base.empty')}
            selected={[]}
            loadChoices={async () => {
                // The one it points at now is not a choice; the rest keep the host's order.
                const branches = await sourceControl.projectBranches(context, owner, repo);
                return branches
                    .filter((branch) => branch !== pull.base)
                    .map((branch) => ({
                        id: branch,
                        label: branch,
                        content: (
                            <span className="flex min-w-0 flex-1 items-center gap-2">
                                <Icon name="git-branch" className="size-3.5 shrink-0 text-muted-foreground" />
                                <span className="truncate font-mono">{branch}</span>
                            </span>
                        ),
                    }));
            }}
            onCommit={([base]) => void commit(base)}
            busy={busy}
        />
    );
};

/** A discussion's category, moved to another where the host keeps more than one. One pick is one change; the surface reads the item and its row again rather than showing the pick before the host has it. */
export const SourceBoardCategory: React.FC<{
    discussion: RepositoryDiscussionReference;
    categories: RepositoryDiscussionCategory[];
    currentId: string;
    context: SourceControlReadContext;
    /** Resolves once the surface has re-read the item, so `busy` covers the refresh. */
    onChanged: () => void | Promise<void>;
}> = ({ discussion, categories, currentId, context, onChanged }) => {
    const { t } = useI18n();
    const { sourceControl } = useRuntimeAPIs();
    const [busy, setBusy] = React.useState(false);
    const descriptor = useSourceControlProvider(discussion.provider);
    const { owner, repo } = discussion.sourceRepo;

    const commit = async (id: string) => {
        setBusy(true);
        try {
            await sourceControl.discussionSetCategory({
                ...context,
                idempotencyKey: newMutationKey(),
                target: { project: { owner, name: repo }, number: discussion.number },
                categoryId: id,
            });
            await onChanged();
        } catch (error) {
            toast.error(t('sourceBoard.category.failed', { reference: referenceNumberLabel(discussion, descriptor) }), {
                description: error instanceof Error ? error.message : String(error),
            });
        } finally {
            setBusy(false);
        }
    };

    return (
        <SourceBoardChoicePicker
            single
            ariaLabel={t('sourceBoard.category.edit')}
            searchPlaceholder={t('sourceBoard.category.search')}
            emptyText={t('sourceBoard.category.empty')}
            selected={[]}
            loadChoices={async () => categories
                // The one it is in now is not a choice; the rest keep the host's order.
                .filter((category) => category.id !== currentId)
                .map((category) => ({
                    id: category.id,
                    label: category.name,
                    content: (
                        <span className="inline-flex min-w-0 items-center gap-1">
                            {category.emoji ? <span aria-hidden className="shrink-0">{category.emoji}</span> : null}
                            <span className="truncate">{category.name}</span>
                        </span>
                    ),
                }))}
            onCommit={([id]) => void commit(id)}
            busy={busy}
        />
    );
};
