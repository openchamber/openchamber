// Adapted from T3 Code's libghostty-vt browser adapter tests (MIT, T3 Tools Inc.).
// See LICENSE-T3CODE in this directory.
import { describe, expect, test } from 'bun:test';

import type { GhosttyCell, GhosttyRow } from './core';
import {
  DEFAULT_TERMINAL_FONT_FAMILY,
  advanceTerminalSelectionClickSequence,
  isTerminalCopyShortcut,
  isTerminalLinkPointerGesture,
  isTerminalPasteShortcut,
  resolveTerminalMouseData,
  shouldBlinkTerminalCursor,
  terminalContentOriginY,
  terminalFontSize,
  terminalGridCellAt,
  terminalLinkAtPositionWithRange,
  terminalScrollbarGeometry,
  terminalScrollbarOffsetAtPointer,
  terminalWheelArrowData,
  terminalWheelDeltaRows,
  loadTerminalFontFamily,
} from './surface';

const cell = (text: string): GhosttyCell => ({
  text,
  wide: 0,
  foreground: { r: 255, g: 255, b: 255 },
  background: { r: 0, g: 0, b: 0 },
  bold: false,
  italic: false,
  invisible: false,
  strikethrough: false,
  overline: false,
  underline: false,
  selected: false,
});

const row = (text: string, cols: number, flags: Partial<Pick<GhosttyRow, 'isWrapContinuation' | 'wrapsToNext'>> = {}): GhosttyRow => ({
  cells: Array.from({ length: cols }, (_, index) => cell([...text][index] ?? '')),
  text: text.trimEnd(),
  isWrapContinuation: flags.isWrapContinuation ?? false,
  wrapsToNext: flags.wrapsToNext ?? false,
});

describe('terminalLinkAtPositionWithRange', () => {
  test('reconstructs a URL soft-wrapped across two rows', () => {
    const rows = [
      row('see https://open', 16, { wrapsToNext: true }),
      row('chamber.dev/docs', 16, { isWrapContinuation: true }),
      row('done', 16),
    ];
    const link = terminalLinkAtPositionWithRange(rows, 1, 3);
    expect(link).toEqual({
      text: 'https://openchamber.dev/docs',
      range: { start: { x: 4, y: 0 }, end: { x: 15, y: 1 } },
    });
  });

  test('refuses a link whose head scrolled above the viewport', () => {
    const rows = [row('chamber.dev/docs', 16, { isWrapContinuation: true }), row('', 16)];
    expect(terminalLinkAtPositionWithRange(rows, 0, 2)).toBeNull();
  });

  test('ignores plain text', () => {
    expect(terminalLinkAtPositionWithRange([row('hello world', 16)], 0, 2)).toBeNull();
  });
});

describe('terminal font resolution', () => {
  test('keeps the glyph fallbacks behind a custom text face and drops canvas-hostile generics', async () => {
    const loads: string[] = [];
    const family = await loadTerminalFontFamily('ui-monospace, "JetBrains Mono", monospace', 13, {
      load: (font) => {
        loads.push(font);
        return Promise.resolve();
      },
      resolve: (value) => `resolved:${value}`,
    });
    expect(family).toBe('resolved:ui-monospace, "JetBrains Mono", monospace');
    expect(loads).toHaveLength(4);
    expect(loads[0]?.startsWith('normal 400 13px "JetBrains Mono", monospace, "SF Mono"')).toBe(true);
    expect(loads[0]).not.toContain('ui-monospace');
  });

  test('clamps requested font sizes to the supported range', () => {
    expect(terminalFontSize(undefined)).toBe(13);
    expect(terminalFontSize(2)).toBe(6);
    expect(terminalFontSize(99)).toBe(32);
    expect(terminalFontSize(14.4)).toBe(14);
  });

  test('the default stack names only concrete faces plus the bundled symbols', () => {
    expect(DEFAULT_TERMINAL_FONT_FAMILY).toContain('"Symbols Nerd Font Mono"');
    expect(DEFAULT_TERMINAL_FONT_FAMILY).not.toContain('ui-monospace');
  });
});

