/** The parts of the reference list both the picker and the board lay out; state lives in `useReferenceBrowser`. */

import * as React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Command, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
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
import { handleDropdownNavigationKey, shouldDismissDropdown } from '@/components/ui/dropdown-navigation';
import { Input } from '@/components/ui/input';
import { PICKER_SEARCH_INPUT_CLASS } from '@/components/ui/MobileSheetList';
import { SortableTabsStrip } from '@/components/ui/sortable-tabs-strip';
import type { Label } from '@/lib/api/types';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { isIMECompositionEvent } from '@/lib/ime';
import { rankByQuery } from '@/lib/search/fuzzySearch';
import type { ChangeRequestTerm } from '@/lib/source-control/providers/descriptor';
import { cn } from '@/lib/utils';

import { ReferenceLabelChips, ReferencePickerRow } from './ReferencePickerRow';
import { useRepositoryLabelReader } from './useRepositoryLabelReader';
import {
    REPOSITORY_PEOPLE,
    REPOSITORY_PEOPLE_LABEL_KEYS,
    REPOSITORY_STATE_LABEL_KEYS,
    REPOSITORY_STATES,
    TRACKER_PEOPLE_FILTERS,
    TRACKER_PEOPLE_LABEL_KEYS,
    TRACKER_PRIORITY_FILTERS,
    TRACKER_PRIORITY_LABEL_KEYS,
    labelColor,
    referencePickerItemKey,
    repositoryKindOfTab,
    repositoryKindTabs,
    trackerStateFilterLabel,
    type ReferencePickerItem,
} from './referencePickerItems';
import { readyValue, type ReferenceBrowser } from './useReferenceBrowser';

const NO_PULLS_KEYS = {
    pullRequest: 'references.picker.empty.pulls',
    mergeRequest: 'references.picker.empty.mergeRequests',
    change: 'references.picker.empty.changes',
} as const satisfies Record<ChangeRequestTerm, I18nKey>;

/** Issues and change requests, named by the provider's term, and discussions where it keeps them; the repository source only. */
export const ReferenceBrowserTabs: React.FC<{ browser: ReferenceBrowser }> = ({ browser }) => {
    const { t } = useI18n();
    if (browser.source !== 'repository') return null;
    const tabs = repositoryKindTabs(t, browser.term, browser.discussions)
        .map((tab) => ({ ...tab, icon: <Icon name={tab.icon} className="size-3.5" /> }));
    return (
        <div className={cn(browser.isMobile ? 'w-full' : tabs.length > 2 ? 'w-[24rem]' : 'w-[16rem]')}>
            <SortableTabsStrip
                items={tabs}
                activeId={browser.repositoryKind}
                onSelect={(id) => browser.selectRepositoryKind(repositoryKindOfTab(id))}
                variant="active-pill"
                layoutMode="fit"
            />
        </div>
    );
};

// The qualifiers the GitHub search text can carry; the list builder gives them
// precedence over the controls, so the controls read as taken over.
const QUALIFIER_STATE = /(^|\s)(is:(open|closed|merged|unmerged|answered|unanswered)|state:\S+)/i;
const QUALIFIER_PEOPLE = /(^|\s)(assignee|author|mentions|review-requested|reviewed-by):\S+/i;

const NO_LABELS: Label[] = [];
const NO_LABEL_NAMES: readonly string[] = [];
// A value no label can hold, so "Clear" never collides with one.
const CLEAR_LABELS_VALUE = '\u0000clear';

type LabelChoices =
    | { status: 'loading' }
    | { status: 'error'; message: string }
    | { status: 'ready'; items: Label[] };

/**
 * The labels the host lists, checked in place: a check reads the list again at
 * once and the panel stays open, as the filter it sets is live. A label the
 * host no longer lists stays chosen, and can be unpicked here.
 */
