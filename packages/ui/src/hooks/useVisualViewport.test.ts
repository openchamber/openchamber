import { describe, expect, test } from 'bun:test';

import { getVisualViewportState, visualViewportStateEqual, deriveMobileRootStyle, type VisualViewportState } from './useVisualViewport';

interface MockVisualViewport {
  height: number;
  offsetTop?: number;
  pageTop?: number;
}

const withWindow = (
  value:
    | { innerHeight: number; visualViewport?: MockVisualViewport | null }
    | undefined,
  run: () => void,
) => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  if (value === undefined) {
    Reflect.deleteProperty(globalThis, 'window');
  } else {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value,
    });
  }

  try {
    run();
  } finally {
    if (originalWindow) {
      Object.defineProperty(globalThis, 'window', originalWindow);
    } else {
      Reflect.deleteProperty(globalThis, 'window');
    }
  }
};

describe('getVisualViewportState', () => {
  test('returns zeroed geometry when window is undefined', () => {
    withWindow(undefined, () => {
      expect(getVisualViewportState()).toEqual({
        height: 0,
        keyboardHeight: 0,
        offsetTop: 0,
        pageTop: 0,
      });
    });
  });

  test('falls back to innerHeight when visualViewport is unavailable', () => {
    withWindow({ innerHeight: 812 }, () => {
      expect(getVisualViewportState()).toEqual({
        height: 812,
        keyboardHeight: 0,
        offsetTop: 0,
        pageTop: 0,
      });
    });
  });

  test('derives keyboard height from visualViewport height', () => {
    withWindow({ innerHeight: 812, visualViewport: { height: 512 } }, () => {
      expect(getVisualViewportState()).toEqual({
        height: 512,
        keyboardHeight: 300,
        offsetTop: 0,
        pageTop: 0,
      });
    });
  });

  test('clamps keyboard height to zero when visualViewport is taller than innerHeight', () => {
    withWindow({ innerHeight: 812, visualViewport: { height: 900 } }, () => {
      expect(getVisualViewportState()).toEqual({
        height: 900,
        keyboardHeight: 0,
        offsetTop: 0,
        pageTop: 0,
      });
    });
  });

  test('exposes offsetTop and pageTop from visualViewport (iOS keyboard pan)', () => {
    withWindow(
      {
        innerHeight: 812,
        visualViewport: { height: 420, offsetTop: 60, pageTop: 392 },
      },
      () => {
        const state = getVisualViewportState();
        expect(state.height).toBe(420);
        expect(state.keyboardHeight).toBe(392);
        expect(state.offsetTop).toBe(60);
        expect(state.pageTop).toBe(392);
      },
    );
  });

  test('iOS pan without resize: height equals innerHeight with non-zero offset', () => {
    withWindow(
      {
        innerHeight: 812,
        visualViewport: { height: 812, offsetTop: 200, pageTop: 200 },
      },
      () => {
        expect(getVisualViewportState()).toEqual({
          height: 812,
          keyboardHeight: 0,
          offsetTop: 200,
          pageTop: 200,
        });
      },
    );
  });

  test('uses zero fallback for missing offsetTop and pageTop', () => {
    withWindow(
      { innerHeight: 812, visualViewport: { height: 600 } },
      () => {
        const state = getVisualViewportState();
        expect(state.offsetTop).toBe(0);
        expect(state.pageTop).toBe(0);
      },
    );
  });
});

describe('visualViewportStateEqual', () => {
  const base: VisualViewportState = {
    height: 812,
    keyboardHeight: 300,
    offsetTop: 60,
    pageTop: 392,
  };

  test('returns true for identical values (same reference)', () => {
    expect(visualViewportStateEqual(base, base)).toBe(true);
  });

  test('returns true for equal values (different reference)', () => {
    const copy: VisualViewportState = { ...base };
    expect(visualViewportStateEqual(base, copy)).toBe(true);
    expect(base).not.toBe(copy);
  });

  test('returns false when height differs', () => {
    const other: VisualViewportState = { ...base, height: 600 };
    expect(visualViewportStateEqual(base, other)).toBe(false);
  });

  test('returns false when keyboardHeight differs', () => {
    const other: VisualViewportState = { ...base, keyboardHeight: 0 };
    expect(visualViewportStateEqual(base, other)).toBe(false);
  });

  test('returns false when offsetTop differs', () => {
    const other: VisualViewportState = { ...base, offsetTop: 0 };
    expect(visualViewportStateEqual(base, other)).toBe(false);
  });

  test('returns false when pageTop differs', () => {
    const other: VisualViewportState = { ...base, pageTop: 0 };
    expect(visualViewportStateEqual(base, other)).toBe(false);
  });

  test('covers all fields: zero state equal to itself', () => {
    const zero: VisualViewportState = { height: 0, keyboardHeight: 0, offsetTop: 0, pageTop: 0 };
    expect(visualViewportStateEqual(zero, { height: 0, keyboardHeight: 0, offsetTop: 0, pageTop: 0 })).toBe(true);
  });
});

