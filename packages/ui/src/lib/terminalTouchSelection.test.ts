import { describe, expect, test } from 'bun:test';
import {
  getTerminalCellFromPoint,
  getTerminalWordRange,
} from './terminalTouchSelection';

describe('terminal touch selection', () => {
  test('maps touch points to clamped terminal cells', () => {
    const bounds = { left: 20, top: 40, width: 800, height: 240 };

    expect(getTerminalCellFromPoint(425, 165, bounds, 80, 24)).toEqual({ column: 40, row: 12 });
    expect(getTerminalCellFromPoint(-100, 500, bounds, 80, 24)).toEqual({ column: 0, row: 23 });
    expect(getTerminalCellFromPoint(20, 40, { ...bounds, width: 0 }, 80, 24)).toBeNull();
  });

  test('selects the non-whitespace token around a long press', () => {
    expect(getTerminalWordRange(Array.from('  /projects/openchamber  '), 10)).toEqual({
      startColumn: 2,
      endColumn: 22,
    });
    expect(getTerminalWordRange(Array.from('foo bar'), 3)).toEqual({ startColumn: 3, endColumn: 3 });
  });
});
