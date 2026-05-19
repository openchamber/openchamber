import { describe, expect, test } from 'bun:test';

import { getVisualViewportState } from './useVisualViewport';

const withWindow = (value: { innerHeight: number; visualViewport?: { height: number } | null }, run: () => void) => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value,
  });

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
  test('falls back to innerHeight when visualViewport is unavailable', () => {
    withWindow({ innerHeight: 812 }, () => {
      expect(getVisualViewportState()).toEqual({ height: 812, keyboardHeight: 0 });
    });
  });

  test('derives keyboard height from visualViewport height', () => {
    withWindow({ innerHeight: 812, visualViewport: { height: 512 } }, () => {
      expect(getVisualViewportState()).toEqual({ height: 512, keyboardHeight: 300 });
    });
  });
});
