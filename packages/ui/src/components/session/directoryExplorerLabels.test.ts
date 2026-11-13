import { afterEach, describe, expect, test } from 'bun:test';

import { getRevealLabelKey } from '@/lib/utils';
import { getDirectoryPickerLabelKey } from './directoryExplorerLabels';

const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

afterEach(() => {
  if (navigatorDescriptor) {
    Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, 'navigator');
  }
});

describe('directory picker label', () => {
  for (const [userAgent, pickerKey, revealKey] of [
    ['Macintosh; Intel Mac OS X 10_15_7', 'directoryExplorerDialog.actions.openInFinder', 'common.revealPath.finder'],
    ['Windows NT 10.0; Win64; x64', 'common.revealPath.fileExplorer', 'common.revealPath.fileExplorer'],
    ['X11; Linux x86_64', 'common.revealPath.fileManager', 'common.revealPath.fileManager'],
  ]) {
    test(`chooses the label for ${userAgent} without changing reveal actions`, () => {
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent } });

      expect(getDirectoryPickerLabelKey()).toBe(pickerKey);
      expect(getRevealLabelKey()).toBe(revealKey);
    });
  }
});
