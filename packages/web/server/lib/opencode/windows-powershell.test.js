import path from 'node:path';
import { describe, expect, it } from 'bun:test';

import { isString } from '../shared/guards.js';
import {
  createWindowsPowerShellResolver,
  getStablePowerShell7Directories,
} from './windows-powershell.js';

const PROGRAM_FILES = 'C:\\Program Files';
const LOCAL_APPDATA = 'C:\\Users\\Ada\\AppData\\Local';
const USER_PROFILE = 'C:\\Users\\Ada';
const WINDOWS_APPS = `${LOCAL_APPDATA}\\Microsoft\\WindowsApps`;
const STABLE_7_DIR = `${PROGRAM_FILES}\\PowerShell\\7`;
const STABLE_7_PREVIEW_DIR = `${PROGRAM_FILES}\\PowerShell\\7-preview`;
const STABLE_7_EXE = `${STABLE_7_DIR}\\pwsh.exe`;
const STABLE_7_PREVIEW_EXE = `${STABLE_7_PREVIEW_DIR}\\pwsh.exe`;
const USER_STABLE_7_EXE = `${LOCAL_APPDATA}\\Microsoft\\PowerShell\\7\\pwsh.exe`;
const SYSTEM_PATH = 'C:\\Windows\\System32';
const SYSTEM_PWSH = `${SYSTEM_PATH}\\pwsh.exe`;
const SYSTEM_POWERSHELL = `${SYSTEM_PATH}\\powershell.exe`;
const ALIAS_PWSH = `${WINDOWS_APPS}\\pwsh.exe`;
const ALIAS_POWERSHELL = `${WINDOWS_APPS}\\powershell.exe`;
const LEGACY_POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const WINDOWS_PATH_DELIMITER = ';';

const probeOutput = (version, executable) => `${version}|${executable}`;

const baseEnv = (overrides = {}) => ({
  PATH: SYSTEM_PATH,
  ProgramFiles: PROGRAM_FILES,
  LOCALAPPDATA: LOCAL_APPDATA,
  USERPROFILE: USER_PROFILE,
  SystemRoot: 'C:\\Windows',
  PATHEXT: '.COM;.EXE;.BAT;.CMD',
  ...overrides,
});

// Keys are the absolute executable handed to spawnSync, which is the point: the
// resolver must resolve a name against the PATH it reports on, because a bare
// name would be looked up with this process's own PATH instead.
const createProbeStub = (executables) => {
  const calls = [];
  const spawnSync = (executable, _args, options) => {
    const pathValue = String(options?.env?.PATH ?? '');
    calls.push({ executable, pathValue });

    const entry = executables[executable];
    if (entry instanceof Error) throw entry;

    const output = entry instanceof Function
      ? entry(pathValue)
      : (isString(entry) ? entry : null);
    if (!isString(output)) return { status: 1, stdout: '', stderr: '' };
    return { status: 0, stdout: `${output}\n`, stderr: '' };
  };
  return { spawnSync, calls };
};

const createResolver = (executables, env = baseEnv(), platform = 'win32') => {
  const stub = createProbeStub(executables);
  const resolver = createWindowsPowerShellResolver({
    env,
    platform,
    path: path.win32,
    spawnSync: stub.spawnSync,
  });
  return { ...stub, resolver };
};

describe('getStablePowerShell7Directories', () => {
  it('lists the named PowerShell 7 install directories on Windows', () => {
    const directories = getStablePowerShell7Directories({ env: baseEnv(), platform: 'win32', path: path.win32 });
    expect(directories).toEqual([
      STABLE_7_DIR,
      STABLE_7_PREVIEW_DIR,
      `${LOCAL_APPDATA}\\Microsoft\\PowerShell\\7`,
    ]);
  });

  it('lists nothing off Windows', () => {
    expect(getStablePowerShell7Directories({ env: baseEnv(), platform: 'linux', path: path.win32 })).toEqual([]);
  });
});

