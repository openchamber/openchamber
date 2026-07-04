import { describe, expect, test } from 'bun:test';

import { buildOpenInAppOptions, getOpenInAppDiscoveryNames } from './useOpenInAppsStore';

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

describe('open-in app discovery helpers', () => {
  test('uses the Linux Files app name for discovery requests', () => {
    const originalWindow = setPlatform('linux');
    try {
      expect(getOpenInAppDiscoveryNames()).toContain('Files');
      expect(getOpenInAppDiscoveryNames()).not.toContain('Finder');
    } finally {
      restoreWindow(originalWindow);
    }
  });

  test('attaches discovered Linux Files icons to the stable finder app id', () => {
    const originalWindow = setPlatform('linux');
    try {
      const options = buildOpenInAppOptions([
        { name: 'Files', iconDataUrl: 'data:image/png;base64,files' },
      ]);

      expect(options.find((app) => app.id === 'finder')).toEqual({
        id: 'finder',
        label: 'Files',
        appName: 'Files',
        iconDataUrl: 'data:image/png;base64,files',
      });
    } finally {
      restoreWindow(originalWindow);
    }
  });
});
