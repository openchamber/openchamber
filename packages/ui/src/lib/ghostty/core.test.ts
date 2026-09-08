// Adapted from T3 Code's libghostty-vt browser adapter tests (MIT, T3 Tools Inc.).
// See LICENSE-T3CODE in this directory.
import { afterEach, describe, expect, test } from 'bun:test';

import { GHOSTTY_CELL_WIDE, GhosttyTerminalCore, ghosttyCellText, ghosttyPaletteBytes, type GhosttyColor } from './core';
import { loadGhosttyRuntime } from './runtime';

const WHITE: GhosttyColor = { r: 255, g: 255, b: 255 };
const BLACK: GhosttyColor = { r: 0, g: 0, b: 0 };

function codepointView(codepoints: ReadonlyArray<number>): DataView {
  const view = new DataView(new ArrayBuffer(codepoints.length * 4));
  codepoints.forEach((codepoint, index) => view.setUint32(index * 4, codepoint, true));
  return view;
}

describe('ghosttyCellText', () => {
  test('converts oversized grapheme clusters without hitting engine spread limits', () => {
    const graphemeLength = 130_000;
    const view = new DataView(new ArrayBuffer(graphemeLength * 4));
    for (let index = 0; index < graphemeLength; index += 1) {
      view.setUint32(index * 4, index === 0 ? 'a'.codePointAt(0)! : 0x301, true);
    }
    const text = ghosttyCellText(view, graphemeLength);
    expect(text.length).toBe(graphemeLength);
    expect(text.codePointAt(0)).toBe('a'.codePointAt(0));
    expect(text.codePointAt(graphemeLength - 1)).toBe(0x301);
  });

  test('converts small clusters including astral codepoints', () => {
    expect([...ghosttyCellText(codepointView([0x1f642, 0x20e3]), 2)]).toEqual(['\u{1F642}', '\u{20E3}']);
    expect(ghosttyCellText(codepointView([0x1f642]), 1)).toBe('🙂');
    expect(ghosttyCellText(codepointView([]), 0)).toBe('');
  });
});

describe('ghosttyPaletteBytes', () => {
  test('places the theme ANSI colors first and keeps the xterm cube and gray ramp', () => {
    const ansi = Array.from({ length: 16 }, (_, index) => ({ r: index, g: index * 2, b: index * 3 }));
    const bytes = ghosttyPaletteBytes(ansi);
    expect(bytes.length).toBe(768);
    expect([...bytes.subarray(15 * 3, 16 * 3)]).toEqual([15, 30, 45]);
    // Index 196 is pure red in the 6x6x6 cube; 232 is the darkest gray.
    expect([...bytes.subarray(196 * 3, 197 * 3)]).toEqual([255, 0, 0]);
    expect([...bytes.subarray(232 * 3, 233 * 3)]).toEqual([8, 8, 8]);
    expect([...bytes.subarray(255 * 3, 256 * 3)]).toEqual([238, 238, 238]);
  });
});

describe('GhosttyTerminalCore', () => {
  const cores = new Set<GhosttyTerminalCore>();

  async function createCore(onData: (data: string) => void = () => {}, palette?: GhosttyColor[]) {
    const core = await GhosttyTerminalCore.create(12, 3, 8, 16, {
      foreground: WHITE,
      background: BLACK,
      cursor: WHITE,
      palette,
    }, onData);
    cores.add(core);
    return core;
  }

  afterEach(() => {
    for (const core of cores) core.dispose();
    cores.clear();
  });

  test('preserves styles, wide cells, and selection after shared memory grows', async () => {
    const core = await createCore();
    const runtime = await loadGhosttyRuntime();
    const grapheme = `e${'́'.repeat(64)}`;
    core.write(`\x1b[1;3;4;8;9;53;38;2;123;45;67;48;2;9;8;7m${grapheme}\x1b[0m界🙂`);
    const cells = core.snapshot().rowData[0]!.cells;
    expect(cells[0]).toEqual({
      text: grapheme,
      wide: 0,
      foreground: { r: 123, g: 45, b: 67 },
      background: { r: 9, g: 8, b: 7 },
      bold: true,
      italic: true,
      invisible: true,
      strikethrough: true,
      overline: true,
      underline: true,
      selected: false,
    });
    expect(cells.slice(1, 5).map(({ text, wide }) => ({ text, wide }))).toEqual([
      { text: '界', wide: 0 },
      { text: '', wide: GHOSTTY_CELL_WIDE.spacerTail },
      { text: '🙂', wide: 0 },
      { text: '', wide: GHOSTTY_CELL_WIDE.spacerTail },
    ]);

    runtime.memory.grow(1);
    core.setSelection({ x: 0, y: 0 }, { x: 2, y: 0 });
    expect(core.snapshot().rowData[0]!.cells[0]).toEqual({ ...cells[0]!, selected: true });
    core.clearSelection();
    expect(core.snapshot().rowData[0]!.cells[0]).toEqual(cells[0]!);
  });

  test('renders ANSI colors from the theme palette', async () => {
    const palette = Array.from({ length: 16 }, (_, index) => ({ r: 10 + index, g: 20, b: 30 }));
    const core = await createCore(() => {}, palette);
    core.write('\x1b[31mred\x1b[0m \x1b[94mblue');
    const cells = core.snapshot().rowData[0]!.cells;
    expect(cells[0]!.foreground).toEqual({ r: 11, g: 20, b: 30 });
    expect(cells[4]!.foreground).toEqual({ r: 22, g: 20, b: 30 });
    // Indices past the theme keep the standard table.
    core.write('\x1b[38;5;196mX');
    expect(core.snapshot().rowData[0]!.cells[8]!.foreground).toEqual({ r: 255, g: 0, b: 0 });
  });

  test('answers device queries through the PTY writer but not during history replay', async () => {
    const replies: string[] = [];
    const core = await createCore((data) => replies.push(data));
    core.write('\x1b[5n');
    expect(replies).toEqual(['\x1b[0n']);
    replies.length = 0;

    core.resetAndWrite('history\x1b[5n');
    expect(replies).toEqual([]);
    expect(core.snapshot().rowData[0]!.text).toBe('history');

    core.write('\x1b[5n');
    expect(replies).toEqual(['\x1b[0n']);
  });

  test('a fresh terminal after disposing a scrolled one shows none of its rows', async () => {
    const first = await createCore();
    first.write(Array.from({ length: 200 }, (_, index) => `leak-${index}\r\n`).join(''));
    first.snapshot();
    first.dispose();
    cores.delete(first);

    const second = await createCore();
    second.write('fresh\r\n'.repeat(4));
    const rows = second.snapshot().rowData.map((row) => row.text);
    expect(rows.some((text) => text.includes('leak-'))).toBe(false);
    expect(rows[0]).toBe('fresh');
  });

  test('reflows history written at a wider size back to the fitted grid', async () => {
    const core = await createCore();
    core.resize(40, 3, 8, 16);
    core.resetAndWrite(`${'x'.repeat(30)}\r\nprompt> `);
    core.resize(12, 3, 8, 16);
    // 30 columns wrap into 12 + 12 + 6; the first wrapped row scrolls out of a 3-row viewport.
    expect(core.snapshot().rowData.map((row) => row.text)).toEqual(['x'.repeat(12), 'x'.repeat(6), 'prompt>']);
  });

  test('encodes bracketed paste only when the terminal asked for it', async () => {
    const core = await createCore();
    expect(core.encodePaste('hello')).toBe('hello');
    core.write('\x1b[?2004h');
    expect(core.encodePaste('hello')).toBe('\x1b[200~hello\x1b[201~');
  });
});
