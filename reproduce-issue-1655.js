/**
 * Reproduction script for Issue #1655: Can't update (linux server / windows pwa app)
 *
 * This script simulates the key parts of the OpenChamber web update flow to
 * demonstrate how the update "progress" can show indefinitely without completing.
 *
 * Run: node reproduce.js
 */

// ---------------------------------------------------------------------------
// Issue context
// ---------------------------------------------------------------------------
// The user reports:
//   1. The blue "Update" button shows on every PWA login
//   2. Clicking it shows "Installing update..." / "Waiting for server..." but
//      the page never reloads — left overnight, still spinning
//   3. The server binary (`openchamber -v`) is at 1.12.4
//   4. The PWA About page shows version 1.12.1
//   5. `openchamber update` (CLI) says "Already up to date"
//
// The server-side version check in `checkForUpdates()` reads from the
// server's own package.json (1.12.4). If npm has no version > 1.12.4,
// it returns `{ available: false }`. But the PWA client *persists the
// store in memory* across PWA "foreground" cycles — if a prior check
// returned `available: true` (e.g. before the server was updated, or
// when the API returned a different result), the stale `true` value
// keeps the update button visible.
//
// More critically: the web update installer flow has NO reliable
// completion path when the update command fails or the spawned child
// process cannot restart the server on the same port.
// ---------------------------------------------------------------------------

// Simulate the client-side update dialog flow

const WEB_UPDATE_POLL_INTERVAL_MS = 100;   // scaled down for demo
const WEB_UPDATE_MAX_WAIT_MS = 2000;       // scaled down for demo
const WEB_UPDATE_MAX_ATTEMPTS = Math.ceil(WEB_UPDATE_MAX_WAIT_MS / WEB_UPDATE_POLL_INTERVAL_MS);

/**
 * Simulates the actual `waitForUpdateApplied` function from
 * packages/ui/src/components/ui/UpdateDialog.tsx (lines 156-189).
 */
