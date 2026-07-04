import { describe, expect, test } from 'bun:test';

import { getOpenInAppById } from './openInApps';

const setPlatform = (platform: string): PropertyDescriptor | undefined => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { __OPENCHAMBER_PLATFORM__: platform },
  });
  return originalWindow;
};

const restoreWindow = (originalWindow: PropertyDescriptor | undefined): void => {
  if (originalWindow) {
    Object.defineProperty(globalThis, 'window', originalWindow);
    return;
  }
  delete (globalThis as { window?: unknown }).window;
};

describe('getOpenInAppById', () => {
  test('returns Linux Files metadata while preserving the finder id', () => {
    const originalWindow = setPlatform('linux');
    try {
      const app = getOpenInAppById('finder');

      expect(app).toEqual({ id: 'finder', label: 'Files', appName: 'Files' });
    } finally {
      restoreWindow(originalWindow);
    }
  });
});
