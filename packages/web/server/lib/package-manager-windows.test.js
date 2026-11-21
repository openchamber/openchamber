import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findWindowsCommandInterpreter, findWindowsPackageManagerShim } from './package-manager-probe.js';

describe('findWindowsCommandInterpreter', () => {
  it('uses an absolute ComSpec', () => {
    expect(findWindowsCommandInterpreter({ ComSpec: String.raw`D:\Win\system32\cmd.exe`, SystemRoot: String.raw`C:\Windows` }))
      .toBe(String.raw`D:\Win\system32\cmd.exe`);
  });

  it('falls back to SystemRoot when ComSpec is missing or relative, and never to a bare cmd.exe', () => {
    expect(findWindowsCommandInterpreter({ SystemRoot: String.raw`C:\Windows` })).toBe(String.raw`C:\Windows\System32\cmd.exe`);
    expect(findWindowsCommandInterpreter({ COMSPEC: 'cmd.exe', SYSTEMROOT: String.raw`C:\Windows` })).toBe(String.raw`C:\Windows\System32\cmd.exe`);
    expect(findWindowsCommandInterpreter({ ComSpec: 'cmd.exe' })).toBeNull();
    expect(findWindowsCommandInterpreter({ SystemRoot: 'Windows' })).toBeNull();
  });
});

describe('findWindowsPackageManagerShim', () => {
  const files = new Set([
    // Shims a working-directory lookup would reach through `.`, `work` and `\work`.
    'npm.cmd',
    String.raw`work\npm.cmd`,
    String.raw`\work\npm.cmd`,
    String.raw`C:\Program Files\nodejs\npm.cmd`,
    String.raw`C:\Program Files\nodejs\npm.exe`,
    String.raw`\\server\share\tools\pnpm.cmd`,
  ].map((file) => file.toLowerCase()));
  // Windows file names are case-insensitive; PATHEXT lists upper-case extensions.
  const exists = (candidate) => files.has(candidate.toLowerCase());

  it('skips relative and current-drive PATH entries that resolve against the working directory', () => {
    const env = { Path: String.raw`.;work;\work;"C:\Program Files\nodejs"`, PATHEXT: '.CMD;.EXE' };
    expect(findWindowsPackageManagerShim('npm', env, exists)).toBe(String.raw`C:\Program Files\nodejs\npm.CMD`);
  });

  it('follows PATHEXT order and accepts UNC directories', () => {
    expect(findWindowsPackageManagerShim('npm', { PATH: String.raw`C:\Program Files\nodejs`, PATHEXT: '.EXE;.CMD' }, exists))
      .toBe(String.raw`C:\Program Files\nodejs\npm.EXE`);
    expect(findWindowsPackageManagerShim('pnpm', { PATH: String.raw`\\server\share\tools` }, exists))
      .toBe(String.raw`\\server\share\tools\pnpm.CMD`);
  });

  it('finds nothing when the manager is not in an absolute PATH directory', () => {
    expect(findWindowsPackageManagerShim('npm', { PATH: String.raw`.;C:\Windows` }, exists)).toBeNull();
    expect(findWindowsPackageManagerShim('yarn', {}, exists)).toBeNull();
  });
});

