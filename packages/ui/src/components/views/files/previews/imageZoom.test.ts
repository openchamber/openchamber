import { describe, expect, test } from 'bun:test';

import { clampImageScale, fitImageScale, stepImageScale, wheelZoomFactor } from './imageZoom';

describe('fitImageScale', () => {
  test('shrinks a wide image to the viewer width minus padding', () => {
    expect(fitImageScale({ width: 1990, height: 874 }, { width: 1024, height: 900 })).toBe(1000 / 1990);
  });

  test('never upscales an image smaller than the viewer', () => {
    expect(fitImageScale({ width: 16, height: 16 }, { width: 800, height: 600 })).toBe(1);
  });

  test('falls back to 1:1 before the viewer has a size', () => {
    expect(fitImageScale({ width: 400, height: 300 }, { width: 0, height: 0 })).toBe(1);
  });
});

describe('clampImageScale', () => {
  test('keeps zoom within its range', () => {
    expect(clampImageScale(100, 0.5)).toBe(16);
    expect(clampImageScale(0.01, 0.5)).toBe(0.1);
  });

  test('lets a huge image zoom out as far as its fit', () => {
    expect(clampImageScale(0.01, 0.04)).toBe(0.04);
  });
});

describe('stepImageScale', () => {
  test('steps to the next preset level from an arbitrary scale', () => {
    expect(stepImageScale(0.503, 1)).toBe(0.75);
    expect(stepImageScale(0.503, -1)).toBe(0.5);
  });

  test('leaves an exact preset level instead of repeating it', () => {
    expect(stepImageScale(1, 1)).toBe(1.5);
    expect(stepImageScale(1, -1)).toBe(0.75);
  });

  test('stops at the ends of the range', () => {
    expect(stepImageScale(16, 1)).toBe(16);
    expect(stepImageScale(0.1, -1)).toBe(0.1);
  });
});

describe('wheelZoomFactor', () => {
  test('zooms in on an upward pinch and out on a downward one', () => {
    expect(wheelZoomFactor(-5, 0)).toBeGreaterThan(1);
    expect(wheelZoomFactor(5, 0)).toBeLessThan(1);
  });

  test('caps a mouse wheel notch and treats line deltas as pixels', () => {
    expect(wheelZoomFactor(-100, 0)).toBe(Math.exp(0.3));
    expect(wheelZoomFactor(-3, 1)).toBe(Math.exp(0.3));
  });
});
