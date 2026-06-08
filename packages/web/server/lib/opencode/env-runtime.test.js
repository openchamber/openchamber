import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createOpenCodeEnvRuntime } from './env-runtime.js';

const originalOpencodeBinary = process.env.OPENCODE_BINARY;
const originalComSpec = process.env.ComSpec;
const originalPath = process.env.PATH;
const originalSystemRoot = process.env.SystemRoot;
const originalWslBinary = process.env.WSL_BINARY;
const originalOpenChamberWslBinary = process.env.OPENCHAMBER_WSL_BINARY;
const originalPlatform = process.platform;
const tempDirs = [];
const itIf = (condition) => condition ? it : it.skip;

const createTempDir = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};

const setPlatform = (platform) => {
  Object.defineProperty(process, 'platform', {
    value: platform,
  });
};

afterEach(() => {
  Object.defineProperty(process, 'platform', {
    value: originalPlatform,
  });

  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  if (typeof originalOpencodeBinary === 'string') {
    process.env.OPENCODE_BINARY = originalOpencodeBinary;
  } else {
    delete process.env.OPENCODE_BINARY;
  }

  if (typeof originalComSpec === 'string') {
    process.env.ComSpec = originalComSpec;
  } else {
    delete process.env.ComSpec;
  }

  if (typeof originalPath === 'string') {
    process.env.PATH = originalPath;
  } else {
    delete process.env.PATH;
  }

  if (typeof originalSystemRoot === 'string') {
    process.env.SystemRoot = originalSystemRoot;
  } else {
    delete process.env.SystemRoot;
  }

  if (typeof originalWslBinary === 'string') {
    process.env.WSL_BINARY = originalWslBinary;
  } else {
    delete process.env.WSL_BINARY;
  }

  if (typeof originalOpenChamberWslBinary === 'string') {
    process.env.OPENCHAMBER_WSL_BINARY = originalOpenChamberWslBinary;
  } else {
    delete process.env.OPENCHAMBER_WSL_BINARY;
  }
});

const createRuntime = (settings, options = {}) => {
  const state = {
    cachedLoginShellEnvSnapshot: null,
    resolvedOpencodeBinary: null,
    resolvedOpencodeBinarySource: null,
    useWslForOpencode: false,
    resolvedWslBinary: null,
    resolvedWslOpencodePath: null,
    resolvedWslDistro: null,
    resolvedNodeBinary: null,
    resolvedBunBinary: null,
    managedOpenCodeShellEnvSnapshot: null,
  };

  const runtime = createOpenCodeEnvRuntime({
    state,
    normalizeDirectoryPath: (value) => value,
    readSettingsFromDiskMigrated: async () => settings,
    spawnSync: options.spawnSync,
  });

  return { runtime, state };
};

