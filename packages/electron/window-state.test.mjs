import assert from 'node:assert/strict';
import test from 'node:test';

import { persistMainWindowState } from './window-state.mjs';

test('leaves saved window state unchanged when the main window is minimized', async () => {
  const originalWindowState = { x: -7, y: -7, width: 1612, height: 1043, maximized: true, fullscreen: false };
  const settings = { desktopWindowState: originalWindowState };
  let mutationRequested = false;
  const browserWindow = {
    id: 1,
    isDestroyed: () => false,
    isMinimized: () => true,
    getBounds: () => ({ x: 0, y: 0, width: 1, height: 1 }),
  };

  await persistMainWindowState({
    browserWindow,
    mainWindowId: 1,
    quakeActive: false,
    minWidth: 800,
    minHeight: 520,
    mutateSettingsRoot: async (mutator) => {
      mutationRequested = true;
      Object.assign(settings, await mutator(settings));
    },
  });

  assert.equal(mutationRequested, false);
  assert.deepEqual(settings.desktopWindowState, originalWindowState);
});

test('persists the maximized snapshot captured before a queued settings write', async () => {
  let isMinimized = false;
  let isMaximized = true;
  const settings = { desktopWindowState: { x: 0, y: 0, width: 1139, height: 715, maximized: false, fullscreen: false } };
  let applyMutation;
  const browserWindow = {
    id: 1,
    isDestroyed: () => false,
    isMinimized: () => isMinimized,
    getBounds: () => ({ x: -7, y: -7, width: 1612, height: 1043 }),
    isMaximized: () => isMaximized,
    isFullScreen: () => false,
  };

  const pendingWrite = persistMainWindowState({
    browserWindow,
    mainWindowId: 1,
    quakeActive: false,
    minWidth: 800,
    minHeight: 520,
    mutateSettingsRoot: (mutator) => new Promise((resolve, reject) => {
      applyMutation = async () => {
        try {
          Object.assign(settings, await mutator(settings));
          resolve();
        } catch (error) {
          reject(error);
        }
      };
    }),
  });

  isMinimized = true;
  isMaximized = false;
  await applyMutation();
  await pendingWrite;

  assert.deepEqual(
    settings.desktopWindowState,
    { x: -7, y: -7, width: 1612, height: 1043, maximized: true, fullscreen: false },
  );
});

test('does not persist a different window or transient Quake geometry', async () => {
  let mutationRequested = false;
  const browserWindow = {
    id: 2,
    isDestroyed: () => false,
    isMinimized: () => false,
  };

  const write = (quakeActive) => persistMainWindowState({
    browserWindow,
    mainWindowId: 1,
    quakeActive,
    minWidth: 800,
    minHeight: 520,
    mutateSettingsRoot: async () => { mutationRequested = true; },
  });

  await write(false);
  await write(true);
  assert.equal(mutationRequested, false);
});
