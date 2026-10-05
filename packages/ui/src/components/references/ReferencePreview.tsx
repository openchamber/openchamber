import * as React from 'react';

import { SimpleMarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { Icon } from '@/components/icon/Icon';
import { Checkbox } from '@/components/ui/checkbox';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import type { GitHubChecksSummary, GitHubPullStatus, GitHubReference, GitHubReferenceComment, GitHubReferenceDetail, LinearIssue, LinearIssueSummary } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

import type { CachedValue } from './referenceCache';
import { getSourceControlProviderLabel } from '@/lib/source-control/identity';
import { ReferenceComments, type ReferenceCommentItem } from './ReferenceComments';
import { ChecksGlyph, ReferenceLabelChips } from './ReferencePickerRow';
import {
    githubStateLook,
    labelColor,
    LINEAR_PRIORITY_KEYS,
    linearStateLook,
    REFERENCE_META_TEXT,
    relativeTimeOf,
    type ReferencePickerItem,
    referenceNumberLabel,
} from './referencePickerItems';

export type ReferencePreviewPurpose = 'attach' | 'worktree';

const MARKDOWN_CLASS = '[&_img]:max-w-full [&_img]:h-auto';

/**
 * `pinned` (desktop pane): the item scrolls and what the agent gets stays in
 * view below it, so a long description never hides the diff switch. Inline
 * (mobile): one flow inside the sheet's own scroll.
 */
const PreviewFrame: React.FC<{ pinned: boolean; footer: React.ReactNode; children: React.ReactNode }> = ({ pinned, footer, children }) => {
    if (!pinned) {
        return (
            <article className="flex flex-col gap-4">
                {children}
                <div className="rounded-lg border border-border/60 px-3 py-2.5">{footer}</div>
            </article>
        );
    }
    return (
        <div className="flex h-full min-h-0 flex-col">
            <ScrollableOverlay outerClassName="min-h-0 flex-1" className="px-6 py-5" disableHorizontal>
                <article className="flex flex-col gap-4">{children}</article>
            </ScrollableOverlay>
            <div className="shrink-0 border-t border-border/60 px-6 py-3">{footer}</div>
        </div>
    );
};

const MetaRow: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
    <>
        <dt className={cn('typography-meta', REFERENCE_META_TEXT)}>{label}</dt>
        <dd className="min-w-0 typography-meta text-muted-foreground">{children}</dd>
    </>
);

const StatePill: React.FC<{ icon: React.ComponentProps<typeof Icon>['name']; color: string; label: string }> = ({ icon, color, label }) => (
    <span
        className="inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-2 typography-meta font-medium"
        style={{ color, backgroundColor: `color-mix(in srgb, ${color} 14%, transparent)` }}
    >
        <Icon name={icon} className="size-3.5" />
        {label}
    </span>
);

const useRelative = (now: number) => {
    const { t } = useI18n();
    return (iso: string | null | undefined) => {
        const relative = relativeTimeOf(iso, now);
        if (!relative) return null;
        return relative.key === 'common.relative.justNow' ? t(relative.key) : t(relative.key, { count: relative.count });
    };
};

const ChecksSummaryText: React.FC<{ checks: GitHubChecksSummary }> = ({ checks }) => {
    const { t } = useI18n();
    if (checks.state === 'failure') return <>{t('references.picker.preview.checksFailed', { failed: checks.failure, total: checks.total })}</>;
    if (checks.state === 'pending') return <>{t('references.picker.preview.checksPending', { pending: checks.pending, total: checks.total })}</>;
    if (checks.state === 'success') return <>{t('references.picker.preview.checksPassed')}</>;
    return null;
};

const REVIEW_KEYS = {
    approved: 'references.picker.preview.review.approved',
    changes_requested: 'references.picker.preview.review.changesRequested',
    review_required: 'references.picker.preview.review.required',
} as const;

