import * as React from 'react';

import { Icon } from '@/components/icon/Icon';
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { dropdownTriggerVariants } from '@/components/ui/dropdown-trigger';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

import type { CachedValue } from './referenceCache';
import { ReferenceComments, type ReferenceThreadActions, type ScopedCommentActions } from './ReferenceComments';
import { REFERENCE_META_TEXT } from './referencePickerItems';
import {
    countReferenceTimeline,
    filterReferenceTimeline,
    newestFirstTimeline,
    type ReferenceActivityFilter,
    type ReferenceCommentItem,
    type ReferenceTimelineEntry,
} from './referenceTimeline';

export type CommentAttachments = {
    onAttach: (comment: ReferenceCommentItem) => void;
    onAttachAll: (comments: ReferenceCommentItem[]) => void;
};

const ACTIVITY_FILTER_OPTIONS: ReadonlyArray<{
    value: ReferenceActivityFilter;
    labelKey:
        | 'references.picker.preview.activityFilter.all'
        | 'references.picker.preview.activityFilter.comments'
        | 'references.picker.preview.activityFilter.unresolved'
        | 'references.picker.preview.activityFilter.resolved';
}> = [
    { value: 'all', labelKey: 'references.picker.preview.activityFilter.all' },
    { value: 'comments', labelKey: 'references.picker.preview.activityFilter.comments' },
    { value: 'unresolved', labelKey: 'references.picker.preview.activityFilter.unresolved' },
    { value: 'resolved', labelKey: 'references.picker.preview.activityFilter.resolved' },
];

const EMPTY_ENTRIES: ReferenceTimelineEntry[] = [];

const EMPTY_FILTER_KEYS = {
    comments: 'references.picker.preview.activityFilter.emptyComments',
    unresolved: 'references.picker.preview.activityFilter.emptyUnresolved',
    resolved: 'references.picker.preview.activityFilter.emptyResolved',
} as const;

const isActivityFilter = (value: string): value is ReferenceActivityFilter => (
    value === 'all' || value === 'comments' || value === 'unresolved' || value === 'resolved'
);

const Pending: React.FC = () => (
    <span className="inline-flex items-center text-muted-foreground">
        <Icon name="loader-4" className="size-3.5 animate-spin" />
    </span>
);

