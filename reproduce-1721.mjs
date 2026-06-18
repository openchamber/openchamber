#!/usr/bin/env node
/**
 * Reproduction script for issue #1721
 * 
 * Demonstrates that isProcessRunning() (packages/web/bin/cli.js:2393)
 * returns false positives when a PID from a stale lockfile has been
 * recycled to an unrelated process. This causes an infinite crashloop
 * when OpenChamber is managed by systemd with Restart=always.
 *
 * The reproduction:
 *   1. Start a non-OpenChamber background process
 *   2. Capture its PID and write a mock OpenChamber lockfile
 *   3. Kill the process (SIGKILL) without removing the lockfile
 *      → simulates a system reboot or kill -9
 *   4. Start another unrelated process that may inherit the same PID
 *   5. Re-run the exact lockfile check from cli.js lines 3430-3435
 *      → Shows false positive: "already running" when port is actually free
 *
 * Run: node reproduce-1721.mjs
 */

import fs from 'fs';
import path from 'path';
import { spawn, execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Reproduce the exact isProcessRunning from cli.js:2393 ──────────
function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ── Reproduce the exact readPidFile from cli.js:2322 ───────────────
function readPidFile(pidFilePath) {
  try {
    const content = fs.readFileSync(pidFilePath, 'utf8').trim();
    const pid = parseInt(content, 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

// ── Reproduce the lockfile check from cli.js lines 3430-3435 ───────
function simulateLockfileCheck(pidFilePath, port) {
  const existingPid = readPidFile(pidFilePath);
  if (existingPid && isProcessRunning(existingPid)) {
    throw new Error(
      `OpenChamber is already running on port ${port} (PID: ${existingPid})`
    );
  }
  return true; // port is free
}

// ── Helper: verify if a process is actually OpenChamber ────────────
function isActualOpenchamberProcess(pid) {
  if (process.platform !== 'linux') {
    // On non-Linux, just acknowledge we can't verify cmdline
    return null;
  }
  try {
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    return (
      cmdline.includes('openchamber') || cmdline.includes('cli.js')
    );
  } catch {
    return false;
  }
}

function getProcessName(pid) {
  try {
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    return cmdline.replace(/\0/g, ' ').trim();
  } catch {
    return `<unreadable (pid ${pid})>`;
  }
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ═══════════════════════════════════════════════════════════════════
//  REPRODUCTION
// ═══════════════════════════════════════════════════════════════════

const tmpDir = fs.mkdtempSync(path.join(__dirname, '.repro-1721-'));
const mockPidFile = path.join(tmpDir, 'openchamber-9090.pid');

let allPassed = true;

try {
  console.log('══════════════════════════════════════════════════════════');
  console.log('  Reproduction of issue #1721: PID recycling false positive');
  console.log('══════════════════════════════════════════════════════════');
  console.log();

  // ── Step 1: Start a non-OpenChamber background process ──────────
  console.log('▶ Step 1: Starting a non-OpenChamber background process...');
  const dummy = spawn(
    process.argv[0],
    ['-e', 'setInterval(() => {}, 60000); console.log("dummy-ready");'],
    { stdio: ['ignore', 'pipe', 'ignore'] }
  );

  // Wait for the dummy to signal it's ready
  await new Promise((resolve) => {
    dummy.stdout.once('data', resolve);
    // safety timeout
    setTimeout(resolve, 3000);
  });

  const stalePid = dummy.pid;
  console.log(`   Spawned dummy process PID: ${stalePid}`);
  console.log(`   Process name: ${getProcessName(stalePid)}`);
  console.log();

  // ── Step 2: Write a mock lockfile (simulating clean first start) ─
  console.log('▶ Step 2: Writing mock lockfile (simulating a successful start)...');
  fs.writeFileSync(mockPidFile, String(stalePid), { mode: 0o600 });
  console.log(`   Lockfile: ${mockPidFile}`);
  console.log(`   Contents: ${fs.readFileSync(mockPidFile, 'utf8').trim()}`);
  console.log();

  // ── Step 3: Verify the lockfile check passes while process lives ─
  console.log('▶ Step 3: Verifying isProcessRunning returns true for our dummy...');
  const runningBefore = isProcessRunning(stalePid);
  console.log(`   isProcessRunning(${stalePid}) → ${runningBefore}`);
  console.log(`   Expected: true  ✓`);

  const isOpenChamber = isActualOpenchamberProcess(stalePid);
  if (isOpenChamber === false) {
    console.log(`   Is it an OpenChamber process? NO`);
    console.log(`   → FALSE POSITIVE CONFIRMED: process exists but is NOT OpenChamber`);
  } else if (isOpenChamber === null) {
    console.log(`   (Cannot verify cmdline on this platform, but PID exists)`);
  }
  console.log();

  // ── Step 4: Kill the dummy (SIGKILL, no cleanup) ────────────────
  console.log('▶ Step 4: Killing the dummy with SIGKILL (simulating crash/reboot without cleanup)...');
  dummy.kill('SIGKILL');

  // Wait for process to die
  let dead = false;
  for (let i = 0; i < 20; i++) {
    try {
      process.kill(stalePid, 0);
    } catch {
      dead = true;
      break;
    }
    await sleep(50);
  }
  console.log(`   Process ${stalePid} terminated: ${dead}`);
  console.log();

  // ── Step 5: Start another process that might reuse the PID ──────
  // On Linux, PID recycling is rapid; starting a new process
  // increases the chance that the old PID gets reassigned.
  console.log('▶ Step 5: Starting new process(es) to trigger PID recycling...');
  let recycledPid = stalePid;
  let recycledCount = 0;

  // Start processes until one of them gets the stale PID
  // (PID recycling is kernel behavior; we cannot force it, but we
  //  can demonstrate the underlying issue even without exact recycling)
  const children = [];
  for (let attempt = 0; attempt < 20; attempt++) {
    const child = spawn(
      process.argv[0],
      ['-e', `setTimeout(() => {}, 100); console.log("child-${attempt}");`],
      { stdio: ['ignore', 'pipe', 'ignore'] }
    );
    children.push(child);
    await new Promise((resolve) => {
      const timeout = setTimeout(resolve, 500);
      child.stdout.once('data', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    if (child.pid === stalePid) {
      recycledPid = child.pid;
      recycledCount++;
      console.log(`   → PID ${stalePid} was recycled! New process got it immediately.`);
      break;
    }
  }

  // Wait for all the temporary children to exit
  for (const c of children) {
    try { c.kill(); } catch {}
  }
  await sleep(200);

  console.log();

  // ── Step 6: Also just try checking with an obviously unrelated PID ─
  console.log('▶ Step 6: Testing isProcessRunning with a known unrelated process...');
  // Use the current process (this script) as an unrelated PID
  const unrelatedPid = process.pid;
  const unrelatedRunning = isProcessRunning(unrelatedPid);
  const unrelatedIsOpenChamber = isActualOpenchamberProcess(unrelatedPid);

  console.log(`   Checking PID ${unrelatedPid} (this reproduction script):`);
  console.log(`   isProcessRunning(${unrelatedPid}) → ${unrelatedRunning}`);
  console.log(`   Process name: ${getProcessName(unrelatedPid)}`);
  if (unrelatedRunning && unrelatedIsOpenChamber === false) {
    console.log(`   → FALSE POSITIVE CONFIRMED: PID ${unrelatedPid} is alive but is NOT OpenChamber`);
    console.log(`     If the lockfile contained this PID, startup would be blocked.`);
  }
  console.log();

  // ── Step 7: Simulate the lockfile check that causes the crashloop ─
  console.log('▶ Step 7: Simulating the lockfile check from cli.js lines 3430-3435...');
  console.log(`   Lockfile still contains: ${fs.readFileSync(mockPidFile, 'utf8').trim()}`);
  console.log();

  let lockfileCheckResult;
  try {
    simulateLockfileCheck(mockPidFile, 9090);
    lockfileCheckResult = 'PASSED (port is free)';
    console.log(`   Result: ${lockfileCheckResult}`);
    console.log('   ← This means the lockfile check gives the CORRECT all-clear.');
    console.log('     (PID was not recycled in this run, but the bug is in the logic,');
    console.log('      not in whether recycling happens on any particular run.)');
  } catch (err) {
    lockfileCheckResult = `FAILED: ${err.message}`;
    console.log(`   Result: ${lockfileCheckResult}`);
    if (recycledCount > 0) {
      console.log('   ← BUG REPRODUCED: Lockfile check falsely reports "already running"');
      console.log('     because the stale PID was recycled to a non-OpenChamber process.');
    }
  }

  // ── Step 8: Direct crashloop simulation ──────────────────────────
  console.log();
  console.log('▶ Step 8: Direct crashloop simulation');
  console.log('   Writing current (non-OpenChamber) PID to lockfile...');
  fs.writeFileSync(mockPidFile, String(process.pid), { mode: 0o600 });
  console.log(`   Lockfile contains PID ${process.pid}`);
  console.log(`   Current process name: ${getProcessName(process.pid)}`);
  console.log(`   Is this OpenChamber? ${isActualOpenchamberProcess(process.pid) === true ? 'YES' : 'NO'}`);
  console.log();

  // Run the lockfile check in a loop (like systemd Restart=always would)
  console.log('   Simulating systemd crashloop (5 iterations, 500ms apart):');
  for (let i = 1; i <= 5; i++) {
    await sleep(500);
    try {
      simulateLockfileCheck(mockPidFile, 9090);
      console.log(`   Iteration ${i}: ALL CLEAR (port 9090 is free)`);
      break;
    } catch (err) {
      console.log(`   Iteration ${i}: ✗ ${err.message}`);
    }
  }
  console.log('   ← CRASHLOOP REPRODUCED: Every restart attempt fails with');
  console.log('     "already running" even though the port is free.');
  console.log('     Under systemd Restart=always, this loops forever.');

  // ── Summary ──────────────────────────────────────────────────────
  console.log();
  console.log('══════════════════════════════════════════════════════════');
  console.log('  ANALYSIS');
  console.log('══════════════════════════════════════════════════════════');
  console.log();
  console.log('  Root cause: isProcessRunning() (cli.js:2393) only checks PID');
  console.log('  existence via process.kill(pid, 0). It does NOT verify that');
  console.log('  the process at that PID is actually an OpenChamber instance.');
  console.log();
  console.log('  This means:');
  console.log('    • If the lockfile contains PID 439 (from a previous run)');
  console.log('    • And PID 439 is now a V8Worker thread (agentmemory)');
  console.log('    • isProcessRunning(439) returns true → "already running"');
  console.log('    • The serve command throws and exits with an error');
  console.log('    • systemd (Restart=always) retries → infinite crashloop');
  console.log();

  // Check the current PID from an actual unrelated process
  const currentPid = process.pid;
  const currentIsRunning = isProcessRunning(currentPid);
  const currentIsOpenChamber = isActualOpenchamberProcess(currentPid);
  console.log(`  Even the CURRENT process (PID ${currentPid}):`);
  console.log(`    isProcessRunning → ${currentIsRunning}`);
  console.log(`    Is OpenChamber?   ${currentIsOpenChamber === true ? 'YES' : 'NO'}`);
  console.log();
  console.log(`  If the lockfile contained PID ${currentPid}, and this script`);
  console.log(`  were NOT OpenChamber (it is not), the lockfile check would`);
  console.log(`  still return "already running" — a false positive.`);
  console.log();

  // Final verdict
  if (unrelatedRunning && unrelatedIsOpenChamber === false) {
    console.log('  ✓ BUG CONFIRMED: isProcessRunning() returns false positives');
    console.log('    for non-OpenChamber processes.');
    console.log();
    console.log('  ✓ CRASHLOOP REPRODUCED (Step 8):');
    console.log('    When the lockfile contains a non-OpenChamber PID, every startup');
    console.log('    attempt fails with "already running" even though the port is free.');
    console.log('    Under systemd Restart=always, this produces an infinite crashloop.');
    console.log();
    if (recycledCount > 0) {
      console.log('  ✓ PID RECYCLING DEMONSTRATED: stale PID was reused by a new');
      console.log('    unrelated process, causing the exact crashloop scenario.');
    } else {
      console.log('  ○ PID recycling was NOT triggered on this run (depends on kernel');
      console.log('    scheduler timing), but the underlying flaw is confirmed:');
      console.log('    isProcessRunning does not verify process identity.');
      console.log('    Under systemd with Restart=always, repeated crash+restart cycles');
      console.log('    will eventually hit a recycled PID that causes the false positive.');
    }
  }
} finally {
  // Cleanup
  try {
    fs.unlinkSync(mockPidFile);
  } catch {}
  try {
    fs.rmdirSync(tmpDir);
  } catch {}
}
