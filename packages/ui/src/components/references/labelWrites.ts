/**
 * Label sets the app wrote, laid over listed items until the host's lists
 * catch up.
 *
 * A label write replaces the item's whole set, so a succeeded receipt means
 * the host now holds exactly the set asked for. The lists that show the item
 * can still answer the old set for a while after it: GitHub reads them through
 * its search index, which lags behind writes, so a re-read right after the
 * write can bring back the old labels, keep an item a label filter no longer
 * matches, or drop one it still does. For `HOLD_MS` after the write the
 * written set wins over whatever a list answers, and decides whether the item
 * belongs to a label-filtered list; after that the lists are believed again,
 * so a later change made elsewhere is not hidden. A close, reopen or merge
 * made through the app ends the hold at once (`forgetLabelWrite`): the item
 * then leaves its list for that change, not for the index.
 */

import * as React from 'react';

import type { Label, RepositoryReference } from '@/lib/api/types';

const HOLD_MS = 120_000;

/** The list an item was shown in when its labels were written, and where. */
export type LabelWriteListing = { listKey: string; index: number };

type LabelWrite = {
    labels: Label[];
    at: number;
    /** The item as written, put back where it was if its list drops it meanwhile. */
    reference: RepositoryReference;
    listing: LabelWriteListing | null;
};

export type LabelWrites = ReadonlyMap<string, LabelWrite>;

// The item's address names the host, the repository and the item, so equal
// numbers on two hosts never share an entry.
const writeKey = (reference: RepositoryReference): string => `${reference.kind}:${reference.url}`;

let writes: LabelWrites = new Map();
const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
};

/** Records a succeeded write of `reference`'s whole label set. */
export function recordLabelWrite(reference: RepositoryReference, labels: Label[], listing: LabelWriteListing | null, at = Date.now()): void {
    const next = new Map(writes);
    next.set(writeKey(reference), { labels, at, reference: { ...reference, labels }, listing });
    writes = next;
    for (const listener of listeners) listener();
}

/** Ends the hold on `reference`'s written labels, after the app changed its state. */
export function forgetLabelWrite(reference: RepositoryReference): void {
    const key = writeKey(reference);
    if (!writes.has(key)) return;
    const next = new Map(writes);
    next.delete(key);
    writes = next;
    for (const listener of listeners) listener();
}

export const useLabelWrites = (): LabelWrites => React.useSyncExternalStore(subscribe, () => writes);

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

const sameLabels = (a: readonly Label[], b: readonly Label[]) => (
    a.length === b.length && a.every((label) => b.some((other) => sameName(other.name, label.name)))
);

const matchesFilter = (labels: readonly Label[], filterLabels: readonly string[]) => (
    filterLabels.every((name) => labels.some((label) => sameName(label.name, name)))
);

/**
 * `items` with the labels written within the hold: a listed item shows the
 * written set and leaves a label-filtered list it no longer matches, and an
 * item a label-filtered list `listKey` showed when it was written comes back
 * at its place when the list's answer dropped it while the written set still
 * matches. Without a label filter a write cannot change membership, so a drop
 * there is a real change and stands.
 * The same array when nothing applies.
 */
export function reconcileLabelWrites<T extends RepositoryReference>(
    items: T[],
    written: LabelWrites,
    options: { listKey: string | null; filterLabels: readonly string[]; now: number; restore: (reference: RepositoryReference) => T | null },
): T[] {
    if (written.size === 0) return items;
    const held = (write: LabelWrite) => options.now - write.at < HOLD_MS;
    const listed = new Set<string>();
    let changed = false;
    const next: T[] = [];
    for (const item of items) {
        const key = writeKey(item);
        const write = written.get(key);
        if (!write || !held(write)) {
            next.push(item);
            continue;
        }
        listed.add(key);
        if (!matchesFilter(write.labels, options.filterLabels)) {
            changed = true;
            continue;
        }
        if (sameLabels(item.labels, write.labels)) {
            next.push(item);
            continue;
        }
        changed = true;
        next.push({ ...item, labels: write.labels });
    }
    if (options.filterLabels.length === 0) return changed ? next : items;
    for (const [key, write] of written) {
        if (listed.has(key) || !held(write) || !write.listing || write.listing.listKey !== options.listKey) continue;
        if (!matchesFilter(write.labels, options.filterLabels)) continue;
        const restored = options.restore(write.reference);
        if (!restored) continue;
        changed = true;
        next.splice(Math.min(write.listing.index, next.length), 0, restored);
    }
    return changed ? next : items;
}
