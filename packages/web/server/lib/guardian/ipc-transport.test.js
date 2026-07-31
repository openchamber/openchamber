import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as windowsAcl from './windows-acl.js';
import {
  createIpcDialer,
  createIpcServer,
  defaultIpcPaths,
} from './ipc-transport.js';

let tmpDirs = [];
const aclInspector = () => ({ entries: [{ principal: 'alice', rights: ['F'] }] });

const mkTmp = (label = 'ipc-transport') => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `openchamber-${label}-`));
  tmpDirs.push(dir);
  return dir;
};

beforeEach(() => {
  // `applyDiscoveryFileAcl` shells out to `icacls`, which is Windows-only.
  // On Linux CI we must stub it. The factory's Windows backend uses
  // the spy-installed version because `writeDiscoveryFileAtomic`
  // captured the function reference at module-load time; the spy
  // replaces it on `windowsAcl`'s namespace export.
  vi.spyOn(windowsAcl, 'applyDiscoveryFileAcl').mockReturnValue({ ok: true, username: 'alice' });
});

afterEach(() => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop();
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  vi.restoreAllMocks();
});

describe('defaultIpcPaths', () => {
  it('returns POSIX socketPath under rootDir for linux', () => {
    const root = mkTmp();
    const result = defaultIpcPaths({ platform: 'linux', rootDir: root });
    expect(result.socketPath).toBe(path.join(root, 'guardian.sock'));
    expect(result.portPath).toBeUndefined();
  });

  it('returns POSIX socketPath for darwin (macOS)', () => {
    const root = mkTmp();
    const result = defaultIpcPaths({ platform: 'darwin', rootDir: root });
    expect(result.socketPath).toBe(path.join(root, 'guardian.sock'));
    expect(result.portPath).toBeUndefined();
  });

  it('returns Windows portPath under portDir for win32', () => {
    const portDir = mkTmp('ipc-transport-portdir');
    const result = defaultIpcPaths({ platform: 'win32', portDir });
    expect(result.portPath).toBe(path.join(portDir, 'port'));
    expect(result.socketPath).toBeUndefined();
  });

  it('throws for unknown platforms (fail closed)', () => {
    expect(() => defaultIpcPaths({ platform: 'plan9', rootDir: mkTmp() })).toThrow(/unsupported platform/);
  });

  it('throws when POSIX rootDir is missing', () => {
    expect(() => defaultIpcPaths({ platform: 'linux' })).toThrow(/rootDir is required/);
  });

  it('throws when Windows portDir is missing', () => {
    expect(() => defaultIpcPaths({ platform: 'win32' })).toThrow(/portDir is required/);
  });
});

