import * as React from 'react';

import { SimpleMarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { Icon } from '@/components/icon/Icon';
import { Checkbox } from '@/components/ui/checkbox';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import type { GitHubChecksSummary, GitHubReference, GitHubReferenceComment, GitHubReferenceDetail, LinearIssue, LinearIssueSummary } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';

import type { CachedValue } from './referenceCache';
import { ReferenceComments, type ReferenceCommentItem } from './ReferenceComments';
import { ChecksGlyph, ReferenceLabelChips } from './ReferencePickerRow';
import {
    githubStateLook,
    labelColor,
    LINEAR_PRIORITY_KEYS,
    linearStateLook,
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
        <dt className="typography-meta text-muted-foreground">{label}</dt>
        <dd className="min-w-0 typography-meta text-foreground">{children}</dd>
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
                    <span className="typography-meta font-normal text-muted-foreground">
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

/** Size, checks and review of a PR, read for the previewed PR only. */
const PullDetailRows: React.FC<{ detail: CachedValue<GitHubReferenceDetail> }> = ({ detail }) => {
    const { t } = useI18n();
    if (detail.status === 'error') {
        return (
            <MetaRow label={t('references.picker.preview.checks')}>
                <span className="text-[var(--status-error-text)]">{t('references.picker.error.load', { error: detail.error })}</span>
            </MetaRow>
        );
    }
    if (detail.status !== 'ready' || !detail.value.pull) {
        return (
            <>
                <MetaRow label={t('references.picker.preview.changes')}><Pending /></MetaRow>
                <MetaRow label={t('references.picker.preview.checks')}><Pending /></MetaRow>
            </>
        );
    }
    const { additions, deletions, changedFiles, checks, reviewDecision } = detail.value.pull;
    return (
        <>
            <MetaRow label={t('references.picker.preview.changes')}>
                <span className="inline-flex items-center gap-2">
                    <span className="text-[var(--status-success)]">+{additions}</span>
                    <span className="text-[var(--status-error)]">−{deletions}</span>
                    <span className="inline-flex items-center gap-0.5 text-muted-foreground">
                        <Icon name="file-list-2" className="size-3.5" />
                        {changedFiles}
                    </span>
                </span>
            </MetaRow>
            {checks && checks.total > 0 ? (
                <MetaRow label={t('references.picker.preview.checks')}>
                    <span className="inline-flex items-center gap-1.5">
                        <ChecksGlyph checks={checks} />
                        <ChecksSummaryText checks={checks} />
                    </span>
                </MetaRow>
            ) : null}
            {reviewDecision ? (
                <MetaRow label={t('references.picker.preview.review')}>{t(REVIEW_KEYS[reviewDecision])}</MetaRow>
            ) : null}
        </>
    );
};

const GitHubPreview: React.FC<{
    reference: GitHubReference;
    detail: CachedValue<GitHubReferenceDetail>;
    purpose: ReferencePreviewPurpose;
    pinned: boolean;
    includeDiff: boolean;
    onIncludeDiffChange: (include: boolean) => void;
    now: number;
}> = ({ reference, detail, purpose, pinned, includeDiff, onIncludeDiffChange, now }) => {
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
    const look = githubStateLook(reference);
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
                    <span className="truncate typography-meta text-muted-foreground">
                        {reference.sourceRepo.owner}/{reference.sourceRepo.repo} {referenceNumberLabel(reference)}
                    </span>
                    <a
                        href={reference.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 typography-meta text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
                    >
                        GitHub
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
                        <PullDetailRows detail={detail} />
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
                    <span className="truncate typography-meta text-muted-foreground">{issue.identifier}</span>
                    <a
                        href={issue.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 typography-meta text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
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
    linearDetail: CachedValue<LinearIssue>;
    githubDetail: CachedValue<GitHubReferenceDetail>;
    purpose: ReferencePreviewPurpose;
    /** Desktop pane: own scroll with the send summary pinned below. */
    pinned: boolean;
    includeDiff: boolean;
    onIncludeDiffChange: (include: boolean) => void;
    now: number;
}> = ({ item, linearDetail, githubDetail, purpose, pinned, includeDiff, onIncludeDiffChange, now }) => {
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
            detail={githubDetail}
            purpose={purpose}
            pinned={pinned}
            includeDiff={includeDiff}
            onIncludeDiffChange={onIncludeDiffChange}
            now={now}
        />
    );
};
