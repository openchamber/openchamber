import { afterEach, beforeEach, describe, mock, test } from 'bun:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

mock.module('vscode', () => ({
  l10n: { t: (value) => value },
  workspace: { getConfiguration: () => ({ get: () => '' }) },
  window: { createOutputChannel: () => ({ appendLine: () => {} }) },
}));

const originalEnv = { ...process.env };
let root = '';

const executable = (filePath) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '');
  if (process.platform !== 'win32') fs.chmodSync(filePath, 0o755);
  return filePath;
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-opencode-'));
  process.env.PATH = path.join(root, 'empty-path');
  process.env.USERPROFILE = path.join(root, 'home');
  process.env.APPDATA = path.join(root, 'appdata');
  process.env.LOCALAPPDATA = path.join(root, 'localappdata');
  process.env.ProgramData = path.join(root, 'programdata');
  process.env.ProgramFiles = path.join(root, 'programfiles');
  delete process.env.OPENCODE_BINARY;
  delete process.env.OPENCODE_PATH;
  delete process.env.OPENCHAMBER_OPENCODE_PATH;
  delete process.env.OPENCHAMBER_OPENCODE_BIN;
});

afterEach(() => {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  fs.rmSync(root, { recursive: true, force: true });
});

describe('OpenCode CLI discovery', () => {
  test('finds opencode2 on an isolated PATH when legacy opencode is absent', async () => {
    const pathDir = path.join(root, 'path');
    const name = process.platform === 'win32' ? 'opencode2.exe' : 'opencode2';
    const opencode2 = executable(path.join(pathDir, name));
    process.env.PATH = pathDir;
    const { resolveOpencodeCliPath } = await import('./opencode');

    assert.equal(resolveOpencodeCliPath({ home: path.join(root, 'home'), fallbacks: [], cache: false }), opencode2);
  });

  test('prefers legacy opencode when both names are on PATH', async () => {
    const pathDir = path.join(root, 'path');
    const extension = process.platform === 'win32' ? '.exe' : '';
    const legacy = executable(path.join(pathDir, `opencode${extension}`));
    executable(path.join(pathDir, `opencode2${extension}`));
    process.env.PATH = pathDir;
    const { resolveOpencodeCliPath } = await import('./opencode');

    assert.equal(resolveOpencodeCliPath({ home: path.join(root, 'home'), fallbacks: [], cache: false }), legacy);
  });

  test.skipIf(process.platform !== 'win32')('unwraps the Windows opencode2 npm shim to its native executable', async () => {
    const npmDir = path.join(root, 'appdata', 'npm');
    const shim = executable(path.join(npmDir, 'opencode2.cmd'));
    const nativeBinary = executable(path.join(npmDir, 'node_modules', '@opencode-ai', 'cli', 'bin', 'opencode2.exe'));
    const { resolveWindowsLaunchSpec } = await import('./opencode');

    assert.deepEqual(resolveWindowsLaunchSpec(shim, ['serve']), { binary: nativeBinary, args: ['serve'] });
  });

  test.skipIf(process.platform !== 'win32')('finds the opencode2 npm shim in the known npm location', async () => {
    const shim = executable(path.join(root, 'appdata', 'npm', 'opencode2.cmd'));
    const { resolveOpencodeCliPath } = await import('./opencode');

    assert.equal(resolveOpencodeCliPath({
      home: path.join(root, 'home'),
      cache: false,
      spawnSync: () => ({ status: 1, stdout: '', stderr: '' }),
    }), shim);
  });

  test.skipIf(process.platform !== 'win32')('uses where.exe for opencode2 when legacy resolves only to the desktop GUI', async () => {
    const desktop = executable(path.join(root, 'localappdata', 'Programs', 'OpenCode', 'OpenCode.exe'));
    const opencode2 = executable(path.join(root, 'where', 'opencode2.exe'));
    const spawnSync = (_command, args) => ({
      status: 0,
      stdout: `${args[0] === 'opencode' ? desktop : opencode2}\r\n`,
      stderr: '',
    });
    const { resolveOpencodeCliPath } = await import('./opencode');

    assert.equal(resolveOpencodeCliPath({
      home: path.join(root, 'home'),
      fallbacks: [],
      cache: false,
      spawnSync,
    }), opencode2);
  });

  test.skipIf(process.platform === 'win32')('uses shell discovery for opencode2 after PATH and known locations miss', async () => {
    const shell = executable(path.join(root, 'shell'));
    const opencode2 = executable(path.join(root, 'shell-bin', 'opencode2'));
    process.env.SHELL = shell;
    const spawnSync = (_command, args) => ({
      status: args.at(-1) === 'command -v opencode2' ? 0 : 1,
      stdout: args.at(-1) === 'command -v opencode2' ? `${opencode2}\n` : '',
      stderr: '',
    });
    const { resolveOpencodeCliPath } = await import('./opencode');

    assert.equal(resolveOpencodeCliPath({
      home: path.join(root, 'home'),
      fallbacks: [],
      cache: false,
      spawnSync,
    }), opencode2);
  });
});
