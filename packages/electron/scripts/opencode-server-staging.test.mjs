import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readPinnedOpenCodeServerVersion, verifyOpenCodeServer } from './opencode-server-staging.mjs';

const writeElf = (filePath, architecture) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const header = Buffer.alloc(20);
  header.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
  header.writeUInt16LE(architecture === 'x64' ? 62 : 183, 18);
  fs.writeFileSync(filePath, header, { mode: 0o755 });
};

const manifest = {
  version: '2.3.0',
  platform: 'linux',
  arch: 'x64',
  nodePty: '@lydell/node-pty-linux-x64/lib/index.js',
  parcelWatcher: '@parcel/watcher-linux-x64-glibc/watcher.node',
  fff: '@ff-labs/fff-bin-linux-x64-gnu/libfff_c.so',
  fffFfi: '@yuuang/ffi-rs-linux-x64-gnu/ffi-rs.linux-x64-gnu.node',
  persistentPty: '@opencode/pty-linux-x64-gnu/bin/opencode-pty',
  photonWasm: 'photon_rs_bg.wasm',
};

const stage = (overrides = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-opencode-server-'));
  const assets = path.join(dir, 'assets');
  const values = { ...manifest, ...overrides };
  fs.writeFileSync(path.join(dir, 'serve.mjs'), 'process.stdout.write("2.3.0\\n")\n');
  fs.mkdirSync(assets, { recursive: true });
  fs.writeFileSync(path.join(assets, 'manifest.json'), JSON.stringify(values));
  fs.mkdirSync(path.dirname(path.join(assets, values.nodePty)), { recursive: true });
  fs.writeFileSync(path.join(assets, values.nodePty), '');
  fs.writeFileSync(path.join(assets, values.photonWasm), '');
  for (const key of ['parcelWatcher', 'fff', 'fffFfi', 'persistentPty']) writeElf(path.join(assets, values[key]), 'x64');
  writeElf(path.join(assets, '@lydell/node-pty-linux-x64/prebuilds/linux-x64/pty.node'), 'x64');
  return dir;
};

const target = { platform: 'linux', arch: 'x64', version: '2.3.0' };

test('pins the bundled server to an exact OpenCode 2.x release', () => {
  assert.match(readPinnedOpenCodeServerVersion(), /^2\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
});

test('accepts a complete staging for its target and runs its --version', () => {
  const dir = stage();
  try {
    assert.deepEqual(verifyOpenCodeServer(dir, target), { version: '2.3.0', ran: false });
    assert.deepEqual(verifyOpenCodeServer(dir, { ...target, runtime: process.execPath }), { version: '2.3.0', ran: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('refuses a staging for another version, platform or architecture', () => {
  const dir = stage();
  try {
    assert.throws(() => verifyOpenCodeServer(dir, { ...target, version: '2.4.0' }), /version mismatch: expected 2\.4\.0, got 2\.3\.0/);
    assert.throws(() => verifyOpenCodeServer(dir, { ...target, arch: 'arm64' }), /staged for linux-x64, expected linux-arm64/);
    writeElf(path.join(dir, 'assets', manifest.persistentPty), 'arm64');
    assert.throws(() => verifyOpenCodeServer(dir, target), /persistent PTY daemon is arm64, expected x64/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('refuses a staging with a missing native file', () => {
  const dir = stage();
  try {
    fs.rmSync(path.join(dir, 'assets', manifest.fffFfi));
    assert.throws(() => verifyOpenCodeServer(dir, target), /missing its fff FFI binding/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('refuses an entry whose --version disagrees with the pin', () => {
  const dir = stage();
  try {
    fs.writeFileSync(path.join(dir, 'serve.mjs'), 'process.stdout.write("2.2.0\\n")\n');
    assert.throws(() => verifyOpenCodeServer(dir, { ...target, runtime: process.execPath }), /reports 2\.2\.0, expected 2\.3\.0/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