describe('createIpcServer (POSIX)', () => {
  it.skipIf(process.platform === 'win32')('linux backend: listens on a Unix socket, chmods it 0600, and unlinks on close', async () => {
    const root = mkTmp();
    const { socketPath } = defaultIpcPaths({ platform: 'linux', rootDir: root });
    const transport = createIpcServer({
      platform: 'linux',
      socketPath,
      log: () => {},
    });
    expect(typeof transport.listen).toBe('function');
    expect(typeof transport.close).toBe('function');

    let receivedSocket = null;
    await transport.listen({
      onRequest: (socket) => {
        receivedSocket = socket;
      },
    });

    // Socket file exists with the expected mode.
    const stat = fs.statSync(socketPath);
    expect(stat.isSocket()).toBe(true);
    expect(stat.mode & 0o777).toBe(0o600);

    // A client can connect and the transport wires the connection to
    // `onRequest` (asserting the socket-side wiring works).
    await new Promise((resolve, reject) => {
      const client = net.createConnection(socketPath);
      const timer = setTimeout(() => {
        client.destroy();
        reject(new Error('connect timeout'));
      }, 2000);
      client.on('connect', () => {
        clearTimeout(timer);
        client.end();
        client.destroy();
        resolve();
      });
      client.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    // Give the server a tick to register the connection before close.
    await new Promise((resolve) => setImmediate(resolve));
    expect(receivedSocket).not.toBeNull();

    await transport.close();
    // After close, the socket file is unlinked on POSIX.
    expect(fs.existsSync(socketPath)).toBe(false);
  });

  it('darwin backend: same surface as linux (constructor only, no live socket)', () => {
    // The platform branch is identical between linux and darwin; a
    // full listen+close round-trip is exercised by the linux test
    // above. Here we only assert the factory returns the expected
    // surface for the macOS platform.
    const root = mkTmp();
    const { socketPath } = defaultIpcPaths({ platform: 'darwin', rootDir: root });
    const transport = createIpcServer({
      platform: 'darwin',
      socketPath,
      log: () => {},
    });
    expect(typeof transport.listen).toBe('function');
    expect(typeof transport.close).toBe('function');
  });

  it('throws when POSIX socketPath is missing', () => {
    expect(() => createIpcServer({ platform: 'linux' })).toThrow(/POSIX socketPath is required/);
  });

  it('close() on an idle transport resolves immediately', async () => {
    const root = mkTmp();
    const { socketPath } = defaultIpcPaths({ platform: 'linux', rootDir: root });
    const transport = createIpcServer({ platform: 'linux', socketPath, log: () => {} });
    // No listen() call — close() must be a no-op.
    await expect(transport.close()).resolves.toBeUndefined();
  });
});

describe('createIpcServer (Windows / W-B)', () => {
  // The Windows backend delegates to `discovery-file.js`. The full
  // happy-path of `writeDiscoveryFileAtomic` is exercised by
  // `discovery-file.test.js`; here we test the transport-factory
  // surface and the ordering invariants.

  it('requires portPath on Windows', () => {
    expect(() => createIpcServer({ platform: 'win32' })).toThrow(/Windows portPath is required/);
  });

  it('publishes the discovery file before listen() resolves and dials succeed', async () => {
    // Force the platform to win32 (we're running on Linux CI).
    const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    const dir = mkTmp('ipc-transport-win32');
    const portPath = path.join(dir, 'port');
    const username = 'alice';

    const transport = createIpcServer({
      platform: 'win32',
      portPath,
      username,
      aclInspector,
      log: () => {},
    });
    expect(typeof transport.listen).toBe('function');
    expect(typeof transport.close).toBe('function');

    try {
      let receivedSocket = null;
      await transport.listen({
        onRequest: (socket) => {
          receivedSocket = socket;
        },
      });

      // Discovery file was published before listen() resolved.
      expect(fs.existsSync(portPath)).toBe(true);
      const body = fs.readFileSync(portPath, 'utf8');
      const m = body.match(/^127\.0\.0\.1:(\d+)\n$/);
      expect(m).not.toBeNull();
      const port = Number.parseInt(m[1], 10);
      expect(Number.isInteger(port) && port > 0 && port <= 65535).toBe(true);

      // A client can dial the published port via the discovery file.
      const client = net.createConnection({ host: '127.0.0.1', port });
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => { client.destroy(); reject(new Error('dial timeout')); }, 2000);
        client.on('connect', () => { clearTimeout(t); client.end(); client.destroy(); resolve(); });
        client.on('error', (err) => { clearTimeout(t); reject(err); });
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(receivedSocket).not.toBeNull();
    } finally {
      await transport.close();
      // Discovery file is removed last (after listener closes).
      expect(fs.existsSync(portPath)).toBe(false);
      if (originalPlatformDescriptor) {
        Object.defineProperty(process, 'platform', originalPlatformDescriptor);
      } else {
        delete process.platform;
      }
    }
  });

  it('removes the discovery file only after the listener has closed (F-6 ordering)', async () => {
    const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    const dir = mkTmp('ipc-transport-win32-order');
    const portPath = path.join(dir, 'port');
    const transport = createIpcServer({
      platform: 'win32', portPath, username: 'alice', aclInspector, log: () => {},
    });

    try {
      await transport.listen({ onRequest: () => {} });
      // The discovery file is present after listen resolves.
      expect(fs.existsSync(portPath)).toBe(true);
      await transport.close();
      // After close resolves, the file is gone.
      expect(fs.existsSync(portPath)).toBe(false);
    } finally {
      if (originalPlatformDescriptor) {
        Object.defineProperty(process, 'platform', originalPlatformDescriptor);
      } else {
        delete process.platform;
      }
    }
  });

  it('propagates writeDiscoveryFileAtomic failure without leaving a listener', async () => {
    const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    // Pre-create a lock file so the publish sequence aborts.
    const dir = mkTmp('ipc-transport-win32-acl-fail');
    const portPath = path.join(dir, 'port');
    fs.writeFileSync(`${portPath}.lock`, '');

    const transport = createIpcServer({
      platform: 'win32', portPath, username: 'alice', aclInspector, log: () => {},
    });

    try {
      await expect(transport.listen({ onRequest: () => {} })).rejects.toThrow(/lock held/);
      // No discovery file was published.
      expect(fs.existsSync(portPath)).toBe(false);
    } finally {
      try { fs.unlinkSync(`${portPath}.lock`); } catch { /* ignore */ }
      await transport.close();
      if (originalPlatformDescriptor) {
        Object.defineProperty(process, 'platform', originalPlatformDescriptor);
      } else {
        delete process.platform;
      }
    }
  });

  it('close() on an idle (never-listened) Windows transport resolves immediately', async () => {
    const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    const dir = mkTmp('ipc-transport-win32-idle');
    const portPath = path.join(dir, 'port');
    const transport = createIpcServer({
      platform: 'win32', portPath, username: 'alice', aclInspector, log: () => {},
    });
    try {
      await expect(transport.close()).resolves.toBeUndefined();
    } finally {
      if (originalPlatformDescriptor) {
        Object.defineProperty(process, 'platform', originalPlatformDescriptor);
      } else {
        delete process.platform;
      }
    }
  });
});

describe('createIpcDialer (POSIX)', () => {
  // Unix-domain sockets are not supported on Windows; the equivalent
  // Windows tests are in their own describe block above. Without
  // this gate, `server.listen(socketPath)` never resolves on Windows
  // and the test times out at the vitest default.
  it.skipIf(process.platform === 'win32')('linux: returns a function that dials the Unix socket', async () => {
    const root = mkTmp();
    const { socketPath } = defaultIpcPaths({ platform: 'linux', rootDir: root });
    // Pre-create a dummy socket so `net.createConnection` succeeds.
    const server = net.createServer();
    await new Promise((resolve) => server.listen(socketPath, resolve));
    try {
      const dial = createIpcDialer({ platform: 'linux', socketPath });
      expect(typeof dial).toBe('function');
      const sock = dial();
      // The connection is async; we await `connect` so the test is
      // deterministic.
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('dial timeout')), 2000);
        sock.once('connect', () => { clearTimeout(t); sock.destroy(); resolve(); });
        sock.once('error', (err) => { clearTimeout(t); reject(err); });
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
      try { fs.unlinkSync(socketPath); } catch { /* ignore */ }
    }
  });

  it('throws when POSIX socketPath is missing', () => {
    expect(() => createIpcDialer({ platform: 'linux' })).toThrow(/POSIX socketPath is required/);
  });
});

