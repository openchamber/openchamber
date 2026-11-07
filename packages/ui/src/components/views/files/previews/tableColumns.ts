type ColumnSlot = { column: number; span?: undefined } | { column: number; span: number };

/** Drawn columns and the gaps between them, in the table's logical column order. */
export const columnSlots = (columnCount: number, drawn: number[]): ColumnSlot[] => {
  const slots: ColumnSlot[] = [];
  let next = 0;
  const gapUntil = (end: number) => {
    // HTML clamps colspan to 1,000, so a long gap needs several cells.
    while (next < end) {
      const span = Math.min(1_000, end - next);
      slots.push({ column: next, span });
      next += span;
    }
  };
  for (const column of drawn) {
    gapUntil(column);
    slots.push({ column });
    next = column + 1;
  }
  gapUntil(columnCount);
  return slots;
};
