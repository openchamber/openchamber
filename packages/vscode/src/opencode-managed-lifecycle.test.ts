import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createManagedOpenCodeServerProcess,
  type CreateManagedOpenCodeServerOptions,
  type ManagedChildProcess,
  type ManagedOpenCodeLifecycleDependencies,
  type ManagedOpenCodeServerHandle,
  type ManagedProcessRegistration,
} from './opencode-managed-lifecycle';

// Every dependency below is injected, so the real managed-process registry is
// never called. The override is a second guard against writing under the user's
// home if a future default slips through; each test file runs in its own
// process, so it cannot leak into other suites.
const isolatedRegistryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-lifecycle-'));
process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY = isolatedRegistryDir;

after(() => {
  fs.rmSync(isolatedRegistryDir, { recursive: true, force: true });
});

const FAKE_PID = 4242;
const FAKE_PORT = 45678;
const FAKE_BINARY = '/test/opencode';

class FakeManagedChildProcess extends EventEmitter implements ManagedChildProcess {
  pid: number | undefined = FAKE_PID;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killedSignals: Array<NodeJS.Signals | number | undefined> = [];
  autoExitOnKill = true;

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killedSignals.push(signal);
    if (this.autoExitOnKill) {
      // Real children report exit asynchronously; the microtask lets the close
      // path exercise its confirmed-exit wait.
      queueMicrotask(() => {
        this.exitCode = 0;
        this.emit('close', 0, null);
      });
    }
    return true;
  }
}

interface LifecycleHarness {
  child: FakeManagedChildProcess;
  deps: ManagedOpenCodeLifecycleDependencies;
  options: CreateManagedOpenCodeServerOptions;
  log: string[];
  registrations: ManagedProcessRegistration[];
  unregisteredPids: Array<number | undefined>;
  killedTreePids: Array<number | undefined>;
}

const createHarness = (overrides: Partial<CreateManagedOpenCodeServerOptions> = {}): LifecycleHarness => {
  const child = new FakeManagedChildProcess();
  const log: string[] = [];
  const registrations: ManagedProcessRegistration[] = [];
  const unregisteredPids: Array<number | undefined> = [];
  const killedTreePids: Array<number | undefined> = [];
  const deps: ManagedOpenCodeLifecycleDependencies = {
    spawnProcess: () => {
      log.push('spawn');
      return child;
    },
    registerManagedProcess: async (entry) => {
      registrations.push(entry);
      log.push(`register:${entry.pid}`);
    },
    unregisterManagedProcess: async (pid) => {
      unregisteredPids.push(pid);
      log.push(`unregister:${pid}`);
    },
    killProcessTree: (pid) => {
      killedTreePids.push(pid);
      log.push(`killTree:${pid}`);
    },
  };
  const options: CreateManagedOpenCodeServerOptions = {
    binary: FAKE_BINARY,
    launchBinary: FAKE_BINARY,
    launchArgs: ['serve', '--hostname', '127.0.0.1', '--port', String(FAKE_PORT)],
    cwd: '/tmp/project',
    env: { OPENCODE_BINARY: FAKE_BINARY },
    port: FAKE_PORT,
    timeoutMs: 2000,
    binaryIsMacAppBundle: false,
    ...overrides,
  };
  return { child, deps, options, log, registrations, unregisteredPids, killedTreePids };
};

const emitListening = (child: FakeManagedChildProcess, url = `http://127.0.0.1:${FAKE_PORT}`) => {
  child.stdout.emit('data', Buffer.from(`opencode server listening on ${url}\n`));
};

const captureRejection = async (promise: Promise<ManagedOpenCodeServerHandle>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }
  assert.fail('expected the managed server startup to reject');
};

