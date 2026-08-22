import { describe, expect, test } from 'bun:test';

import {
  FILL_VIEWPORT,
  MAX_VIEWPORT_SIZE,
  MIN_VIEWPORT_SIZE,
  VIEWPORT_PRESETS,
  clampViewportSize,
  describeViewport,
  fitViewport,
  presetViewport,
  isViewportMode,
  rotateViewport,
  viewportForMode,
  viewportSize,
  viewportSummary,
} from './viewport';

describe('viewport size', () => {
  test('fill has no size of its own', () => {
    expect(viewportSize(FILL_VIEWPORT)).toBeNull();
    expect(fitViewport(FILL_VIEWPORT, { width: 800, height: 600 })).toBeNull();
  });

  test('clamps to a range a page can actually be laid out in', () => {
    expect(clampViewportSize(10)).toBe(MIN_VIEWPORT_SIZE);
    expect(clampViewportSize(99_999)).toBe(MAX_VIEWPORT_SIZE);
    expect(clampViewportSize(390.6)).toBe(391);
    expect(clampViewportSize(Number.NaN)).toBe(MIN_VIEWPORT_SIZE);
  });
});

describe('presets', () => {
  test('resolves a known preset', () => {
    expect(presetViewport('iphone-14')).toEqual({ kind: 'preset', id: 'iphone-14', width: 390, height: 844 });
  });

  test('returns nothing for an unknown id', () => {
    expect(presetViewport('nokia-3310')).toBeNull();
  });

  test('every preset is within the layout range', () => {
    for (const preset of VIEWPORT_PRESETS) {
      expect(clampViewportSize(preset.width)).toBe(preset.width);
      expect(clampViewportSize(preset.height)).toBe(preset.height);
    }
  });

  test('names the current preset and nothing else', () => {
    expect(describeViewport(presetViewport('ipad-mini')!)).toBe('iPad mini');
    expect(describeViewport({ kind: 'custom', width: 500, height: 500 })).toBe('');
    expect(describeViewport(FILL_VIEWPORT)).toBe('');
  });
});

describe('rotation', () => {
  test('swaps the sides', () => {
    expect(rotateViewport({ kind: 'custom', width: 390, height: 844 }))
      .toEqual({ kind: 'custom', width: 844, height: 390 });
  });

  test('a rotated preset stops claiming to be that preset', () => {
    const rotated = rotateViewport(presetViewport('iphone-14')!);
    expect(rotated.kind).toBe('custom');
    expect(describeViewport(rotated)).toBe('');
  });

  test('fill has no orientation', () => {
    expect(rotateViewport(FILL_VIEWPORT)).toEqual(FILL_VIEWPORT);
  });
});

describe('fitting', () => {
  const viewport = { kind: 'custom', width: 400, height: 800 } as const;

  test('keeps the chosen size and scales down to fit', () => {
    const layout = fitViewport(viewport, { width: 200, height: 800 });
    expect(layout).toEqual({ width: 400, height: 800, scale: 0.5 });
  });

  test('fits by whichever side runs out first', () => {
    expect(fitViewport(viewport, { width: 800, height: 400 })?.scale).toBe(0.5);
  });

  test('never enlarges, which would misrepresent the size asked for', () => {
    expect(fitViewport(viewport, { width: 4000, height: 4000 })?.scale).toBe(1);
  });

  test('survives a container measured at zero mid-layout', () => {
    const layout = fitViewport(viewport, { width: 0, height: 0 });
    expect(layout?.width).toBe(400);
    expect(layout && layout.scale > 0).toBe(true);
  });
});

describe('agent viewport vocabulary', () => {
  test('each named mode resolves to a real size', () => {
    for (const mode of ['mobile', 'tablet', 'desktop'] as const) {
      const size = viewportSize(viewportForMode(mode));
      expect(size !== null).toBe(true);
    }
  });

  test('fill has no size, as the agent should expect', () => {
    expect(viewportSize(viewportForMode('fill'))).toBeNull();
  });

  test('accepts only the vocabulary it published', () => {
    expect(isViewportMode('mobile')).toBe(true);
    expect(isViewportMode('phone')).toBe(false);
    expect(isViewportMode(390)).toBe(false);
  });

  test('reports back in the same words it accepts', () => {
    expect(viewportSummary(viewportForMode('mobile')).mode).toBe('mobile');
    expect(viewportSummary(FILL_VIEWPORT).mode).toBe('fill');
  });

  test('calls a hand-typed size custom rather than the nearest name', () => {
    const summary = viewportSummary({ kind: 'custom', width: 500, height: 900 });
    expect(summary.mode).toBe('custom');
    expect(summary.width).toBe(500);
  });
});