describe('OpenCode env runtime', () => {
  it('throws a specific error for a missing configured OpenCode binary in strict mode', async () => {
    const { runtime } = createRuntime({ opencodeBinary: '/missing/opencode' });

    await expect(runtime.applyOpencodeBinaryFromSettings({ strict: true })).rejects.toMatchObject({
      code: 'OPENCODE_BINARY_INVALID',
      message: expect.stringContaining('Configured OpenCode binary not found: /missing/opencode'),
    });
  });

  it('throws a specific error for a configured directory without an executable CLI in strict mode', async () => {
    const dir = createTempDir('openchamber-opencode-dir-');
    const { runtime } = createRuntime({ opencodeBinary: dir });

    await expect(runtime.applyOpencodeBinaryFromSettings({ strict: true })).rejects.toMatchObject({
      code: 'OPENCODE_BINARY_INVALID',
      message: expect.stringContaining('Configured OpenCode binary directory does not contain an executable'),
    });
  });

  it('applies a valid configured executable OpenCode binary', async () => {
    const dir = createTempDir('openchamber-opencode-bin-');
    const binary = path.join(dir, 'opencode');
    fs.writeFileSync(binary, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(binary, 0o755);
    const { runtime, state } = createRuntime({ opencodeBinary: binary });

    await expect(runtime.applyOpencodeBinaryFromSettings({ strict: true })).resolves.toBe(binary);
    expect(process.env.OPENCODE_BINARY).toBe(binary);
    expect(state.resolvedOpencodeBinary).toBe(binary);
    expect(state.resolvedOpencodeBinarySource).toBe('settings');
  });

  itIf(process.platform === 'darwin')('rejects known macOS OpenCode app bundle executable paths', async () => {
    const { runtime } = createRuntime({ opencodeBinary: '/Applications/OpenCode.app/Contents/MacOS/OpenCode' });

    await expect(runtime.applyOpencodeBinaryFromSettings({ strict: true })).rejects.toMatchObject({
      code: 'OPENCODE_BINARY_INVALID',
      message: expect.stringContaining('macOS desktop app bundle'),
    });
  });

  it('rejects WSL settings in strict mode', async () => {
    setPlatform('win32');
    const dir = createTempDir('openchamber-no-wsl-');
    process.env.PATH = dir;
    process.env.SystemRoot = dir;
    process.env.WSL_BINARY = path.join(dir, 'missing-wsl.exe');
    process.env.OPENCHAMBER_WSL_BINARY = path.join(dir, 'missing-openchamber-wsl.exe');
    const { runtime } = createRuntime({ opencodeBinary: 'wsl:/usr/local/bin/opencode' });

    await expect(runtime.applyOpencodeBinaryFromSettings({ strict: true })).rejects.toMatchObject({
      message: expect.stringContaining('uses WSL'),
    });
  });

  it('does not auto-detect OpenCode from WSL fallback paths', () => {
    setPlatform('win32');
    const dir = createTempDir('openchamber-wsl-opencode-');
    const wslBinary = path.join(dir, 'wsl.exe');
    fs.writeFileSync(wslBinary, '');
    process.env.PATH = dir;
    process.env.SystemRoot = dir;
    process.env.WSL_BINARY = wslBinary;
    delete process.env.OPENCODE_BINARY;

    const calls = [];
    const spawnSyncMock = (command, args) => {
      calls.push({ command, args });
      if (command === 'where') {
        return { status: 1, stdout: '', stderr: '' };
      }
      if (command === wslBinary) {
        return { status: 0, stdout: '/home/alice/.opencode/bin/opencode\n', stderr: '' };
      }
      return { status: 1, stdout: '', stderr: '' };
    };
    const { runtime, state } = createRuntime({}, { spawnSync: spawnSyncMock });

    expect(runtime.resolveOpencodeCliPath()).toBeNull();
    expect(state.useWslForOpencode).toBe(false);
    expect(state.resolvedWslBinary).toBeNull();
    expect(state.resolvedWslOpencodePath).toBeNull();
    expect(state.resolvedOpencodeBinarySource).toBeNull();

    const wslCall = calls.find((call) => call.command === wslBinary);
    expect(wslCall).toBeUndefined();
  });

  it('launches Windows cmd shims through cmd call without embedded quotes', () => {
    setPlatform('win32');
    process.env.ComSpec = 'C:\\Windows\\System32\\cmd.exe';
    const dir = createTempDir('openchamber-opencode-cmd-');
    const shim = path.join(dir, 'opencode.cmd');
    fs.writeFileSync(shim, '@echo off\r\nexit /b 0\r\n');
    const { runtime } = createRuntime({});

    expect(runtime.resolveManagedOpenCodeLaunchSpec(shim)).toEqual({
      binary: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', 'call', shim],
      wrapperType: 'cmd-wrapper',
    });
  });

  it('resolves npm OpenCode cmd shims to the packaged Windows executable', () => {
    setPlatform('win32');
    const npmDir = createTempDir('openchamber-opencode-npm-');
    const shim = path.join(npmDir, 'opencode.cmd');
    const nativeBinary = path.join(npmDir, 'node_modules', 'opencode-ai', 'bin', 'opencode.exe');
    fs.mkdirSync(path.dirname(nativeBinary), { recursive: true });
    fs.writeFileSync(nativeBinary, '');
    fs.writeFileSync(shim, '@ECHO off\r\n"%dp0%\\node_modules\\opencode-ai\\bin\\opencode.exe" %*\r\n');
    const { runtime } = createRuntime({});

    expect(runtime.resolveManagedOpenCodeLaunchSpec(shim)).toEqual({
      binary: nativeBinary,
      args: [],
      wrapperType: 'native-wrapper',
    });
  });
});
