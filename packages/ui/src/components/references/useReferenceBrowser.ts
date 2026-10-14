/**
 * The list and preview state behind the reference picker and the issues and
 * PRs board: the GitHub tab and filter, the search, the highlighted row and
 * the details of the item it rests on. Each surface lays these parts out and
 * adds what it does with an item: the picker checks and attaches, the board
 * acts on the previewed one.
 */

import * as React from 'react';

import { handleDropdownNavigationKey } from '@/components/ui/dropdown-navigation';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import type { GitHubPullStatus, GitHubReference, GitHubReferenceKind, RepositoryReferenceFilter } from '@/lib/api/types';
import { isIMECompositionEvent } from '@/lib/ime';

import { itemDirectory, leftOutFolders, type AcrossReference } from './acrossRepositories';
import type { CachedValue } from './referenceCache';
import {
    referencePickerItemKey,
    DEFAULT_LINEAR_FILTER,
    DEFAULT_REPOSITORY_FILTER,
    type LinearReferenceFilter,
    type ReferencePickerItem,
    type ReferencePickerSource,
} from './referencePickerItems';
import {
    useGitHubAcrossReferenceList,
    useGitHubPullStatuses,
    useGitHubPullStatusesAcross,
    useGitHubReferenceDetail,
    useGitHubReferenceList,
    useGitHubSourceStatus,
    useLinearIssueDetail,
    useLinearReferenceList,
    useLinearSourceStatus,
    useRepositoryReferenceProvider,
} from './referenceSources';

// Remembered for the app run: reopening lands on the tab and filter left last.
let lastGitHubKind: GitHubReferenceKind = 'issue';
const lastGitHubFilter = new Map<GitHubReferenceKind, RepositoryReferenceFilter>();
let lastLinearFilter: LinearReferenceFilter = DEFAULT_LINEAR_FILTER;

const NO_REFERENCES: GitHubReference[] = [];
const NO_DIRECTORIES: readonly string[] = [];
const NO_ACROSS_ITEMS: AcrossReference[] = [];
const NO_ITEMS: ReadonlyMap<string, ReferencePickerItem> = new Map();
const SEARCH_DEBOUNCE_MS = 300;
const DETAIL_DEBOUNCE_MS = 250;

export const IDLE_PULL_STATUS: CachedValue<GitHubPullStatus | null> = { status: 'idle' };
export const readyValue = <T,>(state: CachedValue<T | null>): T | null => (state.status === 'ready' ? state.value : null);

export type ReferenceBrowserOptions = {
    source: ReferencePickerSource;
    /** The project GitHub or GitLab items come from. */
    directory: string | null;
    /**
     * Set to list the GitHub issues and PRs of these folders (the repositories
     * under `directory`) together instead of `directory`'s own; each item then
     * carries the folder it belongs to.
     */
    directories?: readonly string[] | null;
    isMobile: boolean;
    /** Tab to open GitHub on; the last used one otherwise. */
    initialGitHubKind?: GitHubReferenceKind;
    /** One Linear team's issues; every team's when absent. */
    linearTeamId?: string | null;
    /** Items kept outside the list (the picker's checked ones) that can still be previewed. */
    retainedItems?: ReadonlyMap<string, ReferencePickerItem>;
    /** One item another surface asked to show, read on its own: it can be highlighted while the list does not hold it. */
    pinnedItem?: ReferencePickerItem | null;
};

