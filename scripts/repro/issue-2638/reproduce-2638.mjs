// Reproduction for https://github.com/openchamber/openchamber/issues/2638
// "[Bug] Chat UI stops updating until the desktop app is restarted"
//
// Run with:  node reproduce-2638.mjs          (Windows-orphan scenario)
//            node reproduce-2638.mjs --baseline (control: healthy restart)
//
// What it wires up (real repo modules, real processes, real ports):
//   - createOpenCodeLifecycleRuntime (packages/web/server/lib/opencode/lifecycle.js)
//   - createGlobalMessageStreamHub   (packages/web/server/lib/event-stream/global-hub.js)
//   - createOpenCodeNetworkRuntime   (packages/web/server/lib/opencode/network-runtime.js)
//   - a fake `opencode serve` binary (fake-opencode-serve.mjs)
//
// Scenario (issue #2638):
//   1. OpenCode starts; the global message-stream hub connects to its
//      /global/event SSE stream. Chat UI updates flow (baseline event e1
//      reaches the hub).
//   2. The managed OpenCode process "exits" but the actual server process
//      survives on the old port (on Windows killProcessOnPort is a no-op and
//      taskkill cannot reach the orphaned tree — the report shows leftover
//      `opencode.exe serve` processes on historical ports).
//   3. restartOpenCode() gives up after 5 s
//      ("Timed out waiting for OpenCode port <old> to be released") and
//      spawns a fresh server on a NEW port.
//   4. HTTP/proxy traffic follows state.openCodePort to the NEW server, but
//      the hub's upstream SSE reader is still pinned to the OLD server's
//      /global/event stream (that connection never closed), so events from
//      the new server never reach the UI. Chat UI goes stale while the new
//      server keeps persisting session data — visible only after restarting
//      the app, exactly as reported.

