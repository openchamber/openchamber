import { describe, expect, test } from 'bun:test';

import {
  PDF_PAGE_GAP_PX,
  anchorScrollDelta,
  clampPdfZoom,
  fitPageWidth,
  pageAtY,
  pageCssWidth,
  pageDisplayHeight,
  pageRenderScale,
  pdfZoomCeiling,
  stepPdfZoom,
} from './pdfZoom';

const PAGE = { width: 612, height: 792 };
const SECOND = { width: 612, height: 792 };

describe('pdfZoom', () => {
  test('fit fills the pane between its padding', () => {
    expect(fitPageWidth(400)).toBe(400 - PDF_PAGE_GAP_PX * 2);
    expect(fitPageWidth(0)).toBe(0);
    expect(fitPageWidth(PDF_PAGE_GAP_PX)).toBe(0);
  });

  test('a page keeps its proportions at the drawn width, rounded to the box pixels', () => {
    expect(pageDisplayHeight(PAGE, 306)).toBe(396);
    expect(pageDisplayHeight(PAGE, 344)).toBe(445);
    expect(pageDisplayHeight({ width: 0, height: 0 }, 306)).toBe(0);
  });

  test('actual size converts PDF points to CSS pixels', () => {
    expect(pageCssWidth(612)).toBeCloseTo(816);
    expect(pageCssWidth(0)).toBe(0);
  });

  test('a point finds its page and offset, and a gap anchors to the next page', () => {
    const sizes = [PAGE, SECOND];
    expect(pageAtY(sizes, 306, 100)).toEqual({ index: 0, localY: 100 });
    expect(pageAtY(sizes, 306, 400)).toEqual({ index: 1, localY: 0 });
    expect(pageAtY(sizes, 306, 500)).toEqual({ index: 1, localY: 500 - 404 });
    expect(pageAtY(sizes, 306, -20)).toEqual({ index: 0, localY: 0 });
    expect(pageAtY(sizes, 306, 2000)).toEqual({ index: 1, localY: 396 });
    expect(pageAtY([], 306, 100)).toBeNull();
  });

  test('a rounded page height keeps the stack aligned with the boxes it describes', () => {
    const sizes = [PAGE, SECOND];
    // 344px draws the 792pt page 445px tall, then an 8px gap.
    expect(pageAtY(sizes, 344, 444)).toEqual({ index: 0, localY: 444 });
    expect(pageAtY(sizes, 344, 446)).toEqual({ index: 1, localY: 0 });
    expect(pageAtY(sizes, 344, 453)).toEqual({ index: 1, localY: 0 });
  });

  test('zoom steps stay between fit and the ceiling', () => {
    expect(clampPdfZoom(0.4, 6)).toBe(1);
    expect(clampPdfZoom(9, 6)).toBe(6);
    expect(stepPdfZoom(1, 1, 6)).toBe(1.25);
    expect(stepPdfZoom(1.25, -1, 6)).toBe(1);
    expect(stepPdfZoom(6, 1, 6)).toBe(6);
    expect(stepPdfZoom(6, -1, 6)).toBe(5);
  });

  test('a page wider than six fits raises the ceiling to its actual size', () => {
    expect(pdfZoomCeiling(pageCssWidth(612), 400)).toBe(6);
    expect(pdfZoomCeiling(pageCssWidth(2000), 400)).toBeCloseTo(2000 * (96 / 72) / 400);
    expect(stepPdfZoom(6, 1, pdfZoomCeiling(pageCssWidth(2000), 400))).toBeCloseTo(2000 * (96 / 72) / 400);
    expect(clampPdfZoom(pageCssWidth(2000) / 400, pdfZoomCeiling(pageCssWidth(2000), 400))).toBeCloseTo(2000 * (96 / 72) / 400);
  });

  test('an anchored zoom scrolls so the page point stays under the pointer', () => {
    const anchor = { pageLeft: 40, pageTop: 120, x: 100, y: 200, clientX: 300, clientY: 500, width: 400 };
    const delta = anchorScrollDelta(anchor, 800);
    expect(delta).toEqual({ left: 40 + 200 - 300, top: 120 + 400 - 500 });
    expect(40 + anchor.x * 2 - delta.left).toBe(anchor.clientX);
    expect(120 + anchor.y * 2 - delta.top).toBe(anchor.clientY);
  });

  test('an anchor with no measured width keeps the point where it is', () => {
    const anchor = { pageLeft: 0, pageTop: 0, x: 10, y: 20, clientX: 30, clientY: 40, width: 0 };
    expect(anchorScrollDelta(anchor, 100)).toEqual({ left: 10 - 30, top: 20 - 40 });
  });

  test('a deep zoom paints inside the canvas budget and CSS stretches the rest', () => {    expect(pageRenderScale(300, { width: 600, height: 800 }, 2)).toBe(1);

    const scale = pageRenderScale(4000, { width: 600, height: 800 }, 3);
    const pixels = (600 * scale) * (800 * scale);
    expect(pixels).toBeLessThan(8_000_100);
    expect(pixels).toBeGreaterThan(7_900_000);
    expect(scale).toBeLessThan(20);
  });

  test('a panoramic page stops at the side limit instead of its pixel budget', () => {
    const scale = pageRenderScale(10000, { width: 1000, height: 100 }, 1);
    expect(1000 * scale).toBeCloseTo(8192);
    expect(100 * scale).toBeLessThan(8192);
  });
});
