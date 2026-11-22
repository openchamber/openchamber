import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Mock child_process to prevent real spawnSync calls that would hang in tests
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(() => ({ status: 0, stdout: '/usr/local/bin', stderr: '' })),
}));

// Windows probes run a quoted absolute shim path through the shell; other
// shell strings are install commands.
function splitProbe(command, args) {
  if (Array.isArray(args)) return [command, args];
  const match = /^"([^"]+)"((?: \S+)*)$/.exec(command);
  if (!match) return [command, null];
  return [path.win32.basename(match[1]).replace(/\.[^.]+$/, ''), match[2].trim().split(' ').filter(Boolean)];
}

// The mocked spawnSync sees Windows probes only for managers a PATH directory holds.
const windowsShimDir = process.platform === 'win32' ? fs.mkdtempSync(path.join(os.tmpdir(), 'oc-pm-shims-')) : null;
if (windowsShimDir) {
  for (const manager of ['npm', 'pnpm', 'yarn']) fs.writeFileSync(path.join(windowsShimDir, `${manager}.cmd`), '');
}
beforeEach(() => {
  if (windowsShimDir) vi.stubEnv('PATH', windowsShimDir);
});
afterAll(() => {
  if (windowsShimDir) fs.rmSync(windowsShimDir, { recursive: true, force: true });
});

// Upstream's detection cases run through the real probe with child_process
// mocked; the fork's own detection tests inject spawnSync instead
// (package-manager.test.js).
describe('detectPackageManagerDetails', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    spawnSync.mockReset();
    vi.unstubAllEnvs();
  });

  it.skipIf(process.platform === 'win32')('finds global-bin ownership when the CLI is nested under build', async () => {
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oc-global-bin-owner-')));
    const root = path.join(directory, 'package');
    const bin = path.join(directory, 'bin');
    fs.mkdirSync(path.join(root, 'build/bin'), { recursive: true });
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: '@openchamber/web',
      main: './build/server/index.js',
      bin: { openchamber: './build/bin/cli.js' },
    }));
    fs.writeFileSync(path.join(root, 'build/bin/cli.js'), '');
    fs.symlinkSync(path.join(root, 'build/bin/cli.js'), path.join(bin, 'openchamber'));
    try {
      vi.stubEnv('OPENCHAMBER_RUNTIME', '');
      vi.stubEnv('OPENCHAMBER_PACKAGE_MANAGER', '');
      spawnSync.mockImplementation((command, args) => {
        if (command !== 'npm') return { status: 1, stdout: '', stderr: '' };
        if (args[0] === '--version') return { status: 0, stdout: '10.0.0', stderr: '' };
        if (args[0] === 'prefix') return { status: 0, stdout: directory, stderr: '' };
        return { status: 1, stdout: '', stderr: '' };
      });
      vi.resetModules();
      const { detectPackageManagerDetails } = await import('./package-manager.js');
      const packagePaths = await import('./web-package-paths.js');
      const resolvePaths = packagePaths.getWebPackagePaths;
      vi.spyOn(packagePaths, 'getWebPackagePaths').mockImplementation((url) =>
        url ? resolvePaths(url) : { ...packagePaths.webPackagePaths, root });
      expect(detectPackageManagerDetails()).toMatchObject({
        packageManager: 'npm',
        packagePath: root,
        reason: 'global-root-owner',
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ['Windows pnpm store', String.raw`D:\pnpm-store\v11\links\@openchamber\web\2.5.1\hash\node_modules\@openchamber\web`, 'pnpm'],
    ['POSIX pnpm store', '/home/user/.local/share/pnpm-store/v11/links/@openchamber/web/2.5.1/hash/node_modules/@openchamber/web', 'pnpm'],
    ['case-insensitive Windows pnpm store', String.raw`D:\PNPM-STORE\v11\links\@openchamber\web\2.5.1\hash\node_modules\@openchamber\web`, 'pnpm'],
    ['pnpm virtual store', '/opt/global/node_modules/.pnpm/@openchamber+web@2.5.1/node_modules/@openchamber/web', 'pnpm'],
    ['npm install', '/usr/local/lib/node_modules/@openchamber/web', 'npm'],
    ['unrelated store name', '/opt/pnpm-store-backup/node_modules/@openchamber/web', 'npm'],
  ])('uses the install path for %s when global roots cannot establish ownership', async (_name, packagePath, packageManager) => {
    vi.stubEnv('OPENCHAMBER_RUNTIME', '');
    vi.stubEnv('OPENCHAMBER_PACKAGE_MANAGER', '');
    vi.stubEnv('npm_config_user_agent', '');
    vi.stubEnv('npm_execpath', '');
    spawnSync.mockImplementation((rawCommand, rawArgs) => {
      const [command, args] = splitProbe(rawCommand, rawArgs);
      if (!args || (command !== 'npm' && command !== 'pnpm')) {
        return { status: 1, stdout: '', stderr: '' };
      }
      if (args[0] === '--version') {
        return { status: 0, stdout: '10.0.0', stderr: '' };
      }
      if (args[0] === 'list') {
        return { status: 0, stdout: '@openchamber/web 2.5.1', stderr: '' };
      }
      return { status: 1, stdout: '', stderr: '' };
    });
    vi.resetModules();
    const { detectPackageManagerDetails, getUpdateCommand } = await import('./package-manager.js');
    const packagePaths = await import('./web-package-paths.js');
    vi.spyOn(packagePaths, 'getWebPackagePaths').mockReturnValue({
      ...packagePaths.webPackagePaths,
      root: packagePath,
    });

    expect(detectPackageManagerDetails()).toMatchObject({
      packageManager,
      packagePath,
      reason: 'hinted-visible-install',
      globalNodeModulesRoot: null,
    });
    expect(getUpdateCommand()).toBe(packageManager === 'pnpm'
      ? 'pnpm add -g @openchamber/web@latest'
      : 'npm install -g @openchamber/web@latest');
  });

  it('keeps reporting a copy no package manager installed after the first detection', async () => {
    vi.stubEnv('OPENCHAMBER_RUNTIME', '');
    vi.stubEnv('OPENCHAMBER_PACKAGE_MANAGER', '');
    // No package manager answers, as on a server where an unpacked tarball runs.
    spawnSync.mockImplementation(() => ({ status: 1, stdout: '', stderr: '' }));
    vi.resetModules();
    const { detectPackageManagerDetails, isUnmanagedInstall } = await import('./package-manager.js');

    expect(detectPackageManagerDetails().reason).toBe('unmanaged-install');
    expect(detectPackageManagerDetails().reason).toBe('unmanaged-install');
    expect(isUnmanagedInstall()).toBe(true);
  });
});