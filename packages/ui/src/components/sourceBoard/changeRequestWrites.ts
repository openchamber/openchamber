import * as React from 'react';

import type { RepositoryChangeRequestReference } from '@/lib/api/types';

export type ChangeRequestWrite = 'confirm' | 'merge' | 'branch' | 'base';

type Pull = Pick<RepositoryChangeRequestReference, 'url'>;

let writes: ReadonlyMap<string, ChangeRequestWrite> = new Map();
const listeners = new Set<() => void>();

const keyOf = (pull: Pull) => `pull:${pull.url}`;

const publish = (next: ReadonlyMap<string, ChangeRequestWrite>) => {
    writes = next;
    for (const listener of listeners) listener();
};

const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
};

export function claimChangeRequestWrite(pull: Pull, kind: ChangeRequestWrite, from?: ChangeRequestWrite): boolean {
    const key = keyOf(pull);
    const held = writes.get(key);
    if (held !== undefined && held !== from) return false;
    publish(new Map(writes).set(key, kind));
    return true;
}

export function releaseChangeRequestWrite(pull: Pull): void {
    const key = keyOf(pull);
    if (!writes.has(key)) return;
    const next = new Map(writes);
    next.delete(key);
    publish(next);
}

export const useChangeRequestWrite = (pull: Pull | null): ChangeRequestWrite | null => React.useSyncExternalStore(
    subscribe,
    () => (pull ? writes.get(keyOf(pull)) ?? null : null),
);
