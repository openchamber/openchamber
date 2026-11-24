import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  readAutoUpdateEnabled,
  startBackgroundDesktopUpdateDownload,
  tryInstallUpdateOnQuit,
} from './auto-update.mjs';

const noopLog = { info: () => {}, warn: () => {}, error: () => {} };

test('readAutoUpdateEnabled defaults to true and respects explicit false', () => {
  assert.equal(readAutoUpdateEnabled(() => ({})), true);
  assert.equal(readAutoUpdateEnabled(() => ({ desktopAutoUpdateEnabled: true })), true);
  assert.equal(readAutoUpdateEnabled(() => ({ desktopAutoUpdateEnabled: false })), false);
});

test('startBackgroundDesktopUpdateDownload skips when disabled, ineligible, or Linux deb/rpm, and rechecks after channel switch', async () => {
  let downloads = 0;
  let releaseFirst;
  let resolveSecond;
  const firstPending = new Promise((resolve) => { releaseFirst = resolve; });
  const secondFinished = new Promise((resolve) => { resolveSecond = resolve; });
  const autoUpdater = {
    downloadUpdate: async () => {
      downloads += 1;
      if (downloads === 1) await firstPending;
      if (downloads === 2) queueMicrotask(resolveSecond);
      return ['/cache/app.zip'];
    },
  };
  const app = { isPackaged: true, isInApplicationsFolder: () => true };

  // Disabled -> skipped
  const disabledState = { pendingUpdate: { version: '2.9.0', electronUpdate: {} } };
  assert.equal(startBackgroundDesktopUpdateDownload({
    app, autoUpdater, state: disabledState, log: noopLog, readAutoUpdateEnabled: () => false, isLinuxPackageInstall: () => false, platform: 'darwin',
  }), null);
  assert.equal(downloads, 0);

  // macOS outside /Applications or Linux deb/rpm -> skipped
  assert.equal(startBackgroundDesktopUpdateDownload({
    app: { isPackaged: true, isInApplicationsFolder: () => false },
    autoUpdater, state: disabledState, log: noopLog, readAutoUpdateEnabled: () => true, isLinuxPackageInstall: () => false, platform: 'darwin',
  }), null);
  assert.equal(startBackgroundDesktopUpdateDownload({
    app, autoUpdater, state: disabledState, log: noopLog, readAutoUpdateEnabled: () => true, isLinuxPackageInstall: () => true, platform: 'linux',
  }), null);
  assert.equal(downloads, 0);

  // Start downloading A, switch pendingUpdate to B mid-flight -> B starts once A finishes
  const state = { pendingUpdate: { version: '2.9.0', electronUpdate: {} } };
  const first = startBackgroundDesktopUpdateDownload({
    app, autoUpdater, state, log: noopLog, readAutoUpdateEnabled: () => true, isLinuxPackageInstall: () => false, platform: 'darwin',
  });
  state.pendingUpdate = { version: '2.9.1', electronUpdate: {} };
  startBackgroundDesktopUpdateDownload({
    app, autoUpdater, state, log: noopLog, readAutoUpdateEnabled: () => true, isLinuxPackageInstall: () => false, platform: 'darwin',
  });
  releaseFirst();
  await first;
  await secondFinished;
  await Promise.resolve();
  assert.equal(downloads, 2);
  assert.equal(state.pendingUpdate.version, '2.9.1');
  assert.equal(state.pendingUpdate.downloaded, true);
});

test('tryInstallUpdateOnQuit disables macOS relaunch and falls back to plain exit on updater error', () => {
  const calls = [];
  const emitter = new EventEmitter();
  const autoUpdater = Object.assign(emitter, {
    autoRunAppAfterInstall: true,
    quitAndInstall: (silent, forceRunAfter) => calls.push([silent, forceRunAfter]),
  });
  const app = { isPackaged: true, isInApplicationsFolder: () => true };
  const state = { pendingUpdate: { version: '2.9.0', downloaded: true }, installingUpdate: false };

  // Skips on Linux deb/rpm and when disabled
  assert.equal(tryInstallUpdateOnQuit({
    app, autoUpdater, state, log: noopLog, readAutoUpdateEnabled: () => false, isLinuxPackageInstall: () => false, platform: 'darwin',
  }), false);
  assert.equal(tryInstallUpdateOnQuit({
    app, autoUpdater, state, log: noopLog, readAutoUpdateEnabled: () => true, isLinuxPackageInstall: () => true, platform: 'linux',
  }), false);
  assert.equal(calls.length, 0);

  // Sets autoRunAppAfterInstall = false and falls back on async updater error
  let fallbackExits = 0;
  assert.equal(tryInstallUpdateOnQuit({
    app, autoUpdater, state, log: noopLog, readAutoUpdateEnabled: () => true, isLinuxPackageInstall: () => false,
    onFallbackExit: () => { fallbackExits += 1; }, platform: 'darwin', fallbackMs: 60_000,
  }), true);
  assert.equal(autoUpdater.autoRunAppAfterInstall, false);
  assert.deepEqual(calls, [[true, false]]);
  assert.equal(state.installingUpdate, true);

  emitter.emit('error', new Error('installer missing'));
  assert.equal(fallbackExits, 1);
  assert.equal(state.installingUpdate, false);
});
