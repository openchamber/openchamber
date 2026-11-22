import * as React from 'react';

type AlignableRow = { value: string };

export const useHighlightAlignment = <TRow extends AlignableRow>(
  index: number,
  rows: readonly TRow[],
  rowRefs: React.RefObject<Map<string, HTMLElement>>,
) => {
  const alignedIndexRef = React.useRef(index);
  React.useLayoutEffect(() => {
    const moved = alignedIndexRef.current !== index;
    alignedIndexRef.current = index;
    if (!moved) return;
    const row = rows[index];
    if (!row) return;
    rowRefs.current?.get(row.value)?.scrollIntoView({ block: 'nearest' });
  }, [index, rows, rowRefs]);
};
