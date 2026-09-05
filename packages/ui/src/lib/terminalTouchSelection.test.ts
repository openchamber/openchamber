import { describe, expect, test } from 'bun:test';
import {
  getTerminalCellFromPoint,
  getSingleCellSelectionOffset,
  getTerminalWordRange,
} from './terminalTouchSelection';

describe('terminal touch selection', () => {
  test('maps touch points to clamped terminal cells', () => {
    const bounds = { left: 20, top: 40, width: 800, height: 240 };

    expect(getTerminalCellFromPoint(425, 165, bounds, 80, 24)).toEqual({ column: 40, row: 12 });
    expect(getTerminalCellFromPoint(-100, 500, bounds, 80, 24)).toEqual({ column: 0, row: 23 });
    expect(getTerminalCellFromPoint(20, 40, { ...bounds, width: 0 }, 80, 24)).toBeNull();
  });

  test('keeps a single-cell selection inside its anchor while crossing the threshold', () => {
    const bounds = { left: 20, top: 40, width: 800, height: 240 };
    const columns = 80;
    const rows = 24;
    const anchor = { column: 40, row: 12 };
    const cellWidth = bounds.width / columns;
    const cellHeight = bounds.height / rows;
    const offset = getSingleCellSelectionOffset(bounds, columns, rows);

    expect(offset).toBeDefined();
    if (!offset) return;

    expect(Math.hypot(offset.x, offset.y)).toBeGreaterThanOrEqual(cellWidth / 2);
    expect(Math.abs(offset.x)).toBeLessThan(cellWidth / 2);
    expect(Math.abs(offset.y)).toBeLessThan(cellHeight / 2);
    expect(getTerminalCellFromPoint(
      bounds.left + (anchor.column + 0.5) * cellWidth + offset.x,
      bounds.top + (anchor.row + 0.5) * cellHeight + offset.y,
      bounds,
      columns,
      rows,
    )).toEqual(anchor);
  });

  test('selects the non-whitespace token around a long press', () => {
    expect(getTerminalWordRange(Array.from('  /projects/openchamber  '), 10)).toEqual({
      startColumn: 2,
      endColumn: 22,
    });
    expect(getTerminalWordRange(Array.from('foo bar'), 3)).toEqual({ startColumn: 3, endColumn: 3 });
  });
});
