import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createOpenCodeEnvRuntime } from './env-runtime.js';

const originalOpencodeBinary = process.env.OPENCODE_BINARY;
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
    return;
  }
  delete process.env.OPENCODE_BINARY;
});

const createRuntime = (settings) => {
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
    ENV_CONFIGURED_OPENCODE_WSL_DISTRO: null,
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

  it('does not classify failed WSL resolution as an invalid configured binary in strict mode', async () => {
    setPlatform('win32');
    const { runtime } = createRuntime({ opencodeBinary: 'wsl:/usr/local/bin/opencode' });

    const rejection = runtime.applyOpencodeBinaryFromSettings({ strict: true });

    await expect(rejection).rejects.toThrow('uses WSL');
    const error = await rejection.catch((caught) => caught);
    expect(error.code).toBeUndefined();
  });
});
