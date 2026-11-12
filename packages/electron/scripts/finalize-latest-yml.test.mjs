import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./finalize-latest-yml.mjs', import.meta.url));

const manifest = (platform, architecture, extension) => `version: 1.2.3
files:
  - url: OpenChamber-1.2.3-${platform}-${architecture}.${extension}
    sha512: ${architecture}-checksum
    size: 123
releaseDate: '2026-07-30T00:00:00.000Z'
`;

const writeManifest = (artifacts, target, filename, content) => {
  fs.mkdirSync(path.join(artifacts, `latest-yml-${target}`), { recursive: true });
  fs.writeFileSync(path.join(artifacts, `latest-yml-${target}`, filename), content);
};

const createFixture = ({ includeWindowsArm64 = true, includeMacArm64 = true } = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-latest-yml-'));
  const artifacts = path.join(root, 'artifacts');
  const output = path.join(root, 'output');
  writeManifest(artifacts, 'x86_64-pc-windows-msvc', 'latest.yml', manifest('win', 'x64', 'exe'));
  if (includeWindowsArm64) {
    writeManifest(artifacts, 'aarch64-pc-windows-msvc', 'latest.yml', manifest('win', 'arm64', 'exe'));
  }
  writeManifest(artifacts, 'x86_64-apple-darwin', 'latest-mac.yml', manifest('mac', 'x64', 'zip'));
  if (includeMacArm64) {
    writeManifest(artifacts, 'aarch64-apple-darwin', 'latest-mac.yml', manifest('mac', 'arm64', 'zip'));
  }
  fs.mkdirSync(output);
  return { root, artifacts, output };
};

const environment = ({ artifacts, output }) => ({
  ...process.env,
  LATEST_YML_DIR: artifacts,
  RUNNER_TEMP: output,
  GH_REPO: 'openchamber/openchamber',
  OPENCHAMBER_VERSION: '1.2.3',
});

test('writes separate x64 and ARM64 Windows update channels', (context) => {
  const fixture = createFixture();
  context.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  execFileSync(process.execPath, [script], { env: environment(fixture) });

  const x64 = fs.readFileSync(path.join(fixture.output, 'latest.yml'), 'utf8');
  const arm64 = fs.readFileSync(path.join(fixture.output, 'latest-arm64.yml'), 'utf8');
  assert.match(x64, /win-x64\.exe/);
  assert.doesNotMatch(x64, /win-arm64\.exe/);
  assert.match(arm64, /win-arm64\.exe/);
  assert.doesNotMatch(arm64, /win-x64\.exe/);
});

test('fails instead of publishing an incomplete Windows channel set', (context) => {
  const fixture = createFixture({ includeWindowsArm64: false });
  context.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  const result = spawnSync(process.execPath, [script], { env: environment(fixture), encoding: 'utf8' });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Both x64 and arm64 Windows update manifests are required/);
});

test('lists both Mac architectures in one manifest', (context) => {
  const fixture = createFixture();
  context.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  execFileSync(process.execPath, [script], { env: environment(fixture) });

  const mac = fs.readFileSync(path.join(fixture.output, 'latest-mac.yml'), 'utf8');
  assert.match(mac, /mac-arm64\.zip/);
  assert.match(mac, /mac-x64\.zip/);
});

test('keeps Macs older than macOS 13 off the update', (context) => {
  const fixture = createFixture();
  context.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  execFileSync(process.execPath, [script], { env: environment(fixture) });

  const mac = fs.readFileSync(path.join(fixture.output, 'latest-mac.yml'), 'utf8');
  const windows = fs.readFileSync(path.join(fixture.output, 'latest.yml'), 'utf8');
  assert.match(mac, /^minimumSystemVersion: 22\.0\.0$/m);
  assert.doesNotMatch(windows, /minimumSystemVersion/);
});

test('fails instead of publishing a Mac manifest without the arm64 build', (context) => {
  const fixture = createFixture({ includeMacArm64: false });
  context.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  const result = spawnSync(process.execPath, [script], { env: environment(fixture), encoding: 'utf8' });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Both x64 and arm64 macOS update manifests are required/);
  assert.equal(fs.existsSync(path.join(fixture.output, 'latest-mac.yml')), false);
});