const ReferenceLabelSection: React.FC<{
    directory: string | null;
    applied: readonly string[];
    onChange: (labels: string[]) => void;
}> = ({ directory, applied, onChange }) => {
    const { t } = useI18n();
    const [query, setQuery] = React.useState('');
    const [activeId, setActiveId] = React.useState<string | null>(null);
    const [choices, setChoices] = React.useState<LabelChoices>({ status: 'loading' });
    // Read while the panel is open, never on mount: the section is only drawn then.
    const { ready, read } = useRepositoryLabelReader(true, directory);

    // The read is re-created whenever the binding settles; the section is read
    // once per opening, not once per identity, so a moving identity cannot loop.
    const readRef = React.useRef(read);
    React.useEffect(() => { readRef.current = read; }, [read]);
    React.useEffect(() => {
        if (!ready) return;
        let current = true;
        setChoices({ status: 'loading' });
        void readRef.current().then(
            (items) => { if (current) setChoices({ status: 'ready', items }); },
            (error: Error) => { if (current) setChoices({ status: 'error', message: error.message }); },
        );
        return () => { current = false; };
    }, [directory, ready]);

    const listed = choices.status === 'ready' ? choices.items : NO_LABELS;
    const all = React.useMemo(() => {
        const names = new Set(listed.map((label) => label.name));
        return [
            ...applied.filter((name) => !names.has(name)).map((name) => ({ name, color: null })),
            ...listed.map((label) => ({ name: label.name, color: labelColor(label.color) })),
        ];
    }, [applied, listed]);
    const shown = React.useMemo(() => (query ? rankByQuery(all, query, (label) => [label.name]) : all), [all, query]);

    return (
        <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>{t('references.picker.filter.group.labels')}</DropdownMenuLabel>
            <Command
                shouldFilter={false}
                value={activeId ?? undefined}
                onValueChange={setActiveId}
                // The field types into itself: the menu's own typeahead would
                // take every character, while Escape still closes the menu.
                onKeyDown={(event) => { if (!shouldDismissDropdown(event)) event.stopPropagation(); }}
                className="min-h-0"
            >
                <CommandInput
                    aria-label={t('references.picker.filter.labels.search')}
                    placeholder={t('references.picker.filter.labels.search')}
                    value={query}
                    onValueChange={setQuery}
                    onKeyDown={(event) => {
                        if (isIMECompositionEvent(event)) {
                            event.stopPropagation();
                            return;
                        }
                        // Ctrl+N/P reach the list, as they do in any other list here.
                        handleDropdownNavigationKey(event, (key) => {
                            event.currentTarget.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
                        });
                    }}
                />
                <CommandList aria-label={t('references.picker.filter.group.labels')} className="max-h-48">
                    {choices.status === 'loading' ? (
                        <div role="status" className="flex justify-center px-3 py-4">
                            <Icon name="loader-4" className="size-4 animate-spin text-muted-foreground" />
                        </div>
                    ) : choices.status === 'error' ? (
                        <div role="alert" className="px-3 py-2 typography-meta text-muted-foreground">
                            <p>{t('references.picker.filter.labels.failed')}</p>
                            <p className="mt-1 break-words">{choices.message}</p>
                        </div>
                    ) : shown.length === 0 ? (
                        <div role="status" className="px-3 py-4 text-center typography-ui-label text-muted-foreground">
                            {t('references.picker.filter.labels.none')}
                        </div>
                    ) : null}
                    {shown.map((label) => {
                        const checked = applied.includes(label.name);
                        return (
                            <CommandItem
                                key={label.name}
                                value={label.name}
                                onSelect={() => onChange(checked ? applied.filter((name) => name !== label.name) : [...applied, label.name])}
                                className="max-w-full"
                            >
                                <span className="flex size-4 shrink-0 items-center justify-center">
                                    {checked ? <Icon name="check" className="size-4 text-foreground" /> : null}
                                </span>
                                <span className="flex min-w-0 flex-1 items-center gap-2 truncate">
                                    <ReferenceLabelChips labels={[label]} />
                                </span>
                            </CommandItem>
                        );
                    })}
                    {applied.length > 0 ? (
                        <CommandItem value={CLEAR_LABELS_VALUE} onSelect={() => onChange([])} className="text-muted-foreground">
                            <span className="flex size-4 shrink-0 items-center justify-center">
                                <Icon name="close" className="size-3.5" />
                            </span>
                            <span className="min-w-0 flex-1 truncate">{t('references.picker.filter.labels.clear')}</span>
                        </CommandItem>
                    ) : null}
                </CommandList>
            </Command>
        </>
    );
};