export function useReferenceBrowser({
    source,
    directory,
    directories = null,
    isMobile,
    initialGitHubKind,
    linearTeamId,
    retainedItems = NO_ITEMS,
    pinnedItem = null,
}: ReferenceBrowserOptions) {
    const [githubKind, setGitHubKind] = React.useState<GitHubReferenceKind>(initialGitHubKind ?? lastGitHubKind);
    const [githubFilter, setGitHubFilter] = React.useState<RepositoryReferenceFilter>(lastGitHubFilter.get(initialGitHubKind ?? lastGitHubKind) ?? DEFAULT_REPOSITORY_FILTER);
    const [linearFilter, setLinearFilter] = React.useState<LinearReferenceFilter>(lastLinearFilter);
    const [query, setQueryState] = React.useState('');
    const debouncedQuery = useDebouncedValue(query, SEARCH_DEBOUNCE_MS);
    const [highlightedKey, setHighlightedKey] = React.useState<string | null>(null);
    const [mobilePreviewKey, setMobilePreviewKey] = React.useState<string | null>(null);
    const [now] = React.useState(() => Date.now());
    const searchRef = React.useRef<HTMLInputElement>(null);

    const across = directories !== null;
    // Across repositories the folders answer for themselves: the list reports
    // those it cannot read, so no single project's status gates it.
    const githubStatus = useGitHubSourceStatus(across ? null : directory);
    // A GitLab project lists in the same tabs, as merge requests, open items only.
    const isGitLab = useRepositoryReferenceProvider(across ? null : directory) === 'gitlab' && !across;
    const linearStatus = useLinearSourceStatus();
    const sourceStatus = source === 'github' ? githubStatus : linearStatus;

    const githubList = useGitHubReferenceList({
        enabled: source === 'github' && githubStatus === 'ready' && !across,
        directory,
        kind: githubKind,
        filter: githubFilter,
        query: debouncedQuery,
    });
    const acrossList = useGitHubAcrossReferenceList({
        enabled: source === 'github' && githubStatus === 'ready' && across,
        directories: directories ?? NO_DIRECTORIES,
        kind: githubKind,
        filter: githubFilter,
        query: debouncedQuery,
    });
    const linearList = useLinearReferenceList({
        enabled: source === 'linear' && linearStatus === 'ready',
        filter: linearFilter,
        query: debouncedQuery,
        teamId: linearTeamId,
    });
    // The other GitHub tab loads in the background, so switching to it is instant.
    const otherGitHubKind: GitHubReferenceKind = githubKind === 'issue' ? 'pull' : 'issue';
    useGitHubReferenceList({
        enabled: source === 'github' && githubStatus === 'ready' && !across,
        directory,
        kind: otherGitHubKind,
        filter: lastGitHubFilter.get(otherGitHubKind) ?? DEFAULT_REPOSITORY_FILTER,
        query: '',
    });
    useGitHubAcrossReferenceList({
        enabled: source === 'github' && githubStatus === 'ready' && across,
        directories: directories ?? NO_DIRECTORIES,
        kind: otherGitHubKind,
        filter: lastGitHubFilter.get(otherGitHubKind) ?? DEFAULT_REPOSITORY_FILTER,
        query: '',
    });
    const list = source === 'github' ? (across ? acrossList : githubList) : linearList;
    // Failed checks and conflicts colour open PRs once their statuses arrive.
    const singlePullStatusOf = useGitHubPullStatuses(across ? null : directory, source === 'github' && !across ? githubList.items : NO_REFERENCES);
    const acrossPullStatusOf = useGitHubPullStatusesAcross(acrossList.contexts, source === 'github' && across ? acrossList.items : NO_ACROSS_ITEMS);
    const pullStatusOf = (reference: GitHubReference, itemFolder?: string): CachedValue<GitHubPullStatus | null> => (
        across ? acrossPullStatusOf(reference, itemFolder ?? null) : singlePullStatusOf(reference)
    );
    // Folders a list across repositories does not show: never asked, or skipped by the answer.
    const leftOut = React.useMemo(
        () => (across && source === 'github' ? leftOutFolders(acrossList.contexts, acrossList.skipped) : []),
        [across, acrossList.contexts, acrossList.skipped, source],
    );

    const items = React.useMemo<ReferencePickerItem[]>(() => {
        if (source === 'linear') return linearList.items.map((issue) => ({ source: 'linear', issue }));
        if (across) return acrossList.items.map((reference) => ({ source: 'github', reference, directory: reference.directory }));
        return githubList.items.map((reference) => ({ source: 'github', reference }));
    }, [across, acrossList.items, githubList.items, linearList.items, source]);

    // An item opened from the preview (a Linear parent or sub-issue): it can be
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
    const { detail: linearDetail } = useLinearIssueDetail(previewItem?.source === 'linear' ? previewItem.issue.id : null, previewSettled);
    // Each item is read through the folder it came from.
    const { detail: githubDetail, refresh: refreshGithubDetail } = useGitHubReferenceDetail(itemDirectory(previewItem, directory), previewItem?.source === 'github' ? previewItem.reference : null, previewSettled);

    const selectGitHubKind = (kind: GitHubReferenceKind) => {
        lastGitHubKind = kind;
        setGitHubKind(kind);
        setGitHubFilter(lastGitHubFilter.get(kind) ?? DEFAULT_REPOSITORY_FILTER);
        setHighlightedKey(null);
    };
    /** Changes the state or whose items, keeping the other. */
    const selectGitHubFilter = (patch: Partial<RepositoryReferenceFilter>) => {
        const filter = { ...githubFilter, ...patch };
        lastGitHubFilter.set(githubKind, filter);
        setGitHubFilter(filter);
        setHighlightedKey(null);
    };
    /** Changes one part of the Linear filter, keeping the others. */
    const selectLinearFilter = (patch: Partial<LinearReferenceFilter>) => {
        const filter = { ...linearFilter, ...patch };
        lastLinearFilter = filter;
        setLinearFilter(filter);
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

    /** Previews an item the list may not hold, such as a Linear issue's parent or sub-issue. */
    const openItem = (item: ReferencePickerItem) => {
        setOpenedItem(item);
        showItem(referencePickerItemKey(item));
    };

    return {
        source,
        directory,
        across,
        leftOut,
        isMobile,
        isGitLab,
        sourceStatus,
        githubKind,
        githubFilter,
        linearFilter,
        query,
        debouncedQuery,
        setQuery,
        selectGitHubKind,
        selectGitHubFilter,
        selectLinearFilter,
        list,
        items,
        pullStatusOf,
        effectiveHighlightKey,
        highlightedItem,
        previewKey,
        previewItem,
        mobilePreviewKey,
        closeMobilePreview: () => setMobilePreviewKey(null),
        linearDetail,
        githubDetail,
        refreshGithubDetail,
        now,
        searchRef,
        handleNavigationKey,
        showItem,
        openItem,
    };
}

export type ReferenceBrowser = ReturnType<typeof useReferenceBrowser>;

