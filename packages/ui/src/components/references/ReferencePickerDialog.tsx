/**
 * The picker for GitHub issues and pull requests, and Linear issues.
 *
 * Desktop shows the list and a preview of the highlighted item side by side,
 * so the user sees what they are about to attach. Mobile shows the list, and
 * a tap on a row opens its preview in place.
 *
 * `selection: 'multiple'` (the composer) checks any number of items, across
 * tabs, and attaches them together. `selection: 'single'` (New Worktree)
 * chooses one. Lists come from the shared reference cache, so switching tabs
 * or reopening the picker shows the last answer at once.
 */

import * as React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { handleDropdownNavigationKey } from '@/components/ui/dropdown-navigation';
import { Input } from '@/components/ui/input';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { SortableTabsStrip } from '@/components/ui/sortable-tabs-strip';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import type { GitHubPullStatus, GitHubReference, GitHubReferenceFilter, GitHubReferenceKind } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';
import { isIMECompositionEvent } from '@/lib/ime';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';

import { ReferencePickerRow } from './ReferencePickerRow';
import { ReferencePreview, type ReferencePreviewPurpose } from './ReferencePreview';
import type { CachedValue } from './referenceCache';
import {
    FILTER_LABEL_KEYS,
    GITHUB_FILTERS,
    LINEAR_FILTERS,
    referencePickerItemKey,
    type LinearReferenceFilter,
    type ReferencePickerItem,
    type ReferencePickerSelection,
    type ReferencePickerSource,
} from './referencePickerItems';
import {
    useGitHubReferenceDetail,
    useGitHubPullStatuses,
    useGitHubReferenceList,
    useGitHubSourceStatus,
    useRepositoryReferenceProvider,
    useLinearIssueDetail,
    useLinearReferenceList,
    useLinearSourceStatus,
} from './referenceSources';

/** A failed confirm: the keys that did not go through stay checked. */
export type ReferencePickerConfirmFailure = { failedKeys: string[]; message: string };

type ReferencePickerDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    source: ReferencePickerSource;
    purpose: ReferencePreviewPurpose;
    selection: 'multiple' | 'single';
    /** The project GitHub items come from. */
    directory: string | null;
    /** Tab to open GitHub on; the last used one otherwise. */
    initialGitHubKind?: GitHubReferenceKind;
    /** Null closes the picker; a failure keeps it open with the message. */
    onConfirm: (selections: ReferencePickerSelection[]) => Promise<ReferencePickerConfirmFailure | null>;
};

// Remembered for the app run: reopening the picker lands where it was left.
let lastGitHubKind: GitHubReferenceKind = 'issue';
const lastGitHubFilter = new Map<GitHubReferenceKind, GitHubReferenceFilter>();
let lastLinearFilter: LinearReferenceFilter = 'open';

const NO_REFERENCES: GitHubReference[] = [];
const IDLE_STATUS: CachedValue<GitHubPullStatus | null> = { status: 'idle' };

const readyValue = <T,>(state: CachedValue<T | null>): T | null => (state.status === 'ready' ? state.value : null);
const SEARCH_DEBOUNCE_MS = 300;
const DETAIL_DEBOUNCE_MS = 250;

export function ReferencePickerDialog(props: ReferencePickerDialogProps) {
    const isMobile = useUIStore((state) => state.isMobile);
    if (!props.open) return null;
    // Remounted per open, so every open starts from the remembered tab and an
    // empty search without effects resetting state after the first paint.
    return <ReferencePickerSurface {...props} isMobile={isMobile} />;
}

