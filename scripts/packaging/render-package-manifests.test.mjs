import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import yaml from 'yaml';

import { renderHomebrewCask, renderWingetManifests, wingetManifestDirectory } from './render-package-manifests.mjs';

const version = '2.7.2';
const sha256 = {
  [`OpenChamber-${version}-win-x64.exe`]: 'aa'.repeat(32),
  [`OpenChamber-${version}-win-arm64.exe`]: 'bb'.repeat(32),
  [`OpenChamber-${version}-mac-arm64.dmg`]: 'cc'.repeat(32),
  [`OpenChamber-${version}-mac-x64.dmg`]: 'dd'.repeat(32),
};

test('winget installer manifest points each architecture at its release installer', () => {
  const files = renderWingetManifests(version, sha256);
  assert.deepEqual(Object.keys(files).sort(), [
    'OpenChamber.OpenChamber.installer.yaml',
    'OpenChamber.OpenChamber.locale.en-US.yaml',
    'OpenChamber.OpenChamber.yaml',
  ]);

  const installer = yaml.parse(files['OpenChamber.OpenChamber.installer.yaml']);
  assert.equal(installer.PackageVersion, version);
  assert.equal(installer.InstallerType, 'nullsoft');
  assert.deepEqual(
    installer.Installers.map(({ Architecture, InstallerUrl, InstallerSha256 }) => [Architecture, InstallerUrl, InstallerSha256]),
    [
      ['x64', `https://github.com/openchamber/openchamber/releases/download/v${version}/OpenChamber-${version}-win-x64.exe`, 'AA'.repeat(32)],
      ['arm64', `https://github.com/openchamber/openchamber/releases/download/v${version}/OpenChamber-${version}-win-arm64.exe`, 'BB'.repeat(32)],
    ],
  );
  for (const content of Object.values(files)) {
    assert.equal(yaml.parse(content).PackageIdentifier, 'OpenChamber.OpenChamber');
  }
  assert.equal(wingetManifestDirectory(version), `manifests/o/OpenChamber/OpenChamber/${version}`);
});

test('Homebrew cask carries both DMG checksums and leaves updates to the app', () => {
  const cask = renderHomebrewCask(version, sha256);
  assert.match(cask, new RegExp(`version "${version}"`));
  assert.match(cask, /sha256 arm:\s+"c{64}",\n\s+intel: "d{64}"/);
  assert.match(cask, /OpenChamber-#\{version\}-mac-#\{arch\}\.dmg/);
  assert.match(cask, /auto_updates true/);
});

test('a missing installer checksum or a pre-release version stops the listing', () => {
  const { [`OpenChamber-${version}-win-arm64.exe`]: _omitted, ...partial } = sha256;
  assert.throws(() => renderWingetManifests(version, partial), /No checksum for OpenChamber-2\.7\.2-win-arm64\.exe/);
  assert.throws(() => renderHomebrewCask('2.7.2-canary.20261108.12', sha256), /stable releases only/);
});

test('installer names match the electron-builder artifactName templates', () => {
  const builder = JSON.parse(readFileSync(fileURLToPath(new URL('../../packages/electron/package.json', import.meta.url)), 'utf8')).build;
  const name = (template, platform, arch) => template.replace('${productName}', 'OpenChamber').replace('${version}', version).replace('${arch}', arch).replace('${ext}', platform === 'win' ? 'exe' : 'dmg');
  const expected = [
    name(builder.win.artifactName, 'win', 'x64'),
    name(builder.win.artifactName, 'win', 'arm64'),
    name(builder.mac.artifactName, 'mac', 'arm64'),
    name(builder.mac.artifactName, 'mac', 'x64'),
  ];
  assert.deepEqual(expected.sort(), Object.keys(sha256).sort());
});

test('the CLI hashes the installers in a directory and writes both listings', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'packaging-in-'));
  const out = mkdtempSync(path.join(os.tmpdir(), 'packaging-out-'));
  for (const name of Object.keys(sha256)) writeFileSync(path.join(dir, name), name);

  const script = fileURLToPath(new URL('./render-package-manifests.mjs', import.meta.url));
  execFileSync(process.execPath, [script, '--version', version, '--dir', dir, '--out', out], { stdio: 'pipe' });

  const installer = yaml.parse(readFileSync(path.join(out, 'winget', wingetManifestDirectory(version), 'OpenChamber.OpenChamber.installer.yaml'), 'utf8'));
  assert.match(installer.Installers[0].InstallerSha256, /^[0-9A-F]{64}$/);
  assert.ok(fs.existsSync(path.join(out, 'homebrew', 'Casks', 'openchamber.rb')));
});