describe.skipIf(process.platform !== 'win32')('Windows package manager shims', () => {
  it.each(['npm', 'pnpm', 'yarn'])('detects and verifies updates with %s.cmd', (manager) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber pm '));
    try {
      fs.writeFileSync(path.join(dir, `${manager}.cmd`), [
        '@echo off',
        'if "%1"=="--version" (echo 10.4.0 & exit /b 0)',
        'if "%1"=="root" (echo %PM_ROOT% & exit /b 0)',
        'if "%1"=="prefix" (echo %PM_ROOT% & exit /b 0)',
        'if "%1"=="list" (echo @openchamber/web@%PM_VERSION% & exit /b 0)',
        'if "%1"=="global" if "%2"=="list" (echo @openchamber/web@%PM_VERSION% & exit /b 0)',
        'exit /b 0',
      ].join('\r\n'));
      const moduleUrl = pathToFileURL(fileURLToPath(new URL('./package-manager.js', import.meta.url))).href;
      const script = `import { detectPackageManagerDetails, executeUpdate } from ${JSON.stringify(moduleUrl)};
        const detection = detectPackageManagerDetails();
        const result = executeUpdate(${JSON.stringify(manager)}, { targetVersion: '1.24.1', silent: true });
        console.log(JSON.stringify({ detection, result }));`;
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
        !['path', 'npm_config_user_agent', 'npm_execpath'].includes(key.toLowerCase())));
      const run = (version, forced = true) => {
        const child = spawnSync(process.execPath, ['--import', new URL('../../scripts/register-server-sources.mjs', import.meta.url).href, '--input-type=module', '-e', script], {
          encoding: 'utf8',
          env: { ...env, OPENCHAMBER_RUNTIME: '', OPENCHAMBER_PACKAGE_MANAGER: forced ? manager : '',
            npm_config_user_agent: manager, npm_execpath: '',
            PATH: `${dir};${process.env.PATH}`, PM_ROOT: dir, PM_VERSION: version },
        });
        expect(child.status, child.stderr).toBe(0);
        return JSON.parse(child.stdout.trim().split(/\r?\n/).at(-1));
      };
      const success = run('1.24.1');
      expect(success.detection.reason).toBe('forced-env');
      expect(success.detection.packageManager).toBe(manager);
      if (manager !== 'yarn') expect(success.detection.globalNodeModulesRoot).toBe(dir);
      expect(success.result).toMatchObject({ success: true, installedVersion: '1.24.1' });
      expect(run('1.24.1', false).detection).toMatchObject({ packageManager: manager, reason: 'hinted-visible-install' });
      expect(run('1.19.0').result).toMatchObject({ success: false, error: expect.stringContaining('1.19.0') });
      expect(run('').result).toMatchObject({ success: false, error: expect.stringContaining('Could not determine') });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);

  it('never runs a pnpm shim from the working directory', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber cwd '));
    const pathDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber path '));
    const marker = path.join(cwd, 'cwd-shim-ran.txt');
    const writeShim = (dir, version, extra = []) => fs.writeFileSync(path.join(dir, 'pnpm.cmd'),
      ['@echo off', ...extra, `echo ${version}`, 'exit /b 0'].join('\r\n'));
    try {
      // The working-directory shim claims a pnpm new enough for --allow-build.
      writeShim(cwd, '10.4.0', [`echo ran>"${marker}"`]);
      const moduleUrl = pathToFileURL(fileURLToPath(new URL('./package-manager.js', import.meta.url))).href;
      const script = `import { getUpdateCommand } from ${JSON.stringify(moduleUrl)};
        console.log(getUpdateCommand('pnpm', { targetVersion: '1.24.1' }));`;
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
      const run = () => {
        const child = spawnSync(process.execPath, ['--import', new URL('../../scripts/register-server-sources.mjs', import.meta.url).href, '--input-type=module', '-e', script], {
          cwd,
          encoding: 'utf8',
          env: { ...env, PATH: `${pathDir};${path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')}` },
        });
        expect(child.status, child.stderr).toBe(0);
        return child.stdout.trim().split(/\r?\n/).at(-1);
      };

      // Only the working directory has pnpm: it is not run.
      expect(run()).toBe('pnpm add -g @openchamber/web@1.24.1');
      expect(fs.existsSync(marker)).toBe(false);

      // The installed pnpm on PATH answers, not the working-directory shim.
      writeShim(pathDir, '9.15.9');
      expect(run()).toBe('pnpm add -g @openchamber/web@1.24.1');
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(pathDir, { recursive: true, force: true });
    }
  }, 60000);
});