export const ReferenceCommentsSection: React.FC<{
    state: CachedValue<ReferenceTimelineEntry[]>;
    total: number | null;
    activity?: boolean;
    now: number;
    attachments?: CommentAttachments;
    threadActions?: ReferenceThreadActions;
    commentActions?: ScopedCommentActions;
    newestFirst?: boolean;
    threadsUnavailable?: boolean;
}> = ({ state, total, activity = false, now, attachments, threadActions, commentActions, newestFirst = false, threadsUnavailable = false }) => {
    const { t } = useI18n();
    const [activeFilter, setActiveFilter] = React.useState<ReferenceActivityFilter>('all');
    const effectiveFilter: ReferenceActivityFilter = activity && !threadsUnavailable ? activeFilter : 'all';

    const allEntries = state.status === 'ready' ? state.value : EMPTY_ENTRIES;
    const counts = React.useMemo(() => countReferenceTimeline(allEntries), [allEntries]);
    const visibleEntries = React.useMemo(
        () => (activity ? filterReferenceTimeline(allEntries, effectiveFilter) : allEntries),
        [activity, allEntries, effectiveFilter],
    );
    const visibleComments = React.useMemo(
        () => visibleEntries.flatMap((entry) => (entry.kind === 'comment' ? [entry, ...(entry.thread?.replies ?? [])] : [])),
        [visibleEntries],
    );
    const shownEntries = React.useMemo(
        () => (newestFirst ? newestFirstTimeline(visibleEntries) : visibleEntries),
        [newestFirst, visibleEntries],
    );

    const activeOption = ACTIVITY_FILTER_OPTIONS.find((option) => option.value === effectiveFilter) ?? ACTIVITY_FILTER_OPTIONS[0];
    const activeCount = effectiveFilter === 'all' ? null : counts[effectiveFilter];
    const triggerLabel = activeCount !== null ? `${t(activeOption.labelKey)} · ${activeCount}` : t(activeOption.labelKey);
    const showFilter = activity && state.status === 'ready' && allEntries.length > 0 && !threadsUnavailable;

    return (
        <section className="flex flex-col gap-3 border-t border-edge pt-4">
            <h4 className="flex flex-wrap items-center gap-2 typography-ui-label font-semibold text-foreground">
                {t(activity ? 'references.picker.preview.activity' : 'references.picker.preview.comments')}
                {showFilter ? (
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <button
                                type="button"
                                className={cn(dropdownTriggerVariants(), 'min-w-0 max-w-[14rem] font-normal')}
                                aria-label={`${t('references.picker.preview.activityFilter.label')}: ${triggerLabel}`}
                            >
                                <span className="truncate">{triggerLabel}</span>
                                <Icon name="arrow-down-s" className="size-3.5" />
                            </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start" className="w-48">
                            <DropdownMenuRadioGroup
                                value={effectiveFilter}
                                onValueChange={(value) => {
                                    if (isActivityFilter(value)) {
                                        setActiveFilter(value);
                                    }
                                }}
                            >
                                {ACTIVITY_FILTER_OPTIONS.map((option) => (
                                    <DropdownMenuRadioItem key={option.value} value={option.value}>
                                        <span className="min-w-0 flex-1 truncate">{t(option.labelKey)}</span>
                                        {option.value !== 'all' ? (
                                            <span className={cn('shrink-0 typography-meta', REFERENCE_META_TEXT)}>
                                                {counts[option.value]}
                                            </span>
                                        ) : null}
                                    </DropdownMenuRadioItem>
                                ))}
                            </DropdownMenuRadioGroup>
                        </DropdownMenuContent>
                    </DropdownMenu>
                ) : null}
                {state.status === 'ready' && total !== null && total > counts.comments ? (
                    <span className={cn('typography-meta font-normal', REFERENCE_META_TEXT)}>
                        {t('references.picker.preview.commentsLatest', { shown: counts.comments, total })}
                    </span>
                ) : null}
                {attachments && visibleComments.length > 0 && state.status === 'ready' ? (
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <button
                                type="button"
                                onClick={() => attachments.onAttachAll(visibleComments)}
                                className={cn('ms-auto inline-flex items-center gap-1 typography-meta font-normal hover:text-foreground', REFERENCE_META_TEXT)}
                            >
                                <Icon name="attachment-2" className="size-3.5" />
                                {t('gitView.pr.comments.addAll')}
                            </button>
                        </TooltipTrigger>
                        <TooltipContent sideOffset={6}>{t('contextTooltips.tracker.attachAllComments')}</TooltipContent>
                    </Tooltip>
                ) : null}
            </h4>
            {threadsUnavailable ? (
                <p className="typography-meta text-muted-foreground">{t('review.threadsUnavailable')}</p>
            ) : null}
            {state.status === 'error' ? (
                <p className="typography-meta text-[var(--status-error-text)]">{t('references.picker.error.load', { error: state.error })}</p>
            ) : state.status !== 'ready' ? (
                <Pending />
            ) : allEntries.length === 0 && !threadsUnavailable ? (
                <p className="typography-meta text-muted-foreground">{t('references.picker.preview.commentsEmpty')}</p>
            ) : visibleEntries.length === 0 && effectiveFilter !== 'all' ? (
                <p className="typography-meta text-muted-foreground">{t(EMPTY_FILTER_KEYS[effectiveFilter])}</p>
            ) : (
                <ReferenceComments entries={shownEntries} now={now} onAttachComment={attachments?.onAttach} threadActions={threadActions} commentActions={commentActions} />
            )}
        </section>
    );
};
