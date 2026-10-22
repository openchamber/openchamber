/**
 * Listed items kept current by the server's tracked items, the same live
 * state behind the sidebar's badges (`lib/trackedItems`).
 *
 * A list, and a PR status asked for it, is what the host said when it was
 * read; nothing reads it again while it stays on screen. The open items it
 * shows are followed instead: the server reads them on a cadence (30 s while
 * checks run), after an agent turn, after a change made through the app, and
 * pushes a state only when it moved. A followed state answered after the
 * list was read is laid over the listed item; an older one never is.
 */

import * as React from 'react';

import type {
    RepositoryIssueReference,
    RepositoryChangeRequestReference,
    ChangeRequestListStatus,
    RepositoryReference,
    SourceControlReadContext,
    TrackerItemSummary,
} from '@/lib/api/types';
import { useRepositoryUrlMatcher, type RepositoryUrlMatcher } from '@/lib/source-control/repositoryUrlMatcher';
import { workItem } from '@/lib/trackedItems/fromLinks';
import { trackedItemKey, type TrackedItem, type TrackedItemState, type TrackedThread, type TrackedWorkItem } from '@/lib/trackedItems/model';
import { isSettledTrackerState } from '@/lib/trackers/stateLook';
import { useTrackedRecords } from '@/stores/useTrackedItemsStore';

import type { PageRead, ReadStamp } from './referenceCache';

// The server answers a list from its own short-lived cache (up to 30 s old),
// so a list counts as read that much before the client got it, unless the
// read was forced after a change or a refresh, which the server answers anew.
const SERVER_CACHE_MS = 30_000;
// A list can page far; its first open items are followed, the rest keep what
// their page said. The server reads GitHub PRs 25 to a query, one query after
// another, and a slow tick delays the sidebar's updates too: two queries.
const FOLLOW_LIMIT = 50;

/** Whether a followed answer from `answeredAt` came after a snapshot read at `read`. */
export const isNewerThanRead = (answeredAt: number, read: ReadStamp): boolean => (
    answeredAt > (read.forced ? read.at : read.at - SERVER_CACHE_MS)
);

/** When the page holding the item at `index` was read. */
const pageReadOf = (pageReads: readonly PageRead[], index: number): ReadStamp | null => {
    let found: ReadStamp | null = null;
    for (const page of pageReads) if (page.start <= index) found = page.read;
    return found;
};

/**
 * The item the server follows for a listed issue or PR, read with the account
 * the list was read with; null for one that is no longer open. The address
 * names the repository the way the provider does (a GitLab project's full
 * path, subgroups included); an address no pattern of the context's provider
 * reads falls back to the listed repository.
 */
function trackedThreadOf(
    reference: RepositoryReference,
    context: SourceControlReadContext | null,
    urls: RepositoryUrlMatcher,
): TrackedThread | null {
    if (!context || reference.state !== 'open') return null;
    const match = urls.match(reference.url);
    const named = match && match.provider === context.provider ? match : null;
    return {
        provider: context.provider,
        instance: context.instance,
        kind: reference.kind,
        owner: named?.owner ?? reference.sourceRepo.owner,
        repo: named?.repo ?? reference.sourceRepo.repo,
        number: reference.number,
        accountId: context.accountId,
    };
}

const trackedWorkItemOf = (item: TrackerItemSummary): TrackedWorkItem | null => (
    isSettledTrackerState(item.state?.category) ? null : workItem(item.provider, item.identifier)
);

type PullPatch = Partial<Pick<RepositoryChangeRequestReference, 'state' | 'draft' | 'title' | 'headSha'>>;
type IssuePatch = Partial<Pick<RepositoryIssueReference, 'state' | 'title'>>;

/** What the followed state changes on a listed item; null when nothing. */
function referencePatch(reference: RepositoryReference, record: TrackedItemState): PullPatch | IssuePatch | null {
    if (reference.kind === 'pull' && record.type === 'pull' && record.state) {
        const { state, draft, title } = record.state;
        const headSha = record.state.headSha ?? reference.headSha;
        if (state === reference.state && draft === reference.draft && title === reference.title && headSha === reference.headSha) return null;
        return { state, draft, title, headSha };
    }
    if (reference.kind === 'issue' && record.type === 'issue' && record.state) {
        const { state, title } = record.state;
        if (state === reference.state && title === reference.title) return null;
        return { state, title };
    }
    return null;
}

