import React from 'react';

type Entry = {
  key: string;
  children: React.ReactNode;
};

type KeepAliveProps = {
  cacheKey: string | null;
  capacity: number;
  children: React.ReactNode;
  onBeforeHide?: () => void;
};

export class KeepAlive extends React.Component<KeepAliveProps> {
  getSnapshotBeforeUpdate(previous: KeepAliveProps) {
    if (previous.cacheKey !== null && previous.cacheKey !== this.props.cacheKey) {
      previous.onBeforeHide?.();
    }
    return null;
  }

  componentDidUpdate() {
    // React requires the paired lifecycle for getSnapshotBeforeUpdate.
  }

  render() {
    return <RetainedEntries {...this.props} />;
  }
}

function RetainedEntries({ cacheKey, capacity, children }: KeepAliveProps) {
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
  if (next !== entries) {
    setEntries(next);
  }

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
