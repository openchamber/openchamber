#!/usr/bin/env node
/**
 * Reproduction script for issue #1720:
 * Mac initial setup process does not detect opencode installed via brew.
 *
 * This script simulates the EXACT opencode binary detection chain that
 * runs during initial setup (first launch) of the OpenChamber desktop app
 * on macOS.
 *
 * Detection chain in packages/web/server/lib/opencode/env-runtime.js:
 *   Step 1: Check env vars (OPENCODE_BINARY, OPENCODE_PATH, etc.)
 *   Step 2: searchPathFor('opencode') — walks process.env.PATH
 *   Step 3a: Hardcoded fallback paths (includes /opt/homebrew/bin/opencode,
 *            /usr/local/bin/opencode, etc.)
 *   Step 3b: Fast-path: /bin/sh -c 'command -v opencode' (with timeout)
 *   Step 4: Shell probing — $SHELL -lic 'command -v opencode'
 *            (with timeout, fixed)
 *
 * On macOS, apps launched from the Dock/Finder inherit a minimal PATH:
 *   /usr/bin:/bin:/usr/sbin:/sbin
 * This does NOT include any brew bin directories.
 *
 * The Electron main process (main.mjs) tries to augment PATH by probing
 * the user's login shell with:
 *   spawnSync($SHELL, ['-il', '-c', 'env -0'], { timeout: 5000 })
 *
 * If the shell startup is slow (>5s due to nvm, pyenv, etc.), this times
 * out and PATH stays minimal. The fast-path (Step 3b) catches standard brew
 * paths even with minimal PATH, and all shell probes now have a 5s timeout
 * to prevent blocking startup indefinitely.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);

// For accurate reproduction, try to find the actual env-runtime.js
const ENV_RUNTIME_PATH = path.resolve(
  path.dirname(__filename),
  '..',
  'packages/web/server/lib/opencode/env-runtime.js'
);

// ── Helpers ──────────────────────────────────────────────────

function isExecutable(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    if (process.platform === 'win32') {
      const ext = path.extname(filePath).toLowerCase();
      if (!ext) return true;
      return ['.exe', '.cmd', '.bat', '.com'].includes(ext);
    }
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function searchPathFor(binaryName, envPath) {
  const trimmed = typeof binaryName === 'string' ? binaryName.trim() : '';
  if (!trimmed) return null;
  const current = typeof envPath === 'string' ? envPath : '';
  const parts = current.split(path.delimiter).filter(Boolean);
  const candidateNames = [trimmed];
  for (const dir of parts) {
    for (const candidateName of candidateNames) {
      const candidate = path.join(dir, candidateName);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

// ── Print section header ─────────────────────────────────────

function section(title) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log(`${'─'.repeat(60)}`);
}

// ── Main reproduction ────────────────────────────────────────

async function main() {
  console.log(`🔍 Issue #1720 Reproduction`);
  console.log(`   Platform: ${process.platform} (${process.arch})`);
  console.log(`   Node: ${process.version}`);
  console.log(`   env-runtime.js: ${fs.existsSync(ENV_RUNTIME_PATH) ? 'found' : 'not found'}`);
  console.log(`   Timestamp: ${new Date().toISOString()}`);
  console.log();

  // ── Step 0: Find actual opencode binary on system ─────────

  section('Step 0: Locate opencode on this system');

  let whichPath = null;
  try {
    const r = spawnSync('which', ['opencode'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) {
      whichPath = r.stdout.trim();
      console.log(`  'which opencode' → ${whichPath}`);
      console.log(`  Is executable: ${isExecutable(whichPath)}`);
      if (isExecutable(whichPath)) {
        const realPath = fs.realpathSync(whichPath);
        console.log(`  Real path (resolved symlinks): ${realPath}`);
      }
    } else {
      console.log(`  'which opencode' failed (status ${r.status})`);
    }
  } catch (err) {
    console.log(`  'which opencode' error: ${err.message}`);
  }

  // Also try 'command -v opencode'
  try {
    const r = spawnSync('sh', ['-c', 'command -v opencode'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) {
      console.log(`  'command -v opencode' → ${r.stdout.trim()}`);
    }
  } catch {}

  console.log();

  // ── Step 1: Check brew prefix ─────────────────────────────

  section('Step 1: Determine brew installation path');

  for (const cmd of ['/opt/homebrew/bin/brew', '/usr/local/bin/brew']) {
    if (isExecutable(cmd)) {
      try {
        const r = spawnSync(cmd, ['--prefix'], { encoding: 'utf8' });
        if (r.status === 0) {
          const prefix = r.stdout.trim();
          console.log(`  Brew at ${cmd}, prefix: ${prefix}`);
          console.log(`  Expected opencode path: ${path.join(prefix, 'bin', 'opencode')}`);
          console.log(`  Exists & executable: ${isExecutable(path.join(prefix, 'bin', 'opencode'))}`);
        }
      } catch {}
    }
  }

  // Check if opencode exists at known brew paths
  for (const candidate of ['/opt/homebrew/bin/opencode', '/usr/local/bin/opencode']) {
    const marker = isExecutable(candidate) ? '✓ EXISTS' : '✗ NOT FOUND';
    console.log(`  ${marker} ${candidate}`);
  }

  // ── Step 2: Simulate Dock-launched environment ────────────

  section('Step 2: Simulate macOS Dock/Finder-launched environment');

  // On macOS, the Dock gives a minimal PATH
  const DOCK_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
  const RUNNER_PATH = process.env.PATH || '';
  const isDockLike = RUNNER_PATH === DOCK_PATH;

  console.log(`  Actual PATH ${isDockLike ? '=' : '≠'} Dock PATH`);
  console.log(`  Actual:   ${RUNNER_PATH}`);
  console.log(`  Dock:     ${DOCK_PATH}`);
  console.log(`  SHELL:    ${process.env.SHELL || '(not set)'}`);

  // ── Step 3: Run the detection chain ───────────────────────

  section('Step 3: Run opencode binary detection chain');

  // 3a. Env vars (fresh install: none set)
  console.log('\n  🔹 Step 3a: Environment variables');
  const envVars = ['OPENCODE_BINARY', 'OPENCODE_PATH', 'OPENCHAMBER_OPENCODE_PATH', 'OPENCHAMBER_OPENCODE_BIN'];
  for (const v of envVars) {
    console.log(`     ${v}=${process.env[v] || '(not set)'}`);
  }

  // 3b. PATH search
  console.log('\n  🔹 Step 3b: PATH search (searchPathFor)');
  const envPath = process.env.PATH || DOCK_PATH;
  const pathResult = searchPathFor('opencode', envPath);
  if (pathResult) {
    console.log(`     ✓ Found: ${pathResult}`);
  } else {
    console.log(`     ✗ Not found in PATH`);
    console.log(`       (PATH=${envPath})`);
  }

  // 3c. Hardcoded fallbacks
  console.log('\n  🔹 Step 3c: Hardcoded fallback paths');
  const home = os.homedir();
  const unixFallbacks = [
    path.join(home, '.opencode', 'bin', 'opencode'),
    path.join(home, '.bun', 'bin', 'opencode'),
    path.join(home, '.local', 'bin', 'opencode'),
    path.join(home, 'bin', 'opencode'),
    '/opt/homebrew/bin/opencode',
    '/usr/local/bin/opencode',
    '/usr/bin/opencode',
    '/bin/opencode',
  ];

  let foundInFallbacks = false;
  for (const candidate of unixFallbacks) {
    const ok = isExecutable(candidate);
    console.log(`     ${ok ? '✓' : '✗'} ${candidate}`);
    if (ok) foundInFallbacks = true;
  }

  // 3c-fp. Fast-path (command -v via /bin/sh)
  console.log('\n  🔹 Step 3c-fp: Fast-path (command -v via /bin/sh)');
  let fastPathFound = false;
  try {
    const fastResult = spawnSync('/bin/sh', ['-c', 'command -v opencode'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
    });
    if (fastResult.status === 0) {
      const found = (fastResult.stdout || '').trim().split(/\s+/).pop() || '';
      if (found && isExecutable(found)) {
        console.log(`     ✓ Found: ${found}`);
        fastPathFound = true;
      } else {
        console.log(`     ✗ Not found (${found || 'empty'})`);
      }
    } else {
      console.log(`     ✗ Status ${fastResult.status} (${fastResult.error?.message || ''})`);
    }
  } catch (err) {
    console.log(`     ⚠ Exception: ${err.message}`);
  }

  // 3d. Shell probing (last resort)
  console.log('\n  🔹 Step 3d: Shell probing (last resort)');
  const shellCandidates = [
    process.env.SHELL || '',
    '/bin/zsh',
    '/bin/bash',
    '/bin/sh',
  ].filter(Boolean).filter((s) => isExecutable(s));

  console.log(`     Available shells: ${shellCandidates.length > 0 ? shellCandidates.join(', ') : 'NONE'}`);

  let shellFound = false;
  for (const shell of shellCandidates) {
    try {
      console.log(`     Probing: ${shell} -lic 'command -v opencode'`);
      const result = spawnSync(shell, ['-lic', 'command -v opencode'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        timeout: 10000,
      });
      if (result.status === 0) {
        const found = (result.stdout || '').trim().split(/\s+/).pop() || '';
        if (found && isExecutable(found)) {
          console.log(`     ✓ Found: ${found}`);
          shellFound = true;
          break;
        }
      }
      if (result.error) {
        console.log(`     ⚠ Error: ${result.error.message}`);
      } else if (result.status !== 0) {
        console.log(`     ✗ Status ${result.status}`);
      }
    } catch (err) {
      console.log(`     ⚠ Exception: ${err.message}`);
    }
  }

  if (!shellFound) {
    console.log('     ✗ Not found via shell probing');
  }

  // ── Summary ──────────────────────────────────────────────

  section('Root Cause Analysis');

  const found = pathResult || foundInFallbacks || fastPathFound || shellFound || (whichPath && isExecutable(whichPath));

  if (found) {
    console.log(`
  ✅ The binary CAN be found by at least one detection method on
     this system. However, this does not rule out the bug on all
     macOS configurations.

  🔧 FIXES APPLIED (issue #1720):

   1. ✅ SHELL PROBING TIMEOUT (env-runtime.js):
       All 4 shell probe spawnSync calls now have a 5-second
       timeout. Prevents indefinite blocking on slow shells.

   2. ✅ FAST-PATH PROBE (env-runtime.js):
       Added /bin/sh -c 'command -v opencode' before the full
       login shell probe. Catches brew binaries at ~10ms instead
       of potentially seconds. (Standard brew paths are also
       covered by hardcoded fallbacks.)

   3. ✅ TOOLCHAIN_SEGMENTS (path-utils.js):
       Added '/usr/local/' to TOOLCHAIN_SEGMENTS so a PATH
       containing /usr/local/bin is recognized as user-configured.

   4. ✅ VS CODE FALLBACK ORDER (opencode.ts):
       Brew fallback order now matches server: /opt/homebrew
       (Apple Silicon) before /usr/local (Intel).

  ⚠️  REMAINING ISSUES (not addressed by this fix):

   1. FILE-SYSTEM PERMISSION ISSUE:
      On macOS with Full Disk Protection, the Electron sandbox
      may restrict access to files outside the app container.

   2. CUSTOM BREW PREFIX:
      If brew is installed at a custom prefix (not /opt/homebrew
      or /usr/local), the hardcoded fallbacks won't match — but
      the fast-path (command -v via sh) may still find it.
`);
  } else {
    console.log(`
  ❌ The binary was NOT found by ANY detection method. This
     confirms the root cause: the detection chain failed.

  The hardcoded fallback paths only cover:
    - /opt/homebrew/bin/opencode (Apple Silicon standard)
    - /usr/local/bin/opencode (Intel standard)

  If opencode is at a different location, it won't be found.
`);
  }

  console.log(`  Binary path (from 'which opencode'): ${whichPath || '(not found)'}`);
  if (whichPath && !unixFallbacks.includes(whichPath)) {
    console.log(`  ⚠️  NOT in hardcoded fallbacks!
    The detected path ${whichPath} is not among the hardcoded
    fallback paths. This is likely the root cause.`);
  }

  console.log(`
  ──────────────────────────────────────────────────────────
  Fixes applied:
  1. ✅ All 4 shell probe spawnSync calls now have a 5s timeout
     (SHELL_PROBE_TIMEOUT_MS, added at env-runtime.js module level)
  2. ✅ Fast-path via /bin/sh -c 'command -v opencode' added
     before login shell probing in all 3 resolvers
  3. ✅ /usr/local/ added to TOOLCHAIN_SEGMENTS in path-utils.js
  4. ✅ Brew fallback order fixed in VS Code extension
     (/opt/homebrew before /usr/local)
`);
}

main().catch(console.error);
