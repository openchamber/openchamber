import assert from 'node:assert/strict';
import path from 'node:path';
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

test('derives bun.exe when Windows PATH exposes only the npm bun.cmd shim', () => {
  const shim = 'C:\\Users\\dev\\AppData\\Roaming\\npm\\bun.cmd';
  const executable = path.win32.resolve(
    path.win32.dirname(shim),
    'node_modules',
    'bun',
    'bin',
    'bun.exe',
  );
  const env = { Path: 'C:\\Users\\dev\\AppData\\Roaming\\npm' };
  const lookups = [];

  assert.equal(resolveBunExecutable({
    platform: 'win32',
    env,
    fileExists: (candidate) => candidate === executable,
    findOnPath: (name, lookupEnv) => {
      assert.equal(lookupEnv, env);
      lookups.push(name);
      return name === 'bun.cmd' ? shim : null;
    },
  }), executable);
  assert.deepEqual(lookups, ['bun.exe', 'bun.cmd']);
});

test('falls back to bun when no directly spawnable executable is available', () => {
  assert.equal(resolveBunExecutable({
    platform: 'win32',
    env: {},
    fileExists: () => false,
    findOnPath: () => null,
  }), 'bun');
});
