import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { canaryBuildConfig } from './canary-build-config.mjs';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseConfig = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8')).build;

test('Canary is the release app with other icons, so an update replaces one with the other', () => {
  const config = canaryBuildConfig(releaseConfig);
  const withReleaseIcons = JSON.parse(JSON.stringify(config).replaceAll('resources/icons-canary', 'resources/icons'));
  assert.deepEqual(withReleaseIcons, releaseConfig);
  assert.equal(config.appId, 'dev.openchamber.desktop');
  assert.equal(config.productName, 'OpenChamber');
  assert.equal(config.extraMetadata, releaseConfig.extraMetadata);
  // The release configuration is left as it was.
  assert.equal(releaseConfig.directories.buildResources, 'resources/icons');
});

test('every icon comes from the Canary icon set, which has every file the build reads', () => {
  const config = canaryBuildConfig(releaseConfig);
  const text = JSON.stringify(config);
  assert.equal(text.includes('"resources/icons/'), false);
  assert.equal(config.directories.buildResources, 'resources/icons-canary');
  const referenced = [...text.matchAll(/"(resources\/icons-canary\/[^"]+)"/g)].map((match) => match[1]);
  assert.ok(referenced.length > 0);
  for (const file of [...referenced, 'resources/icons-canary/Assets.car']) {
    assert.equal(fs.existsSync(path.join(packageDir, file)), true, file);
  }
  const tray = (dir) => fs.readdirSync(path.join(packageDir, dir, 'tray'), { recursive: true }).filter((name) => name.endsWith('.png')).sort();
  assert.deepEqual(tray('resources/icons-canary'), tray('resources/icons'));
});
