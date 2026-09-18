import { describe, expect, test } from 'bun:test';

import { importWithChunkRecovery } from './chunkLoadRecovery';

describe('importWithChunkRecovery', () => {
  test('preserves the import error without navigating the VS Code webview', async () => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    let reloadCount = 0;
    let markerWrites = 0;
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: {
        __VSCODE_CONFIG__: { workspaceFolder: 'C:/repo', workspaceFolders: [] },
        sessionStorage: {
          getItem: () => null,
          setItem: () => { markerWrites += 1; },
        },
        setTimeout: (callback: () => void) => { callback(); return 0; },
        location: { reload: () => { reloadCount += 1; } },
      },
    });

    const failure = new Error('Failed to fetch dynamically imported module');
    let attempts = 0;
    try {
      const caught = await importWithChunkRecovery(async () => {
        attempts += 1;
        throw failure;
      }).catch((error: Error) => error);
      expect(caught).toBe(failure);
      expect(attempts).toBe(2);
      expect(reloadCount).toBe(0);
      expect(markerWrites).toBe(0);
    } finally {
      if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
      else Reflect.deleteProperty(globalThis, 'window');
    }
  });

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
