import { describe, expect, test } from 'bun:test';

import {
  fitMermaidViewBox,
  formatMermaidViewBox,
  getMermaidSvgContentBox,
  getMermaidViewerSignature,
  hasMermaidPointerDragMoved,
  MERMAID_BLOCK_SELECTOR,
  panMermaidViewBox,
  shouldRefreshMermaidViewers,
  zoomMermaidViewBoxAtPoint,
} from './mermaidViewer';

describe('mermaidViewer', () => {
  test('extracts content bounds from the root SVG viewBox', () => {
    expect(getMermaidSvgContentBox({ viewBox: '10 20 400 200', width: '999', height: '999' })).toEqual({
      x: 10,
      y: 20,
      width: 400,
      height: 200,
    });
  });

  test('falls back to numeric SVG width and height when viewBox is missing', () => {
    expect(getMermaidSvgContentBox({ width: '640', height: '320' })).toEqual({
      x: 0,
      y: 0,
      width: 640,
      height: 320,
    });
  });

  test('accepts bare and px SVG width and height values without parsing unresolved units', () => {
    expect(getMermaidSvgContentBox({ width: '1e3', height: '2.5e2px' })).toEqual({
      x: 0,
      y: 0,
      width: 1000,
      height: 250,
    });

    expect(getMermaidSvgContentBox({ width: '100%', height: '200' })).toBeNull();
    expect(getMermaidSvgContentBox({ width: '100em', height: '200' })).toBeNull();
  });

  test('fits content into a viewport while preserving aspect ratio', () => {
    expect(fitMermaidViewBox({ x: 0, y: 0, width: 400, height: 200 }, { width: 300, height: 300 })).toEqual({
      x: 0,
      y: -100,
      width: 400,
      height: 400,
    });
  });

  test('zooms around a pointer so the SVG point under the pointer stays stable', () => {
    const current = { x: 0, y: 0, width: 400, height: 400 };
    const next = zoomMermaidViewBoxAtPoint({
      currentBox: current,
      contentBox: { x: 0, y: 0, width: 400, height: 200 },
      viewport: { width: 300, height: 300 },
      pointer: { x: 75, y: 150 },
      zoomFactor: 2,
      minScale: 0.5,
      maxScale: 4,
    });

    const before = {
      x: current.x + (75 / 300) * current.width,
      y: current.y + (150 / 300) * current.height,
    };
    const after = {
      x: next.x + (75 / 300) * next.width,
      y: next.y + (150 / 300) * next.height,
    };

    expect(Math.abs(after.x - before.x) < 1e-6).toBe(true);
    expect(Math.abs(after.y - before.y) < 1e-6).toBe(true);
    expect(next).toEqual({ x: 50, y: 100, width: 200, height: 200 });
  });

  test('clamps zoom to the configured viewBox scale bounds', () => {
    const next = zoomMermaidViewBoxAtPoint({
      currentBox: { x: 0, y: 0, width: 400, height: 400 },
      contentBox: { x: 0, y: 0, width: 400, height: 200 },
      viewport: { width: 300, height: 300 },
      pointer: { x: 150, y: 150 },
      zoomFactor: 100,
      minScale: 0.5,
      maxScale: 4,
    });

    expect(next.width).toBe(100);
    expect(next.height).toBe(100);
    expect(next.x).toBe(150);
    expect(next.y).toBe(150);
  });

  test('clamps zoom scale relative to the fitted viewport box', () => {
    const next = zoomMermaidViewBoxAtPoint({
      currentBox: { x: -100, y: 0, width: 400, height: 400 },
      contentBox: { x: 0, y: 0, width: 200, height: 400 },
      viewport: { width: 300, height: 300 },
      pointer: { x: 150, y: 150 },
      zoomFactor: 100,
      minScale: 0.5,
      maxScale: 4,
    });

    expect(next).toEqual({ x: 50, y: 150, width: 100, height: 100 });
  });

  test('returns the current viewBox for invalid zoom scale bounds', () => {
    const current = { x: 0, y: 0, width: 400, height: 400 };

    expect(zoomMermaidViewBoxAtPoint({
      currentBox: current,
      contentBox: { x: 0, y: 0, width: 400, height: 200 },
      viewport: { width: 300, height: 300 },
      pointer: { x: 150, y: 150 },
      zoomFactor: 2,
      minScale: 0,
      maxScale: 4,
    })).toBe(current);

    expect(zoomMermaidViewBoxAtPoint({
      currentBox: current,
      contentBox: { x: 0, y: 0, width: 400, height: 200 },
      viewport: { width: 300, height: 300 },
      pointer: { x: 150, y: 150 },
      zoomFactor: 2,
      minScale: 0.5,
      maxScale: Number.POSITIVE_INFINITY,
    })).toBe(current);
  });

  test('formats viewBox numbers without noisy floating point tails', () => {
    expect(formatMermaidViewBox({
      x: 1 / 3,
      y: -2.5,
      width: 100.0000001,
      height: 40,
    })).toBe('0.333333 -2.5 100 40');
  });

  test('pans viewBox by viewport pixel deltas in SVG coordinates', () => {
    expect(panMermaidViewBox({
      currentBox: { x: 10, y: 20, width: 400, height: 200 },
      viewport: { width: 200, height: 100 },
      delta: { x: 25, y: -10 },
    })).toEqual({
      x: -40,
      y: 40,
      width: 400,
      height: 200,
    });
  });

  test('distinguishes real pointer drag from click jitter', () => {
    expect(hasMermaidPointerDragMoved({ x: 10, y: 10 }, { x: 12, y: 11 })).toBe(false);
    expect(hasMermaidPointerDragMoved({ x: 10, y: 10 }, { x: 14, y: 10 })).toBe(true);
  });

  test('viewer signature changes when SVG identity changes within an existing block', () => {
    const first = getMermaidViewerSignature({
      renderMode: 'svg',
      svgMarkup: '<svg viewBox="0 0 100 50"></svg>',
      viewBox: '0 0 100 50',
      width: null,
      height: null,
    });
    const second = getMermaidViewerSignature({
      renderMode: 'svg',
      svgMarkup: '<svg viewBox="0 0 240 120"></svg>',
      viewBox: '0 0 240 120',
      width: null,
      height: null,
    });

    expect(second).not.toBe(first);
  });

  test('viewer signature distinguishes render mode flips and missing SVGs', () => {
    expect(getMermaidViewerSignature({ renderMode: 'ascii' })).toBe('ascii:no-svg');
    expect(getMermaidViewerSignature({ renderMode: 'svg' })).toBe('svg:no-svg');
  });

  test('only requests renderer refresh work for existing mermaid DOM blocks', () => {
    const withoutMermaidBlock = { querySelector: () => null };
    const withMermaidBlock = { querySelector: () => ({}) as Element };

    expect(shouldRefreshMermaidViewers(withoutMermaidBlock)).toBe(false);
    expect(shouldRefreshMermaidViewers(withMermaidBlock)).toBe(true);
  });

  test('exports the shared Mermaid block selector', () => {
    expect(MERMAID_BLOCK_SELECTOR).toBe('[data-markdown="mermaid-block"]');
  });
});
