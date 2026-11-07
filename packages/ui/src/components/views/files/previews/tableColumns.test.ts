import { describe, expect, test } from 'bun:test';

import { columnSlots } from './tableColumns';

describe('virtual column gaps', () => {
  test('every gap fits the HTML colspan limit without moving the drawn columns', () => {
    const cases = [
      { count: 0, drawn: [] },
      { count: 1_000, drawn: [] },
      { count: 1_001, drawn: [] },
      { count: 1_001, drawn: [1_000] },
      { count: 1_002, drawn: [1_001] },
      { count: 5_000, drawn: [0, 2_500, 4_999] },
      { count: 5_000, drawn: [4_998, 4_999] },
    ];
    for (const { count, drawn } of cases) {
      let position = 0;
      const columns: number[] = [];
      for (const slot of columnSlots(count, drawn)) {
        expect(slot.column).toBe(position);
        if (slot.span === undefined) {
          columns.push(slot.column);
          position += 1;
        } else {
          // Browsers clamp a larger colspan, shifting every subsequent cell.
          expect(slot.span > 0 && slot.span <= 1_000).toBe(true);
          position += slot.span;
        }
      }
      expect(columns).toEqual(drawn);
      expect(position).toBe(count);
    }
  });
});
