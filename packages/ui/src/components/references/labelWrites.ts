
import * as React from 'react';

import type { Label, RepositoryReference } from '@/lib/api/types';

const HOLD_MS = 120_000;

export type LabelWriteListing = { listKey: string; index: number };

type LabelWrite = {
    labels: Label[];
    at: number;
    reference: RepositoryReference;
    listing: LabelWriteListing | null;
};

export type LabelWrites = ReadonlyMap<string, LabelWrite>;

const writeKey = (reference: RepositoryReference): string => `${reference.kind}:${reference.url}`;

let writes: LabelWrites = new Map();
const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
};

export function recordLabelWrite(reference: RepositoryReference, labels: Label[], listing: LabelWriteListing | null, at = Date.now()): void {
    const next = new Map(writes);
    next.set(writeKey(reference), { labels, at, reference: { ...reference, labels }, listing });
    writes = next;
    for (const listener of listeners) listener();
}

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
