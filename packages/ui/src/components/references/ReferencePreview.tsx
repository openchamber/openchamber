import * as React from 'react';

import { SimpleMarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import type { GitHubChecksSummary, GitHubPullStatus, GitHubReference, GitHubReferenceComment, GitHubReferenceDetail, LinearIssue, LinearIssueSummary } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

import type { CachedValue } from './referenceCache';
import { getSourceControlProviderLabel } from '@/lib/source-control/identity';
import { ReferenceComments } from './ReferenceComments';
import { buildReferenceTimeline, type ReferenceCommentItem, type ReferenceTimelineEntry } from './referenceTimeline';
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

/** An item's state as a tinted pill; `trailing` adds a chevron when the pill opens a menu. */
export const StatePill: React.FC<{
    icon: React.ComponentProps<typeof Icon>['name'];
    color: string;
    label: string;
    trailing?: React.ReactNode;
}> = ({ icon, color, label, trailing }) => (
    <span
        className="inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-2 typography-meta font-medium"
        style={{ color, backgroundColor: `color-mix(in srgb, ${color} 14%, transparent)` }}
    >
        <Icon name={icon} className="size-3.5" />
        {label}
        {trailing}
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

/** A checks total as the preview and the board's checks dialog show it. */
export const ChecksSummaryLine: React.FC<{ checks: GitHubChecksSummary }> = ({ checks }) => (
    <>
        <ChecksGlyph checks={checks} />
        <ChecksSummaryText checks={checks} />
    </>
);

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
    state: CachedValue<ReferenceTimelineEntry[]>;
    /** How many comments there are in all, to say when only the newest show. */
    total: number | null;
    /** A PR's thread carries its commits too. */
    activity?: boolean;
    now: number;
    attachments?: CommentAttachments;
}> = ({ state, total, activity = false, now, attachments }) => {
    const { t } = useI18n();
    const shown = state.status === 'ready' ? state.value.filter((entry) => entry.kind === 'comment').length : 0;
    return (
        <section className="flex flex-col gap-3 border-t border-border/60 pt-4">
            <h4 className="flex items-center gap-2 typography-ui-label font-semibold text-foreground">
                {t(activity ? 'references.picker.preview.activity' : 'references.picker.preview.comments')}
                {state.status === 'ready' && total !== null && total > shown ? (
                    <span className={cn('typography-meta font-normal', REFERENCE_META_TEXT)}>
                        {t('references.picker.preview.commentsLatest', { shown, total })}
                    </span>
                ) : null}
                {attachments && shown > 0 && state.status === 'ready' ? (
                    <button
                        type="button"
                        onClick={() => attachments.onAttachAll(state.value.flatMap((entry) => (entry.kind === 'comment' ? [entry] : [])))}
                        className={cn('ml-auto inline-flex items-center gap-1 typography-meta font-normal hover:text-foreground', REFERENCE_META_TEXT)}
                    >
                        <Icon name="attachment-2" className="size-3.5" />
                        {t('gitView.pr.comments.addAll')}
                    </button>
                ) : null}
            </h4>
            {state.status === 'error' ? (
                <p className="typography-meta text-[var(--status-error-text)]">{t('references.picker.error.load', { error: state.error })}</p>
            ) : state.status !== 'ready' ? (
                <Pending />
            ) : state.value.length === 0 ? (
                <p className="typography-meta text-muted-foreground">{t('references.picker.preview.commentsEmpty')}</p>
            ) : (
                <ReferenceComments entries={state.value} now={now} onAttachComment={attachments?.onAttach} />
            )}
        </section>
    );
};

/** Pins a comment, or all of them, above the composer. */
type CommentAttachments = {
    onAttach: (comment: ReferenceCommentItem) => void;
    onAttachAll: (comments: ReferenceCommentItem[]) => void;
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
    links?: React.ReactNode;
    /** Opens the PR's check runs; the totals become a button. */
    onOpenChecks?: () => void;
}> = ({ detail, checks, links, onOpenChecks }) => {
    const { t } = useI18n();
    const pull = detail.status === 'ready' ? detail.value.pull : null;
    return (
        <>
            <MetaRow label={t('references.picker.preview.changes')}>
                <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
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
                    {links}
                </span>
            </MetaRow>
            {checks.status === 'ready' ? (
                checks.value && checks.value.total > 0 ? (
                    <MetaRow label={t('references.picker.preview.checks')}>
                        {onOpenChecks ? (
                            <Button
                                variant="ghost"
                                size="xs"
                                onClick={onOpenChecks}
                                className="-ml-1.5 gap-1.5 px-1.5 typography-meta font-normal normal-case text-muted-foreground"
                            >
                                <ChecksSummaryLine checks={checks.value} />
                                <Icon name="arrow-right-s" className="size-3.5 opacity-60" />
                            </Button>
                        ) : (
                            <span className="inline-flex items-center gap-1.5">
                                <ChecksSummaryLine checks={checks.value} />
                            </span>
                        )}
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

/**
 * The previewed PR's checks come with its own detail (GitHub's head commit,
 * GitLab's pipeline), one PR at a time, so the preview never waits for the
 * statuses a whole list asks for. Closed and merged PRs have none to show.
 */
const previewChecks = (
    reference: GitHubReference,
    detail: CachedValue<GitHubReferenceDetail>,
): CachedValue<GitHubChecksSummary | null> => {
    if (reference.kind !== 'pull' || reference.state !== 'open') return NO_CHECKS;
    return mapDetail(detail, (value) => value.pull?.checks ?? null);
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
    footer?: React.ReactNode;
    pullLinks?: React.ReactNode;
    reply?: React.ReactNode;
    labelsControl?: React.ReactNode;
    reviewersControl?: React.ReactNode;
    onOpenChecks?: () => void;
    commentAttachments?: CommentAttachments;
    stateMenu?: React.ReactNode;
}> = ({ reference, pullStatus, detail, purpose, pinned, includeDiff, onIncludeDiffChange, now, footer: footerOverride, pullLinks, reply, labelsControl, reviewersControl, onOpenChecks, commentAttachments, stateMenu }) => {
    const { t } = useI18n();
    const comments = React.useMemo(
        () => mapDetail(detail, (value) => buildReferenceTimeline(value.comments.map((comment: GitHubReferenceComment, index): ReferenceCommentItem => {
            const location = comment.path ? `${comment.path}${comment.line ? `:${comment.line}` : ''}` : null;
            return {
                kind: 'comment',
                key: `${comment.url}#${index}`,
                author: comment.author?.login ?? null,
                avatarUrl: comment.author?.avatarUrl ?? null,
                body: comment.body,
                createdAt: comment.createdAt,
                context: location ?? (comment.review && comment.review !== 'commented' ? t(REVIEW_VERDICT_KEYS[comment.review]) : null),
                location,
            };
        }), (value.pull?.commits ?? []).map((commit) => ({
            sha: commit.sha,
            headline: commit.headline,
            author: commit.author?.login ?? commit.authorName,
            avatarUrl: commit.author?.avatarUrl ?? null,
            committedAt: commit.committedAt,
            url: commit.url,
        })))),
        [detail, t],
    );
    const relative = useRelative(now);
    const look = githubStateLook(reference, pullStatus.status === 'ready' ? pullStatus.value : null);
    const labels = reference.labels.map((label) => ({ name: label.name, color: labelColor(label.color) }));
    const updated = relative(reference.updatedAt);
    const body = reference.body.trim() ? reference.body : '';

    const footer = footerOverride ?? (
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
                    {stateMenu ? (
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <button
                                    type="button"
                                    aria-label={t('references.picker.preview.stateMenuAria', { state: t(look.labelKey) })}
                                    className="shrink-0 rounded-full outline-none transition-opacity hover:opacity-85 focus-visible:ring-2 focus-visible:ring-ring"
                                >
                                    <StatePill
                                        icon={look.icon}
                                        color={look.color}
                                        label={t(look.labelKey)}
                                        trailing={<Icon name="arrow-down-s" className="size-3.5 opacity-70" />}
                                    />
                                </button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="start" className="w-56">{stateMenu}</DropdownMenuContent>
                        </DropdownMenu>
                    ) : (
                        <StatePill icon={look.icon} color={look.color} label={t(look.labelKey)} />
                    )}
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
                        <PullDetailRows detail={detail} checks={previewChecks(reference, detail)} links={pullLinks} onOpenChecks={onOpenChecks} />
                    </>
                ) : null}
                {reviewersControl && reference.kind === 'pull' ? (
                    <MetaRow label={t('references.picker.preview.reviewers')}>{reviewersControl}</MetaRow>
                ) : null}
                {labelsControl ? (
                    // Shown with no labels too, so some can be added.
                    <MetaRow label={t('references.picker.preview.labels')}>{labelsControl}</MetaRow>
                ) : labels.length > 0 ? (
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

            <CommentsSection state={comments} total={detail.status === 'ready' ? detail.value.commentTotal : null} activity={reference.kind === 'pull'} now={now} attachments={commentAttachments} />
            {reply}
        </PreviewFrame>
    );
};

/**
 * A parent or sub-issue as one line: its state, identifier and title. A button
 * that previews it when the surface can, plain text otherwise.
 */
const RelatedLinearIssue: React.FC<{
    issue: LinearIssueSummary;
    onOpen?: (issue: LinearIssueSummary) => void;
    /** A sub-issue row also names its assignee. */
    showAssignee?: boolean;
}> = ({ issue, onOpen, showAssignee = false }) => {
    const look = linearStateLook(issue);
    const assignee = issue.assignee?.displayName || issue.assignee?.name;
    const content = (
        <>
            <Icon name={look.icon} className="size-3.5 shrink-0" style={{ color: look.color }} />
            <span className={cn('shrink-0 font-mono', REFERENCE_META_TEXT)}>{issue.identifier}</span>
            <span className="min-w-0 truncate">{issue.title}</span>
            {showAssignee && assignee ? (
                <span className={cn('ml-auto shrink-0 pl-2', REFERENCE_META_TEXT)}>{assignee}</span>
            ) : null}
        </>
    );
    const className = 'flex w-full min-w-0 items-center gap-1.5 text-left typography-meta';
    if (!onOpen) return <span className={cn(className, 'text-muted-foreground')}>{content}</span>;
    return (
        <button
            type="button"
            onClick={() => onOpen(issue)}
            title={issue.title}
            className={cn(className, 'rounded-sm text-muted-foreground/80 outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring')}
        >
            {content}
        </button>
    );
};

/** A Linear issue's sub-issues, finished of all, in Linear's order. */
const SubIssuesSection: React.FC<{
    issue: LinearIssue;
    onOpen?: (issue: LinearIssueSummary) => void;
}> = ({ issue, onOpen }) => {
    const { t } = useI18n();
    const subIssues = issue.subIssues ?? [];
    if (subIssues.length === 0) return null;
    const done = subIssues.filter((sub) => sub.state?.type === 'completed' || sub.state?.type === 'canceled' || sub.state?.type === 'duplicate').length;
    return (
        <section className="flex flex-col gap-2 border-t border-border/60 pt-4">
            <h4 className="flex items-center gap-2 typography-ui-label font-semibold text-foreground">
                {t('references.picker.preview.subIssues')}
                {issue.subIssuesMore ? null : (
                    <span className={cn('typography-meta font-normal tabular-nums', REFERENCE_META_TEXT)}>{done}/{subIssues.length}</span>
                )}
            </h4>
            <ul className="flex flex-col gap-1.5">
                {subIssues.map((sub) => (
                    <li key={sub.id}><RelatedLinearIssue issue={sub} onOpen={onOpen} showAssignee /></li>
                ))}
            </ul>
            {issue.subIssuesMore ? (
                <a
                    href={issue.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={cn('inline-flex items-center gap-1 self-start typography-meta hover:text-foreground', REFERENCE_META_TEXT)}
                >
                    {t('references.picker.preview.subIssuesMore', { count: subIssues.length })}
                    <Icon name="external-link" className="size-3.5" />
                </a>
            ) : null}
        </section>
    );
};

const LinearPreview: React.FC<{
    issue: LinearIssueSummary;
    detail: CachedValue<LinearIssue>;
    purpose: ReferencePreviewPurpose;
    pinned: boolean;
    now: number;
    footer?: React.ReactNode;
    stateControl?: React.ReactNode;
    onOpenIssue?: (issue: LinearIssueSummary) => void;
}> = ({ issue, detail, purpose, pinned, now, footer: footerOverride, stateControl, onOpenIssue }) => {
    const { t } = useI18n();
    const relative = useRelative(now);
    const look = linearStateLook(issue);
    const full = detail.status === 'ready' ? detail.value : null;
    // A parent or sub-issue opened from another preview comes without its
    // labels and parent; its own detail brings them.
    const labels = (full?.labels ?? issue.labels ?? []).map((label) => ({ name: label.name, color: labelColor(label.color) }));
    const parent = full?.parent ?? issue.parent ?? null;
    const updated = relative(issue.updatedAt);
    const assignee = issue.assignee?.displayName || issue.assignee?.name;
    const comments = React.useMemo(
        () => mapDetail(detail, (value) => (value.comments ?? []).map((comment): ReferenceTimelineEntry => ({
            kind: 'comment',
            key: comment.id,
            author: comment.user?.displayName || comment.user?.name || null,
            avatarUrl: comment.user?.avatarUrl ?? null,
            body: comment.body,
            createdAt: comment.createdAt,
            context: null,
            location: null,
        }))),
        [detail],
    );

    const footer = footerOverride ?? (
        <p className="typography-meta text-muted-foreground">
            {purpose === 'worktree' ? t('references.picker.preview.worktree.issue') : t('references.picker.preview.sends.linear')}
        </p>
    );

    return (
        <PreviewFrame pinned={pinned} footer={footer}>
            <header className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                    {stateControl ?? (issue.state?.name ? <StatePill icon={look.icon} color={look.color} label={issue.state.name} /> : null)}
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
                {parent ? (
                    <MetaRow label={t('references.picker.preview.parent')}>
                        <RelatedLinearIssue issue={parent} onOpen={onOpenIssue} />
                    </MetaRow>
                ) : null}
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

            {full ? <SubIssuesSection issue={full} onOpen={onOpenIssue} /> : null}
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
    /** Replaces what the agent gets with what the surface does with the item. */
    footer?: React.ReactNode;
    /** Beside a PR's size: where to look at its changes. */
    pullLinks?: React.ReactNode;
    /** Replaces a Linear issue's state pill, such as with one that changes the state. */
    linearStateControl?: React.ReactNode;
    /** After an issue's or PR's activity: a way to answer it. */
    reply?: React.ReactNode;
    /** Replace an issue's or PR's labels, and a PR's reviewers, with ones that change them. */
    labelsControl?: React.ReactNode;
    reviewersControl?: React.ReactNode;
    /** Opens the previewed PR's check runs from its checks totals. */
    onOpenChecks?: () => void;
    /** An issue's or PR's comments, pinned above the composer one by one or together. */
    commentAttachments?: CommentAttachments;
    /** Menu items on an issue's or PR's state pill, such as close or reopen. */
    stateMenu?: React.ReactNode;
    /** Previews a Linear issue's parent or sub-issue; without it they are plain text. */
    onOpenLinearIssue?: (issue: LinearIssueSummary) => void;
}> = ({ item, pullStatus, linearDetail, githubDetail, purpose, pinned, includeDiff, onIncludeDiffChange, now, footer, pullLinks, linearStateControl, reply, labelsControl, reviewersControl, onOpenChecks, commentAttachments, stateMenu, onOpenLinearIssue }) => {
    const { t } = useI18n();
    if (!item) {
        return (
            <div className="flex h-full items-center justify-center px-6 text-center typography-meta text-muted-foreground">
                {t('references.picker.preview.empty')}
            </div>
        );
    }
    if (item.source === 'linear') {
        return <LinearPreview issue={item.issue} detail={linearDetail} purpose={purpose} pinned={pinned} now={now} footer={footer} stateControl={linearStateControl} onOpenIssue={onOpenLinearIssue} />;
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
            footer={footer}
            pullLinks={pullLinks}
            reply={reply}
            labelsControl={labelsControl}
            reviewersControl={reviewersControl}
            onOpenChecks={onOpenChecks}
            commentAttachments={commentAttachments}
            stateMenu={stateMenu}
        />
    );
};
