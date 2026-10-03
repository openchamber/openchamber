import { describe, expect, test } from 'bun:test';

import { drawBoxDrawingGlyph, isBoxDrawingText, type BoxDrawingContext } from './boxDrawing';

type Call = readonly [string, ...number[]];

interface RecordingContext {
  readonly context: BoxDrawingContext;
  readonly calls: Call[];
  readonly fills: string[];
}

function recordingContext(): RecordingContext {
  const calls: Call[] = [];
  const fills: string[] = [];
  const context: BoxDrawingContext = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineCap: 'butt',
    fillRect: (x, y, w, h) => {
      calls.push(['fillRect', x, y, w, h]);
      fills.push(String(context.fillStyle));
    },
    beginPath: () => calls.push(['beginPath']),
    moveTo: (x, y) => calls.push(['moveTo', x, y]),
    lineTo: (x, y) => calls.push(['lineTo', x, y]),
    quadraticCurveTo: (cpx, cpy, x, y) => calls.push(['quadraticCurveTo', cpx, cpy, x, y]),
    closePath: () => calls.push(['closePath']),
    fill: () => calls.push(['fill']),
    stroke: () => calls.push(['stroke']),
  };
  return { context, calls, fills };
}

const white = { r: 255, g: 255, b: 255 };
// A 7.8 x 18 cell at a fractional x, like the real grid produces.
const cell = { x: 4 + 7.8 * 3, y: 4 + 18 * 2, width: 7.8, height: 18 };

describe('isBoxDrawingText', () => {
  test('owns box drawing, block elements and powerline arrows only', () => {
    expect(isBoxDrawingText('─')).toBe(true);
    expect(isBoxDrawingText('╬')).toBe(true);
    expect(isBoxDrawingText('▀')).toBe(true);
    expect(isBoxDrawingText('░')).toBe(true);
    expect(isBoxDrawingText('')).toBe(true);
    expect(isBoxDrawingText('a')).toBe(false);
    expect(isBoxDrawingText('❯')).toBe(false);
    expect(isBoxDrawingText('')).toBe(false);
    expect(isBoxDrawingText('──')).toBe(false);
  });
});

describe('drawBoxDrawingGlyph', () => {
  test('fills a full block over the whole rounded cell so stacked rows touch', () => {
    const { context, calls } = recordingContext();
    expect(drawBoxDrawingGlyph(context, '█', cell, white)).toBe(true);
    // x: 27.4 -> 27, right: 35.2 -> 35; y: 40, bottom: 58.
    expect(calls).toEqual([['fillRect', 27, 40, 8, 18]]);
  });

  test('splits the upper and lower half blocks at the shared middle pixel', () => {
    const upper = recordingContext();
    const lower = recordingContext();
    drawBoxDrawingGlyph(upper.context, '▀', cell, white);
    drawBoxDrawingGlyph(lower.context, '▄', cell, white);
    expect(upper.calls).toEqual([['fillRect', 27, 40, 8, 9]]);
    expect(lower.calls).toEqual([['fillRect', 27, 49, 8, 9]]);
  });

  test('shades with the foreground at partial alpha', () => {
    const { context, fills } = recordingContext();
    drawBoxDrawingGlyph(context, '▒', cell, white);
    expect(fills).toEqual(['rgba(255, 255, 255, 0.5)']);
  });

  test('draws light lines edge to edge so neighbouring cells join without seams', () => {
    const { context, calls } = recordingContext();
    drawBoxDrawingGlyph(context, '─', cell, white);
    // Each arm reaches the far edge of the one-pixel center band.
    expect(calls).toEqual([
      ['fillRect', 27, 49, 5, 1],
      ['fillRect', 31, 49, 4, 1],
    ]);
    const next = recordingContext();
    drawBoxDrawingGlyph(next.context, '─', { ...cell, x: cell.x + cell.width }, white);
    expect(next.calls[0]).toEqual(['fillRect', 35, 49, 5, 1]);
  });

  test('closes a light corner at the junction square without a stub', () => {
    const { context, calls } = recordingContext();
    drawBoxDrawingGlyph(context, '┌', cell, white);
    expect(calls).toEqual([
      ['fillRect', 31, 49, 4, 1],
      ['fillRect', 31, 49, 1, 9],
    ]);
  });

  test('draws heavy arms three strokes thick', () => {
    const { context, calls } = recordingContext();
    drawBoxDrawingGlyph(context, '━', cell, white);
    expect(calls).toEqual([
      ['fillRect', 27, 48, 5, 3],
      ['fillRect', 31, 48, 4, 3],
    ]);
  });

  test('nests the two lines of a double corner', () => {
    const { context, calls } = recordingContext();
    drawBoxDrawingGlyph(context, '╔', cell, white);
    // Right arm: outer (top) line from the outer vertical line, inner (bottom)
    // line from the inner vertical line. Down arm mirrors it.
    expect(calls).toEqual([
      ['fillRect', 29, 47, 6, 1],
      ['fillRect', 33, 51, 2, 1],
      ['fillRect', 29, 47, 1, 11],
      ['fillRect', 33, 51, 1, 7],
    ]);
  });

  test('keeps a double cross open in the middle', () => {
    const { context, calls } = recordingContext();
    drawBoxDrawingGlyph(context, '╬', cell, white);
    expect(calls).toEqual([
      ['fillRect', 27, 47, 2, 1],
      ['fillRect', 27, 51, 2, 1],
      ['fillRect', 33, 47, 2, 1],
      ['fillRect', 33, 51, 2, 1],
      ['fillRect', 29, 40, 1, 7],
      ['fillRect', 33, 40, 1, 7],
      ['fillRect', 29, 51, 1, 7],
      ['fillRect', 33, 51, 1, 7],
    ]);
  });

  test('strokes arcs, diagonals and outline arrows and fills solid arrows', () => {
    const arc = recordingContext();
    drawBoxDrawingGlyph(arc.context, '╭', cell, white);
    expect(arc.calls.map(([name]) => name)).toEqual(['beginPath', 'moveTo', 'lineTo', 'quadraticCurveTo', 'lineTo', 'stroke']);
    const diagonal = recordingContext();
    drawBoxDrawingGlyph(diagonal.context, '╳', cell, white);
    expect(diagonal.calls.filter(([name]) => name === 'moveTo')).toHaveLength(2);
    const solid = recordingContext();
    drawBoxDrawingGlyph(solid.context, '', cell, white);
    expect(solid.calls.at(-1)).toEqual(['fill']);
    const outline = recordingContext();
    drawBoxDrawingGlyph(outline.context, '', cell, white);
    expect(outline.calls.at(-1)).toEqual(['stroke']);
  });

  test('splits dashed lines into their dash count', () => {
    const { context, calls } = recordingContext();
    drawBoxDrawingGlyph(context, '┈', cell, white);
    expect(calls).toHaveLength(4);
  });

  test('leaves other text to the font', () => {
    const { context, calls } = recordingContext();
    expect(drawBoxDrawingGlyph(context, 'a', cell, white)).toBe(false);
    expect(calls).toEqual([]);
  });
});
