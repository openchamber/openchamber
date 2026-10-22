/**
 * The list and preview state behind the reference picker and the issues and
 * PRs board: the repository tab and filter, the search, the highlighted row and
 * the details of the item it rests on. Each surface lays these parts out and
 * adds what it does with an item: the picker checks and attaches, the board
 * acts on the previewed one.
 */

import * as React from 'react';

import { handleDropdownNavigationKey } from '@/components/ui/dropdown-navigation';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useMinuteTickerNow } from '@/hooks/useDurationTicker';
import type { ChangeRequestListStatus, RepositoryReference, RepositoryReferenceKind, RepositoryReferenceFilter } from '@/lib/api/types';
import { isIMECompositionEvent } from '@/lib/ime';
import { useSourceControlProvider } from '@/lib/source-control/providers/registry';
import { useTrackedItems } from '@/lib/trackedItems/interest';
import type { TrackedItem } from '@/lib/trackedItems/model';

import { itemDirectory, leftOutFolders, type AcrossReference } from './acrossRepositories';
import type { CachedValue } from './referenceCache';
import {
    referencePickerItemKey,
    trackerOfSource,
    DEFAULT_REPOSITORY_FILTER,
    DEFAULT_TRACKER_FILTER,
    type ReferencePickerItem,
    type ReferencePickerSource,
    type TrackerReferenceFilter,
} from './referencePickerItems';
import {
    useRepositoryAcrossReferenceList,
    useRepositoryPullStatuses,
    useRepositoryPullStatusesAcross,
    useRepositoryReferenceDetail,
    useRepositoryReferenceList,
    useRepositoryReferenceProvider,
    useRepositorySourceStatus,
    useTrackerItemDetail,
    useTrackerReferenceList,
} from './referenceSources';
import { useTrackerDescriptor } from '@/lib/trackers/registry';
import { useTrackerSourceStatus } from '@/lib/trackers/sources';

// Remembered for the app run: reopening lands on the tab and filter left last.
let lastRepositoryKind: RepositoryReferenceKind = 'issue';
const lastRepositoryFilter = new Map<RepositoryReferenceKind, RepositoryReferenceFilter>();
const lastTrackerFilter = new Map<string, TrackerReferenceFilter>();

const NO_REFERENCES: RepositoryReference[] = [];
const NO_DIRECTORIES: readonly string[] = [];
const NO_ACROSS_ITEMS: AcrossReference[] = [];
const NO_ITEMS: ReadonlyMap<string, ReferencePickerItem> = new Map();
const NO_FOLLOWED: TrackedItem[] = [];
const SEARCH_DEBOUNCE_MS = 300;
const DETAIL_DEBOUNCE_MS = 250;

export const IDLE_PULL_STATUS: CachedValue<ChangeRequestListStatus | null> = { status: 'idle' };
export const readyValue = <T,>(state: CachedValue<T | null>): T | null => (state.status === 'ready' ? state.value : null);

export type ReferenceBrowserOptions = {
    source: ReferencePickerSource;
    /** The project repository items come from. */
    directory: string | null;
    /**
     * Set to list the issues and PRs of these folders (the repositories
     * under `directory`) together instead of `directory`'s own; each item then
     * carries the folder it belongs to.
     */
    directories?: readonly string[] | null;
    isMobile: boolean;
    /** Tab to open the repository source on; the last used one otherwise. */
    initialGitHubKind?: RepositoryReferenceKind;
    /** One tracker container's items (a Linear team); every container's when absent. */
    trackerContainerId?: string | null;
    /** Items kept outside the list (the picker's checked ones) that can still be previewed. */
    retainedItems?: ReadonlyMap<string, ReferencePickerItem>;
    /** One item another surface asked to show, read on its own: it can be highlighted while the list does not hold it. */
    pinnedItem?: ReferencePickerItem | null;
    /** Whether the surface is on screen; the open items its list shows are then followed live. */
    onScreen?: boolean;
};

