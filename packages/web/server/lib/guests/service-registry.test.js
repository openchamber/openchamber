import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  SERVICE_TOKEN_ENV,
  createGuestServiceRegistry,
  reapOrphanedGuestServices,
  recordGuestService,
} from './service-registry.js';

const REGISTRY_MODULE = pathToFileURL(path.join(import.meta.dirname, 'service-registry.js')).href;
const TOKEN = 'a'.repeat(48);
const OTHER_TOKEN = 'b'.repeat(48);
const ENTRY = '/fixture/docker/service/main.js';

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitFor = async (check, timeoutMs = 5_000) => {
  const startedAt = Date.now();
  while (!check() && Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return check();
};

let dir;
const spawned = [];

const spawnService = (token) => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    env: { [SERVICE_TOKEN_ENV]: token },
    stdio: 'ignore',
  });
  spawned.push(child.pid);
  return child;
};

/**
 * A host that records a service it spawned and then dies by SIGKILL, so the
 * service is orphaned the way a crash leaves it. `recordedToken` is what the
 * host writes down, `serviceToken` what the service really carries.
 */
const crashHost = async ({ recordedToken = TOKEN, serviceToken = TOKEN } = {}) => {
  const script = `
    import { spawn } from 'node:child_process';
    import { recordGuestService } from ${JSON.stringify(REGISTRY_MODULE)};
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      env: { ${SERVICE_TOKEN_ENV}: ${JSON.stringify(serviceToken)} },
      stdio: 'ignore',
    });
    await recordGuestService(${JSON.stringify(dir)}, {
      pid: child.pid, guestId: 'docker', token: ${JSON.stringify(recordedToken)}, entry: ${JSON.stringify(ENTRY)},
    });
    process.stdout.write(String(child.pid));
    setInterval(() => {}, 1000);
  `;
  const host = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
  spawned.push(host.pid);
  const servicePid = await new Promise((resolve, reject) => {
    host.stdout.once('data', (chunk) => resolve(Number(chunk.toString())));
    host.once('exit', () => reject(new Error('host exited before recording its service')));
  });
  spawned.push(servicePid);
  const exited = new Promise((resolve) => host.once('exit', resolve));
  host.kill('SIGKILL');
  await exited;
  return servicePid;
};

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-guest-registry-'));
});

afterEach(async () => {
  for (const pid of spawned.splice(0)) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ }
  }
  await fs.rm(dir, { recursive: true, force: true });
});

describe('recordGuestService', () => {
  test('writes one owner-only file per pid that holds a digest of the token, never the token', async () => {
    await recordGuestService(dir, { pid: 4242, guestId: 'docker', token: TOKEN, entry: ENTRY });

    expect(await fs.readdir(dir)).toEqual(['4242.json']);
    const text = await fs.readFile(path.join(dir, '4242.json'), 'utf8');
    expect(text).not.toContain(TOKEN);
    expect(JSON.parse(text)).toMatchObject({ pid: 4242, ownerPid: process.pid, guestId: 'docker', entry: ENTRY });
    if (process.platform !== 'win32') {
      expect((await fs.stat(path.join(dir, '4242.json'))).mode & 0o777).toBe(0o600);
    }
  });
});

describe.skipIf(process.platform === 'win32')('reapOrphanedGuestServices with real processes', () => {
  test('stops a service whose host died and drops its record', async () => {
    const pid = await crashHost();
    expect(alive(pid)).toBe(true);

    expect(await reapOrphanedGuestServices(dir)).toEqual({ inspected: 1, reaped: 1 });
    expect(await waitFor(() => !alive(pid))).toBe(true);
    expect(await fs.readdir(dir)).toEqual([]);
  });

  test('leaves an orphan alone when it does not carry the recorded token, and drops the stale record', async () => {
    const pid = await crashHost({ recordedToken: TOKEN, serviceToken: OTHER_TOKEN });

    expect(await reapOrphanedGuestServices(dir)).toEqual({ inspected: 1, reaped: 0 });
    expect(alive(pid)).toBe(true);
    expect(await fs.readdir(dir)).toEqual([]);
  });

  test('leaves a service whose host is alive and keeps its record', async () => {
    const child = spawnService(TOKEN);
    await recordGuestService(dir, { pid: child.pid, guestId: 'docker', token: TOKEN, entry: ENTRY });

    expect(await reapOrphanedGuestServices(dir)).toEqual({ inspected: 1, reaped: 0 });
    expect(alive(child.pid)).toBe(true);
    expect(await fs.readdir(dir)).toEqual([`${child.pid}.json`]);
  });

  test('drops the record of a process that already exited', async () => {
    const child = spawnService(TOKEN);
    await recordGuestService(dir, { pid: child.pid, guestId: 'docker', token: TOKEN, entry: ENTRY });
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGKILL');
    await exited;

    expect(await reapOrphanedGuestServices(dir)).toEqual({ inspected: 1, reaped: 0 });
    expect(await fs.readdir(dir)).toEqual([]);
  });
});

