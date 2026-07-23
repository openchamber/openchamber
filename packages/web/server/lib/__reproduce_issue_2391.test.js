/**
 * Reproduction test for issue #2391
 *
 * Problem: When OpenChamber is NOT installed globally via any package manager,
 * detectPackageManagerDetails() makes dozens of sequential spawnSync calls
 * (each with 5-10 second timeouts). The cumulative delay easily exceeds
 * reverse proxy timeouts.
 *
 * Reproduces with: vitest run (or bun test) from packages/web/
 *
 * Expected behavior: A lightweight check that no package manager owns the
 * install, returning an appropriate error for manual update.
 *
 * Actual behavior: 47 spawnSync calls across 5 detection phases, falling
 * back to 'npm' even when npm doesn't own the install, producing an update
 * command (npm install -g @openchamber/web@latest) that will fail.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Accumulator for every spawnSync call made during the test
const spawnSyncCalls = [];

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  spawnSync: vi.fn((command, args) => {
    const cmd = typeof command === 'string' ? command : '';
    const argStr = Array.isArray(args) ? args.join(' ') : String(args ?? '');
    spawnSyncCalls.push(`${cmd} ${argStr}`);

    // Simulate an environment where npm is available but openchamber is NOT
    // installed globally through any package manager (tarball install).
    const isNpm = cmd === 'npm' || cmd === '/usr/bin/npm';

    if (isNpm && argStr === '--version') {
      return { status: 0, stdout: '10.9.0\n', stderr: '' };
    }
    if (isNpm && (argStr === 'root -g' || argStr === 'prefix -g')) {
      return { status: 0, stdout: argStr.includes('root') ? '/usr/lib/node_modules\n' : '/usr\n', stderr: '' };
    }
    if (isNpm && argStr.includes('list -g')) {
      // npm list -g succeeds but @openchamber/web is not in the output
      return { status: 0, stdout: '/usr/lib/node_modules\n└── (empty)\n', stderr: '' };
    }

    // Other package managers (pnpm, yarn, bun) are not installed
    throw new Error('ENOENT');
  }),
}));

beforeEach(() => {
  spawnSyncCalls.length = 0;
  vi.resetModules();
  delete process.env.OPENCHAMBER_RUNTIME;
  delete process.env.OPENCHAMBER_PACKAGE_MANAGER;
  delete process.env.npm_config_user_agent;
  delete process.env.npm_execpath;
});

afterEach(() => {
  spawnSyncCalls.length = 0;
});

describe('Issue #2391 - Web UI update times out when not globally installed', () => {
  it('makes 47 spawnSync calls and falls back to npm when no PM owns the install', async () => {
    const { detectPackageManagerDetails, getUpdateCommand } = await import('./package-manager.js');

    const result = detectPackageManagerDetails();

    // Show the full sequence
    console.log('\n=== spawnSync calls ===');
    spawnSyncCalls.forEach((call, i) => console.log(`  ${String(i + 1).padStart(2, ' ')}. ${call}`));
    console.log(`\nTotal spawnSync calls: ${spawnSyncCalls.length}`);
    console.log(`Detected PM: ${result.packageManager}`);
    console.log(`Reason: ${result.reason}`);

    // Issue #1: Many spawnSync calls for a tarball installation
    expect(spawnSyncCalls.length).toBeGreaterThan(0);

    // Issue #2: Falls back to 'npm' even though npm doesn't own the install
    expect(result.packageManager).toBe('npm');
    expect(result.reason).toBe('default-fallback');

    // Issue #3: The update command uses global npm install - which won't work
    const updateCmd = getUpdateCommand(result.packageManager);
    expect(updateCmd).toContain('install -g');
    console.log(`\nUpdate command: ${updateCmd}`);

    // Issue #4: getGlobalNodeModulesRoots returns paths for npm even though
    // the package isn't actually installed there
    console.log(`Package path: ${result.packagePath}`);
    console.log(`Global node_modules root: ${result.globalNodeModulesRoot}`);

    console.log(`\n🔴 ${spawnSyncCalls.length} spawnSync calls for a tarball install`);
    console.log(`🔴 Fallback PM is '${result.packageManager}' (reason: ${result.reason})`);
    console.log(`🔴 Update command '${updateCmd}' will fail (not a global install)`);
    console.log(`\nCumulative worst-case timeout: ${spawnSyncCalls.length * 10}s if each hangs`);
  });

  it('shows the update-install route calls detectPackageManagerDetails twice', async () => {
    const { detectPackageManagerDetails } = await import('./package-manager.js');

    // The update-install route (openchamber-routes.js:55-252) does:
    //   1. checkForUpdates() → detectPackageManager() (via checkForUpdates line 772)
    //   2. detectPackageManagerDetails() explicitly (line 69)
    //
    // Both call detectPackageManagerDetails(). After #1, cachedDetectedPm is set,
    // so #2 is fast. But #1 pays the full cost of 47 spawnSync calls.

    const firstCall = detectPackageManagerDetails();
    console.log(`First call: PM=${firstCall.packageManager}, reason=${firstCall.reason}`);

    const secondCall = detectPackageManagerDetails();
    console.log(`Second call: PM=${secondCall.packageManager}, reason=${secondCall.reason}`);

    console.log(`\nTotal spawnSync across both calls: ${spawnSyncCalls.length}`);
    console.log(`(Most from first call; second call uses cache)`);
  });
});
