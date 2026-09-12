import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MINIMUM_CHROME_MAJOR_VERSION,
  createChromeProcessManager,
} from './chrome-process.js';

class FakeChild extends EventEmitter {
  constructor(pid) {
    super();
    this.pid = pid;
    this.killed = false;
    this.stderr = new EventEmitter();
  }

  kill(signal = 'SIGTERM') {
    if (this.killed) return false;
    this.killed = true;
    queueMicrotask(() => this.emit('exit', null, signal));
    return true;
  }
}

const managers = [];
const roots = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.shutdown()));
  await Promise.all(roots.splice(0).map((root) => fs.promises.rm(root, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

const makeRoot = async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'chrome-process-test-'));
  roots.push(root);
  return root;
};

const endpointFile = async (args, websocketPath = '/devtools/browser/from-file') => {
  const profileDir = args.find((arg) => arg.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
  const requestedPort = Number(args.find((arg) => arg.startsWith('--remote-debugging-port=')).split('=')[1]);
  await fs.promises.writeFile(path.join(profileDir, 'DevToolsActivePort'), `${requestedPort || 9222}\n${websocketPath}\n`);
  return profileDir;
};

const createFakeManager = async (overrides = {}) => {
  const tmpDir = await makeRoot();
  let pid = 4100;
  const children = [];
  const launches = [];
  const spawn = overrides.spawn ?? ((binary, args) => {
    const child = new FakeChild(pid++);
    children.push(child);
    launches.push({ binary, args, child });
    queueMicrotask(() => void endpointFile(args));
    return child;
  });
  const manager = createChromeProcessManager({
    env: { OPENCHAMBER_CHROME_PATH: '/test/chrome', PATH: '' },
    isExecutable: () => true,
    platform: 'linux',
    tmpDir,
    spawn,
    probeVersion: async () => ({ product: `Chrome/${MINIMUM_CHROME_MAJOR_VERSION}.0.0.0` }),
    startupTimeoutMs: 250,
    pollIntervalMs: 5,
    ...overrides,
  });
  managers.push(manager);
  return { manager, children, launches };
};

describe('Chrome process manager', () => {
  it('captures the configured port for the next launch without replacing an active process', async () => {
    let configuredPort = 0;
    const { manager, launches } = await createFakeManager({ getDebugPort: () => configuredPort });
    expect(manager.activePort).toBe(null);
    expect(manager.launchDebugPort).toBe(null);
    const first = await manager.ensureProcess();
    expect(manager.activePort).toBe(9222);
    expect(manager.launchDebugPort).toBe(0);
    configuredPort = 19222;
    expect(await manager.ensureProcess()).toBe(first);
    expect(launches).toHaveLength(1);
    await manager.kill();
    expect(manager.activePort).toBe(null);
    await manager.ensureProcess();
    expect(launches[1].args).toContain('--remote-debugging-port=19222');
    expect(manager.activePort).toBe(19222);
    expect(manager.launchDebugPort).toBe(19222);
  });

  it.each([-1, 65536, 1.5, '9222', null, NaN])('rejects invalid configured port %s before spawning', async (port) => {
    const { manager, launches } = await createFakeManager({ getDebugPort: () => port });
    await expect(manager.ensureProcess()).rejects.toThrow(/port.*0.*65535/i);
    expect(launches).toHaveLength(0);
  });

  it('fails an occupied fixed port before spawn without probing or adopting its listener', async () => {
    const listener = net.createServer();
    await new Promise((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(0, '127.0.0.1', resolve);
    });
    const port = listener.address().port;
    const probeVersion = vi.fn();
    try {
      const { manager, launches } = await createFakeManager({ getDebugPort: () => port, probeVersion });
      await expect(manager.ensureProcess()).rejects.toThrow(new RegExp(`port ${port}.*unavailable`, 'i'));
      expect(launches).toHaveLength(0);
      expect(probeVersion).not.toHaveBeenCalled();
      expect(manager.activePort).toBe(null);
      expect(listener.listening).toBe(true);
    } finally {
      await new Promise((resolve) => listener.close(resolve));
    }
  });

  it('rejects a child endpoint on a different port instead of silently falling back', async () => {
    const child = new FakeChild(4600);
    const probeVersion = vi.fn();
    const { manager } = await createFakeManager({
      getDebugPort: () => 19223,
      probeVersion,
      spawn: () => {
        queueMicrotask(() => child.stderr.emit('data', 'DevTools listening on ws://127.0.0.1:19224/devtools/browser/own-child\n'));
        return child;
      },
    });
    await expect(manager.ensureProcess()).rejects.toThrow(/19223.*19224/);
    expect(probeVersion).not.toHaveBeenCalled();
    expect(child.killed).toBe(true);
  });

  it('prefers OPENCHAMBER_CHROME_PATH and reports an invalid override actionably', async () => {
    const { manager, launches } = await createFakeManager();

    await manager.ensureProcess();

    expect(launches[0].binary).toBe('/test/chrome');

    const invalid = createChromeProcessManager({
      env: { OPENCHAMBER_CHROME_PATH: '/missing/chrome', PATH: '' },
      isExecutable: () => false,
      platform: 'linux',
      tmpDir: await makeRoot(),
    });
    managers.push(invalid);
    await expect(invalid.ensureProcess()).rejects.toThrow(/OPENCHAMBER_CHROME_PATH.*missing\/chrome/i);
  });

  it('keeps automatic CDP ports private while Chrome is still starting', async () => {
    const probeEntered = Promise.withResolvers();
    const probe = Promise.withResolvers();
    const { manager } = await createFakeManager({
      probeVersion: () => { probeEntered.resolve(); return probe.promise; },
    });
    const launching = manager.ensureProcess();
    await probeEntered.promise;
    let settled = false;
    const ports = manager.getPrivatePorts().then((value) => { settled = true; return value; });
    await Promise.resolve();
    expect(settled).toBe(false);
    probe.resolve({ product: `Chrome/${MINIMUM_CHROME_MAJOR_VERSION}.0.0.0` });
    await launching;
    expect(await ports).toEqual([9222]);
    await manager.kill();
    expect(await manager.getPrivatePorts()).toEqual([]);
  });

  it('reports how to configure Chrome when discovery finds no binary', async () => {
    const manager = createChromeProcessManager({
      env: { PATH: '' },
      isExecutable: () => false,
      platform: 'linux',
      tmpDir: await makeRoot(),
    });
    managers.push(manager);

    await expect(manager.ensureProcess()).rejects.toThrow(/OPENCHAMBER_CHROME_PATH/);
  });

  it('launches loopback headless Chrome with a private generation-owned profile', async () => {
    const { manager, launches } = await createFakeManager();

    const result = await manager.ensureProcess();

    expect(launches[0].args).toEqual(expect.arrayContaining([
      '--headless=new',
      '--webrtc-ip-handling-policy=disable_non_proxied_udp',
      '--remote-debugging-port=0',
      '--remote-debugging-address=127.0.0.1',
    ]));
    const profileDir = launches[0].args.find((arg) => arg.startsWith('--user-data-dir=')).split('=')[1];
    expect(profileDir).toContain('openchamber-chrome-0-');
    expect(fs.statSync(profileDir).mode & 0o777).toBe(0o700);
    expect(result.webSocketDebuggerUrl).toBe('ws://127.0.0.1:9222/devtools/browser/from-file');
  });

  it('prefers DevToolsActivePort over stderr and uses stderr only as fallback', async () => {
    let call = 0;
    const { manager } = await createFakeManager({
      spawn: (_binary, args) => {
        const child = new FakeChild(4200 + call++);
        queueMicrotask(async () => {
          child.stderr.emit('data', 'DevTools listening on ws://127.0.0.1:9333/devtools/browser/from-stderr\n');
          if (call === 1) await endpointFile(args, '/devtools/browser/from-file');
        });
        return child;
      },
    });

    expect((await manager.ensureProcess()).webSocketDebuggerUrl).toContain('/from-file');
    await manager.ensureProcess({ generation: 1 });
    expect((await manager.ensureProcess()).webSocketDebuggerUrl).toContain('/from-stderr');
  });

  it('enforces the minimum version and removes the failed profile', async () => {
    const { manager, launches, children } = await createFakeManager({
      probeVersion: async () => ({ product: `Chrome/${MINIMUM_CHROME_MAJOR_VERSION - 1}.0` }),
    });

    await expect(manager.ensureProcess()).rejects.toThrow(new RegExp(`Chrome ${MINIMUM_CHROME_MAJOR_VERSION}\\+`));

    const profileDir = launches[0].args.find((arg) => arg.startsWith('--user-data-dir=')).split('=')[1];
    expect(children[0].killed).toBe(true);
    expect(fs.existsSync(profileDir)).toBe(false);
  });

  it('kills a launch whose CDP endpoint never appears before rejecting', async () => {
    const child = new FakeChild(4300);
    const { manager } = await createFakeManager({
      spawn: () => child,
      startupTimeoutMs: 40,
    });

    await expect(manager.ensureProcess()).rejects.toThrow(/timed out.*Chrome/i);
    expect(child.killed).toBe(true);
  });

  it('coalesces concurrent ensures into one process', async () => {
    const { manager, launches } = await createFakeManager();

    const [first, second] = await Promise.all([manager.ensureProcess(), manager.ensureProcess()]);

    expect(first.process).toBe(second.process);
    expect(launches).toHaveLength(1);
  });

  it('supersedes an older in-flight generation and deletes its profile', async () => {
    const launches = [];
    const { manager } = await createFakeManager({
      spawn: (_binary, args) => {
        const child = new FakeChild(4400 + launches.length);
        launches.push({ args, child });
        if (launches.length === 2) queueMicrotask(() => void endpointFile(args));
        return child;
      },
    });
    const first = manager.ensureProcess();
    await vi.waitFor(() => expect(launches).toHaveLength(1));
    const firstProfile = launches[0].args.find((arg) => arg.startsWith('--user-data-dir=')).split('=')[1];

    const second = manager.ensureProcess({ generation: 1 });

    await expect(first).rejects.toThrow(/superseded.*generation 1/i);
    expect((await second).generation).toBe(1);
    expect(launches[0].child.killed).toBe(true);
    expect(fs.existsSync(firstProfile)).toBe(false);
  });

  it('reports a crash during startup immediately instead of timing out', async () => {
    const child = new FakeChild(4500);
    const { manager } = await createFakeManager({ spawn: () => child, startupTimeoutMs: 500 });
    const startedAt = Date.now();
    const pending = manager.ensureProcess();
    await vi.waitFor(() => expect(child.listenerCount('exit')).toBe(1));
    child.emit('exit', 9, null);

    await expect(pending).rejects.toThrow(/Chrome generation 0 exited.*code 9/i);
    expect(Date.now() - startedAt).toBeLessThan(250);
  });

  it('cleans a crashed profile and relaunches on the next ensure', async () => {
    const { manager, launches } = await createFakeManager();
    const first = await manager.ensureProcess();
    const firstProfile = launches[0].args.find((arg) => arg.startsWith('--user-data-dir=')).split('=')[1];

    first.process.emit('exit', 9, null);
    await vi.waitFor(() => expect(fs.existsSync(firstProfile)).toBe(false));
    const second = await manager.ensureProcess();

    expect(second.process).not.toBe(first.process);
    expect(launches).toHaveLength(2);
  });

  it('registers an ordered shutdown hook that kills Chrome and removes its profile', async () => {
    let shutdownHook;
    const { manager, launches } = await createFakeManager({
      registerShutdownHook: (hook) => { shutdownHook = hook; },
    });
    const running = await manager.ensureProcess();
    const profileDir = launches[0].args.find((arg) => arg.startsWith('--user-data-dir=')).split('=')[1];

    await shutdownHook();

    expect(running.process.killed).toBe(true);
    expect(fs.existsSync(profileDir)).toBe(false);
  });
});

const realChrome = process.env.OPENCHAMBER_CHROME_PATH;
const realChromeAvailable = realChrome && fs.existsSync(realChrome);

describe.skipIf(!realChromeAvailable)('real Chrome lifecycle', () => {
  it('probes Browser.getVersion and recovers after SIGKILL during a later generation probe', async () => {
    const tmpDir = await makeRoot();
    let killDuringProbe = false;
    const manager = createChromeProcessManager({
      env: { ...process.env, OPENCHAMBER_CHROME_PATH: realChrome },
      tmpDir,
      beforeVersionProbe: ({ process: child }) => {
        if (killDuringProbe) process.kill(child.pid, 'SIGKILL');
      },
    });
    managers.push(manager);
    const first = await manager.ensureProcess();
    expect(first.version.major).toBeGreaterThanOrEqual(MINIMUM_CHROME_MAJOR_VERSION);
    killDuringProbe = true;
    await expect(manager.ensureProcess({ generation: 1 })).rejects.toThrow(/Chrome generation 1 exited/i);
    killDuringProbe = false;

    const recovered = await manager.ensureProcess();

    expect(recovered.process.pid).not.toBe(first.process.pid);
    expect(recovered.version.major).toBeGreaterThanOrEqual(MINIMUM_CHROME_MAJOR_VERSION);
  }, 30_000);
});

if (!realChromeAvailable) {
  console.warn(`Skipping real Chrome lifecycle: OPENCHAMBER_CHROME_PATH is ${realChrome ? 'not found' : 'not set'}`);
}
