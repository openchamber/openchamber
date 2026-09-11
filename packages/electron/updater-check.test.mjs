import assert from 'node:assert/strict';
import test from 'node:test';

import { checkForDesktopUpdate, hasUpdateArtifact } from './updater-check.mjs';

const compareVersions = (left, right) => left.localeCompare(right, undefined, { numeric: true });

test('signals failed checks without replacing an existing pending update', async () => {
  const pendingUpdate = { version: '2.0.0', electronUpdate: { id: 'existing' } };
  await assert.rejects(
    checkForDesktopUpdate({
      autoUpdater: { checkForUpdates: async () => { throw new Error('feed unavailable'); } },
      currentVersion: '1.0.0',
      pendingUpdate,
      compareVersions,
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
    compareVersions,
  });
  assert.equal(result.available, false);
  assert.equal(result.pendingUpdate, null);
  assert.equal(result.nextVersion, '1.15.0');
});

test('authoritative no-update result clears pending update', async () => {
  const result = await checkForDesktopUpdate({
    autoUpdater: { checkForUpdates: async () => ({ updateInfo: { version: '1.0.0' } }) },
    currentVersion: '1.0.0',
    pendingUpdate: { version: '2.0.0' },
    compareVersions,
  });
  assert.equal(result.available, false);
  assert.equal(result.pendingUpdate, null);
});

test('does not offer a deb update when the manifest only contains an AppImage', async () => {
  const result = await checkForDesktopUpdate({
    autoUpdater: {
      checkForUpdates: async () => ({
        updateInfo: {
          version: '1.1.0',
          files: [{ url: 'OpenChamber-1.1.0-linux-x86_64.AppImage' }],
        },
      }),
    },
    currentVersion: '1.0.0',
    pendingUpdate: { version: '1.1.0' },
    compareVersions,
    artifactExtension: 'deb',
  });
  assert.equal(result.available, false);
  assert.equal(result.pendingUpdate, null);
  assert.equal(result.nextVersion, '1.0.0');
});

test('does not offer an AppImage update when the manifest only contains a deb', async () => {
  assert.equal(
    hasUpdateArtifact({ files: [{ url: 'OpenChamber-1.1.0-linux-amd64.deb' }] }, 'AppImage'),
    false,
  );
});

test('offers an update when the manifest contains the current package type', async () => {
  const result = await checkForDesktopUpdate({
    autoUpdater: {
      checkForUpdates: async () => ({
        updateInfo: {
          version: '1.1.0',
          files: [
            { url: 'OpenChamber-1.1.0-linux-x86_64.AppImage' },
            { url: 'OpenChamber-1.1.0-linux-amd64.deb' },
          ],
        },
      }),
    },
    currentVersion: '1.0.0',
    pendingUpdate: null,
    compareVersions,
    artifactExtension: 'deb',
  });
  assert.equal(result.available, true);
  assert.equal(result.pendingUpdate?.version, '1.1.0');
});