async function waitForUpdateApplied(previousVersion, serverResponses) {
  const maxAttempts = WEB_UPDATE_MAX_ATTEMPTS;
  const intervalMs = WEB_UPDATE_POLL_INTERVAL_MS;
  let callIndex = 0;

  for (let i = 0; i < maxAttempts; i++) {
    try {
      // Simulate the server response
      const response = serverResponses[callIndex] || serverResponses[serverResponses.length - 1];
      callIndex++;

      if (response && response.ok) {
        const data = response.json ? await response.json() : response.data;
        // Condition A: server says no update needed
        if (data && data.available === false) {
          console.log(`  ✓ Poll #${i + 1}: server reports available=false — DONE`);
          return true;
        }
        // Condition B: version changed
        if (
          data &&
          typeof data.currentVersion === 'string' &&
          typeof previousVersion === 'string' &&
          data.currentVersion !== previousVersion
        ) {
          console.log(`  ✓ Poll #${i + 1}: version changed from ${previousVersion} to ${data.currentVersion} — DONE`);
          return true;
        }
        console.log(`  ○ Poll #${i + 1}: server still reports available=true, version=${data?.currentVersion || '?'} — retrying`);
      } else if (response && (response.status === 401 || response.status === 403)) {
        const reachable = await isServerReachable();
        if (reachable) {
          console.log(`  ✓ Poll #${i + 1}: server returned ${response.status} but /health is reachable — DONE`);
          return true;
        }
        console.log(`  ○ Poll #${i + 1}: server returned ${response.status}, /health not reachable — retrying`);
      } else {
        console.log(`  ○ Poll #${i + 1}: response not ok (status=${response?.status || 'no response'}) — retrying`);
      }
    } catch (err) {
      console.log(`  ○ Poll #${i + 1}: fetch error (server restarting) — retrying`);
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  console.log(`  ✗ TIMEOUT after ${maxAttempts} attempts (${WEB_UPDATE_MAX_WAIT_MS}ms)`);
  return false;
}

async function isServerReachable() {
  // Simulate server reachability check
  return false;
}

// ===================================================================
// SCENARIO 1: Server restarts with SAME version after update
// ===================================================================
// This happens when `npm add -g @openchamber/web@latest` installs to a
// *different* global location than where the running server lives.
// The restart command reuses the old binary → same version → poll
// never sees `available: false` or a version change → times out.
console.log('\n' + '='.repeat(70));
console.log('SCENARIO 1: Server restarts with SAME version after update');
console.log('='.repeat(70));
console.log('  Why: npm installs to global node_modules, but restart uses old binary path.\n');

(async () => {
  // Simulate: the update was "installed" (npm did its thing globally)
  // but the running cli.js was not updated (it's at a different path).
  // Server comes back reporting the same version and available=true.
  const responses = [
    // Client starts polling 2s after POST response
    // First few polls get errors (old server shutting down)
    { ok: false, status: 0 },      // connection refused
    { ok: false, status: 0 },      // connection refused
    { ok: false, status: 0 },      // connection refused
    // Server comes back with SAME version
    { ok: true, data: { available: true, currentVersion: '1.12.1', version: '1.12.4' } },
    { ok: true, data: { available: true, currentVersion: '1.12.1', version: '1.12.4' } },
    { ok: true, data: { available: true, currentVersion: '1.12.1', version: '1.12.4' } },
    // ... repeats until timeout
  ];

  // Pad with more "same version" responses up to max attempts
  while (responses.length < WEB_UPDATE_MAX_ATTEMPTS) {
    responses.push({ ok: true, data: { available: true, currentVersion: '1.12.1', version: '1.12.4' } });
  }

  console.time('  Duration');
  const result = await waitForUpdateApplied('1.12.1', responses);
  console.timeEnd('  Duration');
  console.log(`  Result: ${result ? 'UPDATE DETECTED' : 'TIMEOUT / ERROR'}`);
  console.log('  → This demonstrates how the update dialog shows progress\n' +
              '    indefinitely when the server restarts with the same version.\n' +
              '    The client polls for 10 minutes before showing an error.');
})();

// ===================================================================
// SCENARIO 2: previousVersion is undefined → condition B never fires
// ===================================================================
console.log('\n' + '='.repeat(70));
console.log('SCENARIO 2: previousVersion is undefined (info?.currentVersion was null)');
console.log('='.repeat(70));
console.log('  Why: info is null when checkForUpdates was never called successfully.\n');

setTimeout(async () => {
  // When previousVersion is undefined, condition B doesn't fire,
  // even if version changes between polls.
  const responses = [
    { ok: true, data: { available: true, currentVersion: '1.12.1' } },
    { ok: true, data: { available: true, currentVersion: '1.12.4' } }, // version changed!
    { ok: true, data: { available: true, currentVersion: '1.12.4' } },
  ];

  while (responses.length < WEB_UPDATE_MAX_ATTEMPTS) {
    responses.push({ ok: true, data: { available: true, currentVersion: '1.12.4' } });
  }

  console.time('  Duration');
  const result = await waitForUpdateApplied(undefined, responses);
  console.timeEnd('  Duration');
  console.log(`  Result: ${result ? 'UPDATE DETECTED' : 'TIMEOUT / ERROR'}`);
  console.log('  → The version change (1.12.1 → 1.12.4) is NOT detected because\n' +
              '    previousVersion is undefined. Condition B at line 172-179\n' +
              '    requires typeof previousVersion === \'string\'. Only\n' +
              '    available===false would end the loop.');
}, 3000);

// ===================================================================
// SCENARIO 3: Server exits but update command fails
// ===================================================================
console.log('\n' + '='.repeat(70));
console.log('SCENARIO 3: Server exits but the spawned update command FAILS');
console.log('='.repeat(70));
console.log('  Why: The update process (npm add -g) may fail due to permissions,\n' +
            '  network, or the package manager binary not being found. The old\n' +
            '  server already called process.exit(0), so no new server starts.\n');

setTimeout(async () => {
  // The old server responded with { success: true }, then called process.exit(0)
  // The spawned child process failed (no `openchamber` binary in PATH after install)
  // Client polls against a dead server
  const responses = [
    { ok: false, status: 0 },  // connection refused
    { ok: false, status: 0 },  // connection refused
    { ok: false, status: 0 },  // connection refused
    // ... all polls fail until timeout
  ];

  while (responses.length < WEB_UPDATE_MAX_ATTEMPTS) {
    responses.push({ ok: false, status: 0 });
  }

  console.time('  Duration');
  const result = await waitForUpdateApplied('1.12.1', responses);
  console.timeEnd('  Duration');
  console.log(`  Result: ${result ? 'UPDATE DETECTED' : 'TIMEOUT / ERROR'}`);
  console.log('  → The client polls against a dead server for 10 minutes\n' +
              '    (or the scaled-down timeout here) and eventually shows an error.\n' +
              '    No recovery mechanism exists — the user must manually re-run the server.');
}, 6000);

// ===================================================================
// Summary
// ===================================================================
setTimeout(() => {
  console.log('\n' + '='.repeat(70));
  console.log('SUMMARY');
  console.log('='.repeat(70));
  console.log(`
The web update flow in UpdateDialog.tsx + openchamber-routes.js has a
fundamental design issue:

1) The server calls process.exit(0) ~500ms after responding to the POST,
   before the update process has finished.

2) The client's waitForUpdateApplied() polls /api/openchamber/update-check
   but has no reliable way to distinguish "server restarting" from
   "server is gone forever".

3) If the update/restart fails (npm error, port conflict, wrong install
   path), the client hangs for 10 minutes showing a spinner, then shows
   an error with no recovery path.

4) The "blue update button" can appear when:
   - The API/npm check falsely reports an available update
   - A previous check (from before the server was updated) left
     available=true in the in-memory Zustand store
   - The PWA service worker cached old assets showing a stale version

Potential fixes:
- The server should NOT exit immediately. Instead, it should wait for
  the update to complete, verify the new server starts, and then exit.
- The client should have a shorter timeout with clearer error messaging
  and a "retry" / "run CLI command" fallback.
- The version display should use the server-reported version
  (already done in AboutSettings) consistently.
`);
}, 9000);