function workItemPatch(item: TrackerItemSummary, record: TrackedItemState): Pick<TrackerItemSummary, 'title' | 'state'> | null {
    if (record.type !== 'work-item' || !record.state) return null;
    const { title, state } = record.state;
    if (title === item.title && state.name === item.state?.name && state.category === item.state?.category) return null;
    // A state the tracker renamed keeps its id; a different state's id is not known here.
    const id = state.name === item.state?.name ? item.state?.id ?? null : null;
    return { title, state: { id, name: state.name, category: state.category } };
}

/** Lays newer followed states over `items`; the same array when none applies. */
function overlay<T>(
    items: T[],
    records: ReadonlyArray<TrackedItemState | null>,
    pageReads: readonly PageRead[],
    patchOf: (item: T, record: TrackedItemState) => object | null,
): T[] {
    let next: T[] | null = null;
    items.forEach((item, index) => {
        const record = records[index] ?? null;
        const read = pageReadOf(pageReads, index);
        if (!record?.state || !read || !isNewerThanRead(record.fetchedAt, read)) return;
        const patch = patchOf(item, record);
        if (!patch) return;
        next = next ?? [...items];
        next[index] = { ...item, ...patch };
    });
    return next ?? items;
}

/** The first `FOLLOW_LIMIT` open items, in list order. */
const followedOf = (tracked: ReadonlyArray<TrackedItem | null>): TrackedItem[] => (
    tracked.filter((item): item is TrackedItem => item !== null).slice(0, FOLLOW_LIMIT)
);

/** Listed items with their followed state, and what a surface on screen follows (`useTrackedItems`). */
export type LiveItems<T> = { items: T[]; followed: TrackedItem[] };

/** A followed PR's checks and mergeability, and when the server read them. */
export type LivePullStatus = { status: ChangeRequestListStatus; fetchedAt: number };

/**
 * Listed issues and PRs with their followed state. `contextOf` names the read
 * context an item came through; `pageReads` says when each page was read.
 */
export function useLiveReferences<T extends RepositoryReference>(
    items: T[],
    contextOf: (item: T) => SourceControlReadContext | null,
    pageReads: readonly PageRead[],
): LiveItems<T> {
    const urls = useRepositoryUrlMatcher();
    const tracked = React.useMemo(() => items.map((item) => trackedThreadOf(item, contextOf(item), urls)), [contextOf, items, urls]);
    const records = useTrackedRecords(tracked);
    const live = React.useMemo(() => overlay(items, records, pageReads, referencePatch), [items, pageReads, records]);
    const followed = React.useMemo(() => followedOf(tracked), [tracked]);
    return { items: live, followed };
}

/** The same for tracker work items: their state and title. */
export function useLiveTrackerItems<T extends TrackerItemSummary>(items: T[], pageReads: readonly PageRead[]): LiveItems<T> {
    const tracked = React.useMemo(() => items.map(trackedWorkItemOf), [items]);
    const records = useTrackedRecords(tracked);
    const live = React.useMemo(() => overlay(items, records, pageReads, workItemPatch), [items, pageReads, records]);
    const followed = React.useMemo(() => followedOf(tracked), [tracked]);
    return { items: live, followed };
}

/**
 * The followed checks and mergeability of each open PR in `pulls`, by item
 * key, with when they were answered. For a provider without list statuses
 * (`features.listStatuses`, GitLab) this is the only source of a change
 * request's checks.
 */
export function useLivePullStatuses(
    pulls: ReadonlyArray<{ reference: RepositoryReference; context: SourceControlReadContext | null }>,
): (reference: RepositoryReference, context: SourceControlReadContext | null) => LivePullStatus | null {
    const urls = useRepositoryUrlMatcher();
    const tracked = React.useMemo(
        () => pulls.map(({ reference, context }) => (reference.kind === 'pull' ? trackedThreadOf(reference, context, urls) : null)),
        [pulls, urls],
    );
    const records = useTrackedRecords(tracked);
    const byKey = React.useMemo(() => {
        const map = new Map<string, LivePullStatus>();
        records.forEach((record) => {
            if (record?.type !== 'pull' || !record.state || record.state.state !== 'open') return;
            const { owner, repo, number, checks, mergeable, mergeableState } = record.state;
            map.set(trackedItemKey(record.item), { status: { owner, repo, number, checks, mergeable, mergeableState }, fetchedAt: record.fetchedAt });
        });
        return map;
    }, [records]);
    return React.useCallback((reference, context) => {
        const item = reference.kind === 'pull' ? trackedThreadOf(reference, context, urls) : null;
        return item ? byKey.get(trackedItemKey(item)) ?? null : null;
    }, [byKey, urls]);
}