function ReferencePickerSurface({
    onOpenChange,
    source,
    purpose,
    selection,
    directory,
    initialGitHubKind,
    onConfirm,
    isMobile,
}: ReferencePickerDialogProps & { isMobile: boolean }) {
    const { t } = useI18n();
    const [githubKind, setGitHubKind] = React.useState<GitHubReferenceKind>(initialGitHubKind ?? lastGitHubKind);
    const [githubFilter, setGitHubFilter] = React.useState<GitHubReferenceFilter>(lastGitHubFilter.get(initialGitHubKind ?? lastGitHubKind) ?? 'open');
    const [linearFilter, setLinearFilter] = React.useState<LinearReferenceFilter>(lastLinearFilter);
    const [query, setQuery] = React.useState('');
    const debouncedQuery = useDebouncedValue(query, SEARCH_DEBOUNCE_MS);
    const [highlightedKey, setHighlightedKey] = React.useState<string | null>(null);
    const [checked, setChecked] = React.useState<ReadonlyMap<string, ReferencePickerItem>>(new Map());
    const [diffIncluded, setDiffIncluded] = React.useState<ReadonlySet<string>>(new Set());
    const [confirming, setConfirming] = React.useState(false);
    const [confirmError, setConfirmError] = React.useState<string | null>(null);
    const [mobilePreviewKey, setMobilePreviewKey] = React.useState<string | null>(null);
    const [now] = React.useState(() => Date.now());
    const searchRef = React.useRef<HTMLInputElement>(null);

    const githubStatus = useGitHubSourceStatus(directory);
    // A GitLab project lists in the same tabs, as merge requests, open items only.
    const isGitLab = useRepositoryReferenceProvider(directory) === 'gitlab';
    const linearStatus = useLinearSourceStatus();
    const sourceStatus = source === 'github' ? githubStatus : linearStatus;

    const githubList = useGitHubReferenceList({
        enabled: source === 'github' && githubStatus === 'ready',
        directory,
        kind: githubKind,
        filter: isGitLab ? 'open' : githubFilter,
        query: debouncedQuery,
    });
    const linearList = useLinearReferenceList({
        enabled: source === 'linear' && linearStatus === 'ready',
        filter: linearFilter,
        query: debouncedQuery,
    });
    // The other GitHub tab loads in the background, so switching to it is instant.
    const otherGitHubKind: GitHubReferenceKind = githubKind === 'issue' ? 'pull' : 'issue';
    useGitHubReferenceList({
        enabled: source === 'github' && githubStatus === 'ready',
        directory,
        kind: otherGitHubKind,
        filter: isGitLab ? 'open' : lastGitHubFilter.get(otherGitHubKind) ?? 'open',
        query: '',
    });
    const list = source === 'github' ? githubList : linearList;
    // Failed checks and conflicts colour open PRs once their statuses arrive.
    const pullStatusOf = useGitHubPullStatuses(directory, source === 'github' ? githubList.items : NO_REFERENCES);

    const items = React.useMemo<ReferencePickerItem[]>(() => (
        source === 'github'
            ? githubList.items.map((reference) => ({ source: 'github', reference }))
            : linearList.items.map((issue) => ({ source: 'linear', issue }))
    ), [githubList.items, linearList.items, source]);

    // The highlight follows the list: the first row until the user moves it,
    // and the first row again when the highlighted one leaves the list.
    const effectiveHighlightKey = highlightedKey && items.some((item) => referencePickerItemKey(item) === highlightedKey)
        ? highlightedKey
        : (items[0] ? referencePickerItemKey(items[0]) : null);
    const highlightedItem = items.find((item) => referencePickerItemKey(item) === effectiveHighlightKey)
        ?? (effectiveHighlightKey ? checked.get(effectiveHighlightKey) ?? null : null);
    const previewKey = isMobile ? mobilePreviewKey : effectiveHighlightKey;
    const previewItem = previewKey
        ? items.find((item) => referencePickerItemKey(item) === previewKey) ?? checked.get(previewKey) ?? null
        : null;

    // Details are asked for the row the highlight rests on, not every row an
    // arrow key passes over; one already fetched shows at once.
    const settledPreviewItem = useDebouncedValue(previewItem, DETAIL_DEBOUNCE_MS);
    const previewSettled = Boolean(settledPreviewItem && previewItem
        && referencePickerItemKey(settledPreviewItem) === referencePickerItemKey(previewItem));
    const { detail: linearDetail } = useLinearIssueDetail(previewItem?.source === 'linear' ? previewItem.issue.id : null, previewSettled);
    const githubDetail = useGitHubReferenceDetail(directory, previewItem?.source === 'github' ? previewItem.reference : null, previewSettled);

    const selectGitHubKind = (kind: GitHubReferenceKind) => {
        lastGitHubKind = kind;
        setGitHubKind(kind);
        setGitHubFilter(lastGitHubFilter.get(kind) ?? 'open');
        setHighlightedKey(null);
    };
    const selectGitHubFilter = (filter: GitHubReferenceFilter) => {
        lastGitHubFilter.set(githubKind, filter);
        setGitHubFilter(filter);
        setHighlightedKey(null);
    };
    const selectLinearFilter = (filter: LinearReferenceFilter) => {
        lastLinearFilter = filter;
        setLinearFilter(filter);
        setHighlightedKey(null);
    };

    const toggleChecked = React.useCallback((item: ReferencePickerItem) => {
        const key = referencePickerItemKey(item);
        setChecked((current) => {
            const next = new Map(current);
            if (next.has(key)) next.delete(key);
            else next.set(key, item);
            return next;
        });
        setConfirmError(null);
    }, []);

    const setIncludeDiff = React.useCallback((key: string, include: boolean) => {
        setDiffIncluded((current) => {
            const next = new Set(current);
            if (include) next.add(key);
            else next.delete(key);
            return next;
        });
    }, []);

    const toSelection = React.useCallback((item: ReferencePickerItem): ReferencePickerSelection => (
        item.source === 'linear'
            ? item
            : { source: 'github', reference: item.reference, includeDiff: diffIncluded.has(referencePickerItemKey(item)) }
    ), [diffIncluded]);

    /** Confirm the checked items plus `extra`, or just `extra` in single mode. */
    const confirm = React.useCallback(async (extra: ReferencePickerItem | null) => {
        if (confirming) return;
        const chosen = new Map(selection === 'multiple' ? checked : []);
        if (extra) chosen.set(referencePickerItemKey(extra), extra);
        if (chosen.size === 0) return;
        setConfirming(true);
        setConfirmError(null);
        try {
            const failure = await onConfirm([...chosen.values()].map(toSelection));
            if (!failure) {
                onOpenChange(false);
                return;
            }
            setConfirmError(failure.message);
            setChecked(new Map([...chosen].filter(([key]) => failure.failedKeys.includes(key))));
        } finally {
            setConfirming(false);
        }
    }, [checked, confirming, onConfirm, onOpenChange, selection, toSelection]);

    const moveHighlight = React.useCallback((direction: 1 | -1) => {
        if (items.length === 0) return;
        const index = items.findIndex((item) => referencePickerItemKey(item) === effectiveHighlightKey);
        const next = items[Math.min(items.length - 1, Math.max(0, index + direction))];
        if (next) setHighlightedKey(referencePickerItemKey(next));
        if (direction === 1 && index >= items.length - 3) list.loadMore();
    }, [effectiveHighlightKey, items, list]);

    const handleSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
        if (isIMECompositionEvent(event)) return;
        if (handleDropdownNavigationKey(event, (key) => moveHighlight(key === 'ArrowDown' ? 1 : -1))) return;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            moveHighlight(event.key === 'ArrowDown' ? 1 : -1);
            return;
        }
        if (event.key !== 'Enter' || !highlightedItem) return;
        event.preventDefault();
        if (selection === 'multiple' && event.shiftKey) {
            toggleChecked(highlightedItem);
            return;
        }
        void confirm(selection === 'multiple' && checked.size > 0 ? null : highlightedItem);
    };

    // Load the next page when the end of the list scrolls into view.
    const sentinelRef = React.useRef<HTMLDivElement>(null);
    const { hasMore, loadMore } = list;
    React.useEffect(() => {
        const sentinel = sentinelRef.current;
        if (!sentinel || !hasMore) return;
        const observer = new IntersectionObserver((entries) => {
            if (entries.some((entry) => entry.isIntersecting)) loadMore();
        }, { rootMargin: '200px' });
        observer.observe(sentinel);
        return () => observer.disconnect();
    }, [hasMore, loadMore, items.length]);

    const title = t(source === 'github'
        ? (isGitLab
            ? (purpose === 'worktree' ? 'references.picker.title.gitlab.worktree' : 'references.picker.title.gitlab.attach')
            : (purpose === 'worktree' ? 'references.picker.title.github.worktree' : 'references.picker.title.github.attach'))
        : (purpose === 'worktree' ? 'references.picker.title.linear.worktree' : 'references.picker.title.linear.attach'));

    const openSettings = () => {
        const ui = useUIStore.getState();
        ui.setSettingsPage('integrations');
        ui.setSettingsDialogOpen(true);
        onOpenChange(false);
    };

    const tabs = source === 'github' ? (
        <div className={cn(isMobile ? 'w-full' : 'w-[16rem]')}>
            <SortableTabsStrip
                items={[
                    { id: 'issue', label: t('references.picker.tab.issues'), icon: <Icon name="record-circle" className="size-3.5" /> },
                    { id: 'pull', label: t(isGitLab ? 'references.picker.tab.mergeRequests' : 'references.picker.tab.pulls'), icon: <Icon name="git-pull-request" className="size-3.5" /> },
                ]}
                activeId={githubKind}
                onSelect={(id) => selectGitHubKind(id === 'pull' ? 'pull' : 'issue')}
                variant="active-pill"
                layoutMode="fit"
            />
        </div>
    ) : null;

    const filters = source === 'github'
        ? (isGitLab ? [] : GITHUB_FILTERS[githubKind]).map((filter) => ({
            id: filter,
            label: t(FILTER_LABEL_KEYS[filter]),
            active: githubFilter === filter,
            select: () => selectGitHubFilter(filter),
        }))
        : LINEAR_FILTERS.map((filter) => ({
            id: filter,
            label: t(FILTER_LABEL_KEYS[filter]),
            active: linearFilter === filter,
            select: () => selectLinearFilter(filter),
        }));

    const searchAndFilters = (
        <div className={cn('flex gap-2', isMobile ? 'flex-col' : 'min-w-0 flex-1 items-center')}>
            {/* Desktop: shares the title row, so the field gives way first when it runs short. */}
            <div className={cn('relative', isMobile ? 'w-full' : 'min-w-[10rem] max-w-[18rem] flex-1')}>
                <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                    ref={searchRef}
                    autoFocus={!isMobile}
                    value={query}
                    onChange={(event) => {
                        setQuery(event.target.value);
                        setHighlightedKey(null);
                    }}
                    onKeyDown={handleSearchKeyDown}
                    placeholder={t(source === 'linear' ? 'references.picker.search.linear' : isGitLab ? 'references.picker.search.gitlab' : 'references.picker.search.github')}
                    aria-label={t(source === 'linear' ? 'references.picker.search.linear' : isGitLab ? 'references.picker.search.gitlab' : 'references.picker.search.github')}
                    className="h-9 w-full pl-9 pr-14"
                />
                <div className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-1">
                    {list.refreshing && list.status !== 'loading' ? (
                        <Icon name="loader-4" className="size-3.5 animate-spin text-muted-foreground" />
                    ) : null}
                    {query ? (
                        <button
                            type="button"
                            onClick={() => {
                                setQuery('');
                                setHighlightedKey(null);
                                searchRef.current?.focus();
                            }}
                            className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
                            aria-label={t('references.picker.actions.clearSearch')}
                            title={t('references.picker.actions.clearSearch')}
                        >
                            <Icon name="close" className="size-3.5" />
                        </button>
                    ) : null}
                </div>
            </div>
            <div className="flex shrink-0 items-center gap-1 overflow-x-auto">
                {filters.map((filter) => (
                    <Button
                        key={filter.id}
                        type="button"
                        variant="chip"
                        size="sm"
                        // As tall as the search field beside it.
                        className="h-9"
                        aria-pressed={filter.active}
                        onClick={filter.select}
                    >
                        {filter.label}
                    </Button>
                ))}
            </div>
        </div>
    );

    const emptyText = () => {
        if (debouncedQuery.trim()) return t('references.picker.empty.search');
        if (source === 'linear') return t('references.picker.empty.linear');
        if (githubKind === 'issue') return t('references.picker.empty.issues');
        return t(isGitLab ? 'references.picker.empty.mergeRequests' : 'references.picker.empty.pulls');
    };

    const centered = (children: React.ReactNode) => (
        <div className="flex h-full min-h-[12rem] flex-col items-center justify-center gap-3 px-6 py-10 text-center typography-meta text-muted-foreground">
            {children}
        </div>
    );

    const listBody = (() => {
        if (sourceStatus === 'unsupported') return centered(t('references.picker.empty.unsupported'));
        if (sourceStatus === 'disconnected' || list.unavailable === 'disconnected') {
            return centered(
                <>
                    <span>{t(source === 'linear'
                        ? 'references.picker.empty.linear.notConnected'
                        : isGitLab ? 'references.picker.empty.gitlab.notConnected' : 'references.picker.empty.github.notConnected')}</span>
                    <Button size="sm" variant="outline" onClick={openSettings}>{t('references.picker.actions.openSettings')}</Button>
                </>,
            );
        }
        if (source === 'github' && !directory) return centered(t('references.picker.empty.noProject'));
        if (list.unavailable === 'no-repo') return centered(t('references.picker.empty.noRepo'));
        if (list.status === 'loading') {
            return centered(
                <span className="inline-flex items-center gap-2">
                    <Icon name="loader-4" className="size-4 animate-spin" />
                    {t('references.picker.loading')}
                </span>,
            );
        }
        if (list.status === 'error') {
            return centered(
                <>
                    <span className="break-words text-[var(--status-error-text)]">{t('references.picker.error.load', { error: list.error ?? '' })}</span>
                    <Button size="sm" variant="outline" onClick={list.retry}>{t('references.picker.actions.retry')}</Button>
                </>,
            );
        }
        return (
            <div role="listbox" aria-label={title} aria-multiselectable={selection === 'multiple'} className="flex flex-col gap-1 p-1.5">
                {list.error ? (
                    <div className="mb-1 flex items-center gap-2 rounded-lg bg-[var(--status-error-background)] px-2.5 py-1.5 typography-meta text-[var(--status-error-text)]">
                        <span className="min-w-0 flex-1 break-words">{t('references.picker.error.refresh', { error: list.error })}</span>
                        <Button size="xs" variant="ghost" onClick={list.retry}>{t('references.picker.actions.retry')}</Button>
                    </div>
                ) : null}
                {items.length === 0 ? centered(emptyText()) : null}
                {items.map((item) => {
                    const key = referencePickerItemKey(item);
                    return (
                        <ReferencePickerRow
                            key={key}
                            item={item}
                            pullStatus={item.source === 'github' ? readyValue(pullStatusOf(item.reference)) : null}
                            highlighted={!isMobile && key === effectiveHighlightKey}
                            checked={selection === 'multiple' ? checked.has(key) : null}
                            diffIncluded={diffIncluded.has(key)}
                            now={now}
                            onHighlight={() => {
                                if (isMobile) {
                                    setMobilePreviewKey(key);
                                    return;
                                }
                                setHighlightedKey(key);
                                searchRef.current?.focus();
                            }}
                            onToggle={() => toggleChecked(item)}
                            onActivate={() => void confirm(item)}
                        />
                    );
                })}
                {list.hasMore ? (
                    <div ref={sentinelRef} className="flex justify-center py-3">
                        {list.loadingMore ? <Icon name="loader-4" className="size-4 animate-spin text-muted-foreground" /> : null}
                    </div>
                ) : null}
            </div>
        );
    })();

    const preview = (
        <ReferencePreview
            item={previewItem}
            pullStatus={previewItem?.source === 'github' ? pullStatusOf(previewItem.reference) : IDLE_STATUS}
            linearDetail={linearDetail}
            githubDetail={githubDetail}
            purpose={purpose}
            pinned={!isMobile}
            includeDiff={previewKey ? diffIncluded.has(previewKey) : false}
            onIncludeDiffChange={(include) => {
                if (previewKey) setIncludeDiff(previewKey, include);
            }}
            now={now}
        />
    );

    const checkedCount = checked.size;
    const confirmLabel = selection === 'single'
        ? t('references.picker.actions.choose')
        : checkedCount > 1
            ? t('references.picker.actions.attachCount', { count: checkedCount })
            : t('references.picker.actions.attach');

    // In multiple mode the button attaches what is checked, or the
    // highlighted item when nothing is; single mode always takes the highlight.
    const confirmTarget = isMobile ? previewItem : highlightedItem;
    const canConfirm = !confirming && (selection === 'multiple' ? checkedCount > 0 || Boolean(confirmTarget) : Boolean(confirmTarget));
    const runConfirm = () => void confirm(selection === 'multiple' && checkedCount > 0 && !(isMobile && previewItem) ? null : confirmTarget);

    const footerStatus = confirmError ? (
        <span className="min-w-0 break-words typography-meta text-[var(--status-error-text)]">{confirmError}</span>
    ) : (
        <span className="min-w-0 truncate typography-meta text-muted-foreground">
            {selection === 'multiple' && checkedCount > 0
                ? t('references.picker.footer.selected', { count: checkedCount })
                : isMobile ? null : t(selection === 'multiple' ? 'references.picker.footer.hint.multiple' : 'references.picker.footer.hint.single')}
        </span>
    );

    const confirmButton = (
        <Button size="sm" onClick={runConfirm} disabled={!canConfirm} className={cn(isMobile && 'flex-1')}>
            {confirming ? <Icon name="loader-4" className="size-3.5 animate-spin" /> : null}
            {confirmLabel}
        </Button>
    );

    if (isMobile) {
        const inPreview = Boolean(mobilePreviewKey && previewItem);
        return (
            <MobileOverlayPanel
                open
                title={title}
                onClose={() => onOpenChange(false)}
                contentMaxHeightClassName="max-h-[calc(100dvh-12rem)]"
                renderHeader={(closeButton) => (
                    <div className="flex flex-col gap-2 border-b border-border/40 px-3 py-2">
                        <div className="flex items-center justify-between gap-2">
                            {inPreview ? (
                                <Button variant="ghost" size="sm" onClick={() => setMobilePreviewKey(null)} className="-ml-1">
                                    <Icon name="arrow-left-s" className="size-4" />
                                    {t('references.picker.actions.back')}
                                </Button>
                            ) : (
                                <h2 className="typography-ui-label font-semibold text-foreground">{title}</h2>
                            )}
                            {closeButton}
                        </div>
                        {inPreview ? null : (
                            <>
                                {tabs}
                                {searchAndFilters}
                            </>
                        )}
                    </div>
                )}
                footer={(
                    <div className="flex flex-col gap-2">
                        {confirmError || checkedCount > 0 ? footerStatus : null}
                        <div className="flex items-center gap-2">
                            {inPreview && selection === 'multiple' && previewItem ? (
                                <Button variant="outline" size="sm" className="flex-1" onClick={() => toggleChecked(previewItem)}>
                                    {checked.has(referencePickerItemKey(previewItem))
                                        ? t('references.picker.actions.unselect')
                                        : t('references.picker.actions.select')}
                                </Button>
                            ) : null}
                            {confirmButton}
                        </div>
                    </div>
                )}
            >
                {inPreview ? <div className="px-2 py-1">{preview}</div> : listBody}
            </MobileOverlayPanel>
        );
    }

    return (
        <Dialog open onOpenChange={onOpenChange}>
            <DialogContent className="h-[min(90vh,58rem)] w-[min(72rem,calc(100vw-1.5rem))] max-w-6xl gap-0 overflow-hidden p-0">
                <div className="flex shrink-0 flex-col gap-3 border-b border-border/60 px-5 pb-3 pt-4">
                    <div className="flex flex-wrap items-center gap-3 pr-8">
                        <DialogTitle className="flex shrink-0 items-center gap-2 typography-ui-header">
                            <Icon name={source === 'linear' ? 'linear' : isGitLab ? 'gitlab' : 'github'} className="size-5" />
                            {title}
                        </DialogTitle>
                        <DialogDescription className="sr-only">
                            {t(selection === 'multiple' ? 'references.picker.footer.hint.multiple' : 'references.picker.footer.hint.single')}
                        </DialogDescription>
                        {tabs}
                        {searchAndFilters}
                    </div>
                </div>
                <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
                    <ScrollableOverlay outerClassName="min-h-0 border-r border-border/60" disableHorizontal>
                        {listBody}
                    </ScrollableOverlay>
                    <div className="min-h-0">{preview}</div>
                </div>
                <div className="flex shrink-0 items-center gap-3 border-t border-border/60 px-5 py-3">
                    <div className="min-w-0 flex-1">{footerStatus}</div>
                    <Button size="sm" variant="outline" onClick={() => onOpenChange(false)}>
                        {t('references.picker.actions.cancel')}
                    </Button>
                    {confirmButton}
                </div>
            </DialogContent>
        </Dialog>
    );
}
