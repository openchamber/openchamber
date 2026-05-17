import { describe, expect, test } from 'bun:test';

import { importWithChunkRecovery } from './chunkLoadRecovery';

describe('importWithChunkRecovery', () => {
  test('schedules recovery reload when stored reload marker is corrupt', async () => {
    const globalWithWindow = globalThis as unknown as { window?: unknown };
    const previousWindow = globalWithWindow.window;
    let storedMarker: string | null = null;
    let reloadCount = 0;

    globalWithWindow.window = {
      sessionStorage: {
        getItem: () => '{not json',
        setItem: (_key: string, value: string) => {
          storedMarker = value;
        },
      },
      setTimeout: (callback: () => void) => {
        callback();
        return 0;
      },
      location: {
        reload: () => {
          reloadCount += 1;
        },
      },
    };

    try {
      let caught: unknown;
      try {
        await importWithChunkRecovery(async () => {
          throw new Error('Failed to fetch dynamically imported module');
        }, { retries: 0 });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(Error);
      expect(storedMarker).not.toBeNull();
      expect(reloadCount).toBe(1);
    } finally {
      if (previousWindow === undefined) {
        delete globalWithWindow.window;
      } else {
        globalWithWindow.window = previousWindow;
      }
    }
  });
});