const Pending = () => <Icon name="loader-4" className="size-3.5 animate-spin text-muted-foreground" />;

/** Description with images and the HTML GitHub allows; the agent gets the source. */
const ReferenceBody: React.FC<{ content: string }> = ({ content }) => (
    <SimpleMarkdownRenderer content={content} className={MARKDOWN_CLASS} enableFileReferences={false} allowRawHtml />
);

/** The thread section under the body: loading, failure, empty, or the comments. */
const CommentsSection: React.FC<{
    state: CachedValue<ReferenceCommentItem[]>;
    total: number | null;
    now: number;
}> = ({ state, total, now }) => {
    const { t } = useI18n();
    const shown = state.status === 'ready' ? state.value.length : 0;
    return (
        <section className="flex flex-col gap-3 border-t border-border/60 pt-4">
            <h4 className="flex items-center gap-2 typography-ui-label font-semibold text-foreground">
                {t('references.picker.preview.comments')}
                {state.status === 'ready' && total !== null && total > shown ? (
                    <span className={cn('typography-meta font-normal', REFERENCE_META_TEXT)}>
                        {t('references.picker.preview.commentsLatest', { shown, total })}
                    </span>
                ) : null}
            </h4>
            {state.status === 'error' ? (
                <p className="typography-meta text-[var(--status-error-text)]">{t('references.picker.error.load', { error: state.error })}</p>
            ) : state.status !== 'ready' ? (
                <Pending />
            ) : state.value.length === 0 ? (
                <p className="typography-meta text-muted-foreground">{t('references.picker.preview.commentsEmpty')}</p>
            ) : (
                <ReferenceComments comments={state.value} now={now} />
            )}
        </section>
    );
};

const REVIEW_VERDICT_KEYS = {
    approved: 'references.picker.preview.review.approved',
    changes_requested: 'references.picker.preview.review.changesRequested',
    dismissed: 'references.picker.comment.dismissed',
} as const;

const mapDetail = <T, R>(state: CachedValue<T>, map: (value: T) => R): CachedValue<R> => (
    state.status === 'ready' ? { status: 'ready', value: map(state.value) } : state
);

const LoadError: React.FC<{ error: string }> = ({ error }) => {
    const { t } = useI18n();
    return <span className="text-[var(--status-error-text)]">{t('references.picker.error.load', { error })}</span>;
};

/**
 * Size and review of the previewed PR from its detail, and its checks from
 * `checks`: the status that colours a GitHub PR, or a GitLab detail's pipeline.
 */
const PullDetailRows: React.FC<{
    detail: CachedValue<GitHubReferenceDetail>;
    checks: CachedValue<GitHubChecksSummary | null>;
}> = ({ detail, checks }) => {
    const { t } = useI18n();
    const pull = detail.status === 'ready' ? detail.value.pull : null;
    return (
        <>
            <MetaRow label={t('references.picker.preview.changes')}>
                {detail.status === 'error' ? <LoadError error={detail.error} /> : pull ? (
                    <span className="inline-flex items-center gap-2">
                        <span className="text-[var(--status-success)]">+{pull.additions}</span>
                        <span className="text-[var(--status-error)]">−{pull.deletions}</span>
                        <span className="inline-flex items-center gap-0.5 text-muted-foreground">
                            <Icon name="file-list-2" className="size-3.5" />
                            {pull.changedFiles}
                        </span>
                    </span>
                ) : <Pending />}
            </MetaRow>
            {checks.status === 'ready' ? (
                checks.value && checks.value.total > 0 ? (
                    <MetaRow label={t('references.picker.preview.checks')}>
                        <span className="inline-flex items-center gap-1.5">
                            <ChecksGlyph checks={checks.value} />
                            <ChecksSummaryText checks={checks.value} />
                        </span>
                    </MetaRow>
                ) : null
            ) : (
                <MetaRow label={t('references.picker.preview.checks')}>
                    {checks.status === 'error' ? <LoadError error={checks.error} /> : <Pending />}
                </MetaRow>
            )}
            {pull?.reviewDecision ? (
                <MetaRow label={t('references.picker.preview.review')}>{t(REVIEW_KEYS[pull.reviewDecision])}</MetaRow>
            ) : null}
        </>
    );
};

