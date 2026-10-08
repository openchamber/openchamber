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
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

import { ReferencePickerRow } from './ReferencePickerRow';
import {
    REPOSITORY_PEOPLE,
    REPOSITORY_PEOPLE_LABEL_KEYS,
    REPOSITORY_STATE_LABEL_KEYS,
    REPOSITORY_STATES,
    LINEAR_PEOPLE_FILTERS,
    LINEAR_PEOPLE_LABEL_KEYS,
    LINEAR_PRIORITY_FILTERS,
    LINEAR_PRIORITY_LABEL_KEYS,
    LINEAR_STATUS_FILTERS,
    LINEAR_STATUS_LABEL_KEYS,
    referencePickerItemKey,
    type ReferencePickerItem,
} from './referencePickerItems';
import { readyValue, type ReferenceBrowser } from './useReferenceBrowser';

/** Issues and pull requests (merge requests on GitLab); GitHub only. */
export const ReferenceBrowserTabs: React.FC<{ browser: ReferenceBrowser }> = ({ browser }) => {
    const { t } = useI18n();
    if (browser.source !== 'github') return null;
    return (
        <div className={cn(browser.isMobile ? 'w-full' : 'w-[16rem]')}>
            <SortableTabsStrip
                items={[
                    { id: 'issue', label: t('references.picker.tab.issues'), icon: <Icon name="record-circle" className="size-3.5" /> },
                    { id: 'pull', label: t(browser.isGitLab ? 'references.picker.tab.mergeRequests' : 'references.picker.tab.pulls'), icon: <Icon name="git-pull-request" className="size-3.5" /> },
                ]}
                activeId={browser.githubKind}
                onSelect={(id) => browser.selectGitHubKind(id === 'pull' ? 'pull' : 'issue')}
                variant="active-pill"
                layoutMode="fit"
                // As tall as the search field and the filter beside it.
                activePillButtonClassName={browser.isMobile ? undefined : 'h-7'}
            />
        </div>
    );
};

/** Which items the list shows. Picking stays in the menu, so Linear's parts combine. */
const ReferenceFilterMenu: React.FC<{ browser: ReferenceBrowser }> = ({ browser }) => {
    const { t } = useI18n();
    const { source } = browser;
    const { status, people, priority } = browser.linearFilter;
    const repository = browser.githubFilter;
    const summary = source === 'github'
        ? [
            t(REPOSITORY_STATE_LABEL_KEYS[repository.state]),
            repository.people === 'any' ? null : t(REPOSITORY_PEOPLE_LABEL_KEYS[repository.people]),
        ].filter(Boolean).join(' · ')
        : [
            t(LINEAR_STATUS_LABEL_KEYS[status]),
            people === 'any' ? null : t(LINEAR_PEOPLE_LABEL_KEYS[people]),
            priority === 'all' ? null : t(LINEAR_PRIORITY_LABEL_KEYS[priority]),
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
                    className={cn(dropdownTriggerVariants(), 'min-w-0 max-w-[18rem] shrink-0', browser.isMobile && 'w-full max-w-none')}
                >
                    <span className="flex min-w-0 items-center gap-1.5">
                        <Icon name="filter-3" className="size-4" />
                        <span className="truncate">{summary}</span>
                    </span>
                    <Icon name="arrow-down-s" className="size-4 opacity-50" />
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
                {source === 'github' ? (
                    <>
                        {group(t('references.picker.filter.group.status'), repository.state, REPOSITORY_STATES[browser.githubKind], (option) => t(REPOSITORY_STATE_LABEL_KEYS[option]), (option) => browser.selectGitHubFilter({ state: option }))}
                        <DropdownMenuSeparator />
                        {group(t('references.picker.filter.group.people'), repository.people, REPOSITORY_PEOPLE[browser.githubKind], (option) => t(REPOSITORY_PEOPLE_LABEL_KEYS[option]), (option) => browser.selectGitHubFilter({ people: option }))}
                    </>
                ) : (
                    <>
                        {group(t('references.picker.filter.group.status'), status, LINEAR_STATUS_FILTERS, (option) => t(LINEAR_STATUS_LABEL_KEYS[option]), (option) => browser.selectLinearFilter({ status: option }))}
                        <DropdownMenuSeparator />
                        {group(t('references.picker.filter.group.people'), people, LINEAR_PEOPLE_FILTERS, (option) => t(LINEAR_PEOPLE_LABEL_KEYS[option]), (option) => browser.selectLinearFilter({ people: option }))}
                        <DropdownMenuSeparator />
                        {group(t('references.picker.filter.group.priority'), priority, LINEAR_PRIORITY_FILTERS, (option) => t(LINEAR_PRIORITY_LABEL_KEYS[option]), (option) => browser.selectLinearFilter({ priority: option }))}
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
}> = ({ browser, onKeyDown }) => {
    const { t } = useI18n();
    const { source, isGitLab, isMobile, list, query, searchRef } = browser;
    const placeholder = t(source === 'linear' ? 'references.picker.search.linear' : isGitLab ? 'references.picker.search.gitlab' : 'references.picker.search.github');

    return (
        <div className={cn('flex gap-2', isMobile ? 'flex-col' : 'min-w-[14rem] flex-1 items-center')}>
            <div className="relative min-w-0 flex-1">
                <Icon name="search" className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                    ref={searchRef}
                    autoFocus={!isMobile}
                    value={query}
                    onChange={(event) => browser.setQuery(event.target.value)}
                    onKeyDown={onKeyDown}
                    placeholder={placeholder}
                    aria-label={placeholder}
                    title={placeholder}
                    className={cn('w-full pl-8 pr-14', isMobile ? 'h-9' : 'h-8')}
                />
                <div className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-1">
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
}> = ({ browser, label, multiselectable, onOpenSettings, rowSelection, onActivate, onShow }) => {
    const { t } = useI18n();
    const { source, sourceStatus, list, items, isGitLab, isMobile, directory, debouncedQuery, githubKind } = browser;

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
        if (source === 'linear') return t('references.picker.empty.linear');
        if (githubKind === 'issue') return t('references.picker.empty.issues');
        return t(isGitLab ? 'references.picker.empty.mergeRequests' : 'references.picker.empty.pulls');
    };

    if (sourceStatus === 'unsupported') return centered(t('references.picker.empty.unsupported'));
    if (sourceStatus === 'disconnected' || list.unavailable === 'disconnected') {
        return centered(
            <>
                <span>{t(source === 'linear'
                    ? 'references.picker.empty.linear.notConnected'
                    : isGitLab ? 'references.picker.empty.gitlab.notConnected' : 'references.picker.empty.github.notConnected')}</span>
                <Button size="sm" variant="outline" onClick={onOpenSettings}>{t('references.picker.actions.openSettings')}</Button>
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
                        pullStatus={item.source === 'github' ? readyValue(browser.pullStatusOf(item.reference)) : null}
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
    );
};
