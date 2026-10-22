/** The parts of the reference list both the picker and the board lay out; state lives in `useReferenceBrowser`. */

import * as React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuLabel,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { dropdownTriggerVariants } from '@/components/ui/dropdown-trigger';
import { Input } from '@/components/ui/input';
import { SortableTabsStrip } from '@/components/ui/sortable-tabs-strip';
import { useI18n, type I18nKey } from '@/lib/i18n';
import type { ChangeRequestTerm } from '@/lib/source-control/providers/descriptor';
import { cn } from '@/lib/utils';

import { ReferencePickerRow } from './ReferencePickerRow';
import {
    CHANGE_REQUEST_TAB_KEYS,
    REPOSITORY_PEOPLE,
    REPOSITORY_PEOPLE_LABEL_KEYS,
    REPOSITORY_STATE_LABEL_KEYS,
    REPOSITORY_STATES,
    TRACKER_PEOPLE_FILTERS,
    TRACKER_PEOPLE_LABEL_KEYS,
    TRACKER_PRIORITY_FILTERS,
    TRACKER_PRIORITY_LABEL_KEYS,
    referencePickerItemKey,
    trackerStateFilterLabel,
    type ReferencePickerItem,
} from './referencePickerItems';
import { readyValue, type ReferenceBrowser } from './useReferenceBrowser';

const NO_PULLS_KEYS = {
    pullRequest: 'references.picker.empty.pulls',
    mergeRequest: 'references.picker.empty.mergeRequests',
} as const satisfies Record<ChangeRequestTerm, I18nKey>;

/** Issues and change requests, named by the provider's term; the repository source only. */
export const ReferenceBrowserTabs: React.FC<{ browser: ReferenceBrowser }> = ({ browser }) => {
    const { t } = useI18n();
    if (browser.source !== 'repository') return null;
    return (
        <div className={cn(browser.isMobile ? 'w-full' : 'w-[16rem]')}>
            <SortableTabsStrip
                items={[
                    { id: 'issue', label: t('references.picker.tab.issues'), icon: <Icon name="record-circle" className="size-3.5" /> },
                    { id: 'pull', label: t(CHANGE_REQUEST_TAB_KEYS[browser.term]), icon: <Icon name="git-pull-request" className="size-3.5" /> },
                ]}
                activeId={browser.repositoryKind}
                onSelect={(id) => browser.selectRepositoryKind(id === 'pull' ? 'pull' : 'issue')}
                variant="active-pill"
                layoutMode="fit"
            />
        </div>
    );
};

/**
 * Which items the list shows. Picking stays in the menu, so a tracker's parts
 * combine. A tracker offers its descriptor's state filters, and people and
 * priority where its `filters` capabilities say so.
 */
