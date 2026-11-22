import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createOpenCodeLifecycleRuntime } from './lifecycle.js';
import { readManagedProcessOwner, registerManagedProcess } from './managed-process-registry.js';

// Other test files mock node:child_process for the shared lifecycle module, so these must be the real functions.
const { spawn: realSpawn, spawnSync: realSpawnSync } = createRequire(import.meta.url)('node:child_process');

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

const fakeOpenCodeScript = (markerPath) => `
  const fs = require('node:fs');
  const http = require('node:http');
  const host = process.argv[process.argv.indexOf('--hostname') + 1];
  const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
  fs.appendFileSync(${JSON.stringify(markerPath)}, process.pid + '\\n');
  const server = http.createServer((req, res) => {
    if (req.url === '/api/info' || req.url === '/global/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ healthy: true, version: '2.0.14', pid: process.pid }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(port, host, () => process.stdout.write('server listening on http://' + host + ':' + port + '\\n'));
`;

// The probe surface of the lifecycle: previewManagedOpenCodeLaunch is the dry run a
// handoff successor reports to its predecessor, and reclaimManagedOpenCodeOwnership is
// the predecessor's rollback after a failed handoff. The oracle is the design's
// section 3 and 4: the preview matches the decision a real start would make, and the
// re-claim names the predecessor as owner again without touching another server's child.
const createFixture = async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'oc-probe-lifecycle-'));
  const markerPath = path.join(root, 'pids');
  await fsp.writeFile(path.join(root, 'serve'), fakeOpenCodeScript(markerPath));
  const binary = { current: process.execPath };
  const instanceDir = path.join(root, 'instance');
  await fsp.mkdir(instanceDir, { recursive: true });
  const createRuntime = () => createOpenCodeLifecycleRuntime({
    state: { openCodeWorkingDirectory: root, useWslForOpencode: false },
    dataDir: root,
    env: { ENV_CONFIGURED_OPENCODE_HOSTNAME: '127.0.0.1' },
    syncToHmrState() {}, syncFromHmrState() {},
    checkOpenCodeBinary: async () => '2.0.14',
    ensureOpencodeCliEnv: () => binary.current,
    applyOpencodeBinaryFromSettings: async () => {},
    ensureLocalOpenCodeServerPassword: async () => 'fixture-only',
    getOpenCodeAuthHeaders: () => ({}),
    resolveManagedOpenCodeLaunchSpec: (value) => ({ binary: value, args: [] }),
    normalizeApiPrefix: (value) => value,
    setOpenCodePort() {}, setDetectedOpenCodeApiPrefix() {},
    waitForReady: async () => true,
    managedStartupTimeoutMs: 5000,
    spawnProcess: realSpawn,
    spawnSyncProcess: realSpawnSync,
    getInstanceDir: () => instanceDir,
  });
  const spawnedPids = async () => (await fsp.readFile(markerPath, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(Number);
  const cleanup = async () => {
    for (const pid of (await spawnedPids()).reverse()) {
      if (alive(pid)) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ }
      }
    }
    await fsp.rm(root, { recursive: true, force: true });
  };
  return { root, binary, instanceDir, createRuntime, spawnedPids, cleanup };
};

const deadPid = async () => {
  const child = realSpawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((resolve) => child.once('exit', resolve));
  return child.pid;
};

