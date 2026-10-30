import assert from 'node:assert/strict';
import test from 'node:test';

import { checkForDesktopUpdate, isDowngrade } from './updater-check.mjs';

test('signals failed checks without replacing an existing pending update', async () => {
  const pendingUpdate = { version: '2.0.0', electronUpdate: { id: 'existing' } };
  await assert.rejects(
    checkForDesktopUpdate({
      autoUpdater: { checkForUpdates: async () => { throw new Error('feed unavailable'); } },
      currentVersion: '1.0.0',
      pendingUpdate,
    }),
    /Unable to check for updates: feed unavailable.*network connection/,
  );
  assert.deepEqual(pendingUpdate, { version: '2.0.0', electronUpdate: { id: 'existing' } });
});

test('treats missing update feed (404) as no update available', async () => {
  const result = await checkForDesktopUpdate({
    autoUpdater: {
      checkForUpdates: async () => {
        throw new Error('HttpError: 404 Not Found "https://github.com/.../latest-linux.yml"');
      },
    },
    currentVersion: '1.15.0',
    pendingUpdate: { version: '1.16.0' },
  });
  assert.equal(result.available, false);
  assert.equal(result.pendingUpdate, null);
  assert.equal(result.nextVersion, '1.15.0');
});

test('authoritative no-update result clears pending update', async () => {
  const result = await checkForDesktopUpdate({
    autoUpdater: { checkForUpdates: async () => ({ isUpdateAvailable: false, updateInfo: { version: '1.0.0' } }) },
    currentVersion: '1.0.0',
    pendingUpdate: { version: '2.0.0' },
  });
  assert.equal(result.available, false);
  assert.equal(result.pendingUpdate, null);
});

test('takes the updater verdict, so a downgrade it allows is an available update', async () => {
  // Stable after Canary: the latest release is older than the running build.
  const updateResult = { isUpdateAvailable: true, updateInfo: { version: '2.5.3' } };
  const result = await checkForDesktopUpdate({
    autoUpdater: { checkForUpdates: async () => updateResult },
    currentVersion: '2.5.4-canary.20261030.12',
    pendingUpdate: null,
  });
  assert.equal(result.available, true);
  assert.equal(result.nextVersion, '2.5.3');
  assert.deepEqual(result.pendingUpdate, { version: '2.5.3', electronUpdate: updateResult, downgrade: true });
});

test('only the release before the one a Canary build leads to is a downgrade', () => {
  assert.equal(isDowngrade('2.5.3', '2.5.4-canary.20261030.1'), true);
  assert.equal(isDowngrade('2.4.9', '2.5.4-canary.20261030.1'), true);
  assert.equal(isDowngrade('2.5.4', '2.5.4-canary.20261030.1'), false);
  assert.equal(isDowngrade('2.6.0', '2.5.4-canary.20261030.1'), false);
  assert.equal(isDowngrade('2.5.4-canary.20261031.2', '2.5.4-canary.20261030.1'), false);
  assert.equal(isDowngrade('2.5.4', '2.5.3'), false);
});

test('an ordinary update is not a downgrade', async () => {
  const result = await checkForDesktopUpdate({
    autoUpdater: { checkForUpdates: async () => ({ isUpdateAvailable: true, updateInfo: { version: '2.5.4' } }) },
    currentVersion: '2.5.3',
    pendingUpdate: null,
  });
  assert.equal(result.pendingUpdate.downgrade, false);
});

test('a verdict without a version is not an update', async () => {
  const result = await checkForDesktopUpdate({
    autoUpdater: { checkForUpdates: async () => ({ isUpdateAvailable: true, updateInfo: {} }) },
    currentVersion: '1.0.0',
    pendingUpdate: null,
  });
  assert.equal(result.available, false);
  assert.equal(result.nextVersion, '1.0.0');
});