import { spawnSync } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Repository root (override with REPO=/path/to/openchamber if needed). Default:
// walk up from this script until we find the repo root (AGENTS.md + package.json).
const findRepoRoot = () => {
  let dir = __dirname;
  for (let i = 0; i < 8; i += 1) {
    if (fs.existsSync(path.join(dir, 'AGENTS.md')) && fs.existsSync(path.join(dir, 'package.json'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return '/home/runner/work/openchamber/openchamber';
};
const REPO = process.env.REPO || findRepoRoot();

const BASELINE = process.argv.includes('--baseline');

// Simulate the Windows behavior reported in #2638 (process.platform is read
// at call time inside lifecycle.js: killProcessOnPort no-ops on win32 and
// terminateChildProcess takes the taskkill path, which cannot exist here).
if (!BASELINE) {
  Object.defineProperty(process, 'platform', { value: 'win32' });
}

const { createOpenCodeLifecycleRuntime } = await import(
  path.join(REPO, 'packages/web/server/lib/opencode/lifecycle.js')
);

// --- shared state + real network runtime -----------------------------------
const state = {
  openCodeWorkingDirectory: '/tmp',
  openCodeProcess: null,
  openCodePort: null,
  openCodeBaseUrl: null,
  currentRestartPromise: null,
  isRestartingOpenCode: false,
  openCodeApiPrefix: '',
  openCodeApiPrefixDetected: false,
  openCodeApiDetectionTimer: null,
  lastOpenCodeError: null,
  isOpenCodeReady: false,
  openCodeNotReadySince: 0,
  isExternalOpenCode: false,
  isShuttingDown: false,
  healthCheckInterval: null,
  expressApp: null,
  useWslForOpencode: false,
  resolvedWslBinary: null,
  resolvedWslOpencodePath: null,
  resolvedWslDistro: null,
  lastOpenCodeLaunchDiagnostics: null,
};

const { createOpenCodeNetworkRuntime } = await import(
  path.join(REPO, 'packages/web/server/lib/opencode/network-runtime.js')
);
const networkRuntime = createOpenCodeNetworkRuntime({
  state,
  getOpenCodeAuthHeaders: () => ({}),
  configuredOpenCodeHostname: '127.0.0.1',
});

const fakeBinary = path.join(__dirname, 'fake-opencode-serve.mjs');
const pidDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-repro-2638-'));
process.env.OPENCODE_BINARY = fakeBinary;
process.env.FAKE_OPENCODE_PID_DIR = pidDir;
if (BASELINE) process.env.FAKE_OPENCODE_BASELINE = '1';

const lifecycle = createOpenCodeLifecycleRuntime({
  state,
  env: {
    ENV_CONFIGURED_OPENCODE_PORT: 0,
    ENV_CONFIGURED_OPENCODE_HOST: null,
    ENV_EFFECTIVE_PORT: 0,
    ENV_CONFIGURED_OPENCODE_HOSTNAME: '127.0.0.1',
    ENV_SKIP_OPENCODE_START: false,
  },
  syncToHmrState: () => {},
  syncFromHmrState: () => {},
  getOpenCodeAuthHeaders: () => ({}),
  buildOpenCodeUrl: (...args) => networkRuntime.buildOpenCodeUrl(...args),
  waitForReady: (...args) => networkRuntime.waitForReady(...args),
  normalizeApiPrefix: (...args) => networkRuntime.normalizeApiPrefix(...args),
  applyOpencodeBinaryFromSettings: async () => {},
  ensureOpencodeCliEnv: () => {},
  ensureLocalOpenCodeServerPassword: async () => 'password',
  resolveManagedOpenCodeLaunchSpec: (binary) => ({ binary, args: [], wrapperType: null }),
  setOpenCodePort: (port) => { state.openCodePort = port; },
  setDetectedOpenCodeApiPrefix: () => {},
  setupProxy: () => {},
  ensureOpenCodeApiPrefix: () => {},
  clearResolvedOpenCodeBinary: () => {},
  buildAugmentedPath: () => process.env.PATH,
  buildManagedOpenCodePath: () => process.env.PATH,
  getManagedOpenCodeShellEnvSnapshot: async () => ({}),
  getManagedOpenCodeEnv: async () => ({}),
  reapManagedOrphanedProcesses: async () => ({ reaped: 0 }),
  getWarmupDirectories: async () => [],
  // Production index.js wires this to the message-stream runtime's
  // rebindUpstream(); mirror it here so the harness exercises the fix.
  onOpenCodeRestarted: () => {
    try {
      rebindHub?.();
    } catch {
    }
  },
});

const { createGlobalMessageStreamHub } = await import(
  path.join(REPO, 'packages/web/server/lib/event-stream/global-hub.js')
);

// The hub represents the server→OpenCode SSE push pipeline that feeds the
// renderer (both the server-side PushWatcher and the browser WS bridge).
const received = [];
const statuses = [];
let rebindHub = null;
const hub = createGlobalMessageStreamHub({
  buildOpenCodeUrl: (p) => networkRuntime.buildOpenCodeUrl(p, ''),
  getOpenCodeAuthHeaders: () => ({}),
  upstreamStallTimeoutMs: 20000,
  upstreamReconnectDelayMs: 250,
});
hub.subscribeEvent(({ eventId, payload }) => {
  received.push({ eventId, type: payload?.type, id: payload?.id });
});
hub.subscribeStatus((status) => statuses.push(status));
rebindHub = () => {
  hub.stop();
  hub.start();
};

// --- helpers ----------------------------------------------------------------
const warnLog = [];
const origWarn = console.warn;
console.warn = (...args) => {
  warnLog.push(args.map(String).join(' '));
  origWarn(...args);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(50);
  }
  throw new Error(`timeout waiting for ${what}`);
}

const emitEvent = async (port, id, type = 'session.updated') => {
  const res = await fetch(`http://127.0.0.1:${port}/emit?type=${type}&id=${id}`);
  if (!res.ok) throw new Error(`emit ${id} failed on port ${port}`);
  return res.json();
};

const persistedEvents = async (port) => {
  const res = await fetch(`http://127.0.0.1:${port}/events`);
  return res.ok ? res.json() : [];
};

const portOpen = (port) => new Promise((resolve) => {
  const socket = net.connect({ port, host: '127.0.0.1' });
  const timer = setTimeout(() => { socket.destroy(); resolve(false); }, 300);
  socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve(true); });
  socket.once('error', () => { clearTimeout(timer); resolve(false); });
});

const pidFilePids = () => {
  const out = [];
  for (const file of fs.readdirSync(pidDir)) {
    if (!file.endsWith('.pid')) continue;
    try {
      out.push({ label: file.replace(/\.pid$/, ''), pid: Number(fs.readFileSync(path.join(pidDir, file), 'utf8')) });
    } catch {
      // ignore
    }
  }
  return out;
};

const killPortPids = (port) => {
  try {
    const result = spawnSync('lsof', ['-ti', `:${port}`], { encoding: 'utf8' });
    const pids = String(result.stdout || '').trim().split(/\s+/).map(Number).filter(Boolean);
    for (const pid of pids) {
      if (pid === process.pid) continue; // never kill ourselves (TIME_WAIT client sockets)
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  } catch { /* lsof unavailable */ }
};

const cleanup = async () => {
  for (const { label, pid } of pidFilePids()) {
    if (label.startsWith('launcher') || label.startsWith('baseline')) {
      try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ }
    } else {
      try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
    }
  }
  if (state.openCodePort) killPortPids(state.openCodePort);
  // Belt and braces: kill any surviving fake-opencode processes from this run.
  try {
    const result = spawnSync('pgrep', ['-f', 'fake-opencode-serve.mjs'], { encoding: 'utf8' });
    const pids = String(result.stdout || '').trim().split(/\s+/).map(Number).filter(Boolean);
    for (const pid of pids) {
      if (pid === process.pid) continue;
      try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
    }
  } catch { /* pgrep unavailable */ }
  await sleep(300);
  try { fs.rmSync(pidDir, { recursive: true, force: true }); } catch { /* ignore */ }
  console.warn = origWarn;
};

// --- run ---------------------------------------------------------------------
console.log(`\n=== reproduce-2638 (${BASELINE ? 'BASELINE control' : 'Windows-orphan scenario'}) ===\n`);
let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

try {
  // 1. Bootstrapping starts the managed OpenCode (launcher + server core) on P1.
  await lifecycle.bootstrapOpenCodeAtStartup();
  const p1 = state.openCodePort;
  console.log(`[1] bootstrap OK — managed OpenCode listening on port ${p1} (pid ${state.openCodeProcess?.pid})`);

  // 2. Connect the message-stream hub (server→OpenCode SSE push pipeline).
  hub.start();
  await waitFor(() => statuses.some((s) => s.type === 'connect'), 10000, 'hub connect to P1');
  console.log('[2] message-stream hub connected to /global/event');

  // 3. Baseline delivery: an event emitted by P1 reaches the UI pipeline.
  await emitEvent(p1, 'evt-before-restart');
  await waitFor(() => received.some((r) => r.eventId === 'evt-before-restart'), 5000, 'event delivery');
  check('events flow to the UI before the restart (baseline)', received.some((r) => r.eventId === 'evt-before-restart'));

  // 4. The managed process "exits" while the actual server survives on P1
  //    (simulates the Windows orphan: launcher dies, server core keeps the
  //    port and the SSE stream). In baseline mode the server runs in-process
  //    and dies with the managed process instead.
  const launcherPid = state.openCodeProcess.pid;
  process.kill(launcherPid, 'SIGTERM');
  await waitFor(async () => {
    try { process.kill(launcherPid, 0); return false; } catch { return true; }
  }, 5000, 'launcher exit');
  console.log(`[4] managed process (pid ${launcherPid}) exited; ${BASELINE ? 'server process died with it' : `orphaned server core still listening on ${p1}`}`);

  // 5. Trigger the reported restart path ("Refreshing OpenCode after manual
  //    configuration reload" / periodic health check).
  console.log('[5] triggering restart (refreshOpenCodeAfterConfigChange)...');
  await lifecycle.refreshOpenCodeAfterConfigChange('manual configuration reload');
  const p2 = state.openCodePort;
  console.log(`[5] restarted — new managed OpenCode listening on port ${p2}`);

  // 6. Assert the reported log line: the old port was never released. In the
  //    baseline control the port IS released, so the warning must be absent.
  const timeoutWarn = warnLog.find((line) => line.includes('Timed out waiting for OpenCode port') && line.includes(String(p1)));
  if (BASELINE) {
    check(`no "Timed out waiting for OpenCode port ${p1}" warning in baseline control`, !timeoutWarn);
  } else {
    check(`"Timed out waiting for OpenCode port ${p1} to be released" is logged`, Boolean(timeoutWarn), timeoutWarn || '');
  }
  check('new port differs from old port (leaked process pinned the old one)', p2 !== p1, `p1=${p1} p2=${p2}`);

  // 7. Assert the orphaned old server is still running (process pile-up from
  //    the report: "six opencode.exe serve processes were still running").
  //    In baseline mode we instead expect the port to be properly released.
  const oldCoreStillUp = await portOpen(p1);
  const pids = pidFilePids();
  const orphanPids = pids.filter(({ label }) => label.startsWith('core')).map(({ pid }) => pid);
  const orphanAlive = orphanPids.length > 0 && orphanPids.every((pid) => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  });
  if (BASELINE) {
    check('old port properly released (no orphan in baseline control)', !oldCoreStillUp,
      `old port ${p1} ${oldCoreStillUp ? 'still open' : 'released'}`);
  } else {
    check('orphaned server process still running on the old port', oldCoreStillUp && orphanAlive,
      `old port ${p1} still open; orphan core pids ${orphanPids.join(', ')}`);
  }

  // 8. The stale-UI reproduction: the new server persists events, but in the
  //    orphan scenario they never reach the UI because the hub is still pinned
  //    to the old SSE stream. In baseline mode the hub must reconnect to the
  //    new port and deliver them (wait for the reconnect before emitting —
  //    the upstream reader only learns about the new port on its next attempt).
  const connectsBefore = statuses.filter((s) => s.type === 'connect').length;
  if (!BASELINE) {
    await sleep(1000);
  } else {
    await waitFor(() => statuses.filter((s) => s.type === 'connect').length >= connectsBefore + 1, 15000, 'hub reconnect to new port');
  }
  await emitEvent(p2, 'evt-after-restart');
  console.log(`[8] emitted evt-after-restart on new port ${p2} — waiting to see if the UI receives it...`);
  await sleep(2500);
  const deliveredAfter = received.filter((r) => r.eventId === 'evt-after-restart').length;
  if (BASELINE) {
    check('NEW server event IS delivered to the UI (hub reconnected in baseline)', deliveredAfter === 1,
      `delivered=${deliveredAfter}, total hub events=${received.length}`);
  } else {
    // Fixed: the lifecycle hook rebinds the hub after the managed restart,
    // so the UI receives events from the new port even when the old port is
    // orphaned. The wait mirrors the baseline branch (the reader re-dials on
    // its next attempt after the rebind).
    await waitFor(() => statuses.filter((s) => s.type === 'connect').length >= connectsBefore + 1, 15000, 'hub reconnect to new port after rebind');
    check('NEW server event IS delivered to the UI (rebound after restart)', deliveredAfter === 1,
      `delivered=${deliveredAfter}, total hub events=${received.length}`);
  }

  const persistedOnNew = await persistedEvents(p2);
  check('NEW server persisted the event (data survives, UI does not show it)', persistedOnNew.some((e) => e.id === 'evt-after-restart'),
    `persisted on port ${p2}: ${JSON.stringify(persistedOnNew)}`);

  // 9. Orphan scenario: with the rebind the hub is no longer pinned to the
  //    old server — events emitted by the old (zombie) server must NOT reach
  //    the UI anymore (it left the previous upstream behind).
  if (!BASELINE) {
    await emitEvent(p1, 'evt-zombie-old-server');
    await sleep(2000);
    check('OLD zombie server events no longer reach the UI (hub rebound to new upstream)', !received.some((r) => r.eventId === 'evt-zombie-old-server'));
  }

  console.log(`\n=== ${failures === 0 ? 'REPRODUCED (all checks passed)' : `${failures} check(s) FAILED`} ===\n`);
  console.log(`hub statuses observed: ${JSON.stringify(statuses)}`);
} catch (error) {
  console.error('\nReproduction script error:', error);
  failures += 1;
} finally {
  await cleanup();
}

process.exit(failures === 0 ? 0 : 1);