describe('shortcuts and gestures', () => {
  test('copy uses Cmd on macOS and Ctrl elsewhere, keeping Ctrl+C for SIGINT on macOS', () => {
    expect(isTerminalCopyShortcut({ key: 'c', ctrlKey: true, metaKey: false, shiftKey: false }, 'MacIntel')).toBe(false);
    expect(isTerminalCopyShortcut({ key: 'c', ctrlKey: false, metaKey: true, shiftKey: false }, 'MacIntel')).toBe(true);
    expect(isTerminalCopyShortcut({ key: 'C', ctrlKey: true, metaKey: false, shiftKey: true }, 'Linux x86_64')).toBe(true);
  });

  test('paste uses Cmd+V on macOS, Ctrl+Shift+V or Shift+Insert elsewhere', () => {
    expect(isTerminalPasteShortcut({ key: 'v', ctrlKey: false, metaKey: true, shiftKey: false }, 'MacIntel')).toBe(true);
    expect(isTerminalPasteShortcut({ key: 'v', ctrlKey: true, metaKey: false, shiftKey: false }, 'Win32')).toBe(false);
    expect(isTerminalPasteShortcut({ key: 'v', ctrlKey: true, metaKey: false, shiftKey: true }, 'Win32')).toBe(true);
    expect(isTerminalPasteShortcut({ key: 'Insert', ctrlKey: false, metaKey: false, shiftKey: true }, 'Win32')).toBe(true);
  });

  test('link activation uses Command on macOS and Control elsewhere', () => {
    expect(isTerminalLinkPointerGesture({ ctrlKey: false, metaKey: true }, 'MacIntel')).toBe(true);
    expect(isTerminalLinkPointerGesture({ ctrlKey: true, metaKey: false }, 'MacIntel')).toBe(false);
    expect(isTerminalLinkPointerGesture({ ctrlKey: true, metaKey: false }, 'Linux x86_64')).toBe(true);
  });

  test('recognizes stationary double and triple presses and restarts after movement', () => {
    const first = advanceTerminalSelectionClickSequence(null, { clientX: 10, clientY: 10, timeStamp: 0 });
    const second = advanceTerminalSelectionClickSequence(first, { clientX: 11, clientY: 10, timeStamp: 200 });
    const third = advanceTerminalSelectionClickSequence(second, { clientX: 11, clientY: 11, timeStamp: 400 });
    expect([first.count, second.count, third.count]).toEqual([1, 2, 3]);
    expect(advanceTerminalSelectionClickSequence(third, { clientX: 11, clientY: 11, timeStamp: 600 }).count).toBe(1);
    expect(advanceTerminalSelectionClickSequence(second, { clientX: 40, clientY: 10, timeStamp: 500 }).count).toBe(1);
  });

  test('drops repeated motion reports until another action resets the cell', () => {
    const motion = resolveTerminalMouseData('motion', '\x1b[<35;3;4M', '');
    expect(motion.send).toBe(true);
    expect(resolveTerminalMouseData('motion', '\x1b[<35;3;4M', motion.nextMotionData).send).toBe(false);
    const press = resolveTerminalMouseData('press', '\x1b[<0;3;4M', motion.nextMotionData);
    expect(press).toEqual({ send: true, nextMotionData: '' });
  });
});

describe('wheel scrolling', () => {
  test('converts line and page deltas into rows and accumulates fractional pixels', () => {
    expect(terminalWheelDeltaRows({ deltaY: 3, deltaMode: 1 }, 16, 24, 0)).toEqual({ rows: 3, remainder: 0 });
    expect(terminalWheelDeltaRows({ deltaY: -1, deltaMode: 2 }, 16, 24, 0)).toEqual({ rows: -24, remainder: 0 });
    const partial = terminalWheelDeltaRows({ deltaY: 10, deltaMode: 0 }, 16, 24, 0);
    expect(partial.rows).toBe(0);
    expect(terminalWheelDeltaRows({ deltaY: 10, deltaMode: 0 }, 16, 24, partial.remainder).rows).toBe(1);
  });

  test('emits one arrow per row honoring application cursor keys', () => {
    expect(terminalWheelArrowData(-2, false)).toBe('\x1b[A\x1b[A');
    expect(terminalWheelArrowData(1, true)).toBe('\x1bOB');
    expect(terminalWheelArrowData(0, false)).toBe('');
  });
});

describe('layout helpers', () => {
  test('anchors the grid to the bottom only once scrollback exists', () => {
    expect(terminalContentOriginY(100, 4, 5, 16, false)).toBe(4);
    expect(terminalContentOriginY(100, 4, 5, 16, true)).toBe(16);
  });

  test('maps points inside the rendered grid without clamping its padding', () => {
    const options = { bounds: { left: 10, top: 20 }, cols: 10, rows: 5, metrics: { width: 8, height: 16 }, padding: 4, originY: 4 };
    expect(terminalGridCellAt({ ...options, clientX: 14, clientY: 24 })).toEqual({ x: 0, y: 0 });
    expect(terminalGridCellAt({ ...options, clientX: 93, clientY: 103 })).toEqual({ x: 9, y: 4 });
    expect(terminalGridCellAt({ ...options, clientX: 12, clientY: 24 })).toBeNull();
  });

  test('maps Ghostty scrollbar state to a proportional thumb and back to rows', () => {
    const state = { total: 1000, offset: 500, len: 100 };
    const geometry = terminalScrollbarGeometry(state, 200);
    expect(geometry).toEqual({ thumbHeight: 20, thumbTop: 100, maxOffset: 900 });
    expect(terminalScrollbarOffsetAtPointer(state, 200, 190, 10)).toBe(900);
    expect(terminalScrollbarGeometry({ total: 24, offset: 0, len: 24 }, 200)).toBeNull();
  });

  test('blinks only a focused visible cursor the terminal asked to blink', () => {
    expect(shouldBlinkTerminalCursor({ focused: true, cursorBlinking: true, cursorVisible: true, reducedMotion: false })).toBe(true);
    expect(shouldBlinkTerminalCursor({ focused: false, cursorBlinking: true, cursorVisible: true, reducedMotion: false })).toBe(false);
    expect(shouldBlinkTerminalCursor({ focused: true, cursorBlinking: true, cursorVisible: true, reducedMotion: true })).toBe(false);
  });
});