export function useReferenceBrowser({
    source,
    directory,
    directories = null,
    isMobile,
    initialGitHubKind,
    trackerContainerId,
    retainedItems = NO_ITEMS,
    pinnedItem = null,
    onScreen = true,
}: ReferenceBrowserOptions) {
    const [repositoryKind, setRepositoryKind] = React.useState<RepositoryReferenceKind>(initialGitHubKind ?? lastRepositoryKind);
    const [repositoryFilter, setRepositoryFilter] = React.useState<RepositoryReferenceFilter>(lastRepositoryFilter.get(initialGitHubKind ?? lastRepositoryKind) ?? DEFAULT_REPOSITORY_FILTER);
    const tracker = trackerOfSource(source);
    const trackerDescriptor = useTrackerDescriptor(tracker);
    // A filter the tracker no longer offers reads as its default.
    const [chosenFilter, setTrackerFilter] = React.useState<{ tracker: string; filter: TrackerReferenceFilter } | null>(null);
    const rememberedFilter = (chosenFilter && chosenFilter.tracker === tracker ? chosenFilter.filter : undefined)
        ?? (tracker ? lastTrackerFilter.get(tracker) : undefined)
        ?? DEFAULT_TRACKER_FILTER;
    const trackerFilter = React.useMemo<TrackerReferenceFilter>(() => ({
        state: trackerDescriptor.stateFilters.includes(rememberedFilter.state) ? rememberedFilter.state : DEFAULT_TRACKER_FILTER.state,
        people: trackerDescriptor.capabilities.filters.people ? rememberedFilter.people : DEFAULT_TRACKER_FILTER.people,
        priority: trackerDescriptor.capabilities.filters.priority ? rememberedFilter.priority : DEFAULT_TRACKER_FILTER.priority,
    }), [rememberedFilter, trackerDescriptor]);
    const [query, setQueryState] = React.useState('');
    const debouncedQuery = useDebouncedValue(query, SEARCH_DEBOUNCE_MS);
    const [highlightedKey, setHighlightedKey] = React.useState<string | null>(null);
    const [mobilePreviewKey, setMobilePreviewKey] = React.useState<string | null>(null);
    // "5m ago" labels; the board stays open for hours, so the clock moves.
    const now = useMinuteTickerNow(true);
    const searchRef = React.useRef<HTMLInputElement>(null);

    const across = directories !== null;
    // Across repositories the folders answer for themselves: the list reports
    // those it cannot read, so no single project's status gates it.
    const repositoryStatus = useRepositorySourceStatus(across ? null : directory);
    const trackerStatus = useTrackerSourceStatus(tracker);
    const sourceStatus = source === 'repository' ? repositoryStatus : trackerStatus;

    const repositoryList = useRepositoryReferenceList({
        enabled: source === 'repository' && repositoryStatus === 'ready' && !across,
        directory,
        kind: repositoryKind,
        filter: repositoryFilter,
        query: debouncedQuery,
    });
    const acrossList = useRepositoryAcrossReferenceList({
        enabled: source === 'repository' && repositoryStatus === 'ready' && across,
        directories: directories ?? NO_DIRECTORIES,
        kind: repositoryKind,
        filter: repositoryFilter,
        query: debouncedQuery,
    });
    const trackerList = useTrackerReferenceList({
        enabled: tracker !== null && trackerStatus === 'ready',
        provider: tracker,
        filter: trackerFilter,
        query: debouncedQuery,
        containerId: trackerContainerId,
    });
    // Who hosts the items, for their wording and mark: the project's provider,
    // or across repositories the one the search asks.
    const projectProvider = useRepositoryReferenceProvider(across ? null : directory);
    const descriptor = useSourceControlProvider(across ? acrossList.contexts.provider : projectProvider);
    const term = descriptor.terminology.changeRequest;

    // The other repository tab loads in the background, so switching to it is instant.
    const otherRepositoryKind: RepositoryReferenceKind = repositoryKind === 'issue' ? 'pull' : 'issue';
    useRepositoryReferenceList({
        enabled: source === 'repository' && repositoryStatus === 'ready' && !across,
        directory,
        kind: otherRepositoryKind,
        filter: lastRepositoryFilter.get(otherRepositoryKind) ?? DEFAULT_REPOSITORY_FILTER,
        query: '',
    });
    useRepositoryAcrossReferenceList({
        enabled: source === 'repository' && repositoryStatus === 'ready' && across,
        directories: directories ?? NO_DIRECTORIES,
        kind: otherRepositoryKind,
        filter: lastRepositoryFilter.get(otherRepositoryKind) ?? DEFAULT_REPOSITORY_FILTER,
        query: '',
    });
    const list = source === 'repository' ? (across ? acrossList : repositoryList) : trackerList;
    // Only the list on screen is followed; the other tab is read again when shown.
    useTrackedItems(onScreen ? list.followed : NO_FOLLOWED);
    // Failed checks and conflicts colour open PRs once their statuses arrive.
    const singlePullStatusOf = useRepositoryPullStatuses(across ? null : directory, source === 'repository' && !across ? repositoryList.items : NO_REFERENCES);
    const acrossPullStatusOf = useRepositoryPullStatusesAcross(acrossList.contexts, source === 'repository' && across ? acrossList.items : NO_ACROSS_ITEMS);
    const pullStatusOf = (reference: RepositoryReference, itemFolder?: string): CachedValue<ChangeRequestListStatus | null> => (
        across ? acrossPullStatusOf(reference, itemFolder ?? null) : singlePullStatusOf(reference)
    );
    // Folders a list across repositories does not show: never asked, or skipped by the answer.
    const leftOut = React.useMemo(
        () => (across && source === 'repository' ? leftOutFolders(acrossList.contexts, acrossList.skipped) : []),
        [across, acrossList.contexts, acrossList.skipped, source],
    );

    const items = React.useMemo<ReferencePickerItem[]>(() => {
        if (tracker) return trackerList.items.map((item) => ({ source: 'tracker', provider: tracker, item }));
        if (across) return acrossList.items.map((reference) => ({ source: 'repository', reference, directory: reference.directory }));
        return repositoryList.items.map((reference) => ({ source: 'repository', reference }));
    }, [across, acrossList.items, repositoryList.items, trackerList.items, tracker]);

    // An item opened from the preview (a tracker item's parent or child): it can be
    // highlighted while the list does not hold it, like a pinned one.
    const [openedItem, setOpenedItem] = React.useState<ReferencePickerItem | null>(null);

    // The highlight follows the list: the first row until the user moves it,
    // and the first row again when the highlighted one leaves the list.
    const pinnedKey = pinnedItem ? referencePickerItemKey(pinnedItem) : null;
    const openedKey = openedItem ? referencePickerItemKey(openedItem) : null;
    const effectiveHighlightKey = highlightedKey && (highlightedKey === pinnedKey || highlightedKey === openedKey || items.some((item) => referencePickerItemKey(item) === highlightedKey))
        ? highlightedKey
        : (items[0] ? referencePickerItemKey(items[0]) : null);
    const findItem = (key: string | null) => (key
        ? items.find((item) => referencePickerItemKey(item) === key)
            ?? retainedItems.get(key)
            ?? (key === pinnedKey ? pinnedItem : null)
            ?? (key === openedKey ? openedItem : null)
        : null);
    const highlightedItem = findItem(effectiveHighlightKey);
    const previewKey = isMobile ? mobilePreviewKey : effectiveHighlightKey;
    const previewItem = findItem(previewKey);

    // Details are asked for the row the highlight rests on, not every row an
    // arrow key passes over; one already fetched shows at once.
    const settledPreviewItem = useDebouncedValue(previewItem, DETAIL_DEBOUNCE_MS);
    const previewSettled = Boolean(settledPreviewItem && previewItem
        && referencePickerItemKey(settledPreviewItem) === referencePickerItemKey(previewItem));
    const { detail: trackerDetail } = useTrackerItemDetail(
        previewItem?.source === 'tracker' ? { provider: previewItem.provider, id: previewItem.item.id } : null,
        previewSettled,
    );
    // The revision picked for the previewed change; another item, or the latest, reads as none.
    const [revisionChoice, setRevisionChoice] = React.useState<{ key: string; sha: string } | null>(null);
    const previewRevision = revisionChoice && previewKey !== null && revisionChoice.key === previewKey ? revisionChoice.sha : null;
    const selectPreviewRevision = React.useCallback((sha: string | null) => {
        setRevisionChoice(sha && previewKey !== null ? { key: previewKey, sha } : null);
    }, [previewKey]);
    // Each item is read through the folder it came from.
    const { detail: repositoryDetail, latest: repositoryLatestDetail, refresh: refreshRepositoryDetail } = useRepositoryReferenceDetail(
        itemDirectory(previewItem, directory),
        previewItem?.source === 'repository' ? previewItem.reference : null,
        previewSettled,
        previewRevision,
    );

    const selectRepositoryKind = (kind: RepositoryReferenceKind) => {
        lastRepositoryKind = kind;
        setRepositoryKind(kind);
        setRepositoryFilter(lastRepositoryFilter.get(kind) ?? DEFAULT_REPOSITORY_FILTER);
        setHighlightedKey(null);
    };
    /** Changes the state or whose items, keeping the other. */
    const selectRepositoryFilter = (patch: Partial<RepositoryReferenceFilter>) => {
        const filter = { ...repositoryFilter, ...patch };
        lastRepositoryFilter.set(repositoryKind, filter);
        setRepositoryFilter(filter);
        setHighlightedKey(null);
    };
    /** Changes one part of the tracker filter, keeping the others; remembered per tracker. */
    const selectTrackerFilter = (patch: Partial<TrackerReferenceFilter>) => {
        if (!tracker) return;
        const filter = { ...trackerFilter, ...patch };
        lastTrackerFilter.set(tracker, filter);
        setTrackerFilter({ tracker, filter });
        setHighlightedKey(null);
    };
    const setQuery = React.useCallback((value: string) => {
        setQueryState(value);
        setHighlightedKey(null);
    }, []);

    const moveHighlight = React.useCallback((direction: 1 | -1) => {
        if (items.length === 0) return;
        const index = items.findIndex((item) => referencePickerItemKey(item) === effectiveHighlightKey);
        const next = items[Math.min(items.length - 1, Math.max(0, index + direction))];
        if (next) setHighlightedKey(referencePickerItemKey(next));
        if (direction === 1 && index >= items.length - 3) list.loadMore();
    }, [effectiveHighlightKey, items, list]);

    /** Arrows and Ctrl+N/P from the search field; true when the key was used. */
    const handleNavigationKey = (event: React.KeyboardEvent<HTMLInputElement>): boolean => {
        if (isIMECompositionEvent(event)) return false;
        if (handleDropdownNavigationKey(event, (key) => moveHighlight(key === 'ArrowDown' ? 1 : -1))) return true;
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return false;
        event.preventDefault();
        moveHighlight(event.key === 'ArrowDown' ? 1 : -1);
        return true;
    };

    /** A row click: highlights on desktop, opens the preview in place on mobile. */
    const showItem = (key: string) => {
        if (isMobile) {
            setMobilePreviewKey(key);
            return;
        }
        setHighlightedKey(key);
        searchRef.current?.focus();
    };

    /** Previews an item the list may not hold, such as a tracker item's parent or child. */
    const openItem = (item: ReferencePickerItem) => {
        setOpenedItem(item);
        showItem(referencePickerItemKey(item));
    };

    return {
        source,
        directory,
        across,
        /** Across repositories, the provider the search asks; null otherwise or while unknown. */
        acrossProvider: across ? acrossList.contexts.provider : null,
        leftOut,
        isMobile,
        descriptor,
        term,
        sourceStatus,
        repositoryKind,
        repositoryFilter,
        tracker,
        trackerDescriptor,
        trackerFilter,
        query,
        debouncedQuery,
        setQuery,
        selectRepositoryKind,
        selectRepositoryFilter,
        selectTrackerFilter,
        list,
        items,
        pullStatusOf,
        effectiveHighlightKey,
        highlightedItem,
        previewKey,
        previewItem,
        mobilePreviewKey,
        closeMobilePreview: () => setMobilePreviewKey(null),
        trackerDetail,
        repositoryDetail,
        repositoryLatestDetail,
        refreshRepositoryDetail,
        previewRevision,
        selectPreviewRevision,
        now,
        searchRef,
        handleNavigationKey,
        showItem,
        openItem,
    };
}

export type ReferenceBrowser = ReturnType<typeof useReferenceBrowser>;

