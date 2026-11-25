import * as React from 'react';

import { SimpleMarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { dropdownTriggerVariants } from '@/components/ui/dropdown-trigger';
import { Input } from '@/components/ui/input';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { CISummary, ChangeRequestListStatus, ChangeRequestRevision, ChangeRequestRevisionKind, RepositoryReference, RepositoryReferenceComment, RepositoryReferenceDetail, TrackerItem, TrackerItemSummary, PullRequestStackLayer } from '@/lib/api/types';
import { useAvatarImage } from '@/hooks/useAvatarImage';
import { useEmojiShortcodes } from '@/lib/emoji/shortcodes';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { isIMECompositionEvent } from '@/lib/ime';
import { cn } from '@/lib/utils';

import { ButtonTooltip } from '@/components/ui/action-toolbar';
import type { CachedValue } from './referenceCache';
import { ReferenceMarkdownRewriteContext, useProjectUploadRewrite } from './projectUploads';
import { ReferenceMarkdownEditor } from './ReferenceMarkdownEditor';
import { foldTrackerCollapsibles } from './trackerCollapsibles';
import { PreviewRefreshButton } from './PreviewRefreshButton';
import { ReferenceLinksContext, useReferenceLinks } from './referenceLinks';
import { useSourceControlProvider } from '@/lib/source-control/providers/registry';
import { trackerPresentation } from '@/lib/trackers/presentation';
import { useTrackerDescriptor } from '@/lib/trackers/registry';
import { isSettledTrackerState, trackerStateGlyph } from '@/lib/trackers/stateLook';
import { type ReferenceCommentActions, type ReferenceThreadActions, type ScopedCommentActions } from './ReferenceComments';
import { ReferenceCommentsSection, type CommentAttachments } from './ReferenceCommentsSection';
import { commentDraftScope } from './referenceCommentDrafts';
import { useRepositoryReadContext } from './referenceSources';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { buildReferenceTimeline, type ReferenceCommentItem, type ReferenceTimelineEntry } from './referenceTimeline';
import { ChecksGlyph, DiscussionCategory, ReferenceLabelChips } from './ReferencePickerRow';
import { PullStackRows } from './PullStackRows';
import { useReferenceImagePreview } from './useReferenceImagePreview';
import { useCopyReferenceLink } from './useCopyReferenceLink';
import { LoadError, MetaRow, ReferenceAssigneesRow } from './ReferenceMetaEditors';
import {
    repositoryStateLook,
    labelColor,
    newerTrackerRead,
    REFERENCE_META_TEXT,
    relativeTimeOf,
    type ReferencePickerItem,
    referenceNumberLabel,
    TRACKER_PRIORITY_KEYS,
} from './referencePickerItems';
import { joinProjectPath } from '@/lib/source-control/projectPath';
import { DiffCount } from '@/components/ui/diff-count';
import { forgetReferenceTextDraft, referenceTextDraft, referenceTextDraftKey, rememberReferenceTextDraft } from './referenceTextDrafts';

export type ReferencePreviewPurpose = 'attach' | 'worktree';

const MARKDOWN_CLASS = '[&_img]:max-w-full [&_img]:h-auto';
const ZOOMABLE_IMAGE_CLASS = '[&_[data-markdown-content]_img:not(a_img):not([aria-hidden=true])]:cursor-zoom-in';

const PreviewFrame: React.FC<{ pinned: boolean; header: React.ReactNode; meta: React.ReactNode; footer: React.ReactNode; children: React.ReactNode }> = ({ pinned, header, meta, footer, children }) => {
    const imagePreview = useReferenceImagePreview();
    if (!pinned) {
        return (
            <article className={cn('flex flex-col gap-4', ZOOMABLE_IMAGE_CLASS)} onClick={imagePreview.onClick}>
                <header className="flex flex-col gap-2">{header}</header>
                <div className="border-b border-edge pb-4">{meta}</div>
                {children}
                <div className="rounded-lg border border-edge px-3 py-2.5">{footer}</div>
                {imagePreview.viewer}
            </article>
        );
    }
    return (
        <div className="flex h-full min-h-0 flex-col">
            <div className="shrink-0 border-b border-edge px-6 pb-4 pt-5">
                <header className="flex flex-col gap-2">{header}</header>
            </div>
            <ScrollableOverlay outerClassName="min-h-0 flex-1" className="px-6 pb-5 pt-4" disableHorizontal>
                <article className={cn('flex flex-col gap-4', ZOOMABLE_IMAGE_CLASS)} onClick={imagePreview.onClick}>
                    <div className="border-b border-edge pb-4">{meta}</div>
                    {children}
                </article>
            </ScrollableOverlay>
            <div className="shrink-0 border-t border-edge px-6 py-3">{footer}</div>
            {imagePreview.viewer}
        </div>
    );
};

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

const ChecksSummaryText: React.FC<{ checks: CISummary }> = ({ checks }) => {
    const { t } = useI18n();
    if (checks.state === 'failure') return <>{t('references.picker.preview.checksFailed', { failed: checks.failure, total: checks.total })}</>;
    if (checks.state === 'pending') return <>{t('references.picker.preview.checksPending', { pending: checks.pending, total: checks.total })}</>;
    if (checks.state === 'success') return <>{t('references.picker.preview.checksPassed')}</>;
    return null;
};

export const ChecksSummaryLine: React.FC<{ checks: CISummary }> = ({ checks }) => (
    <>
        <ChecksGlyph checks={checks} />
        <ChecksSummaryText checks={checks} />
    </>
);

const SENDS_KEYS = {
    issue: 'references.picker.preview.sends.issue',
    pull: 'references.picker.preview.sends.pull',
    discussion: 'references.picker.preview.sends.discussion',
} as const satisfies Record<RepositoryReference['kind'], I18nKey>;
const WORKTREE_KEYS = {
    issue: 'references.picker.preview.worktree.issue',
    pull: 'references.picker.preview.worktree.pull',
    discussion: 'references.picker.preview.worktree.discussion',
} as const satisfies Record<RepositoryReference['kind'], I18nKey>;

const REVIEW_KEYS = {
    approved: 'references.picker.preview.review.approved',
    changes_requested: 'references.picker.preview.review.changesRequested',
    review_required: 'references.picker.preview.review.required',
} as const;

const Pending = () => <Icon name="loader-4" className="size-3.5 animate-spin text-muted-foreground" />;

const REVISION_KIND_KEYS = {
    rework: 'references.picker.preview.revision.kind.rework',
    'trivial-rebase': 'references.picker.preview.revision.kind.trivialRebase',
    'merge-first-parent-update': 'references.picker.preview.revision.kind.mergeUpdate',
    'no-code-change': 'references.picker.preview.revision.kind.noCodeChange',
    'no-change': 'references.picker.preview.revision.kind.noChange',
} as const satisfies Record<ChangeRequestRevisionKind, I18nKey>;

export type RevisionChoice = {
    revisions: ChangeRequestRevision[];
    selected: string | null;
    onSelect: (sha: string | null) => void;
};

const RevisionPicker: React.FC<{ choice: RevisionChoice }> = ({ choice }) => {
    const { t } = useI18n();
    const latest = choice.revisions.at(-1);
    if (!latest || choice.revisions.length < 2) return null;
    const shown = choice.revisions.find((revision) => revision.sha === choice.selected) ?? latest;
    const labelOf = (revision: ChangeRequestRevision) => (revision === latest
        ? t('references.picker.preview.revision.latest', { number: revision.number })
        : t('references.picker.preview.revision.number', { number: revision.number }));
    return (
        <DropdownMenu>
            <Tooltip>
                <TooltipTrigger asChild>
                    <DropdownMenuTrigger asChild>
                        <button
                            type="button"
                            className={cn(dropdownTriggerVariants(), 'min-w-0 max-w-[14rem] font-normal')}
                            aria-label={t('references.picker.preview.revision.label')}
                        >
                            <span className="truncate">{labelOf(shown)}</span>
                            <Icon name="arrow-down-s" className="size-3.5" />
                        </button>
                    </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent sideOffset={6}>{t('contextTooltips.tracker.choosePatchset')}</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="start" className="w-64">
                <DropdownMenuRadioGroup
                    value={shown.sha}
                    onValueChange={(value) => choice.onSelect(value === latest.sha ? null : String(value))}
                >
                    {[...choice.revisions].reverse().map((revision) => (
                        <DropdownMenuRadioItem key={revision.sha} value={revision.sha}>
                            <span className="min-w-0 flex-1 truncate">{labelOf(revision)}</span>
                            {revision.kind && revision.kind !== 'rework' ? (
                                <span className={cn('shrink-0 typography-meta', REFERENCE_META_TEXT)}>{t(REVISION_KIND_KEYS[revision.kind])}</span>
                            ) : null}
                        </DropdownMenuRadioItem>
                    ))}
                </DropdownMenuRadioGroup>
            </DropdownMenuContent>
        </DropdownMenu>
    );
};

const ChangeFlags: React.FC<{ reference: RepositoryReference }> = ({ reference }) => {
    const { t } = useI18n();
    if (reference.kind !== 'pull') return null;
    const flags = [
        reference.workInProgress && !reference.draft ? t('references.picker.preview.wip') : null,
        reference.private ? t('references.picker.preview.private') : null,
    ].filter((flag): flag is string => flag !== null);
    if (flags.length === 0 && !reference.topic) return null;
    return (
        <span className="flex min-w-0 flex-wrap items-center gap-1.5">
            {flags.map((flag) => (
                <span key={flag} className="inline-flex h-5 shrink-0 items-center rounded-full bg-surface-muted px-2 typography-micro text-muted-foreground">{flag}</span>
            ))}
            {reference.topic ? (
                <span className={cn('min-w-0 truncate typography-meta', REFERENCE_META_TEXT)} title={reference.topic}>
                    {t('references.picker.preview.topic', { topic: reference.topic })}
                </span>
            ) : null}
        </span>
    );
};

const ReferenceBody: React.FC<{ content: string }> = ({ content }) => {
    const rewrite = React.useContext(ReferenceMarkdownRewriteContext);
    const links = React.useContext(ReferenceLinksContext);
    const shown = React.useMemo(() => (rewrite ? rewrite(content) : content), [content, rewrite]);
    const emojiShortcodes = useEmojiShortcodes(shown);
    return (
        <SimpleMarkdownRenderer
            content={shown}
            className={MARKDOWN_CLASS}
            enableFileReferences={false}
            allowRawHtml
            singleTilde
            repositoryLinks={links.repository}
            emojiShortcodes={emojiShortcodes}
            directory={links.directory}
        />
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

const PullDetailRows: React.FC<{
    detail: CachedValue<RepositoryReferenceDetail>;
    checks: CachedValue<CISummary | null>;
    links?: React.ReactNode;
    onOpenChecks?: () => void;
    revisionChoice?: RevisionChoice;
}> = ({ detail, checks, links, onOpenChecks, revisionChoice }) => {
    const { t } = useI18n();
    const pull = detail.status === 'ready' ? detail.value.pull : null;
    return (
        <>
            <MetaRow label={t('references.picker.preview.changes')}>
                <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    {revisionChoice ? <RevisionPicker choice={revisionChoice} /> : null}
                    {detail.status === 'error' ? <LoadError error={detail.error} /> : pull ? (
                        <span className="inline-flex items-center gap-2">
                            <DiffCount added={pull.additions} removed={pull.deletions} />
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
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <Button
                                        variant="ghost"
                                        size="xs"
                                        onClick={onOpenChecks}
                                        className="-ms-1.5 gap-1.5 px-1.5 typography-meta font-normal normal-case text-muted-foreground"
                                    >
                                        <ChecksSummaryLine checks={checks.value} />
                                        <Icon name="arrow-right-s" className="size-3.5 opacity-60" />
                                    </Button>
                                </TooltipTrigger>
                                <TooltipContent sideOffset={6}>{t('contextTooltips.tracker.showChecks')}</TooltipContent>
                            </Tooltip>
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

const CopyReferenceLinkButton: React.FC<{ url: string; className?: string }> = ({ url, className }) => {
    const { t } = useI18n();
    const copyLink = useCopyReferenceLink();
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <button
                    type="button"
                    className={cn('inline-flex size-6 shrink-0 items-center justify-center rounded-md hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', REFERENCE_META_TEXT, className)}
                    aria-label={t('references.link.copy')}
                    onClick={() => copyLink(url)}
                >
                    <Icon name="link" className="size-3.5" />
                </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>{t('references.link.copy')}</TooltipContent>
        </Tooltip>
    );
};

const NO_CHECKS: CachedValue<CISummary | null> = { status: 'ready', value: null };

const previewChecks = (
    reference: RepositoryReference,
    pullStatus: CachedValue<ChangeRequestListStatus | null>,
    detail: CachedValue<RepositoryReferenceDetail>,
): CachedValue<CISummary | null> => {
    if (reference.kind !== 'pull' || reference.state !== 'open') return NO_CHECKS;
    if (pullStatus.status === 'ready' && pullStatus.value?.checks) return { status: 'ready', value: pullStatus.value.checks };
    return mapDetail(detail, (value) => value.pull?.checks ?? null);
};

const RepositoryPreview: React.FC<{
    reference: RepositoryReference;
    pullStatus: CachedValue<ChangeRequestListStatus | null>;
    detail: CachedValue<RepositoryReferenceDetail>;
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
    assigneesControl?: React.ReactNode;
    onOpenChecks?: () => void;
    commentAttachments?: CommentAttachments;
    stateMenu?: React.ReactNode;
    onRefresh?: () => Promise<void>;
    threadActions?: ReferenceThreadActions;
    onOpenStackLayer?: (layer: PullRequestStackLayer) => void;
    revisionChoice?: RevisionChoice;
    onSaveText?: (input: { title: string; body: string }) => Promise<void>;
    commentActions?: ScopedCommentActions;
}> = ({ reference, pullStatus, detail, purpose, pinned, includeDiff, onIncludeDiffChange, now, footer: footerOverride, pullLinks, reply, labelsControl, reviewersControl, assigneesControl, onOpenChecks, commentAttachments, stateMenu, onRefresh, threadActions, onOpenStackLayer, revisionChoice, onSaveText, commentActions }) => {
    const { t } = useI18n();
    const { broken: authorBroken, onError } = useAvatarImage(reference.author?.avatarUrl);
    const comments = React.useMemo(() => {
        const commentItem = (comment: RepositoryReferenceComment, key: string): ReferenceCommentItem => {
            const location = comment.path ? `${comment.path}${comment.line ? `:${comment.line}` : ''}` : null;
            const item: ReferenceCommentItem = {
                kind: 'comment',
                key,
                author: comment.author?.login ?? null,
                avatarUrl: comment.author?.avatarUrl ?? null,
                body: comment.body,
                createdAt: comment.createdAt,
                context: location ?? (comment.review && comment.review !== 'commented' ? t(REVIEW_VERDICT_KEYS[comment.review]) : null),
                location,
            };
            if (comment.id !== undefined) item.id = comment.id;
            if (comment.canUpdate !== undefined) item.canUpdate = comment.canUpdate;
            if (comment.canDelete !== undefined) item.canDelete = comment.canDelete;
            if (comment.answer) item.answer = comment.answer;
            if (comment.excerpt) item.excerpt = comment.excerpt;
            if (comment.thread) {
                item.thread = {
                    id: comment.thread.id,
                    resolved: comment.thread.resolved,
                    canResolve: comment.thread.canResolve,
                    canReply: comment.thread.canReply,
                    replies: comment.thread.replies.map((reply, index) => ({ ...commentItem(reply, `${key}/${index}`), context: null })),
                };
            }
            return item;
        };
        return mapDetail(detail, (value) => buildReferenceTimeline(value.comments.map((comment, index) => commentItem(comment, `${comment.url}#${index}`)), (value.pull?.commits ?? []).map((commit) => ({
            sha: commit.sha,
            headline: commit.headline,
            author: commit.author?.login ?? commit.authorName,
            avatarUrl: commit.author?.avatarUrl ?? null,
            committedAt: commit.committedAt,
            url: commit.url,
        })), value.references ?? []));
    }, [detail, t]);
    const relative = useRelative(now);
    const descriptor = useSourceControlProvider(reference.provider);
    const look = repositoryStateLook(reference, pullStatus.status === 'ready' ? pullStatus.value : null);
    const labels = reference.labels.map((label) => ({ name: label.name, color: labelColor(label.color) }));
    const assignees = reference.kind === 'issue' && detail.status === 'ready' ? detail.value.assignees : undefined;
    const showsAssignees = reference.kind === 'issue' && (detail.status === 'ready'
        ? assignees !== undefined && (Boolean(assigneesControl) || assignees.length > 0)
        : detail.status !== 'error' && Boolean(assigneesControl));
    const updated = relative(reference.updatedAt);
    const body = reference.body.trim() ? reference.body : '';
    const stack = reference.kind === 'pull' && detail.status === 'ready' ? detail.value.pull?.stack ?? null : null;
    const numberLabel = (number: number) => referenceNumberLabel({ ...reference, number }, descriptor);
    const stackPosition = stack ? stack.layers.findIndex((layer) => layer.number === reference.number) + 1 : 0;

    const draftKey = referenceTextDraftKey(reference);
    const currentDraftKey = React.useRef(draftKey);
    currentDraftKey.current = draftKey;
    const [openEditor, setOpenEditor] = React.useState<{ key: string; title: string; body: string } | null>(null);
    const editing = openEditor?.key === draftKey ? openEditor : null;
    const [savingKeys, setSavingKeys] = React.useState<ReadonlySet<string>>(() => new Set());
    const savingRef = React.useRef(new Set<string>());
    const saving = savingKeys.has(draftKey);
    const titleInput = React.useRef<HTMLInputElement>(null);
    const editButton = React.useRef<HTMLButtonElement>(null);
    const focusEditButton = () => { requestAnimationFrame(() => editButton.current?.focus()); };
    const isEditing = editing !== null;
    const editDraft = (next: { title: string; body: string }) => {
        rememberReferenceTextDraft(draftKey, next);
        setOpenEditor({ key: draftKey, ...next });
    };
    const markSaving = (key: string, on: boolean) => {
        if (on) savingRef.current.add(key);
        else savingRef.current.delete(key);
        setSavingKeys(new Set(savingRef.current));
    };
    const detailBody = detail.status === 'ready' ? detail.value.body : undefined;
    const storedBody = detailBody ?? reference.body;
    const canEditText = onSaveText !== undefined
        && reference.linked !== true
        && !(reference.bodyTruncated && detailBody === undefined)
        && (detail.status !== 'ready' || detail.value.viewerCanUpdate !== false)
        && (reference.kind === 'pull'
            ? descriptor.features.changeRequestEdit
            : reference.kind === 'discussion'
                ? descriptor.features.discussions
                : descriptor.features.issueEdit);
    const showEdit = canEditText && !isEditing;
    const trimmedTitle = editing?.title.trim() ?? '';
    const changed = editing !== null && (trimmedTitle !== reference.title || editing.body !== storedBody);
    const canSave = changed && trimmedTitle.length > 0 && !saving;
    React.useEffect(() => {
        if (!isEditing) return;
        const input = titleInput.current;
        if (!input) return;
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
    }, [isEditing]);
    const closeEditor = (key: string) => {
        setOpenEditor((current) => (current?.key === key ? null : current));
        if (currentDraftKey.current === key) focusEditButton();
    };
    const cancelEditing = () => {
        if (savingRef.current.has(draftKey)) return;
        forgetReferenceTextDraft(draftKey);
        closeEditor(draftKey);
    };
    const saveText = async () => {
        if (!editing || !canSave || !onSaveText || savingRef.current.has(draftKey)) return;
        const key = draftKey;
        const save = onSaveText;
        const input = { title: trimmedTitle, body: editing.body };
        markSaving(key, true);
        try {
            await save(input);
            forgetReferenceTextDraft(key);
            closeEditor(key);
        } catch (error) {
            toast.error(t('sourceBoard.edit.saveFailed'), { description: error instanceof Error ? error.message : String(error) });
        } finally {
            markSaving(key, false);
        }
    };
    const onEditorKeyDown = (event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        event.stopPropagation();
        if (isIMECompositionEvent(event)) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            cancelEditing();
        } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void saveText();
        } else if (event.key === 'Enter' && event.currentTarget instanceof HTMLInputElement) {
            event.preventDefault();
            void saveText();
        }
    };

    const footer = footerOverride ?? (
        <div className="flex flex-col gap-2">
            <p className="typography-meta text-muted-foreground">
                {t((purpose === 'worktree' ? WORKTREE_KEYS : SENDS_KEYS)[reference.kind])}
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
        <PreviewFrame
            pinned={pinned}
            footer={footer}
            header={
                <>
                    <div className="flex items-center gap-2">
                        {stateMenu ? (
                            <DropdownMenu>
                                <Tooltip>
                                    <TooltipTrigger asChild>
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
                                    </TooltipTrigger>
                                    <TooltipContent side="bottom" sideOffset={6}>{t('contextTooltips.tracker.changeState')}</TooltipContent>
                                </Tooltip>
                                <DropdownMenuContent align="start" className="w-56">{stateMenu}</DropdownMenuContent>
                            </DropdownMenu>
                        ) : (
                            <StatePill icon={look.icon} color={look.color} label={t(look.labelKey)} />
                        )}
                        <span className={cn('truncate typography-meta', REFERENCE_META_TEXT)}>
                            {joinProjectPath(reference.sourceRepo.owner, reference.sourceRepo.repo)} {referenceNumberLabel(reference, descriptor)}
                        </span>
                        {showEdit ? (
                            <ButtonTooltip label={t('sourceBoard.edit.action')} side="bottom" className="ms-auto shrink-0">
                                <button
                                    ref={editButton}
                                    type="button"
                                    className={cn('inline-flex size-6 shrink-0 items-center justify-center rounded-md hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none', REFERENCE_META_TEXT)}
                                    aria-label={t('sourceBoard.edit.action')}
                                    onClick={() => setOpenEditor({ key: draftKey, ...(referenceTextDraft(draftKey) ?? { title: reference.title, body: storedBody }) })}
                                >
                                    <Icon name="pencil" className="size-3.5" />
                                </button>
                            </ButtonTooltip>
                        ) : null}
                        {onRefresh ? <PreviewRefreshButton onRefresh={onRefresh} className={showEdit ? undefined : 'ms-auto'} /> : null}
                        <CopyReferenceLinkButton url={reference.url} className={onRefresh || showEdit ? undefined : 'ms-auto'} />
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <a
                                    href={reference.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className={cn('inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 typography-meta hover:bg-interactive-hover hover:text-foreground', REFERENCE_META_TEXT)}
                                >
                                    {descriptor.label}
                                    <Icon name="external-link" className="size-3.5" />
                                </a>
                            </TooltipTrigger>
                            <TooltipContent side="bottom" sideOffset={6}>{t('contextTooltips.tracker.openOnHost', { host: descriptor.label })}</TooltipContent>
                        </Tooltip>
                    </div>
                    {editing ? (
                        <div className="flex min-w-0 flex-1 items-center gap-2">
                            <Input
                                ref={titleInput}
                                dir="auto"
                                inputSize="compact"
                                value={editing.title}
                                onChange={(event) => {
                                    if (!editing) return;
                                    editDraft({ title: event.target.value, body: editing.body });
                                }}
                                onKeyDown={onEditorKeyDown}
                                aria-label={t('sourceBoard.edit.title')}
                                placeholder={t('sourceBoard.edit.title')}
                                disabled={saving}
                            />
                            <Button size="sm" onClick={() => void saveText()} disabled={!canSave}>
                                {saving ? <Icon name="loader-4" className="size-3.5 animate-spin" /> : null}
                                {t('sourceBoard.edit.save')}
                            </Button>
                            <Button size="sm" variant="ghost" onClick={cancelEditing} disabled={saving}>
                                {t('sourceBoard.edit.cancel')}
                            </Button>
                        </div>
                    ) : (
                        <h3 dir="auto" className="typography-ui-header font-semibold break-words text-foreground">{reference.title}</h3>
                    )}
                    <ChangeFlags reference={reference} />
                </>
            }
            meta={
                <dl className="grid grid-cols-[max-content_minmax(0,1fr)] items-center gap-x-4 gap-y-1.5">
                    {reference.author ? (
                        <MetaRow label={t('references.picker.preview.author')}>
                            <span className="inline-flex items-center gap-1.5">
                                {reference.author.avatarUrl && !authorBroken ? (
                                    <img src={reference.author.avatarUrl} alt="" className="size-4 rounded-full" loading="lazy" onError={onError} />
                                ) : reference.author.avatarUrl ? (
                                    <span className="flex size-4 items-center justify-center rounded-full bg-surface-muted text-[0.625rem] leading-none">
                                        {reference.author.login.slice(0, 1).toUpperCase()}
                                    </span>
                                ) : null}
                                {reference.author.login}
                            </span>
                        </MetaRow>
                    ) : null}
                    {updated ? <MetaRow label={t('references.picker.preview.updated')}>{updated}</MetaRow> : null}
                    {reference.kind === 'discussion' ? (
                        <>
                            <MetaRow label={t('references.picker.preview.category')}><DiscussionCategory category={reference.category} /></MetaRow>
                            {reference.category.answerable ? (
                                <MetaRow label={t('references.picker.preview.answer')}>
                                    {reference.answered ? (
                                        <span className="inline-flex items-center gap-1">
                                            <Icon name="checkbox-circle" className="size-3.5 text-[var(--status-success)]" />
                                            {t('references.picker.state.answered')}
                                        </span>
                                    ) : t('references.picker.discussion.unanswered')}
                                </MetaRow>
                            ) : null}
                            {reference.upvotes > 0 ? (
                                <MetaRow label={t('references.picker.preview.upvotes')}>
                                    <span className="tabular-nums">{reference.upvotes}</span>
                                </MetaRow>
                            ) : null}
                            {reference.locked ? (
                                <MetaRow label={t('references.picker.preview.locked')}>{t('references.picker.discussion.lockedNote')}</MetaRow>
                            ) : null}
                        </>
                    ) : null}
                    {reference.kind === 'pull' ? (
                        <>
                            <MetaRow label={t('references.picker.preview.branch')}>
                                {descriptor.features.branchHeads ? (
                                    <span className="inline-flex max-w-full items-center gap-1 font-mono">
                                        <span className="truncate">{reference.head}</span>
                                        <Icon name="arrow-right" className="size-3 shrink-0 text-muted-foreground" />
                                        <span className="truncate">{reference.base}</span>
                                    </span>
                                ) : (
                                    <span className="block truncate font-mono">{reference.base}</span>
                                )}
                            </MetaRow>
                            <PullDetailRows
                                detail={detail}
                                checks={previewChecks(reference, pullStatus, detail)}
                                links={pullLinks}
                                onOpenChecks={onOpenChecks}
                                revisionChoice={descriptor.features.revisions ? revisionChoice : undefined}
                            />
                        </>
                    ) : null}
                    {reviewersControl && reference.kind === 'pull' ? (
                        <MetaRow label={t('references.picker.preview.reviewers')}>{reviewersControl}</MetaRow>
                    ) : null}
                    {showsAssignees ? (
                        <ReferenceAssigneesRow control={assigneesControl} assignees={assignees ?? []} />
                    ) : null}
                    {labelsControl ? (
                        <MetaRow label={t('references.picker.preview.labels')}>{labelsControl}</MetaRow>
                    ) : labels.length > 0 ? (
                        <MetaRow label={t('references.picker.preview.labels')}><ReferenceLabelChips labels={labels} /></MetaRow>
                    ) : null}
                </dl>
            }
        >
            {stack ? (
                <section className="flex flex-col gap-2 border-b border-edge pb-4">
                    <h4 className="flex items-center gap-2 typography-ui-label font-semibold text-foreground">
                        {t('stacks.preview.label')}
                        {stackPosition > 0 ? (
                            <span className={cn('typography-meta font-normal tabular-nums', REFERENCE_META_TEXT)}>
                                {t('stacks.preview.position', { position: stackPosition, size: stack.layers.length })}
                            </span>
                        ) : null}
                        {stack.number !== null && stack.layers.filter((layer) => layer.state === 'open').length > 1 ? (
                            <a
                                href={reference.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className={cn('ms-auto inline-flex items-center gap-1 typography-meta font-normal hover:text-foreground', REFERENCE_META_TEXT)}
                            >
                                {t('stacks.preview.rebaseOnHost')}
                                <Icon name="external-link" className="size-3.5" />
                            </a>
                        ) : null}
                    </h4>
                    <PullStackRows stack={stack} current={reference.number} numberLabel={numberLabel} currentLook={look} onOpen={onOpenStackLayer} />
                </section>
            ) : null}

            <div className="min-w-0 flex-1">
                {editing ? (
                    <>
                        <ReferenceMarkdownEditor
                            value={editing.body}
                            onChange={(text) => {
                                if (!editing) return;
                                editDraft({ title: editing.title, body: text });
                            }}
                            onSubmit={() => void saveText()}
                            onCancel={cancelEditing}
                            placeholder={t('sourceBoard.edit.body')}
                            disabled={saving}
                            maxLines={8}
                            aria-label={t('sourceBoard.edit.body')}
                        />
                        {}
                        <div className="mt-2 hidden items-center gap-2 pointer-coarse:flex">
                            <Button size="sm" onClick={() => void saveText()} disabled={!canSave}>
                                {saving ? <Icon name="loader-4" className="size-3.5 animate-spin" /> : null}
                                {t('sourceBoard.edit.save')}
                            </Button>
                            <Button size="sm" variant="ghost" onClick={cancelEditing} disabled={saving}>
                                {t('sourceBoard.edit.cancel')}
                            </Button>
                        </div>
                    </>
                ) : body ? (
                    <ReferenceBody content={body} />
                ) : (
                    <p className="typography-meta text-muted-foreground">{t('references.picker.preview.noDescription')}</p>
                )}
                {reference.bodyTruncated ? (
                    <p className="mt-3 typography-meta text-muted-foreground">{t('references.picker.preview.truncated')}</p>
                ) : null}
            </div>

            <ReferenceCommentsSection key={draftKey} state={comments} total={detail.status === 'ready' ? detail.value.commentTotal : null} activity={reference.kind === 'pull'} now={now} attachments={commentAttachments} threadActions={threadActions} commentActions={commentActions} />
            {reply}
        </PreviewFrame>
    );
};

const RelatedTrackerItem: React.FC<{
    issue: TrackerItemSummary;
    onOpen?: (issue: TrackerItemSummary) => void;
    showAssignee?: boolean;
}> = ({ issue, onOpen, showAssignee = false }) => {
    const look = trackerStateGlyph(issue.state?.category);
    const assignee = issue.assignee?.name;
    const content = (
        <>
            <Icon name={look.icon} className="size-3.5 shrink-0" style={{ color: look.color }} />
            <span className={cn('shrink-0 font-mono', REFERENCE_META_TEXT)}>{issue.identifier}</span>
            <span dir="auto" className="min-w-0 truncate">{issue.title}</span>
            {showAssignee && assignee ? (
                <span className={cn('ms-auto shrink-0 ps-2', REFERENCE_META_TEXT)}>{assignee}</span>
            ) : null}
        </>
    );
    const className = 'flex w-full min-w-0 items-center gap-1.5 text-start typography-meta';
    if (!onOpen) return <span className={cn(className, 'text-muted-foreground')}>{content}</span>;
    return (
        <button
            type="button"
            onClick={() => onOpen(issue)}
            title={issue.title}
            className={cn(className, 'rounded-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring')}
        >
            {content}
        </button>
    );
};

const SubIssuesSection: React.FC<{
    issue: TrackerItem;
    onOpen?: (issue: TrackerItemSummary) => void;
}> = ({ issue, onOpen }) => {
    const { t } = useI18n();
    const subIssues = issue.children ?? [];
    if (subIssues.length === 0) return null;
    const done = subIssues.filter((sub) => isSettledTrackerState(sub.state?.category)).length;
    return (
        <section className="flex flex-col gap-2 border-t border-edge pt-4">
            <h4 className="flex items-center gap-2 typography-ui-label font-semibold text-foreground">
                {t('references.picker.preview.subIssues')}
                {issue.childrenMore ? null : (
                    <span className={cn('typography-meta font-normal tabular-nums', REFERENCE_META_TEXT)}>{done}/{subIssues.length}</span>
                )}
            </h4>
            <ul className="flex flex-col gap-1.5">
                {subIssues.map((sub) => (
                    <li key={sub.id}><RelatedTrackerItem issue={sub} onOpen={onOpen} showAssignee /></li>
                ))}
            </ul>
            {issue.childrenMore ? (
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

const TrackerPreview: React.FC<{
    issue: TrackerItemSummary;
    detail: CachedValue<TrackerItem>;
    purpose: ReferencePreviewPurpose;
    pinned: boolean;
    now: number;
    footer?: React.ReactNode;
    stateControl?: React.ReactNode;
    onOpenIssue?: (issue: TrackerItemSummary) => void;
    onRefresh?: () => Promise<void>;
}> = ({ issue: listed, detail, purpose, pinned, now, footer: footerOverride, stateControl, onOpenIssue, onRefresh }) => {
    const { t } = useI18n();
    const relative = useRelative(now);
    const full = detail.status === 'ready' && detail.value.id === listed.id ? detail.value : null;
    const issue = newerTrackerRead(listed, full);
    const descriptor = useTrackerDescriptor(issue.provider);
    const { capabilities } = descriptor;
    const look = trackerStateGlyph(issue.state?.category);
    const labels = capabilities.labels
        ? (issue.labels ?? full?.labels ?? listed.labels ?? []).map((label) => ({ name: label.name, color: labelColor(label.color) }))
        : [];
    const parent = capabilities.children ? issue.parent ?? full?.parent ?? listed.parent ?? null : null;
    const updated = relative(issue.updatedAt);
    const assignee = issue.assignee?.name;
    const comments = React.useMemo(
        () => mapDetail(detail, (value) => (value.comments ?? []).map((comment): ReferenceTimelineEntry => ({
            kind: 'comment',
            key: comment.id,
            author: comment.author?.name ?? null,
            avatarUrl: comment.author?.avatarUrl ?? null,
            body: foldTrackerCollapsibles(comment.body),
            createdAt: comment.createdAt,
            context: null,
            location: null,
        }))),
        [detail],
    );

    const footer = footerOverride ?? (
        <p className="typography-meta text-muted-foreground">
            {purpose === 'worktree' ? t('references.picker.preview.worktree.issue') : t('references.picker.preview.sends.tracker')}
        </p>
    );

    return (
        <PreviewFrame
            pinned={pinned}
            footer={footer}
            header={
                <>
                    <div className="flex items-center gap-2">
                        {stateControl ?? (issue.state?.name ? <StatePill icon={look.icon} color={look.color} label={issue.state.name} /> : null)}
                        <span className={cn('truncate typography-meta', REFERENCE_META_TEXT)}>{issue.identifier}</span>
                        {onRefresh ? <PreviewRefreshButton onRefresh={onRefresh} className="ms-auto" /> : null}
                        <CopyReferenceLinkButton url={issue.url} className={onRefresh ? undefined : 'ms-auto'} />
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <a
                                    href={issue.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className={cn('inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 typography-meta hover:bg-interactive-hover hover:text-foreground', REFERENCE_META_TEXT)}
                                >
                                    {descriptor.name}
                                    <Icon name="external-link" className="size-3.5" />
                                </a>
                            </TooltipTrigger>
                            <TooltipContent side="bottom" sideOffset={6}>{t('contextTooltips.tracker.openOnHost', { host: descriptor.name })}</TooltipContent>
                        </Tooltip>
                    </div>
                    <h3 dir="auto" className="typography-ui-header font-semibold break-words text-foreground">{issue.title}</h3>
                </>
            }
            meta={
                <dl className="grid grid-cols-[max-content_minmax(0,1fr)] items-center gap-x-4 gap-y-1.5">
                    {parent ? (
                        <MetaRow label={t('references.picker.preview.parent')}>
                            <RelatedTrackerItem issue={parent} onOpen={onOpenIssue} />
                        </MetaRow>
                    ) : null}
                    {assignee ? <MetaRow label={t('references.picker.preview.assignee')}>{assignee}</MetaRow> : null}
                    {issue.container ? <MetaRow label={t(trackerPresentation(issue.provider).copy.containerMeta)}>{issue.container.name}</MetaRow> : null}
                    {capabilities.priority && issue.priority && issue.priority !== 'none' ? (
                        <MetaRow label={t('references.picker.preview.priority')}>{t(TRACKER_PRIORITY_KEYS[issue.priority])}</MetaRow>
                    ) : null}
                    {updated ? <MetaRow label={t('references.picker.preview.updated')}>{updated}</MetaRow> : null}
                    {labels.length > 0 ? (
                        <MetaRow label={t('references.picker.preview.labels')}><ReferenceLabelChips labels={labels} /></MetaRow>
                    ) : null}
                </dl>
            }
        >
            <div className="min-w-0 flex-1">
                {detail.status === 'loading' || detail.status === 'idle' ? (
                    <p className="inline-flex items-center gap-2 typography-meta text-muted-foreground">
                        <Icon name="loader-4" className="size-3.5 animate-spin" />
                        {t('references.picker.loading')}
                    </p>
                ) : detail.status === 'error' ? (
                    <p className="typography-meta text-[var(--status-error-text)]">{t('references.picker.error.load', { error: detail.error })}</p>
                ) : full?.description?.trim() ? (
                    <ReferenceBody content={foldTrackerCollapsibles(full.description)} />
                ) : (
                    <p className="typography-meta text-muted-foreground">{t('references.picker.preview.noDescription')}</p>
                )}
            </div>

            {full && capabilities.children ? <SubIssuesSection issue={full} onOpen={onOpenIssue} /> : null}
            {detail.status === 'ready' ? <ReferenceCommentsSection state={comments} total={null} now={now} /> : null}
        </PreviewFrame>
    );
};

export const ReferencePreview: React.FC<{
    item: ReferencePickerItem | null;
    directory: string | null;
    pullStatus: CachedValue<ChangeRequestListStatus | null>;
    trackerDetail: CachedValue<TrackerItem>;
    repositoryDetail: CachedValue<RepositoryReferenceDetail>;
    purpose: ReferencePreviewPurpose;
    pinned: boolean;
    includeDiff: boolean;
    onIncludeDiffChange: (include: boolean) => void;
    now: number;
    footer?: React.ReactNode;
    pullLinks?: React.ReactNode;
    trackerStateControl?: React.ReactNode;
    reply?: React.ReactNode;
    labelsControl?: React.ReactNode;
    reviewersControl?: React.ReactNode;
    assigneesControl?: React.ReactNode;
    onOpenChecks?: () => void;
    commentAttachments?: CommentAttachments;
    stateMenu?: React.ReactNode;
    onOpenTrackerItem?: (item: TrackerItemSummary) => void;
    onRefresh?: () => Promise<void>;
    threadActions?: ReferenceThreadActions;
    commentActions?: ReferenceCommentActions;
    onOpenStackLayer?: (layer: PullRequestStackLayer) => void;
    revisionChoice?: RevisionChoice;
    onSaveText?: (input: { title: string; body: string }) => Promise<void>;
}> = ({ item, directory, pullStatus, trackerDetail, repositoryDetail, purpose, pinned, includeDiff, onIncludeDiffChange, now, footer, pullLinks, trackerStateControl, reply, labelsControl, reviewersControl, assigneesControl, onOpenChecks, commentAttachments, stateMenu, onOpenTrackerItem, onRefresh, threadActions, onOpenStackLayer, revisionChoice, onSaveText, commentActions }) => {
    const { t } = useI18n();
    const reference = item?.source === 'repository' ? item.reference : null;
    const rewriteMarkdown = useProjectUploadRewrite(directory, reference);
    const links = useReferenceLinks(directory, reference);
    const commentWrites = useSourceControlProvider(reference?.provider ?? null).features.commentEdit;
    const readContext = useRepositoryReadContext(reference ? directory : null);
    const commentAccount = readContext && readContext !== 'missing'
        ? [readContext.provider, readContext.instance, readContext.accountId].join('\u0000')
        : '';
    if (!item) {
        return (
            <div className="flex h-full items-center justify-center px-6 text-center typography-meta text-muted-foreground">
                {t('references.picker.preview.empty')}
            </div>
        );
    }
    if (item.source === 'tracker') {
        return <TrackerPreview issue={item.item} detail={trackerDetail} purpose={purpose} pinned={pinned} now={now} footer={footer} stateControl={trackerStateControl} onOpenIssue={onOpenTrackerItem} onRefresh={onRefresh} />;
    }
    return (
        <ReferenceMarkdownRewriteContext.Provider value={rewriteMarkdown}>
            <ReferenceLinksContext.Provider value={links}>
                <RepositoryPreview
                    reference={item.reference}
                    pullStatus={pullStatus}
                    detail={repositoryDetail}
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
                    assigneesControl={assigneesControl}
                    onOpenChecks={onOpenChecks}
                    commentAttachments={commentAttachments}
                    stateMenu={stateMenu}
                    onRefresh={onRefresh}
                    threadActions={threadActions}
                    onOpenStackLayer={onOpenStackLayer}
                    revisionChoice={revisionChoice}
                    onSaveText={onSaveText}
                    commentActions={commentWrites && commentActions ? { ...commentActions, draftScope: commentDraftScope(getRuntimeKey(), directory, commentAccount, item.reference.url) } : undefined}
                />
            </ReferenceLinksContext.Provider>
        </ReferenceMarkdownRewriteContext.Provider>
    );
};
