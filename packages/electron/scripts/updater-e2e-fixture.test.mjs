import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createFixtureServer, stageUpdaterFixture } from './updater-e2e-fixture.mjs';
import { parseUpdateManifest, verifyUpdateManifest } from './verify-update-manifest.mjs';

test('stages architecture-specific generic updater fixtures with valid metadata', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-updater-fixture-'));
  try {
    const source = path.join(root, 'OpenChamber-1.15.1-linux-arm64.AppImage');
    const directory = path.join(root, 'feed');
    fs.writeFileSync(source, 'fixture-appimage');
    const result = stageUpdaterFixture({
      architecture: 'arm64',
      nextAppImage: source,
      version: '1.15.1',
      directory,
    });
    assert.equal(result.manifestName, 'latest-linux-arm64.yml');
    const manifestPath = path.join(directory, result.manifestName);
    assert.deepEqual(parseUpdateManifest(fs.readFileSync(manifestPath, 'utf8')).files.length, 1);
    assert.deepEqual(verifyUpdateManifest({
      manifestPath,
      artifactPath: result.artifactPath,
      expectedVersion: '1.15.1',
    }), {
      name: 'OpenChamber-1.15.1-linux-arm64.AppImage',
      size: 16,
      version: '1.15.1',
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('serves only staged fixture files over loopback', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-updater-server-'));
  const artifact = path.join(root, 'OpenChamber.AppImage');
  fs.writeFileSync(artifact, 'fixture');
  const { server, url } = await createFixtureServer({ directory: root });
  try {
    assert.equal(new URL(url).hostname, '127.0.0.1');
    const response = await fetch(`${url}OpenChamber.AppImage`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'fixture');
    assert.equal((await fetch(`${url}../package.json`)).status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
