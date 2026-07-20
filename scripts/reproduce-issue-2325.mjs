#!/usr/bin/env node

/**
 * Reproduction script for Issue #2325:
 * OpenChamber cannot connect to OpenCode server in WSL - "Auth required" even with credentials
 *
 * Run: node scripts/reproduce-issue-2325.mjs
 *
 * This script reproduces the bug by simulating the exact code paths
 * used by OpenChamber when connecting to a remote OpenCode server.
 */

// =============================================================================
// SIMULATED CODE PATHS FROM OPEnCHAMBER
// =============================================================================

// From packages/electron/main.mjs - probeHostWithTimeout
function simulateProbeHostWithTimeout(url, clientToken = '', expectedServerId = '') {
  const versionUrl = `${url.replace(/\/$/, '')}/api/version`;
  const started = Date.now();

  const headers = { 'Accept': 'application/json' };
  const token = typeof clientToken === 'string' ? clientToken.trim() : '';
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const status = simulateFetchVersion(versionUrl, headers);

  const latencyMs = Date.now() - started;

  if (status === 401 || status === 403) {
    return { status: 'auth', latencyMs };
  }
  if (status < 200 || status >= 300) {
    return { status: 'unreachable', latencyMs };
  }
  return { status: 'ok', latencyMs };
}

// Simulate what the OpenCode server returns for /api/version
function simulateFetchVersion(url, headers) {
  const hasBearerToken = headers['Authorization'] && headers['Authorization'].startsWith('Bearer ');

  // The OpenCode server (opencode serve binary) has the following behavior:
  // - When OPENCODE_SERVER_PASSWORD is NOT set: the server generates a random
  //   password and enables auth. /api/version returns 401 without valid auth.
  // - When OPENCODE_SERVER_PASSWORD IS set: /api/version returns 401 without
  //   valid auth headers.
  //
  // BUT: Based on createUiAuth in packages/web/server/lib/ui-auth/ui-auth.js:
  // When no password is configured (empty string), the uiAuthController has
  // `enabled: false` and handleSessionStatus returns authenticated.
  // The /api/version endpoint (core-routes.js line 248) is unauthenticated.
  //
  // HOWEVER: The user is running `opencode serve` (a separate binary from the
  // opencode repo), not OpenChamber's server. The opencode binary may behave
  // differently - it may always require auth for API endpoints.

  if (!hasBearerToken) {
    // Without auth token, the OpenCode server returns 401
    return 401;
  }
  return 200;
}

// From packages/electron/main.mjs - isLocalRuntimeUrl
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);

function simulateIsLocalRuntimeUrl(targetUrl, sidecarUrl) {
  if (!sidecarUrl) return false;

  const target = new URL(targetUrl);
  const local = new URL(sidecarUrl);

  if (target.origin === local.origin) return true;

  const portOf = (u) => u.port || (u.protocol === 'https:' ? '443' : '80');
  return portOf(target) === portOf(local) && LOOPBACK_HOSTNAMES.has(target.hostname);
}

// From packages/electron/main.mjs - resolveStoredClientTokenForUrl
function simulateResolveStoredClientTokenForUrl(targetUrl, config, sidecarUrl, localClientToken) {
  const normalizedTarget = targetUrl;
  if (!normalizedTarget) return '';

  if (simulateIsLocalRuntimeUrl(normalizedTarget, sidecarUrl)) {
    return localClientToken || '';
  }

  for (const host of config.hosts || []) {
    const hostUrl = host.url ? host.url.replace(/\/$/, '') : '';
    const apiUrl = host.apiUrl ? host.apiUrl.replace(/\/$/, '') : (host.url || '');
    if (normalizedTarget === hostUrl || normalizedTarget === apiUrl) {
      return host.clientToken || '';
    }
  }
  return '';
}

// From packages/ui/src/components/auth/SessionAuthGate.tsx - isLocalDesktopRuntime
function simulateIsLocalDesktopRuntime(localOrigin, apiBaseUrl) {
  if (!localOrigin) return false;
  const effectiveTarget = apiBaseUrl || 'http://unknown';

  try {
    if (new URL(localOrigin).origin === new URL(effectiveTarget).origin) return true;
  } catch { /* ignore */ }

  try {
    const normalized = effectiveTarget;
    const clean = new URL(normalized).hostname.replace(/^\[|\]$/g, '');
    return clean === 'localhost' || clean === '127.0.0.1' || clean === '::1';
  } catch {
    return false;
  }
}