const ReferenceFilterMenu: React.FC<{ browser: ReferenceBrowser }> = ({ browser }) => {
    const { t } = useI18n();
    const { source, trackerDescriptor } = browser;
    const { state, people, priority } = browser.trackerFilter;
    const { filters } = trackerDescriptor.capabilities;
    const repository = browser.repositoryFilter;
    const summary = source === 'repository'
        ? [
            t(REPOSITORY_STATE_LABEL_KEYS[repository.state]),
            repository.people === 'any' ? null : t(REPOSITORY_PEOPLE_LABEL_KEYS[repository.people]),
        ].filter(Boolean).join(' · ')
        : [
            trackerStateFilterLabel(state, t),
            people === 'any' ? null : t(TRACKER_PEOPLE_LABEL_KEYS[people]),
            priority === 'all' ? null : t(TRACKER_PRIORITY_LABEL_KEYS[priority]),
        ].filter(Boolean).join(' · ');

    const group = <T extends string>(
        label: string,
        value: T,
        options: readonly T[],
        labelOf: (option: T) => string,
        onSelect: (option: T) => void,
    ) => (
        <>
            <DropdownMenuLabel>{label}</DropdownMenuLabel>
            <DropdownMenuRadioGroup
                value={value}
                onValueChange={(next) => {
                    const option = options.find((entry) => entry === next);
                    if (option) onSelect(option);
                }}
            >
                {options.map((option) => <DropdownMenuRadioItem key={option} value={option}>{labelOf(option)}</DropdownMenuRadioItem>)}
            </DropdownMenuRadioGroup>
        </>
    );

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    aria-label={t('references.picker.filter.label')}
                    title={summary}
                    className={cn(dropdownTriggerVariants({ size: browser.isMobile ? 'mobile' : 'default' }), 'min-w-0 max-w-[18rem] shrink-0', browser.isMobile && 'max-w-[45%]')}
                >
                    <span className="flex min-w-0 items-center gap-1.5">
                        <Icon name="filter-3" className="size-4" />
                        <span className="truncate">{summary}</span>
                    </span>
                    <Icon name="arrow-down-s" className="size-4 opacity-50" />
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
                {source === 'repository' ? (
                    <>
                        {group(t('references.picker.filter.group.status'), repository.state, REPOSITORY_STATES[browser.repositoryKind], (option) => t(REPOSITORY_STATE_LABEL_KEYS[option]), (option) => browser.selectRepositoryFilter({ state: option }))}
                        <DropdownMenuSeparator />
                        {group(t('references.picker.filter.group.people'), repository.people, REPOSITORY_PEOPLE[browser.repositoryKind], (option) => t(REPOSITORY_PEOPLE_LABEL_KEYS[option]), (option) => browser.selectRepositoryFilter({ people: option }))}
                    </>
                ) : (
                    <>
                        {group(t('references.picker.filter.group.status'), state, trackerDescriptor.stateFilters, (option) => trackerStateFilterLabel(option, t), (option) => browser.selectTrackerFilter({ state: option }))}
                        {filters.people ? (
                            <>
                                <DropdownMenuSeparator />
                                {group(t('references.picker.filter.group.people'), people, TRACKER_PEOPLE_FILTERS, (option) => t(TRACKER_PEOPLE_LABEL_KEYS[option]), (option) => browser.selectTrackerFilter({ people: option }))}
                            </>
                        ) : null}
                        {filters.priority ? (
                            <>
                                <DropdownMenuSeparator />
                                {group(t('references.picker.filter.group.priority'), priority, TRACKER_PRIORITY_FILTERS, (option) => t(TRACKER_PRIORITY_LABEL_KEYS[option]), (option) => browser.selectTrackerFilter({ priority: option }))}
                            </>
                        ) : null}
                    </>
                )}
            </DropdownMenuContent>
        </DropdownMenu>
    );
};

