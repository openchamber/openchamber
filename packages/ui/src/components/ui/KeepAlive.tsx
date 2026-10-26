import React from 'react';

type Entry = {
  key: string;
  children: React.ReactNode;
};

type KeepAliveProps = {
  /** Null hides the pool without adding a loading/empty-state entry. */
  cacheKey: string | null;
  capacity: number;
  children: React.ReactNode;
};

/** Retains keyed React subtrees. Removing the least-recent entry unmounts it. */
export function KeepAlive({ cacheKey, capacity, children }: KeepAliveProps) {
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new Error('KeepAlive capacity must be a positive integer');
  }

  const [entries, setEntries] = React.useState<Entry[]>([]);
  const current = entries.find((entry) => entry.key === cacheKey);
  let next = entries;
  if (cacheKey !== null && (current?.children !== children || entries.at(-1)?.key !== cacheKey)) {
    next = [
      ...entries.filter((entry) => entry.key !== cacheKey),
      { key: cacheKey, children },
    ];
  }
  if (next.length > capacity) {
    next = next.slice(-capacity);
  }
  // Update only this component's state. An abandoned concurrent render cannot
  // evict anything from the committed tree or mutate its stored JSX.
  if (next !== entries) {
    setEntries(next);
  }

  // LRU promotion must not move retained DOM: moving an iframe can reload it.
  // A stable key order changes only membership, independently of recency.
  const ordered = [...next].sort((left, right) => {
    if (left.key === right.key) return 0;
    return left.key < right.key ? -1 : 1;
  });

  return ordered.map((entry) => (
    <React.Activity key={entry.key} mode={entry.key === cacheKey ? 'visible' : 'hidden'}>
      {entry.children}
    </React.Activity>
  ));
}