describe('createIpcDialer (Windows / W-B)', () => {
  it('win32: does not throw on construction when portPath is provided', () => {
    expect(() => createIpcDialer({
      platform: 'win32',
      portPath: '/nonexistent/port',
    })).not.toThrow();
  });

  it('win32: dialing surfaces an error at call time (file missing / wrong platform)', async () => {
    const dial = createIpcDialer({
      platform: 'win32',
      portPath: '/nonexistent/port',
    });
    // On non-Windows CI, the platform check in `discovery-file.js`
    // fires first and surfaces a "Windows-only" error. Either error
    // is acceptable per the W-A spec: the contract is "construction
    // does not throw, dial surfaces the failure".
    await expect(dial()).rejects.toThrow();
  });

  it('win32: dialer dials 127.0.0.1:<port> from a published discovery file', async () => {
    const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    const dir = mkTmp('ipc-transport-dialer-win32');
    const portPath = path.join(dir, 'port');

    // Stand up a real loopback TCP server, then publish a matching
    // discovery file. The dialer must read the port from the file
    // and dial it.
    const server = net.createServer();
    await new Promise((resolve) => server.listen({ host: '127.0.0.1', port: 0 }, resolve));
    const port = server.address().port;
    fs.writeFileSync(portPath, `127.0.0.1:${port}\n`);

    try {
      const dial = createIpcDialer({
        platform: 'win32',
        portPath,
        username: 'alice',
        aclInspector: () => ({ entries: [{ principal: 'alice', rights: ['F'] }] }),
      });
      const sock = await dial();
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => { sock.destroy(); reject(new Error('dial timeout')); }, 2000);
        sock.once('connect', () => { clearTimeout(t); sock.destroy(); resolve(); });
        sock.once('error', (err) => { clearTimeout(t); reject(err); });
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
      try { fs.unlinkSync(portPath); } catch { /* ignore */ }
      if (originalPlatformDescriptor) {
        Object.defineProperty(process, 'platform', originalPlatformDescriptor);
      } else {
        delete process.platform;
      }
    }
  });

  it('win32: dialer throws on a malformed discovery file', async () => {
    const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    const dir = mkTmp('ipc-transport-dialer-malformed');
    const portPath = path.join(dir, 'port');
    fs.writeFileSync(portPath, 'not-a-port\n');
    try {
      const dial = createIpcDialer({ platform: 'win32', portPath });
      await expect(dial()).rejects.toThrow();
    } finally {
      try { fs.unlinkSync(portPath); } catch { /* ignore */ }
      if (originalPlatformDescriptor) {
        Object.defineProperty(process, 'platform', originalPlatformDescriptor);
      } else {
        delete process.platform;
      }
    }
  });
});
