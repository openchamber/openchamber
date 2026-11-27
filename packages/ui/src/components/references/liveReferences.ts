
import * as React from 'react';

import type {
    RepositoryDiscussionReference,
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

const SERVER_CACHE_MS = 30_000;
const FOLLOW_LIMIT = 50;

export const isNewerThanRead = (answeredAt: number, read: ReadStamp): boolean => (
    answeredAt > (read.forced ? read.at : read.at - SERVER_CACHE_MS)
);

const pageReadOf = (pageReads: readonly PageRead[], index: number): ReadStamp | null => {
    let found: ReadStamp | null = null;
    for (const page of pageReads) if (page.start <= index) found = page.read;
    return found;
};

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

type PullPatch = Partial<Pick<RepositoryChangeRequestReference, 'state' | 'draft' | 'title' | 'headSha' | 'base'>>;
type IssuePatch = Partial<Pick<RepositoryIssueReference, 'state' | 'title'>>;
type DiscussionPatch = Partial<Pick<RepositoryDiscussionReference, 'state' | 'title' | 'answered'>>;

function referencePatch(reference: RepositoryReference, record: TrackedItemState): PullPatch | IssuePatch | DiscussionPatch | null {
    if (reference.kind === 'pull' && record.type === 'pull' && record.state) {
        const { state, draft, title } = record.state;
        const headSha = record.state.headSha ?? reference.headSha;
        const base = record.state.base ?? reference.base;
        if (state === reference.state && draft === reference.draft && title === reference.title && headSha === reference.headSha && base === reference.base) return null;
        return { state, draft, title, headSha, base };
    }
    if (reference.kind === 'issue' && record.type === 'issue' && record.state) {
        const { state, title } = record.state;
        if (state === reference.state && title === reference.title) return null;
        return { state, title };
    }
    if (reference.kind === 'discussion' && record.type === 'discussion' && record.state) {
        const { state, title, answered } = record.state;
        if (state === reference.state && title === reference.title && answered === reference.answered) return null;
        return { state, title, answered };
    }
    return null;
}

function workItemPatch(item: TrackerItemSummary, record: TrackedItemState): Pick<TrackerItemSummary, 'title' | 'state'> | null {
    if (record.type !== 'work-item' || !record.state) return null;
    const { title, state } = record.state;
    if (title === item.title && state.name === item.state?.name && state.category === item.state?.category) return null;
    const id = state.name === item.state?.name ? item.state?.id ?? null : null;
    return { title, state: { id, name: state.name, category: state.category } };
}

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

const followedOf = (tracked: ReadonlyArray<TrackedItem | null>): TrackedItem[] => (
    tracked.filter((item): item is TrackedItem => item !== null).slice(0, FOLLOW_LIMIT)
);

export type LiveItems<T> = { items: T[]; followed: TrackedItem[] };

export type LivePullStatus = { status: ChangeRequestListStatus; fetchedAt: number };

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

export function useLiveTrackerItems<T extends TrackerItemSummary>(items: T[], pageReads: readonly PageRead[]): LiveItems<T> {
    const tracked = React.useMemo(() => items.map(trackedWorkItemOf), [items]);
    const records = useTrackedRecords(tracked);
    const live = React.useMemo(() => overlay(items, records, pageReads, workItemPatch), [items, pageReads, records]);
    const followed = React.useMemo(() => followedOf(tracked), [tracked]);
    return { items: live, followed };
}

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