describe('deriveMobileRootStyle', () => {
  // Helper to extract effective top from a CSSProperties object.
  const getEffectiveTop = (style: { top?: number | string } | undefined): number => {
    if (!style || style.top === undefined) return 0;
    return typeof style.top === 'number' ? style.top : parseFloat(String(style.top)) || 0;
  };

  test('returns undefined when isMobile is false (desktop)', () => {
    expect(
      deriveMobileRootStyle({
        isMobile: false,
        viewport: { height: 500, keyboardHeight: 0, offsetTop: 0, pageTop: 0 },
        scrollY: 0,
      }),
    ).toBe(undefined);
  });

  test('returns undefined when viewport height is zero', () => {
    expect(
      deriveMobileRootStyle({
        isMobile: true,
        viewport: { height: 0, keyboardHeight: 0, offsetTop: 0, pageTop: 0 },
        scrollY: 0,
      }),
    ).toBe(undefined);
  });

  test('returns undefined when viewport height is negative', () => {
    expect(
      deriveMobileRootStyle({
        isMobile: true,
        viewport: { height: -10, keyboardHeight: 0, offsetTop: 0, pageTop: 0 },
        scrollY: 0,
      }),
    ).toBe(undefined);
  });

  test('resize-only geometry: effective root top 0, height equals visualViewport.height', () => {
    const result = deriveMobileRootStyle({
      isMobile: true,
      viewport: { height: 500, keyboardHeight: 312, offsetTop: 0, pageTop: 0 },
      scrollY: 0,
    });
    expect(result).not.toBe(undefined);
    expect(result!.height).toBe(500);
    expect(getEffectiveTop(result)).toBe(0);
  });

  test('pan-only geometry: effective root top equals visual viewport origin', () => {
    const result = deriveMobileRootStyle({
      isMobile: true,
      viewport: { height: 812, keyboardHeight: 0, offsetTop: 200, pageTop: 200 },
      scrollY: 0,
    });
    expect(result).not.toBe(undefined);
    expect(result!.height).toBe(812);
    expect(getEffectiveTop(result)).toBe(200);
  });

  test('mixed resize+pan geometry: effective root top equals visual viewport origin', () => {
    const result = deriveMobileRootStyle({
      isMobile: true,
      viewport: { height: 420, keyboardHeight: 392, offsetTop: 60, pageTop: 392 },
      scrollY: 0,
    });
    expect(result).not.toBe(undefined);
    expect(result!.height).toBe(420);
    expect(getEffectiveTop(result)).toBe(60);
  });

  test('origin normalization: offsetTop takes priority over pageTop', () => {
    const result = deriveMobileRootStyle({
      isMobile: true,
      viewport: { height: 420, keyboardHeight: 392, offsetTop: 60, pageTop: 500 },
      scrollY: 100,
    });
    // offsetTop=60 should win; pageTop-scrollY=400 should not be used
    expect(getEffectiveTop(result)).toBe(60);
  });

  test('origin normalization: pageTop - scrollY fallback when offsetTop is zero', () => {
    const result = deriveMobileRootStyle({
      isMobile: true,
      viewport: { height: 420, keyboardHeight: 392, offsetTop: 0, pageTop: 392 },
      scrollY: 100,
    });
    expect(result).not.toBe(undefined);
    expect(result!.height).toBe(420);
    expect(getEffectiveTop(result)).toBe(292); // pageTop - scrollY = 392 - 100
  });

  test('origin is 0 when both offsetTop and pageTop are zero', () => {
    const result = deriveMobileRootStyle({
      isMobile: true,
      viewport: { height: 500, keyboardHeight: 312, offsetTop: 0, pageTop: 0 },
      scrollY: 0,
    });
    expect(result).not.toBe(undefined);
    expect(getEffectiveTop(result)).toBe(0);
  });

  test('style does not include position:fixed when origin is 0 (preserves flow layout)', () => {
    const result = deriveMobileRootStyle({
      isMobile: true,
      viewport: { height: 500, keyboardHeight: 312, offsetTop: 0, pageTop: 0 },
      scrollY: 0,
    });
    expect(result).not.toBe(undefined);
    expect(result!.position).toBe(undefined);
  });

  test('style includes position:fixed when origin is non-zero', () => {
    const result = deriveMobileRootStyle({
      isMobile: true,
      viewport: { height: 420, keyboardHeight: 392, offsetTop: 60, pageTop: 392 },
      scrollY: 0,
    });
    expect(result).not.toBe(undefined);
    expect(result!.position).toBe('fixed');
    expect(result!.left).toBe(0);
    expect(result!.right).toBe(0);
  });
});