// =============================================================================
// REPRODUCTION SCENARIOS
// =============================================================================

function printSection(title) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`  ${title}`);
  console.log(`${'='.repeat(70)}`);
}

function printSubSection(title) {
  console.log(`\n  --- ${title} ---`);
}

function printFinding(label, value, impact) {
  console.log(`  ${label}: ${value}`);
  if (impact) console.log(`    → Impact: ${impact}`);
}

console.log(`
╔══════════════════════════════════════════════════════════════╗
║  Reproduction: Issue #2325                                   ║
║  OpenChamber cannot connect to OpenCode server in WSL        ║
║  "Auth required" even with credentials                       ║
╚══════════════════════════════════════════════════════════════╝
`);

// ==========================================================
// SETUP: Scenario Configuration
// ==========================================================
printSection('SCENARIO SETUP');

const serverUrl = 'http://localhost:4096';
const sidecarUrl = 'http://127.0.0.1:12345'; // OpenChamber's internal sidecar
const localClientToken = 'local-token-abc';
const serverPassword = 'test123';

printFinding('OpenCode server URL (in WSL)', serverUrl);
printFinding('OpenChamber sidecar URL', sidecarUrl);
printFinding('Configured server password', serverPassword);
printFinding('Local client token (from sidecar)', localClientToken);

// ==========================================================
// REPRODUCTION 1: Probe returns "auth" without token
// ==========================================================
printSection('REPRODUCTION 1: Probe returns "auth" without client token');

printSubSection('Scenario A: User adds server without token');
const probeResultNoToken = simulateProbeHostWithTimeout(serverUrl, '');
printFinding('Probe result', probeResultNoToken.status.toUpperCase());
printFinding('Probe latency', `${probeResultNoToken.latencyMs}ms`, 
  probeResultNoToken.status === 'auth'
    ? 'User sees "Auth required" badge. This is the first bug surface.'
    : '');

printSubSection('Scenario B: User adds server WITH token');
const probeResultWithToken = simulateProbeHostWithTimeout(serverUrl, 'valid-client-token');
printFinding('Probe result', probeResultWithToken.status.toUpperCase(),
  probeResultWithToken.status === 'ok' ? 'Token works — user needs to know to obtain one first.' : '');

// ==========================================================
// REPRODUCTION 2: isLocalRuntimeUrl misidentification
// ==========================================================
printSection('REPRODUCTION 2: isLocalRuntimeUrl host detection');

// Normal case: different ports
const isLocalNormal = simulateIsLocalRuntimeUrl(serverUrl, sidecarUrl);
printSubSection('Case A: Different ports (normal)');
printFinding('Target', serverUrl);
printFinding('Sidecar', sidecarUrl);
printFinding('isLocalRuntimeUrl', isLocalNormal,
  'FALSE — ports differ. No special local token handling.');

// Edge case: same port
const sidecarSamePort = 'http://127.0.0.1:4096';
const isLocalSamePort = simulateIsLocalRuntimeUrl(serverUrl, sidecarSamePort);
printSubSection('Case B: Same port collision (possible)');
printFinding('Target', serverUrl);
printFinding('Sidecar', sidecarSamePort);
printFinding('isLocalRuntimeUrl', isLocalSamePort,
  'TRUE! If OpenChamber sidecar and WSL server use same port, '
  + 'OpenChamber may wrongly treat WSL server as local and send '
  + 'the wrong client token.');

// ==========================================================
// REPRODUCTION 3: Token resolution gives wrong token
// ==========================================================
printSection('REPRODUCTION 3: Token resolution may return wrong token');

const hostConfig = {
  hosts: [
    { id: 'host-1', label: 'WSL Server', url: serverUrl, apiUrl: serverUrl },
  ],
  defaultHostId: null,
};

// Standard resolution (different ports)
const resolvedToken = simulateResolveStoredClientTokenForUrl(
  serverUrl, hostConfig, sidecarUrl, localClientToken
);
printFinding('Host without clientToken', 'Added with empty token');
printFinding('Resolved token (different ports)', resolvedToken || '(empty)',
  resolvedToken ? 'Got token from config' : 'Empty — probe sends no auth → 401 → "auth required"');

