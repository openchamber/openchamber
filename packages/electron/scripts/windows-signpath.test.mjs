import assert from 'node:assert/strict';
import test from 'node:test';

import { rewriteUpdateManifest } from './windows-signpath.mjs';

const manifest = `version: 2.5.3
files:
  - url: OpenChamber-2.5.3-win-x64.exe
    sha512: unsigned==
    size: 100
path: OpenChamber-2.5.3-win-x64.exe
sha512: unsigned==
releaseDate: '2026-10-30T10:00:00.000Z'
`;

test('points latest.yml at the signed installer', () => {
  assert.equal(
    rewriteUpdateManifest(manifest, 'OpenChamber-2.5.3-win-x64.exe', { sha512: 'signed==', size: 120 }),
    `version: 2.5.3
files:
  - url: OpenChamber-2.5.3-win-x64.exe
    sha512: signed==
    size: 120
path: OpenChamber-2.5.3-win-x64.exe
sha512: signed==
releaseDate: '2026-10-30T10:00:00.000Z'
`,
  );
});

test('refuses a latest.yml that does not list the installer', () => {
  assert.throws(
    () => rewriteUpdateManifest(manifest, 'OpenChamber-2.5.3-win-arm64.exe', { sha512: 'signed==', size: 120 }),
    /no complete entry for OpenChamber-2\.5\.3-win-arm64\.exe/,
  );
});
