import { describe, expect, it } from 'vitest';
import {
  buildChromeLaunchArgs,
  findBrowserExecutable,
  resolveBrowserExecutableSource,
} from './chrome.js';
import {
  getManagedBrowserInstallDir,
  resolveBrowserInstallPlatform,
  shouldDefaultNoSandbox,
} from './install.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('resolveBrowserInstallPlatform', () => {
  it('maps linux architectures including arm64', () => {
    expect(resolveBrowserInstallPlatform({ platform: 'linux', arch: 'x64' })).toBe('linux-x64');
    expect(resolveBrowserInstallPlatform({ platform: 'linux', arch: 'arm64' })).toBe('linux-arm64');
    expect(resolveBrowserInstallPlatform({ platform: 'linux', arch: 'aarch64' })).toBe('linux-arm64');
  });

  it('maps mac and windows', () => {
    expect(resolveBrowserInstallPlatform({ platform: 'darwin', arch: 'arm64' })).toBe('mac-arm64');
    expect(resolveBrowserInstallPlatform({ platform: 'darwin', arch: 'x64' })).toBe('mac-x64');
    expect(resolveBrowserInstallPlatform({ platform: 'win32', arch: 'x64' })).toBe('win64');
  });
});

describe('findBrowserExecutable', () => {
  it('prefers settings path over env and discovery', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-chrome-'));
    const preferred = path.join(dir, 'preferred-chrome');
    const envPath = path.join(dir, 'env-chrome');
    fs.writeFileSync(preferred, '');
    fs.writeFileSync(envPath, '');
    const found = findBrowserExecutable({
      fs,
      path,
      env: { OPENCHAMBER_BROWSER_PATH: envPath },
      preferredPath: preferred,
      searchPathFor: () => null,
    });
    expect(found).toBe(preferred);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns null when preferred path is missing instead of falling through', () => {
    const found = findBrowserExecutable({
      fs,
      path,
      env: {},
      preferredPath: '/definitely/missing/chrome-binary',
      searchPathFor: () => '/usr/bin/google-chrome-stable',
    });
    expect(found).toBeNull();
  });

  it('uses managed install under dataDir when present', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-data-'));
    const installDir = getManagedBrowserInstallDir(dataDir);
    fs.mkdirSync(path.join(installDir, 'opt', 'google', 'chrome'), { recursive: true });
    const executable = path.join(installDir, 'opt', 'google', 'chrome', 'google-chrome');
    fs.writeFileSync(executable, '');
    fs.writeFileSync(
      path.join(installDir, 'install.json'),
      JSON.stringify({ executable, platform: 'linux-x64', version: 'test' }),
    );
    const found = findBrowserExecutable({
      fs,
      path,
      env: {},
      dataDir,
      searchPathFor: () => null,
    });
    expect(found).toBe(executable);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
});

describe('resolveBrowserExecutableSource', () => {
  it('reports missing preferred settings path', () => {
    const resolved = resolveBrowserExecutableSource({
      fs,
      path,
      env: {},
      preferredPath: '/missing/chrome',
      searchPathFor: () => null,
    });
    expect(resolved).toMatchObject({ executable: null, source: 'settings', missingPreferred: true });
  });
});

describe('buildChromeLaunchArgs', () => {
  it('adds no-sandbox when requested or via env', () => {
    const base = buildChromeLaunchArgs({ profileDir: '/tmp/p', noSandbox: true });
    expect(base).toContain('--no-sandbox');
    expect(base).toContain('--disable-setuid-sandbox');
    expect(base).toContain('--disable-gpu');
    expect(base).toContain('--headless=new');

    const viaEnv = buildChromeLaunchArgs({
      profileDir: '/tmp/p',
      env: { OPENCHAMBER_BROWSER_NO_SANDBOX: 'true' },
    });
    expect(viaEnv).toContain('--no-sandbox');
  });

  it('keeps sandbox for non-root without flags', () => {
    const args = buildChromeLaunchArgs({ profileDir: '/tmp/p', isRoot: false, noSandbox: false, env: {} });
    expect(args).not.toContain('--no-sandbox');
  });
});

describe('shouldDefaultNoSandbox', () => {
  it('defaults true for root linux', () => {
    expect(shouldDefaultNoSandbox({ platform: 'linux', getuid: () => 0, fs: { existsSync: () => false } })).toBe(true);
  });

  it('defaults true when /.dockerenv exists', () => {
    expect(
      shouldDefaultNoSandbox({
        platform: 'linux',
        getuid: () => 1000,
        fs: { existsSync: (p) => p === '/.dockerenv' },
      }),
    ).toBe(true);
  });

  it('defaults false on mac', () => {
    expect(shouldDefaultNoSandbox({ platform: 'darwin', getuid: () => 0, fs: { existsSync: () => true } })).toBe(false);
  });
});