/**
 * Which items the list shows: one trigger, and one panel for status, people,
 * priority and the repository's labels. Picking stays in the panel, so a
 * tracker's parts combine, and a label check reads the list again at once.
 */
const ReferenceFilterMenu: React.FC<{ browser: ReferenceBrowser }> = ({ browser }) => {
    const { t } = useI18n();
    const { source, trackerDescriptor } = browser;
    const { state, people, priority } = browser.trackerFilter;
    const { filters } = trackerDescriptor.capabilities;
    const repository = browser.repositoryFilter;
    const applied = repository.labels;
    // Labels narrow issues and change requests of the one repository the
    // browser reads; a discussion has none, and a tracker keeps its own.
    const labelsAvailable = source === 'repository' && !browser.across && browser.repositoryKind !== 'discussion' && Boolean(browser.directory);
    // Only this repository's own list is narrowed by them, so a tracker, a
    // discussion or an across list names none even when one was picked here.
    const shownLabels = labelsAvailable ? applied : NO_LABEL_NAMES;
    // An 18rem cap leaves room for one name; the rest count, and the tooltip names them all.
    const labelSummary = shownLabels.length === 0 ? null : shownLabels.length === 1 ? shownLabels[0] : `${shownLabels[0]} +${shownLabels.length - 1}`;
    const appliedNames = shownLabels.join(', ');
    const advancedSearch = source === 'repository' && browser.descriptor.features.advancedSearch;
    // The qualifier itself, so the panel names what decides the list instead of
    // leaving a checked value that no longer applies.
    const stateQualifier = advancedSearch ? browser.query.match(QUALIFIER_STATE)?.[0].trim() ?? null : null;
    const peopleQualifier = advancedSearch ? browser.query.match(QUALIFIER_PEOPLE)?.[0].trim() ?? null : null;
    const stateFromSearch = stateQualifier !== null;
    const peopleFromSearch = peopleQualifier !== null;

    // A qualifier the user typed decides that field: the summary names it, not
    // the control's value, which no longer applies.
    const statusText = stateFromSearch ? stateQualifier : source === 'repository'
        ? t(REPOSITORY_STATE_LABEL_KEYS[repository.state])
        : trackerStateFilterLabel(state, t);
    const peopleText = peopleFromSearch ? peopleQualifier : source === 'repository'
        ? (repository.people === 'any' ? null : t(REPOSITORY_PEOPLE_LABEL_KEYS[repository.people]))
        : (people === 'any' ? null : t(TRACKER_PEOPLE_LABEL_KEYS[people]));
    const summary = [statusText, peopleText, source === 'repository' ? labelSummary : priority === 'all' ? null : t(TRACKER_PRIORITY_LABEL_KEYS[priority])]
        .filter(Boolean)
        .join(' · ');
    const title = source === 'repository' ? [statusText, peopleText, appliedNames || null].filter(Boolean).join(' · ') : summary;
    const filterLabel = t('references.picker.filter.label');

    // GitHub reads these qualifiers out of the search text itself; the host
    // then ignores the control, so the control shows it has been taken over
    // rather than offering a choice that changes nothing.
    const group = <T extends string>(
        label: string,
        value: T,
        options: readonly T[],
        labelOf: (option: T) => string,
        onSelect: (option: T) => void,
        takenQualifier: string | null = null,
    ) => (
        <>
            <DropdownMenuLabel>{takenQualifier ? `${label} · ${takenQualifier}` : label}</DropdownMenuLabel>
            <DropdownMenuRadioGroup
                value={takenQualifier ? '' : value}
                onValueChange={(next) => {
                    const option = options.find((entry) => entry === next);
                    if (option) onSelect(option);
                }}
            >
                {options.map((option) => (
                    <DropdownMenuRadioItem key={option} value={option} disabled={takenQualifier !== null} className={takenQualifier ? 'opacity-50' : undefined}>
                        {labelOf(option)}
                    </DropdownMenuRadioItem>
                ))}
            </DropdownMenuRadioGroup>
        </>
    );

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    aria-label={appliedNames ? `${filterLabel}: ${appliedNames}` : filterLabel}
                    title={title}
                    className={cn(dropdownTriggerVariants({ size: browser.isMobile ? 'mobile' : 'default' }), 'min-w-0 max-w-[18rem] shrink-0', browser.isMobile && 'max-w-[45%]')}
                >
                    <span className="flex min-w-0 items-center gap-1.5">
                        <Icon name="filter-3" className="size-4" />
                        <span className="truncate">{summary}</span>
                    </span>
                    <Icon name="arrow-down-s" className="size-4 opacity-50" />
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
                align="end"
                className={cn('max-h-[min(var(--available-height),28rem)] overflow-y-auto', labelsAvailable ? 'w-64' : 'w-56')}
            >
                {source === 'repository' ? (
                    <>
                        {group(t('references.picker.filter.group.status'), repository.state, REPOSITORY_STATES[browser.repositoryKind], (option) => t(REPOSITORY_STATE_LABEL_KEYS[option]), (option) => browser.selectRepositoryFilter({ state: option }), stateQualifier)}
                        <DropdownMenuSeparator />
                        {group(t('references.picker.filter.group.people'), repository.people, REPOSITORY_PEOPLE[browser.repositoryKind], (option) => t(REPOSITORY_PEOPLE_LABEL_KEYS[option]), (option) => browser.selectRepositoryFilter({ people: option }), peopleQualifier)}
                        {labelsAvailable ? (
                            <ReferenceLabelSection
                                directory={browser.directory}
                                applied={shownLabels}
                                onChange={(labels) => browser.selectRepositoryFilter({ labels })}
                            />
                        ) : null}
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
    const discussions = !tracked && browser.repositoryKind === 'discussion';
    const placeholder = t(tracked ? 'references.picker.search.tracker' : discussions ? 'references.picker.search.discussions' : `references.picker.search.${term}`);
    // The phone's field shares its row with the filter, so it gets the short wording;
    // the label keeps the full one.
    const shortPlaceholder = t(tracked
        ? 'references.picker.search.mobile.tracker'
        : discussions ? 'references.picker.search.mobile.discussions' : `references.picker.search.mobile.${term}`);
    // Only GitHub parses the search text; elsewhere the same words would be
    // matched as plain text, so no hint is offered.
    const advancedHint = source === 'repository' && !discussions && browser.descriptor.features.advancedSearch
        ? ` · ${t('references.picker.search.advancedHint')}`
        : '';

    return (
        <div className={cn('flex items-center gap-2', !isMobile && 'min-w-[14rem] flex-1')}>
            <div className="relative min-w-0 flex-1">
                <Icon name="search" className={cn('pointer-events-none absolute inset-s-2.5 top-1/2 -translate-y-1/2 text-muted-foreground', isMobile ? 'size-3.5' : 'size-4')} />
                <Input
                    ref={searchRef}
                    autoFocus={!isMobile}
                    value={query}
                    onChange={(event) => browser.setQuery(event.target.value)}
                    onKeyDown={onKeyDown}
                    placeholder={isMobile ? shortPlaceholder : placeholder + advancedHint}
                    aria-label={placeholder}
                    title={placeholder + advancedHint}
                    inputSize={isMobile ? 'default' : 'compact'}
                    className={cn('w-full', isMobile ? PICKER_SEARCH_INPUT_CLASS : 'ps-8', 'pe-14')}
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
        if (repositoryKind === 'discussion') return t('references.picker.empty.discussions');
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