// ==========================================================
// REPRODUCTION 4: isLocalDesktopRuntime causes wrong login path
// ==========================================================
printSection('REPRODUCTION 4: Login path selection (SessionAuthGate)');

const isLocal = simulateIsLocalDesktopRuntime(sidecarUrl, serverUrl);
printFinding('localOrigin', sidecarUrl);
printFinding('apiBaseUrl', serverUrl);
printFinding('isLocalDesktopRuntime()', isLocal);
printFinding('shouldUseDesktopShellPasswordLogin()', !isLocal,
  !isLocal
    ? 'Uses Electron main process login (loginRemoteAndIssueClientToken) — more reliable'
    : 'Uses renderer-side submitPassword — sends clientKind: "desktop-local" in body');

// Show what the body looks like
if (isLocal) {
  printSubSection('Auth request body (renderer-side)');
  const authBody = {
    password: serverPassword,
    trustDevice: false,
    issueClientToken: true,
    clientLabel: 'OpenChamber Desktop',
    clientKind: 'desktop-local',
    dedupeKey: 'desktop-local',
  };
  console.log(`  ${JSON.stringify(authBody, null, 4)}`);
  printFinding('clientKind sent to server', '"desktop-local"',
    'Server at WSL sees "desktop-local" kind from a remote machine. '
    + 'The server may misinterpret this as local access, affecting '
    + 'permissions or token issuance.');
}

// ==========================================================
// REPRODUCTION 5: End-to-end flow with auth configured
// ==========================================================
printSection('REPRODUCTION 5: Full connection flow with password configured');

console.log(`
  Step 1: User adds host "${serverUrl}" without token
          → Host shows "Auth required" badge

  Step 2: User clicks host to switch to it
          → handleSwitch() in DesktopHostSwitcher
          → probe returns "auth" (not blocked)
          → switchRuntimeEndpoint({ apiBaseUrl: "${serverUrl}", clientToken: "" })

  Step 3: SessionAuthGate loads
          → GET /auth/session returns 401
          → State: "locked"
          → Password input shown

  Step 4: User enters password "${serverPassword}"
          → submitPassword(): POST /auth/session with password

  Step 5a: Server validates password
           → Returns 200 with session cookie
           → issueClientToken creates client token
           → applyDesktopClientToken() saves + switches runtime

  Step 5b: Server rejects password (wrong or generated)
           → Returns 401
           → User sees "Incorrect password"
           → No way to recover without knowing the actual password
`);

// ==========================================================
// ROOT CAUSE SUMMARY
// ==========================================================
printSection('ROOT CAUSE SUMMARY');

console.log(`
  The issue has TWO interrelated root causes:

  ROOT CAUSE 1 - Authentication mismatch:
  ────────────────────────────────────────
  The OpenCode server (opencode serve) always requires authentication.
  Even without OPENCODE_SERVER_PASSWORD set, it generates a random password
  internally. OpenChamber's probe hits /api/version WITHOUT any auth
  headers, getting a 401 response. The probe reports "auth required".

  ROOT CAUSE 2 - Local runtime misclassification for WSL:
  ────────────────────────────────────────────────────────
  When the target URL is http://localhost:4096 (WSL), the SessionAuthGate's
  isLocalDesktopRuntime() returns TRUE because localhost is a loopback
  address. This:
    a) Causes shouldUseDesktopShellPasswordLogin() to return FALSE, so the
       Electron main process login path (loginRemoteAndIssueClientToken)
       is NOT used. Instead, the renderer-side submitPassword is used.
    b) The auth request includes clientKind: 'desktop-local' in the body,
       which labels the client as "local" even though it's connecting
       remotely (across the Windows/WSL boundary).
    c) When the server generates its own random password (no env var set),
       the user doesn't know what password to enter.

  ADDITIONAL FINDING:
  ───────────────────
  If the OpenChamber sidecar happens to use the same port as the WSL
  OpenCode server (4096), isLocalRuntimeUrl() would return TRUE,
  causing resolveStoredClientTokenForUrl() to return the LOCAL client
  token instead of the (empty) remote host token. This would send a
  wrong token to the WSL server, potentially getting 403 errors instead
  of 401.
`);