describe('VS Code managed OpenCode lifecycle', () => {
  test('registers the child at spawn, before the listening line resolves', async () => {
    const harness = createHarness();
    let finishRegistration: (() => void) | undefined;
    harness.deps.registerManagedProcess = (entry) => {
      harness.registrations.push(entry);
      return new Promise<void>((resolve) => {
        finishRegistration = resolve;
      });
    };

    const serverPromise = createManagedOpenCodeServerProcess(harness.options, harness.deps);

    // The spawn tick registers immediately: no output exists yet.
    assert.equal(harness.registrations.length, 1);
    assert.deepEqual(harness.registrations[0], {
      pid: FAKE_PID,
      ownerPid: process.pid,
      port: FAKE_PORT,
      binary: FAKE_BINARY,
      runtime: 'vscode',
    });

    emitListening(harness.child);
    let started = false;
    void serverPromise.then(() => { started = true; });
    await Promise.resolve();
    assert.equal(started, false, 'startup must wait for registration');

    finishRegistration?.();
    const handle = await serverPromise;
    assert.equal(handle.url, `http://127.0.0.1:${FAKE_PORT}`);
    await handle.close();
  });

  test('startup timeout kills, awaits exit, unregisters, and keeps the existing message', async () => {
    const harness = createHarness({ timeoutMs: 25 });
    const serverPromise = createManagedOpenCodeServerProcess(harness.options, harness.deps);
    harness.child.stderr.emit('data', Buffer.from('slow start\n'));

    const message = await captureRejection(serverPromise);

    assert.equal(message, 'Timeout waiting for server to start after 25ms. Output: slow start');
    assert.deepEqual(harness.registrations.map((entry) => entry.pid), [FAKE_PID]);
    assert.deepEqual(harness.killedTreePids, [FAKE_PID]);
    assert.deepEqual(harness.child.killedSignals, ['SIGTERM']);
    assert.deepEqual(harness.unregisteredPids, [FAKE_PID]);
  });

  test('startup timeout without output keeps the existing no-output hint', async () => {
    const harness = createHarness({ timeoutMs: 20 });

    const message = await captureRejection(createManagedOpenCodeServerProcess(harness.options, harness.deps));

    assert.equal(message, 'Timeout waiting for server to start after 20ms. Output: (none — process printed nothing)');
    assert.deepEqual(harness.unregisteredPids, [FAKE_PID]);
  });

  test('unparsable listening line cleans up and keeps the existing message', async () => {
    const harness = createHarness();
    const serverPromise = createManagedOpenCodeServerProcess(harness.options, harness.deps);
    harness.child.stdout.emit('data', Buffer.from('opencode server listening without a url\n'));

    const message = await captureRejection(serverPromise);

    assert.equal(message, 'Failed to parse server url from output: opencode server listening without a url');
    assert.deepEqual(harness.killedTreePids, [FAKE_PID]);
    assert.deepEqual(harness.child.killedSignals, ['SIGTERM']);
    assert.deepEqual(harness.unregisteredPids, [FAKE_PID]);
  });

  test('early exit cleans up and keeps the existing exit message', async () => {
    const harness = createHarness();
    const serverPromise = createManagedOpenCodeServerProcess(harness.options, harness.deps);
    harness.child.exitCode = 3;
    harness.child.emit('exit', 3, null);

    const message = await captureRejection(serverPromise);

    assert.equal(
      message,
      `OpenCode process exited before serving with code 3. Binary used: ${FAKE_BINARY}. Output: `,
    );
    // The child already exited; its pid must not be signaled again.
    assert.deepEqual(harness.killedTreePids, []);
    assert.deepEqual(harness.child.killedSignals, []);
    assert.deepEqual(harness.unregisteredPids, [FAKE_PID]);
  });

  test('early exit keeps the macOS app-bundle hint', async () => {
    const harness = createHarness({ binaryIsMacAppBundle: true });
    const serverPromise = createManagedOpenCodeServerProcess(harness.options, harness.deps);
    harness.child.exitCode = 1;
    harness.child.emit('exit', 1, null);

    const message = await captureRejection(serverPromise);

    assert.equal(
      message,
      `OpenCode process exited before serving with code 1. Binary used: ${FAKE_BINARY}. The configured binary appears to point at the macOS desktop app bundle; OpenChamber needs the standalone opencode CLI. Output: `,
    );
  });

  test('spawn error cleans up and propagates the original error', async () => {
    const harness = createHarness();
    const serverPromise = createManagedOpenCodeServerProcess(harness.options, harness.deps);
    harness.child.emit('error', new Error('spawn opencode ENOENT'));

    const message = await captureRejection(serverPromise);

    assert.equal(message, 'spawn opencode ENOENT');
    assert.deepEqual(harness.killedTreePids, [FAKE_PID]);
    assert.deepEqual(harness.unregisteredPids, [FAKE_PID]);
  });

  test('registration rejection terminates the child before the error propagates', async () => {
    const harness = createHarness();
    harness.deps.registerManagedProcess = async () => {
      throw new Error('registry write failed');
    };

    const message = await captureRejection(createManagedOpenCodeServerProcess(harness.options, harness.deps));

    assert.equal(message, 'registry write failed');
    assert.deepEqual(harness.killedTreePids, [FAKE_PID]);
    assert.deepEqual(harness.child.killedSignals, ['SIGTERM']);
    assert.deepEqual(harness.unregisteredPids, [FAKE_PID]);
  });

  test('close kills, awaits confirmed exit, and unregisters exactly once', async () => {
    const harness = createHarness();
    let childExitedWhenUnregistered: boolean | null = null;
    harness.deps.unregisterManagedProcess = async (pid) => {
      harness.unregisteredPids.push(pid);
      harness.log.push(`unregister:${pid}`);
      childExitedWhenUnregistered = harness.child.exitCode !== null || harness.child.signalCode !== null;
    };

    const serverPromise = createManagedOpenCodeServerProcess(harness.options, harness.deps);
    emitListening(harness.child);
    const handle = await serverPromise;

    await handle.close();
    await handle.close();

    assert.equal(harness.child.killedSignals.length, 1);
    assert.deepEqual(harness.child.killedSignals, ['SIGTERM']);
    assert.deepEqual(harness.killedTreePids, [FAKE_PID]);
    assert.deepEqual(harness.unregisteredPids, [FAKE_PID]);
    assert.equal(childExitedWhenUnregistered, true, 'the registry entry must be dropped only after the child exited');
    assert.equal(harness.log.indexOf(`register:${FAKE_PID}`) < harness.log.indexOf(`killTree:${FAKE_PID}`), true);
    assert.equal(harness.log.indexOf(`killTree:${FAKE_PID}`) < harness.log.indexOf(`unregister:${FAKE_PID}`), true);
  });
});
