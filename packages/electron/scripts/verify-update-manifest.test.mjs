import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { verifyUpdateManifest } from './verify-update-manifest.mjs';

const fixture = (manifestName, artifactNames, fields) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-manifest-test-'));
  const manifestPath = path.join(root, manifestName);
  const names = Array.isArray(artifactNames) ? artifactNames : [artifactNames];
  const artifacts = names.map((name) => {
    const artifactPath = path.join(root, name);
    const bytes = Buffer.from(`artifact:${name}`);
    fs.writeFileSync(artifactPath, bytes);
    return { artifactPath, bytes, name };
  });
  fs.writeFileSync(manifestPath, [
    'version: 1.15.0',
    'files:',
    ...(fields || artifacts.flatMap(({ bytes, name }) => [
      `  - url: ${name}`,
      `    sha512: ${crypto.createHash('sha512').update(bytes).digest('base64')}`,
      `    size: ${bytes.length}`,
    ])),
    `path: ${names[0]}`,
    'releaseDate: 2026-07-10T00:00:00.000Z',
    '',
  ].join('\n'));
  const artifactPaths = artifacts.map(({ artifactPath }) => artifactPath);
  return { root, artifactPath: artifactPaths[0], artifactPaths, manifestPath };
};

for (const [manifestName, artifactNames] of [
  ['latest-linux.yml', [
    'OpenChamber-1.15.0-linux-x86_64.AppImage',
    'OpenChamber-1.15.0-linux-amd64.deb',
  ]],
  ['latest-linux-arm64.yml', [
    'OpenChamber-1.15.0-linux-arm64.AppImage',
    'OpenChamber-1.15.0-linux-arm64.deb',
  ]],
]) {
  test(`validates architecture-specific ${manifestName}`, () => {
    const value = fixture(manifestName, artifactNames);
    try {
      assert.deepEqual(verifyUpdateManifest({ ...value, expectedVersion: '1.15.0' }), {
        artifacts: value.artifactPaths.map((artifactPath) => ({
          name: path.basename(artifactPath),
          size: Buffer.byteLength(`artifact:${path.basename(artifactPath)}`),
        })),
        version: '1.15.0',
      });
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

test('rejects a release manifest that omits the deb artifact', () => {
  const value = fixture('latest-linux.yml', 'OpenChamber-1.15.0-linux-x86_64.AppImage');
  try {
    const debPath = path.join(value.root, 'OpenChamber-1.15.0-linux-amd64.deb');
    fs.writeFileSync(debPath, 'deb');
    assert.throws(() => verifyUpdateManifest({
      manifestPath: value.manifestPath,
      artifactPaths: [value.artifactPath, debPath],
      expectedVersion: '1.15.0',
    }), /exactly 2 artifacts/);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test('rejects a checksum mismatch in either release artifact', () => {
  const value = fixture('latest-linux.yml', [
    'OpenChamber-1.15.0-linux-x86_64.AppImage',
    'OpenChamber-1.15.0-linux-amd64.deb',
  ]);
  try {
    for (const artifactPath of value.artifactPaths) {
      const original = fs.readFileSync(artifactPath);
      const changed = Buffer.from(original);
      changed[0] ^= 0xff;
      fs.writeFileSync(artifactPath, changed);

      // Restore each file before corrupting the next one so every assertion proves
      // that the verifier reached and checked the currently selected manifest entry.
      try {
        const extensionPattern = path.extname(artifactPath).replace('.', '\\.');
        assert.throws(
          () => verifyUpdateManifest({ ...value, expectedVersion: '1.15.0' }),
          new RegExp(`sha512 mismatch.*${extensionPattern}`),
        );
      } finally {
        fs.writeFileSync(artifactPath, original);
      }
    }
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});