/** The search field, taking the room it is given, and the filter beside it. */
export const ReferenceBrowserSearch: React.FC<{
    browser: ReferenceBrowser;
    onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
    /** After the filter, such as the board's list refresh. */
    trailing?: React.ReactNode;
}> = ({ browser, onKeyDown, trailing }) => {
    const { t } = useI18n();
    const { source, term, isMobile, list, query, searchRef } = browser;
    const tracked = source !== 'repository';
    const placeholder = t(tracked ? 'references.picker.search.tracker' : `references.picker.search.${term}`);
    // The phone's field shares its row with the filter, so it gets the short wording;
    // the label keeps the full one.
    const shortPlaceholder = t(tracked ? 'references.picker.search.mobile.tracker' : `references.picker.search.mobile.${term}`);

    return (
        <div className={cn('flex items-center gap-2', !isMobile && 'min-w-[14rem] flex-1')}>
            <div className="relative min-w-0 flex-1">
                <Icon name="search" className="pointer-events-none absolute inset-s-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                    ref={searchRef}
                    autoFocus={!isMobile}
                    value={query}
                    onChange={(event) => browser.setQuery(event.target.value)}
                    onKeyDown={onKeyDown}
                    placeholder={isMobile ? shortPlaceholder : placeholder}
                    aria-label={placeholder}
                    title={placeholder}
                    inputSize={isMobile ? 'default' : 'compact'}
                    className="w-full ps-8 pe-14"
                />
                <div className="absolute inset-e-1.5 top-1/2 flex -translate-y-1/2 items-center gap-1">
                    {list.refreshing && list.status !== 'loading' ? (
                        <Icon name="loader-4" className="size-3.5 animate-spin text-muted-foreground" />
                    ) : null}
                    {query ? (
                        <button
                            type="button"
                            onClick={() => {
                                browser.setQuery('');
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
            <ReferenceFilterMenu browser={browser} />
            {trailing}
        </div>
    );
};

/** What a row adds on a surface that checks items; a board row has none of it. */
type ReferenceBrowserRowSelection = {
    /** Null where rows have no checkbox. */
    checked: boolean | null;
    diffIncluded: boolean;
    onToggle: () => void;
};

/** The list with its loading, failure, empty and not-connected states. */
export const ReferenceBrowserList: React.FC<{
    browser: ReferenceBrowser;
    label: string;
    multiselectable: boolean;
    onOpenSettings: () => void;
    rowSelection?: (item: ReferencePickerItem, key: string) => ReferenceBrowserRowSelection;
    onActivate?: (item: ReferencePickerItem) => void;
    /** After a row is clicked to show it, as when the list closes then. */
    onShow?: () => void;
    /** A quiet line above the rows, such as the repositories a list across several left out. */
    notice?: React.ReactNode;
}> = ({ browser, label, multiselectable, onOpenSettings, rowSelection, onActivate, onShow, notice }) => {
    const { t } = useI18n();
    const { source, sourceStatus, list, items, term, descriptor, isMobile, directory, debouncedQuery, repositoryKind, tracker } = browser;

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

    const centered = (children: React.ReactNode) => (
        <div className="flex h-full min-h-[12rem] flex-col items-center justify-center gap-3 px-6 py-10 text-center typography-meta text-muted-foreground">
            {children}
        </div>
    );
    const emptyText = () => {
        if (debouncedQuery.trim()) return t('references.picker.empty.search');
        if (tracker) return t('references.picker.empty.tracker');
        if (repositoryKind === 'issue') return t('references.picker.empty.issues');
        return t(NO_PULLS_KEYS[term]);
    };

    if (sourceStatus === 'unsupported') return centered(t('references.picker.empty.unsupported'));
    if (sourceStatus === 'disconnected' || list.unavailable === 'disconnected') {
        return centered(
            <>
                <span>{tracker
                    ? t('references.picker.empty.tracker.notConnected', { provider: browser.trackerDescriptor.name })
                    : t(`references.picker.empty.notConnected.${term}`, { provider: descriptor.label })}</span>
                <Button size="sm" variant="outline" onClick={onOpenSettings}>{t('references.picker.actions.openSettings')}</Button>
            </>,
        );
    }
    if (source === 'repository' && !directory) return centered(t('references.picker.empty.noProject'));
    if (list.unavailable === 'no-repo') {
        return (
            <>
                {notice}
                {centered(t('references.picker.empty.noRepo'))}
            </>
        );
    }
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
        <>
            {notice}
            <div role="listbox" aria-label={label} aria-multiselectable={multiselectable} className="flex flex-col gap-1 p-1.5">
                {list.error ? (
                    <div className="mb-1 flex items-center gap-2 rounded-lg bg-[var(--status-error-background)] px-2.5 py-1.5 typography-meta text-[var(--status-error-text)]">
                        <span className="min-w-0 flex-1 break-words">{t('references.picker.error.refresh', { error: list.error })}</span>
                        <Button size="xs" variant="ghost" onClick={list.retry}>{t('references.picker.actions.retry')}</Button>
                    </div>
                ) : null}
                {items.length === 0 ? centered(emptyText()) : null}
                {items.map((item) => {
                    const key = referencePickerItemKey(item);
                    const selection = rowSelection?.(item, key) ?? null;
                    return (
                        <ReferencePickerRow
                            key={key}
                            item={item}
                            pullStatus={item.source === 'repository' ? readyValue(browser.pullStatusOf(item.reference, item.directory)) : null}
                            showRepository={browser.across}
                            highlighted={!isMobile && key === browser.effectiveHighlightKey}
                            checked={selection?.checked ?? null}
                            diffIncluded={selection?.diffIncluded ?? false}
                            now={browser.now}
                            onHighlight={() => {
                                browser.showItem(key);
                                onShow?.();
                            }}
                            onToggle={() => selection?.onToggle()}
                            onActivate={() => onActivate?.(item)}
                        />
                    );
                })}
                {list.hasMore ? (
                    <div ref={sentinelRef} className="flex justify-center py-3">
                        {list.loadingMore ? <Icon name="loader-4" className="size-4 animate-spin text-muted-foreground" /> : null}
                    </div>
                ) : null}
            </div>
        </>
    );
};
