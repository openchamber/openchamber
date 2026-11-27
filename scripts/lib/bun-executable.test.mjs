import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveBunExecutable } from './bun-executable.mjs';

test('uses the Bun executable that launched the package script', () => {
  const executable = '/opt/bun/bin/bun';
  assert.equal(resolveBunExecutable({
    platform: 'linux',
    env: { npm_execpath: executable },
    fileExists: (candidate) => candidate === executable,
  }), executable);
});

test('prefers bun.exe from PATH on Windows', () => {
  const executable = 'C:\\Tools\\Bun\\bun.exe';
  assert.equal(resolveBunExecutable({
    platform: 'win32',
    env: {},
    fileExists: () => false,
    findOnPath: (name) => name === 'bun.exe' ? executable : null,
  }), executable);
});

test('does not return an extensionless Windows npm shim', () => {
  const shim = 'C:\\Users\\dev\\AppData\\Roaming\\npm\\bun';
  const executable = 'C:\\Tools\\Bun\\bun.exe';

  assert.equal(resolveBunExecutable({
    platform: 'win32',
    env: { npm_execpath: shim },
    fileExists: (candidate) => candidate === shim,
    findOnPath: (name) => name === 'bun.exe' ? executable : null,
  }), executable);
});

test('derives bun.exe when Windows PATH exposes only an npm bun.cmd shim', () => {
  const shims = [
    ['C:\\Users\\dev\\AppData\\Roaming\\npm\\bun.cmd', 'C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\bun\\bin\\bun.exe'],
    ['C:\\Dev Projects\\node_modules\\.bin\\bun.cmd', 'C:\\Dev Projects\\node_modules\\bun\\bin\\bun.exe'],
    ['C:\\Tools\\node_modules\\.bin\\bun.cmd', 'C:\\Tools\\node_modules\\.bin\\node_modules\\bun\\bin\\bun.exe'],
  ];
  for (const [shim, executable] of shims) {
    assert.equal(resolveBunExecutable({
      platform: 'win32',
      env: {},
      fileExists: (candidate) => candidate === executable,
      findOnPath: (name) => name === 'bun.cmd' ? shim : null,
    }), executable);
  }
});

test('falls back to bun when no directly spawnable executable is available', () => {
  assert.equal(resolveBunExecutable({
    platform: 'win32',
    env: {},
    fileExists: () => false,
    findOnPath: () => null,
  }), 'bun');
});