describe('reapOrphanedGuestServices decisions', () => {
  const fakeProcesses = (alivePids) => {
    const signals = [];
    const signalProcess = (pid, signal) => {
      signals.push([pid, signal]);
      if (!alivePids.has(pid)) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      if (signal === 'SIGTERM' || signal === 'SIGKILL') alivePids.delete(pid);
    };
    return { signals, signalProcess };
  };

  test('answers zero for a registry that does not exist', async () => {
    const registry = createGuestServiceRegistry(fakeProcesses(new Set()));

    expect(await registry.reapOrphanedGuestServices(path.join(dir, 'missing'))).toEqual({ inspected: 0, reaped: 0 });
  });

  test('drops unreadable and invalid records without signalling anything', async () => {
    const processes = fakeProcesses(new Set());
    const registry = createGuestServiceRegistry(processes);
    await fs.writeFile(path.join(dir, 'broken.json'), '{ not json');
    // A non-positive pid would signal a whole process group, or every process.
    await fs.writeFile(path.join(dir, '-1.json'), JSON.stringify({
      pid: -1, ownerPid: 2, guestId: 'docker', tokenSha256: '0'.repeat(64), execPath: process.execPath, entry: ENTRY,
    }));

    expect(await registry.reapOrphanedGuestServices(dir)).toEqual({ inspected: 2, reaped: 0 });
    expect(processes.signals).toEqual([]);
    expect(await fs.readdir(dir)).toEqual([]);
  });

  test('removes temp records of a writer that died and keeps those of a live one', async () => {
    const processes = fakeProcesses(new Set([7001]));
    const registry = createGuestServiceRegistry(processes);
    await fs.writeFile(path.join(dir, '4242.json.tmp-6001-0a1b2c3d'), '{}');
    await fs.writeFile(path.join(dir, '4343.json.tmp-7001-0a1b2c3d'), '{}');

    expect(await registry.reapOrphanedGuestServices(dir)).toEqual({ inspected: 0, reaped: 0 });
    expect(await fs.readdir(dir)).toEqual(['4343.json.tmp-7001-0a1b2c3d']);
  });

  test('keeps the record when the process cannot be inspected', async () => {
    const processes = fakeProcesses(new Set([4242]));
    const registry = createGuestServiceRegistry({
      ...processes,
      platform: 'darwin',
      execFileAsync: async () => { throw new Error('ps failed'); },
    });
    await registry.recordGuestService(dir, { pid: 4242, guestId: 'docker', token: TOKEN, entry: ENTRY });

    expect(await registry.reapOrphanedGuestServices(dir)).toEqual({ inspected: 1, reaped: 0 });
    expect(processes.signals).toEqual([[4242, 0]]);
    expect(await fs.readdir(dir)).toEqual(['4242.json']);
  });

  describe('on Windows', () => {
    const windowsRegistry = (alivePids, processInfo) => {
      const processes = fakeProcesses(alivePids);
      const registry = createGuestServiceRegistry({
        ...processes,
        platform: 'win32',
        execFileAsync: async (file) => {
          expect(file).toMatch(/powershell\.exe$/i);
          return { stdout: JSON.stringify(processInfo), stderr: '' };
        },
      });
      return { registry, signals: processes.signals };
    };

    test('stops a service whose owner is dead when the command line names its entry', async () => {
      // The owner is this process; leaving it out of the live set plays a dead host.
      const { registry, signals } = windowsRegistry(new Set([4242]), {
        commandLine: `"${process.execPath}" ${ENTRY}`,
        // Windows paths compare without case.
        executablePath: process.execPath.toUpperCase(),
      });
      await registry.recordGuestService(dir, { pid: 4242, guestId: 'docker', token: TOKEN, entry: ENTRY });

      expect(await registry.reapOrphanedGuestServices(dir)).toEqual({ inspected: 1, reaped: 1 });
      expect(signals).toContainEqual([4242, 'SIGTERM']);
      expect(await fs.readdir(dir)).toEqual([]);
    });

    test('leaves a service whose owner is alive', async () => {
      const { registry, signals } = windowsRegistry(new Set([4242, process.pid]), {
        commandLine: `"${process.execPath}" ${ENTRY}`,
        executablePath: process.execPath,
      });
      await registry.recordGuestService(dir, { pid: 4242, guestId: 'docker', token: TOKEN, entry: ENTRY });

      expect(await registry.reapOrphanedGuestServices(dir)).toEqual({ inspected: 1, reaped: 0 });
      expect(signals.filter(([, signal]) => signal !== 0)).toEqual([]);
      expect(await fs.readdir(dir)).toEqual(['4242.json']);
    });

    test('leaves a reused pid that runs something else and drops the stale record', async () => {
      const { registry, signals } = windowsRegistry(new Set([4242]), {
        commandLine: `"${process.execPath}" C:\\Users\\me\\dev-server.js`,
        executablePath: process.execPath,
      });
      await registry.recordGuestService(dir, { pid: 4242, guestId: 'docker', token: TOKEN, entry: ENTRY });

      expect(await registry.reapOrphanedGuestServices(dir)).toEqual({ inspected: 1, reaped: 0 });
      expect(signals.filter(([, signal]) => signal !== 0)).toEqual([]);
      expect(await fs.readdir(dir)).toEqual([]);
    });
  });
});