const NO_CHECKS: CachedValue<GitHubChecksSummary | null> = { status: 'ready', value: null };
const CHECKS_PENDING: CachedValue<GitHubChecksSummary | null> = { status: 'loading' };

/** Where the previewed PR's checks come from; closed and merged PRs have none to show. */
const previewChecks = (
    reference: GitHubReference,
    pullStatus: CachedValue<GitHubPullStatus | null>,
    detail: CachedValue<GitHubReferenceDetail>,
): CachedValue<GitHubChecksSummary | null> => {
    if (reference.provider === 'gitlab') return mapDetail(detail, (value) => value.pull?.checks ?? null);
    if (reference.kind !== 'pull' || reference.state !== 'open') return NO_CHECKS;
    // Idle: listed, but its status has not been asked for yet.
    if (pullStatus.status === 'idle') return CHECKS_PENDING;
    return mapDetail(pullStatus, (status) => status?.checks ?? null);
};

const GitHubPreview: React.FC<{
    reference: GitHubReference;
    pullStatus: CachedValue<GitHubPullStatus | null>;
    detail: CachedValue<GitHubReferenceDetail>;
    purpose: ReferencePreviewPurpose;
    pinned: boolean;
    includeDiff: boolean;
    onIncludeDiffChange: (include: boolean) => void;
    now: number;
}> = ({ reference, pullStatus, detail, purpose, pinned, includeDiff, onIncludeDiffChange, now }) => {
    const { t } = useI18n();
    const comments = React.useMemo(
        () => mapDetail(detail, (value) => value.comments.map((comment: GitHubReferenceComment, index): ReferenceCommentItem => ({
            key: `${comment.url}#${index}`,
            author: comment.author?.login ?? null,
            avatarUrl: comment.author?.avatarUrl ?? null,
            body: comment.body,
            createdAt: comment.createdAt,
            context: comment.path
                ? `${comment.path}${comment.line ? `:${comment.line}` : ''}`
                : comment.review && comment.review !== 'commented' ? t(REVIEW_VERDICT_KEYS[comment.review]) : null,
        }))),
        [detail, t],
    );
    const relative = useRelative(now);
    const look = githubStateLook(reference, pullStatus.status === 'ready' ? pullStatus.value : null);
    const labels = reference.labels.map((label) => ({ name: label.name, color: labelColor(label.color) }));
    const updated = relative(reference.updatedAt);
    const body = reference.body.trim() ? reference.body : '';

    const footer = (
        <div className="flex flex-col gap-2">
            <p className="typography-meta text-muted-foreground">
                {purpose === 'worktree'
                    ? t(reference.kind === 'pull' ? 'references.picker.preview.worktree.pull' : 'references.picker.preview.worktree.issue')
                    : t(reference.kind === 'pull' ? 'references.picker.preview.sends.pull' : 'references.picker.preview.sends.issue')}
            </p>
            {reference.kind === 'pull' ? (
                <label className="flex cursor-pointer items-center gap-2 typography-meta text-foreground">
                    <Checkbox checked={includeDiff} onChange={onIncludeDiffChange} ariaLabel={t('references.picker.preview.includeDiff')} />
                    {t('references.picker.preview.includeDiff')}
                </label>
            ) : null}
        </div>
    );

    return (
        <PreviewFrame pinned={pinned} footer={footer}>
            <header className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                    <StatePill icon={look.icon} color={look.color} label={t(look.labelKey)} />
                    <span className={cn('truncate typography-meta', REFERENCE_META_TEXT)}>
                        {reference.sourceRepo.owner}/{reference.sourceRepo.repo} {referenceNumberLabel(reference)}
                    </span>
                    <a
                        href={reference.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={cn('ml-auto inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 typography-meta hover:bg-interactive-hover hover:text-foreground', REFERENCE_META_TEXT)}
                    >
                        {getSourceControlProviderLabel(reference.provider ?? 'github')}
                        <Icon name="external-link" className="size-3.5" />
                    </a>
                </div>
                <h3 className="typography-ui-header font-semibold break-words text-foreground">{reference.title}</h3>
            </header>

            <dl className="grid grid-cols-[max-content_minmax(0,1fr)] items-center gap-x-4 gap-y-1.5">
                {reference.author ? (
                    <MetaRow label={t('references.picker.preview.author')}>
                        <span className="inline-flex items-center gap-1.5">
                            {reference.author.avatarUrl ? (
                                <img src={reference.author.avatarUrl} alt="" className="size-4 rounded-full" loading="lazy" />
                            ) : null}
                            {reference.author.login}
                        </span>
                    </MetaRow>
                ) : null}
                {updated ? <MetaRow label={t('references.picker.preview.updated')}>{updated}</MetaRow> : null}
                {reference.kind === 'pull' ? (
                    <>
                        <MetaRow label={t('references.picker.preview.branch')}>
                            <span className="inline-flex max-w-full items-center gap-1 font-mono">
                                <span className="truncate">{reference.head}</span>
                                <Icon name="arrow-right" className="size-3 shrink-0 text-muted-foreground" />
                                <span className="truncate">{reference.base}</span>
                            </span>
                        </MetaRow>
                        <PullDetailRows detail={detail} checks={previewChecks(reference, pullStatus, detail)} />
                    </>
                ) : null}
                {labels.length > 0 ? (
                    <MetaRow label={t('references.picker.preview.labels')}><ReferenceLabelChips labels={labels} /></MetaRow>
                ) : null}
            </dl>

            <div className="min-w-0 flex-1 border-t border-border/60 pt-4">
                {body ? (
                    <ReferenceBody content={body} />
                ) : (
                    <p className="typography-meta text-muted-foreground">{t('references.picker.preview.noDescription')}</p>
                )}
                {reference.bodyTruncated ? (
                    <p className="mt-3 typography-meta text-muted-foreground">{t('references.picker.preview.truncated')}</p>
                ) : null}
            </div>

            <CommentsSection state={comments} total={detail.status === 'ready' ? detail.value.commentTotal : null} now={now} />
        </PreviewFrame>
    );
};

const LinearPreview: React.FC<{
    issue: LinearIssueSummary;
    detail: CachedValue<LinearIssue>;
    purpose: ReferencePreviewPurpose;
    pinned: boolean;
    now: number;
}> = ({ issue, detail, purpose, pinned, now }) => {
    const { t } = useI18n();
    const relative = useRelative(now);
    const look = linearStateLook(issue);
    const labels = (issue.labels ?? []).map((label) => ({ name: label.name, color: labelColor(label.color) }));
    const updated = relative(issue.updatedAt);
    const assignee = issue.assignee?.displayName || issue.assignee?.name;
    const full = detail.status === 'ready' ? detail.value : null;
    const comments = React.useMemo(
        () => mapDetail(detail, (value) => (value.comments ?? []).map((comment): ReferenceCommentItem => ({
            key: comment.id,
            author: comment.user?.displayName || comment.user?.name || null,
            avatarUrl: comment.user?.avatarUrl ?? null,
            body: comment.body,
            createdAt: comment.createdAt,
            context: null,
        }))),
        [detail],
    );

    const footer = (
        <p className="typography-meta text-muted-foreground">
            {purpose === 'worktree' ? t('references.picker.preview.worktree.issue') : t('references.picker.preview.sends.linear')}
        </p>
    );

    return (
        <PreviewFrame pinned={pinned} footer={footer}>
            <header className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                    {issue.state?.name ? <StatePill icon={look.icon} color={look.color} label={issue.state.name} /> : null}
                    <span className={cn('truncate typography-meta', REFERENCE_META_TEXT)}>{issue.identifier}</span>
                    <a
                        href={issue.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={cn('ml-auto inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 typography-meta hover:bg-interactive-hover hover:text-foreground', REFERENCE_META_TEXT)}
                    >
                        Linear
                        <Icon name="external-link" className="size-3.5" />
                    </a>
                </div>
                <h3 className="typography-ui-header font-semibold break-words text-foreground">{issue.title}</h3>
            </header>

            <dl className="grid grid-cols-[max-content_minmax(0,1fr)] items-center gap-x-4 gap-y-1.5">
                {assignee ? <MetaRow label={t('references.picker.preview.assignee')}>{assignee}</MetaRow> : null}
                {issue.team ? <MetaRow label={t('references.picker.preview.team')}>{issue.team.name}</MetaRow> : null}
                {issue.priority && issue.priority > 0 ? (
                    <MetaRow label={t('references.picker.preview.priority')}>{t(LINEAR_PRIORITY_KEYS[issue.priority])}</MetaRow>
                ) : null}
                {updated ? <MetaRow label={t('references.picker.preview.updated')}>{updated}</MetaRow> : null}
                {labels.length > 0 ? (
                    <MetaRow label={t('references.picker.preview.labels')}><ReferenceLabelChips labels={labels} /></MetaRow>
                ) : null}
            </dl>

            <div className="min-w-0 flex-1 border-t border-border/60 pt-4">
                {detail.status === 'loading' || detail.status === 'idle' ? (
                    <p className="inline-flex items-center gap-2 typography-meta text-muted-foreground">
                        <Icon name="loader-4" className="size-3.5 animate-spin" />
                        {t('references.picker.loading')}
                    </p>
                ) : detail.status === 'error' ? (
                    <p className="typography-meta text-[var(--status-error-text)]">{t('references.picker.error.load', { error: detail.error })}</p>
                ) : full?.description?.trim() ? (
                    <ReferenceBody content={full.description} />
                ) : (
                    <p className="typography-meta text-muted-foreground">{t('references.picker.preview.noDescription')}</p>
                )}
            </div>

            {detail.status === 'ready' ? <CommentsSection state={comments} total={null} now={now} /> : null}
        </PreviewFrame>
    );
};

export const ReferencePreview: React.FC<{
    item: ReferencePickerItem | null;
    /** The previewed PR's checks and mergeability, as its row has them. */
    pullStatus: CachedValue<GitHubPullStatus | null>;
    linearDetail: CachedValue<LinearIssue>;
    githubDetail: CachedValue<GitHubReferenceDetail>;
    purpose: ReferencePreviewPurpose;
    /** Desktop pane: own scroll with the send summary pinned below. */
    pinned: boolean;
    includeDiff: boolean;
    onIncludeDiffChange: (include: boolean) => void;
    now: number;
}> = ({ item, pullStatus, linearDetail, githubDetail, purpose, pinned, includeDiff, onIncludeDiffChange, now }) => {
    const { t } = useI18n();
    if (!item) {
        return (
            <div className="flex h-full items-center justify-center px-6 text-center typography-meta text-muted-foreground">
                {t('references.picker.preview.empty')}
            </div>
        );
    }
    if (item.source === 'linear') {
        return <LinearPreview issue={item.issue} detail={linearDetail} purpose={purpose} pinned={pinned} now={now} />;
    }
    return (
        <GitHubPreview
            reference={item.reference}
            pullStatus={pullStatus}
            detail={githubDetail}
            purpose={purpose}
            pinned={pinned}
            includeDiff={includeDiff}
            onIncludeDiffChange={onIncludeDiffChange}
            now={now}
        />
    );
};
