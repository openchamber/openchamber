import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./finalize-latest-yml.mjs', import.meta.url));

const manifest = (architecture) => `version: 1.2.3
files:
  - url: OpenChamber-1.2.3-win-${architecture}.exe
    sha512: ${architecture}-checksum
    size: 123
releaseDate: '2026-07-30T00:00:00.000Z'
`;

const createFixture = ({ includeArm64 = true } = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-latest-yml-'));
  const artifacts = path.join(root, 'artifacts');
  const output = path.join(root, 'output');
  fs.mkdirSync(path.join(artifacts, 'latest-yml-x86_64-pc-windows-msvc'), { recursive: true });
  fs.writeFileSync(path.join(artifacts, 'latest-yml-x86_64-pc-windows-msvc', 'latest.yml'), manifest('x64'));
  if (includeArm64) {
    fs.mkdirSync(path.join(artifacts, 'latest-yml-aarch64-pc-windows-msvc'), { recursive: true });
    fs.writeFileSync(path.join(artifacts, 'latest-yml-aarch64-pc-windows-msvc', 'latest.yml'), manifest('arm64'));
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
  const fixture = createFixture({ includeArm64: false });
  context.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  const result = spawnSync(process.execPath, [script], { env: environment(fixture), encoding: 'utf8' });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Both x64 and arm64 Windows update manifests are required/);
});
