import assert from 'node:assert/strict';
import test from 'node:test';

import { checkForDesktopUpdate, downloadPendingDesktopUpdate, isDowngrade, markDesktopUpdateDownloaded } from './updater-check.mjs';

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
    pendingUpdate: null,
  });
  assert.equal(result.available, false);
  assert.equal(result.pendingUpdate, null);
  assert.equal(result.nextVersion, '1.15.0');
});

for (const message of ['ENOTFOUND', 'HttpError: 404 Not Found']) {
  test(`preserves a downloaded update on feed failure: ${message}`, async () => {
    const pendingUpdate = { version: '2.0.0', downloaded: true, downloadedFile: '/cache/A' };
    await assert.rejects(checkForDesktopUpdate({
      autoUpdater: { checkForUpdates: async () => { throw new Error(message); } },
      currentVersion: '1.0.0', pendingUpdate,
    }), /Unable to check for updates/);
    assert.equal(pendingUpdate.downloaded, true);
    assert.equal(pendingUpdate.downloadedFile, '/cache/A');
  });
}

test('download A, check B, finish A never marks B ready or starts a second download', async () => {
  let finish;
  let calls = 0;
  const autoUpdater = {
    downloadUpdate: () => {
      calls += 1;
      return new Promise((resolve) => { finish = resolve; });
    },
    checkForUpdates: async () => ({ isUpdateAvailable: true, updateInfo: { version: '3.0.0' } }),
  };
  const state = { pendingUpdate: { version: '2.0.0', electronUpdate: {} }, updateDownloadPromise: null };
  const download = downloadPendingDesktopUpdate({ autoUpdater, state });
  const duplicate = downloadPendingDesktopUpdate({ autoUpdater, state });
  const checked = await checkForDesktopUpdate({ autoUpdater, currentVersion: '1.0.0', pendingUpdate: state.pendingUpdate });
  state.pendingUpdate = checked.pendingUpdate;
  await assert.rejects(downloadPendingDesktopUpdate({ autoUpdater, state }), /already in progress/);
  markDesktopUpdateDownloaded(state.pendingUpdate, { version: '2.0.0', downloadedFile: '/cache/A' });
  assert.equal(state.pendingUpdate.downloaded, undefined);
  finish(['/cache/A']);
  await Promise.all([download, duplicate]);
  assert.equal(calls, 1);
  assert.equal(state.pendingUpdate.version, '3.0.0');
  assert.equal(state.pendingUpdate.downloaded, undefined);
  assert.equal(state.pendingUpdate.downloadedFile, undefined);
  assert.equal(state.updateDownloadPromise, null);
  assert.equal(state.updateDownloadVersion, null);
});

test('a cached payload without an event is ready and a failed download can retry', async () => {
  const state = { pendingUpdate: { version: '2.0.0', electronUpdate: {} }, updateDownloadPromise: null };
  await assert.rejects(downloadPendingDesktopUpdate({
    state, autoUpdater: { downloadUpdate: async () => { throw new Error('offline'); } },
  }), /offline/);
  assert.equal(state.updateDownloadPromise, null);
  assert.equal(state.updateDownloadVersion, null);
  await downloadPendingDesktopUpdate({ state, autoUpdater: { downloadUpdate: async () => ['/cache/A'] } });
  assert.equal(state.pendingUpdate.downloaded, true);
  assert.equal(state.pendingUpdate.downloadedFile, '/cache/A');
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

test('keeps the downloaded payload when the same version is checked again', async () => {
  const pendingUpdate = {
    version: '2.0.0',
    electronUpdate: { id: 'existing' },
    downloaded: true,
    downloadedFile: 'C:/cache/OpenChamber-2.0.0-win-x64.exe',
  };
  const result = await checkForDesktopUpdate({
    autoUpdater: { checkForUpdates: async () => ({ isUpdateAvailable: true, updateInfo: { version: '2.0.0' } }) },
    currentVersion: '1.0.0',
    pendingUpdate,
  });
  assert.equal(result.available, true);
  assert.equal(result.pendingUpdate.version, '2.0.0');
  assert.equal(result.pendingUpdate.downloaded, true);
  assert.equal(result.pendingUpdate.downloadedFile, 'C:/cache/OpenChamber-2.0.0-win-x64.exe');
  assert.notEqual(result.pendingUpdate.electronUpdate, pendingUpdate.electronUpdate);
});

test('drops the downloaded payload when a newer version appears', async () => {
  const pendingUpdate = {
    version: '2.0.0',
    electronUpdate: { id: 'existing' },
    downloaded: true,
  };
  const result = await checkForDesktopUpdate({
    autoUpdater: { checkForUpdates: async () => ({ isUpdateAvailable: true, updateInfo: { version: '2.1.0' } }) },
    currentVersion: '1.0.0',
    pendingUpdate,
  });
  assert.equal(result.available, true);
  assert.equal(result.pendingUpdate.version, '2.1.0');
  assert.equal(result.pendingUpdate.downloaded, undefined);
});
