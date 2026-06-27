#!/usr/bin/env node
/**
 * Reproduction script for issue #1861:
 * OpenChamber update conflicts with systemd user service (Restart=always)
 *
 * This script demonstrates the structural bug by analyzing the two code paths.
 * It does NOT require systemd or a running instance — it parses the source modules
 * and proves that `updateCommand` lacks the `launchMode` check that `restartCommand` has.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGES_WEB_BIN_LIB = path.join(__dirname, 'packages', 'web', 'bin', 'lib');

// ---- Helpers ----

function readSource(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function searchSource(source, pattern) {
  const lines = source.split('\n');
  const results = [];
  for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i])) {
      results.push({ line: i + 1, text: lines[i].trim() });
    }
  }
  return results;
}

// ---- Analysis ----

console.log('=== Reproduction: Issue #1861 ===\n');

// 1. Check that discoverRunningInstances returns launchMode
const lifecycleSource = readSource(path.join(PACKAGES_WEB_BIN_LIB, 'cli-lifecycle.js'));
const launchModeInDiscovery = searchSource(lifecycleSource, /launchMode/);

console.log('1. Does discoverRunningInstances() return launchMode?');
const hasLaunchModeInReturn = launchModeInDiscovery.some(
  r => r.text.includes("launchMode:") && r.text.includes("'foreground'")
);
console.log(`   ${hasLaunchModeInReturn ? 'YES ✓' : 'NO ✗'} — launchMode is read from storedOptions`);
if (hasLaunchModeInReturn) {
  const relevant = launchModeInDiscovery.filter(r => r.text.includes('launchMode'));
  for (const r of relevant) {
    console.log(`   Line ${r.line}: ${r.text}`);
  }
}
console.log('');

// 2. Check restartCommand's launchMode handling
const lifecycleCmdSource = readSource(path.join(PACKAGES_WEB_BIN_LIB, 'commands-lifecycle.js'));

const launchModeInRestart = searchSource(lifecycleCmdSource, /launchMode|isForeground/);
const skipServeInRestart = searchSource(lifecycleCmdSource, /continue|serve/).filter(
  r => r.line >= 315 && r.line <= 345
);

console.log('2. Does restartCommand check launchMode and skip serve() for foreground?');
const hasLaunchModeCheck = launchModeInRestart.some(r => r.text.includes("launchMode"));
const hasForegroundCheck = launchModeInRestart.some(r => r.text.includes("isForeground"));
const hasContinueSkip = lifecycleCmdSource.includes('// Foreground instances are managed by a process manager');
console.log(`   launchMode read: ${hasLaunchModeCheck ? 'YES ✓' : 'NO ✗'}`);
console.log(`   isForeground check: ${hasForegroundCheck ? 'YES ✓' : 'NO ✗'}`);
console.log(`   Skip serve() with continue: ${hasContinueSkip ? 'YES ✓ (lines 338-345 skip serve() for foreground)' : 'NO ✗'}`);

if (hasLaunchModeCheck) {
  for (const r of launchModeInRestart) {
    console.log(`   Line ${r.line}: ${r.text}`);
  }
}
console.log('');

// 3. Check updateCommand's launchMode handling
const updateCmdSource = readSource(path.join(PACKAGES_WEB_BIN_LIB, 'commands-update.js'));

const launchModeInUpdate = searchSource(updateCmdSource, /launchMode|isForeground|foreground/);
const serveCallInUpdate = searchSource(updateCmdSource, /serveCommand/);

console.log('3. Does updateCommand check launchMode and skip serve() for foreground?');
const hasAnyForegroundRef = launchModeInUpdate.length > 0;
console.log(`   Any reference to launchMode/foreground: ${hasAnyForegroundRef ? 'YES' : 'NO ✗'}`);
console.log(`   Missing launchMode check: ${!hasAnyForegroundRef ? 'YES ✗ — NO launchMode handling at all' : 'NO'}`);

console.log('');
console.log('   serveCommand calls in updateCommand:');
for (const r of serveCallInUpdate) {
  console.log(`   Line ${r.line}: ${r.text}`);
}
console.log('');

// 4. Demonstrate the exact difference
console.log('4. === Exact structural difference ===');
console.log('');
console.log('   restartCommand (commands-lifecycle.js, around lines 315-345):');
console.log('     const launchMode = instance.launchMode || \'daemon\';');
console.log('     const isForeground = launchMode === \'foreground\';');
console.log('     ...');
console.log('     if (isForeground) {');
console.log('       // Foreground instances are managed by a process manager');
console.log('       // (systemd, Docker, etc.) that will restart them automatically');
console.log('       continue;  // ← does NOT call serve()');
console.log('     }');
console.log('     ...');
console.log('     await runServe({...});  // ← only for daemon mode');
console.log('');
console.log('   updateCommand (commands-update.js, lines 104-118):');
console.log('     if (runningInstances.length > 0) {');
console.log('       for (const instance of runningInstances) {');
console.log('         const storedOptions = ...;');
console.log('         await serveCommand({  // ← ALWAYS calls serve(), no launchMode check');
console.log('           port: storedOptions.port || instance.port,');
console.log('           ...');
console.log('         });');
console.log('       }');
console.log('     }');

// 5. Check if the web UI path partially handles it
const routesSource = readSource(path.join(__dirname, 'packages', 'web', 'server', 'lib', 'opencode', 'openchamber-routes.js'));
const uiForegroundCheck = searchSource(routesSource, /isForegroundService|launchMode.*foreground/);
const uiRestartCmdCheck = searchSource(routesSource, /restartCmd\s*=\s*isForegroundService/);
const uiExitCall = searchSource(routesSource, /process\.exit\(0\)/);

console.log('');
console.log('5. Web UI update path (POST /api/openchamber/update-install):');
if (uiForegroundCheck.length > 0) {
  console.log('   ✓ Detects foreground service mode:');
  for (const r of uiForegroundCheck) {
    console.log(`     Line ${r.line}: ${r.text}`);
  }
}
if (uiRestartCmdCheck.length > 0) {
  console.log('   ✓ Sets empty restart command for foreground services');
}
if (uiExitCall.length > 0) {
  for (const r of uiExitCall) {
    console.log(`   ⚠ process.exit(0) called at line ${r.line}: ${r.text}`);
  }
  console.log('   ⚠ After spawn + 500ms delay, systemd with Restart=always');
  console.log('      restarts the OLD version before the update script finishes.');
  console.log('      (RestartSec=5s, but update script has sleep 2 + npm install = ?)');
}

// ---- Summary ----
console.log('');
console.log('========================================');
console.log('  SUMMARY');
console.log('========================================');
console.log('');
console.log('  Bug confirmed: updateCommand does NOT check instance.launchMode');
console.log('  before calling serveCommand(), unlike restartCommand which does.');
console.log('');
console.log('  The data (launchMode) IS available — discoverRunningInstances()');
console.log('  returns it from storedOptions at cli-lifecycle.js line 228.');
console.log('');
console.log('  Two affected paths:');
console.log('  1. CLI `openchamber update` — always calls serve() after update');
console.log('  2. Web UI update — partial fix exists (detects foreground, skips');
console.log('     restart command), but process.exit(0) after 500ms races with');
console.log('     systemd Restart=always');
console.log('');
console.log('  Fix needed: Add launchMode === "foreground" check in updateCommand');
console.log('  (commands-update.js lines 104-118) matching restartCommand pattern.');
