import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { verifyUpdateManifest } from './verify-update-manifest.mjs';

const fixture = (manifestName, artifactName, fields) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-manifest-test-'));
  const artifactPath = path.join(root, artifactName);
  const manifestPath = path.join(root, manifestName);
  const bytes = Buffer.from(`artifact:${artifactName}`);
  fs.writeFileSync(artifactPath, bytes);
  fs.writeFileSync(manifestPath, [
    'version: 1.15.0',
    'files:',
    ...(fields || [
      `  - url: ${artifactName}`,
      `    sha512: ${crypto.createHash('sha512').update(bytes).digest('base64')}`,
      `    size: ${bytes.length}`,
    ]),
    `path: ${artifactName}`,
    'releaseDate: 2026-07-10T00:00:00.000Z',
    '',
  ].join('\n'));
  return { root, artifactPath, manifestPath };
};

for (const [manifestName, artifactName] of [
  ['latest-linux.yml', 'OpenChamber-1.15.0-linux-x86_64.AppImage'],
  ['latest-linux-arm64.yml', 'OpenChamber-1.15.0-linux-arm64.AppImage'],
]) {
  test(`validates architecture-specific ${manifestName}`, () => {
    const value = fixture(manifestName, artifactName);
    try {
      assert.equal(verifyUpdateManifest({ ...value, expectedVersion: '1.15.0' }).name, artifactName);
    } finally {
      fs.rmSync(value.root, { recursive: true, force: true });
    }
  });
}

test('accepts electron-builder field ordering and optional blockMapSize', () => {
  const artifactName = 'OpenChamber-1.15.0-linux-x86_64.AppImage';
  const bytes = Buffer.from(`artifact:${artifactName}`);
  const value = fixture('latest-linux.yml', artifactName, [
    `  - sha512: ${crypto.createHash('sha512').update(bytes).digest('base64')}`,
    `    size: ${bytes.length}`,
    '    blockMapSize: 1234',
    `    url: ${artifactName}`,
  ]);
  try {
    assert.equal(verifyUpdateManifest({ ...value, expectedVersion: '1.15.0' }).name, artifactName);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test('rejects a manifest that points at the other architecture artifact', () => {
  const value = fixture('latest-linux-arm64.yml', 'OpenChamber-1.15.0-linux-arm64.AppImage');
  try {
    const x64Artifact = path.join(value.root, 'OpenChamber-1.15.0-linux-x86_64.AppImage');
    fs.copyFileSync(value.artifactPath, x64Artifact);
    assert.throws(() => verifyUpdateManifest({
      manifestPath: value.manifestPath,
      artifactPath: x64Artifact,
      expectedVersion: '1.15.0',
    }), /artifact mismatch/);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});