describe('handoff probe lifecycle surface', () => {
  let previousRegistry;
  afterEach(() => {
    if (previousRegistry === undefined) delete process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY;
    else process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY = previousRegistry;
  });
  const useFixtureRegistry = (fixture) => {
    previousRegistry = process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY;
    process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY = path.join(fixture.root, 'registry');
  };

  it('previews adopt for a successor with the same launch, and reads the running version', async () => {
    const fixture = await createFixture();
    useFixtureRegistry(fixture);
    const predecessor = fixture.createRuntime();
    const successor = fixture.createRuntime();
    try {
      const first = await predecessor.startOpenCode();
      const preview = await successor.previewManagedOpenCodeLaunch();
      expect(preview.decision).toEqual({ action: 'adopt', reason: 'matches-state' });
      expect(preview.openCodeVersion).toBe('2.0.14');
      expect(alive(first.pid)).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);

  it('previews a handoff when the successor launch changed the binary', async () => {
    const fixture = await createFixture();
    useFixtureRegistry(fixture);
    const predecessor = fixture.createRuntime();
    try {
      await predecessor.startOpenCode();
      const nextBinary = path.join(fixture.root, 'opencode-next');
      fs.copyFileSync(process.execPath, nextBinary);
      fs.chmodSync(nextBinary, 0o755);
      fixture.binary.current = nextBinary;
      const successor = fixture.createRuntime();
      const preview = await successor.previewManagedOpenCodeLaunch();
      expect(preview.decision.action).toBe('handoff');
      expect(preview.decision.reason).toBe('binary-changed');
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);

  it('previews adopt with no managed state to protect', async () => {
    const fixture = await createFixture();
    useFixtureRegistry(fixture);
    const successor = fixture.createRuntime();
    try {
      const preview = await successor.previewManagedOpenCodeLaunch();
      expect(preview).toEqual({ decision: { action: 'adopt', reason: 'no-managed-state' }, openCodeVersion: null });
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);

  it('previews start with unverified-owner when another live server owns the recorded OpenCode', async () => {
    const fixture = await createFixture();
    useFixtureRegistry(fixture);
    const predecessor = fixture.createRuntime();
    const sleeper = realSpawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' });
    try {
      const first = await predecessor.startOpenCode();
      await registerManagedProcess({ pid: first.pid, ownerPid: sleeper.pid, port: Number(new URL(first.url).port), binary: fixture.binary.current, runtime: 'web' });
      const successor = fixture.createRuntime();
      const preview = await successor.previewManagedOpenCodeLaunch();
      expect(preview.decision).toEqual({ action: 'start', reason: 'unverified-owner' });
    } finally {
      sleeper.kill('SIGKILL');
      await fixture.cleanup();
    }
  }, 30_000);

  it('re-claims the registry entry and the instance folder from a dead successor', async () => {
    const fixture = await createFixture();
    useFixtureRegistry(fixture);
    const predecessor = fixture.createRuntime();
    try {
      const first = await predecessor.startOpenCode();
      const successorPid = await deadPid();
      await registerManagedProcess({ pid: first.pid, ownerPid: successorPid, port: Number(new URL(first.url).port), binary: fixture.binary.current, runtime: 'web' });
      await fsp.writeFile(path.join(fixture.instanceDir, 'owner'), `${successorPid}\n`);
      expect(readManagedProcessOwner(first.pid)).toBe(successorPid);

      await expect(predecessor.reclaimManagedOpenCodeOwnership({ successorPid })).resolves.toBe(true);

      expect(readManagedProcessOwner(first.pid)).toBe(process.pid);
      expect(fs.readFileSync(path.join(fixture.instanceDir, 'owner'), 'utf8').trim()).toBe(String(process.pid));
      // Idempotent: a second re-claim after a later failure changes nothing.
      await expect(predecessor.reclaimManagedOpenCodeOwnership({ successorPid })).resolves.toBe(true);
      expect(readManagedProcessOwner(first.pid)).toBe(process.pid);
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);

  it('leaves an OpenCode another live server owns alone on re-claim', async () => {
    const fixture = await createFixture();
    useFixtureRegistry(fixture);
    const predecessor = fixture.createRuntime();
    const sleeper = realSpawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' });
    try {
      const first = await predecessor.startOpenCode();
      await registerManagedProcess({ pid: first.pid, ownerPid: sleeper.pid, port: Number(new URL(first.url).port), binary: fixture.binary.current, runtime: 'web' });
      const successorPid = await deadPid();

      await expect(predecessor.reclaimManagedOpenCodeOwnership({ successorPid })).resolves.toBe(false);
      expect(readManagedProcessOwner(first.pid)).toBe(sleeper.pid);
    } finally {
      sleeper.kill('SIGKILL');
      await fixture.cleanup();
    }
  }, 30_000);
});