describe('createWindowsPowerShellResolver', () => {
  it('answers nothing off Windows', () => {
    const { resolver } = createResolver({}, baseEnv(), 'linux');
    expect(resolver.getStableDirectory()).toBeNull();
    expect(resolver.describe({ managedPath: SYSTEM_PATH })).toBeNull();
  });

  it('keeps a stable directory only when the binary verifies as PowerShell 7', () => {
    const { resolver } = createResolver({
      [STABLE_7_EXE]: probeOutput('7.6.7', STABLE_7_EXE),
    });

    expect(resolver.getStableDirectory()).toBe(STABLE_7_DIR);
  });

  it('treats an existing directory whose binary is not PowerShell 7 as absent', () => {
    // A stale or half-removed install still sits at the stable path.
    const { resolver } = createResolver({
      [STABLE_7_EXE]: probeOutput('5.1.26100.9549', LEGACY_POWERSHELL),
    });

    expect(resolver.getStableDirectory()).toBeNull();
  });

  it('accepts a preview build as PowerShell 7', () => {
    const { resolver } = createResolver({
      [STABLE_7_PREVIEW_EXE]: probeOutput('7.5.0-preview.4', STABLE_7_PREVIEW_EXE),
    });

    expect(resolver.getStableDirectory()).toBe(STABLE_7_PREVIEW_DIR);
  });

  it('skips a stable candidate that cannot be spawned', () => {
    const { resolver } = createResolver({
      [STABLE_7_EXE]: new Error('EACCES'),
      [STABLE_7_PREVIEW_EXE]: probeOutput('7.6.0', STABLE_7_PREVIEW_EXE),
    });

    expect(resolver.getStableDirectory()).toBe(STABLE_7_PREVIEW_DIR);
  });

  it('picks the highest version when several stable installs verify', () => {
    const { resolver } = createResolver({
      [USER_STABLE_7_EXE]: probeOutput('7.6.7', USER_STABLE_7_EXE),
      [STABLE_7_EXE]: probeOutput('7.2.24', STABLE_7_EXE),
      [STABLE_7_PREVIEW_EXE]: probeOutput('7.7.0', STABLE_7_PREVIEW_EXE),
    });

    expect(resolver.getStableDirectory()).toBe(STABLE_7_PREVIEW_DIR);
  });

  it('resolves a name to absolute candidates from the reported PATH, never to a bare name', () => {
    const { resolver, calls } = createResolver({
      [ALIAS_PWSH]: probeOutput('7.6.7', ALIAS_PWSH),
    });

    resolver.describe({ managedPath: SYSTEM_PATH });

    const probed = calls.map((call) => call.executable);
    expect(probed).toContain(SYSTEM_PWSH);
    expect(probed).toContain(ALIAS_PWSH);
    expect(probed.every((executable) => executable.includes('\\'))).toBe(true);
    expect(probed).not.toContain('pwsh.exe');
    expect(probed).not.toContain('powershell.exe');
  });

  it('reports the stable install once it is in front of the managed PATH', () => {
    const managedPath = [STABLE_7_DIR, SYSTEM_PATH].join(WINDOWS_PATH_DELIMITER);
    const { resolver } = createResolver({
      [STABLE_7_EXE]: probeOutput('7.6.7', STABLE_7_EXE),
    });

    const report = resolver.describe({ managedPath });

    expect(report.diagnostics).toMatchObject({
      insertedDirectory: STABLE_7_DIR,
      pwshPath: STABLE_7_EXE,
      pwshVersion: '7.6.7',
      effectivePath: STABLE_7_EXE,
      effectiveVersion: '7.6.7',
      downgrade: false,
    });
    expect(report.warning).toBeNull();
  });

  it('reports the versioned Store target the alias resolves to', () => {
    const versionedTarget = 'C:\\Program Files\\WindowsApps\\Microsoft.PowerShell_7.6.7.0_x64__8wekyb3d8bbwe\\pwsh.EXE';
    const { resolver } = createResolver({
      [ALIAS_PWSH]: probeOutput('7.6.7', versionedTarget),
    });

    const report = resolver.describe({ managedPath: [WINDOWS_APPS, SYSTEM_PATH].join(WINDOWS_PATH_DELIMITER) });

    expect(report.diagnostics.effectivePath).toBe(versionedTarget);
    expect(report.diagnostics.downgrade).toBe(false);
    expect(report.summary).toContain(versionedTarget);
  });

  it('warns only when PowerShell 7 is installed but the shell resolves to 5.1', () => {
    // The managed PATH is built from a redirected LocalAppData, so it does not
    // carry the alias directory and by-name resolution falls to Windows
    // PowerShell, while the Store pwsh 7 still exists under the user profile.
    const redirectedLocalAppData = 'C:\\Redirected\\Local';
    const { resolver } = createResolver({
      [ALIAS_PWSH]: probeOutput('7.6.7', ALIAS_PWSH),
      [LEGACY_POWERSHELL]: probeOutput('5.1.26100.9549', LEGACY_POWERSHELL),
    }, baseEnv({ LOCALAPPDATA: redirectedLocalAppData }));

    const report = resolver.describe({ managedPath: SYSTEM_PATH });

    expect(report.diagnostics.downgrade).toBe(true);
    expect(report.diagnostics.pwshPath).toBe(ALIAS_PWSH);
    expect(report.diagnostics.effectiveVersion).toBe('5.1.26100.9549');
    expect(report.warning).toContain('Windows PowerShell 5.1');
  });

  it('stays silent on a machine whose only interpreter is Windows PowerShell 5.1', () => {
    const { resolver } = createResolver({
      [SYSTEM_POWERSHELL]: probeOutput('5.1.26100.9549', LEGACY_POWERSHELL),
    });

    const report = resolver.describe({ managedPath: SYSTEM_PATH });

    expect(report.diagnostics.downgrade).toBe(false);
    expect(report.diagnostics.pwshPath).toBeNull();
    expect(report.warning).toBeNull();
    expect(report.summary).toContain('Windows PowerShell 5.1.26100.9549');
  });

  it('falls back to the absolute Windows PowerShell path when by-name lookup finds nothing', () => {
    const { resolver } = createResolver({
      [LEGACY_POWERSHELL]: probeOutput('5.1.26100.9549', LEGACY_POWERSHELL),
    });

    const report = resolver.describe({ managedPath: '' });

    expect(report.diagnostics.effectiveVersion).toBe('5.1.26100.9549');
  });

  it('does not probe again for a PATH it already answered', () => {
    const { resolver, calls } = createResolver({
      [STABLE_7_EXE]: probeOutput('7.6.7', STABLE_7_EXE),
    });

    resolver.describe({ managedPath: SYSTEM_PATH });
    const afterFirst = calls.length;
    resolver.describe({ managedPath: SYSTEM_PATH });

    expect(calls.length).toBe(afterFirst);
  });
});
