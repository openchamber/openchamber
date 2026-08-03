import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fork, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as windowsAcl from './windows-acl.js';
import { removeFileByIdentity, writeDiscoveryFileAtomic } from './discovery-file.js';
import {
  createIpcDialer,
  createIpcServer,
  defaultIpcPaths,
  recoverStaleGuardianTransportArtifacts,
} from './ipc-transport.js';
import { snapshotFileIdentity } from './file-identity.js';

let tmpDirs = [];
const aclInspector = () => ({ entries: [{ principal: 'alice', rights: ['F'] }] });
const HELPER_PATH = fileURLToPath(new URL('./ipc-listener-helper.js', import.meta.url));

const mkTmp = (label = 'ipc-transport') => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `openchamber-${label}-`));
  tmpDirs.push(dir);
  return dir;
};

const createCrashedSocket = async (socketPath) => {
  const child = spawn(process.execPath, [
    '--input-type=module',
    '-e',
    `import net from 'node:net'; const server = net.createServer(); server.listen(${JSON.stringify(socketPath)}, '127.0.0.1');`,
  ], { stdio: 'ignore' });
  for (let attempt = 0; attempt < 100 && !fs.existsSync(socketPath); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  fs.linkSync(socketPath, `${socketPath}.owner`);
  child.kill('SIGKILL');
  await new Promise((resolve) => child.once('exit', resolve));
};

const startListenerHelper = async (socketPath) => {
  const helperProcessOptions = process.versions?.bun
    ? { execPath: 'node', env: { PATH: process.env.PATH || '/usr/bin:/bin' } }
    : { execPath: process.execPath, env: {} };
  const child = fork(HELPER_PATH, [], {
    env: helperProcessOptions.env,
    execArgv: [],
    execPath: helperProcessOptions.execPath,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  await new Promise((resolve, reject) => {
    let tokenHandle = null;
    let tokenBuffer = '';
    const tokenMarker = (token) => `guardian-ipc-publication-handle:${token}\n`;
    const tokenAccept = (token) => `guardian-ipc-publication-accept:${token}\n`;
    const tokenCommit = (token) => `guardian-ipc-publication-commit:${token}\n`;
    const tokenCommitAck = (token) => `guardian-ipc-publication-commit-ack:${token}\n`;
    const tokenCommitConfirm = (token) => `guardian-ipc-publication-commit-confirm:${token}\n`;
    const onMessage = (message, handle) => {
      if (message?.type === 'ready-candidate') {
        tokenHandle = handle;
        const onCandidateData = (chunk) => {
          tokenBuffer += chunk.toString();
          if (!tokenBuffer.includes(tokenMarker(message.publicationToken))) return;
          tokenBuffer = '';
          tokenHandle.off('data', onCandidateData);
          tokenHandle.pause();
          child.send({
            type: 'accept-ready',
            publicationToken: message.publicationToken,
          });
        };
        tokenHandle.on('data', onCandidateData);
        tokenHandle.resume();
        child.send({
          type: 'publication-handle-ready',
          publicationToken: message.publicationToken,
        });
      } else if (message?.type === 'ready') {
        const onCommit = (chunk) => {
          tokenBuffer += chunk.toString();
          if (!tokenBuffer.includes(tokenCommit(message.publicationToken))) return;
          tokenBuffer = '';
          tokenHandle.off('data', onCommit);
          const onConfirm = (confirmChunk) => {
            tokenBuffer += confirmChunk.toString();
            if (!tokenBuffer.includes(tokenCommitConfirm(message.publicationToken))) return;
            tokenHandle.destroy();
            resolve();
          };
          tokenHandle.on('data', onConfirm);
          tokenHandle.write(tokenCommitAck(message.publicationToken));
        };
        tokenHandle.on('data', onCommit);
        tokenHandle.resume();
        tokenHandle.write(tokenAccept(message.publicationToken));
      } else if (message?.type === 'error') reject(new Error(`helper failed: ${message.code}`));
    };
    child.on('message', onMessage);
    child.once('error', reject);
    child.send({ type: 'listen', socketPath });
  });
  return child;
};

const waitForChildExit = (child) => new Promise((resolve) => {
  if (child.exitCode !== null || child.signalCode !== null) {
    resolve();
    return;
  }
  child.once('exit', resolve);
});

const staleGuardianMarker = (root, token, socketPath = path.join(root, 'guardian.sock')) => {
  let transportIdentity = null;
  try {
    const publicIdentity = snapshotFileIdentity(fs.lstatSync(socketPath));
    const ownerIdentity = snapshotFileIdentity(fs.lstatSync(`${socketPath}.owner`));
    if (publicIdentity && ownerIdentity) {
      transportIdentity = { publicIdentity, ownerIdentity };
    }
  } catch {
    // The caller may be constructing a marker before transport publication.
  }
  return {
    status: 'valid',
    token,
    pid: 42420,
    identity: {
      processStartTicks: '10',
      launch: { commandLine: 'node openchamber-guardian.js', cwd: root },
      owner: '1000',
    },
    transportIdentity,
  };
};

const ctimeOnlyStat = (stat) => Object.assign(
  Object.create(Object.getPrototypeOf(stat)),
  stat,
  {
    birthtime: undefined,
    birthtimeNs: undefined,
    birthtimeMs: undefined,
    ctime: undefined,
    ctimeNs: undefined,
    ctimeMs: Math.trunc(Number(stat.ctimeMs)),
  },
);

const createCtimeFakeForkProcess = () => {
  const helpers = [];
  const createPublicationHandle = (token) => {
    const handle = new net.Socket();
    handle.write = (value, callback) => {
      if (String(value).startsWith('guardian-ipc-publication-accept:')) {
        queueMicrotask(() => handle.emit(
          'data',
          Buffer.from(`guardian-ipc-publication-commit:${token}\n`),
        ));
      } else if (String(value).startsWith('guardian-ipc-publication-commit-ack:')) {
        queueMicrotask(() => handle.emit(
          'data',
          Buffer.from(`guardian-ipc-publication-commit-confirm:${token}\n`),
        ));
      }
      callback?.();
      return true;
    };
    handle.destroy = vi.fn(() => handle);
    return handle;
  };
  const forkProcess = () => {
    const child = new EventEmitter();
    child.connected = true;
    child.exitCode = null;
    child.signalCode = null;
    child.kill = vi.fn(() => {
      child.connected = false;
      child.signalCode = 'SIGKILL';
      queueMicrotask(() => {
        child.emit('exit', null, 'SIGKILL');
        child.emit('close', null, 'SIGKILL');
      });
    });
    child.send = (message, callback) => {
      if (message?.type === 'listen') {
        const server = net.createServer();
        child.server = server;
        child.socketPath = message.socketPath;
        const ownerPath = `${message.socketPath}.owner`;
        server.listen(ownerPath, () => {
          fs.chmodSync(ownerPath, 0o600);
          fs.linkSync(ownerPath, message.socketPath);
           const publicIdentity = snapshotFileIdentity(fs.lstatSync(message.socketPath));
           const ownerIdentity = snapshotFileIdentity(fs.lstatSync(ownerPath));
           const listenerIdentity = snapshotFileIdentity(fs.fstatSync(server._handle.fd));
            const publicationToken = 'a'.repeat(64);
            const publicationHandle = createPublicationHandle(publicationToken);
            child.publicationHandle = publicationHandle;
            const publicationProof = {
             token: publicationToken,
             listenerIdentity,
             boundPathIdentity: ownerIdentity,
             descriptorIdentity: ownerIdentity,
             publicIdentity,
             ownerIdentity,
           };
            child.emit('message', {
              type: 'ready-candidate',
              publicationHandle: 'accepted-probe',
              publicationToken,
              publicationProof,
            }, publicationHandle);
            callback?.();
         });
         return true;
        }
        if (message?.type === 'publication-handle-ready') {
          queueMicrotask(() => child.publicationHandle?.emit(
            'data',
            Buffer.from(`guardian-ipc-publication-handle:${message.publicationToken}\n`),
          ));
          callback?.();
          return true;
        }
        if (message?.type === 'accept-ready') {
         const publicationToken = message.publicationToken;
         const publicIdentity = snapshotFileIdentity(fs.lstatSync(child.socketPath));
         const ownerIdentity = snapshotFileIdentity(fs.lstatSync(`${child.socketPath}.owner`));
         const listenerIdentity = snapshotFileIdentity(fs.fstatSync(child.server._handle.fd));
         child.emit('message', {
           type: 'ready',
           publicationToken,
           publicationProof: {
             token: publicationToken,
             listenerIdentity,
             boundPathIdentity: ownerIdentity,
             descriptorIdentity: ownerIdentity,
             publicIdentity,
             ownerIdentity,
           },
         });
         callback?.();
         return true;
       }
       if (message?.type === 'shutdown') {
        callback?.();
        child.connected = false;
        if (child.socketPath && fs.existsSync(`${child.socketPath}.owner`)) {
          fs.unlinkSync(`${child.socketPath}.owner`);
          fs.linkSync(child.socketPath, `${child.socketPath}.owner`);
        } else if (child.socketPath && !fs.existsSync(`${child.socketPath}.owner`)) {
          fs.linkSync(child.socketPath, `${child.socketPath}.owner`);
        } else if (child.socketPath && !fs.existsSync(child.socketPath)) {
          fs.linkSync(`${child.socketPath}.owner`, child.socketPath);
        }
        const closedPublicIdentity = snapshotFileIdentity(fs.lstatSync(child.socketPath));
        const closedOwnerIdentity = snapshotFileIdentity(fs.lstatSync(`${child.socketPath}.owner`));
        child.emit('message', {
          type: 'closed',
          descriptorIdentity: closedOwnerIdentity,
          publicIdentity: closedPublicIdentity,
          ownerIdentity: closedOwnerIdentity,
        });
        child.server = null;
        child.exitCode = 0;
        queueMicrotask(() => {
          child.emit('exit', 0, null);
          child.emit('close', 0, null);
        });
      }
      return true;
    };
    helpers.push(child);
    return child;
  };
  return { forkProcess, helpers };
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
  it.skipIf(process.platform === 'win32')('helper crash leaves an identity-checked stale socket for recovery', async () => {
    const root = mkTmp('ipc-listener-helper-crash');
    const { socketPath } = defaultIpcPaths({ platform: 'linux', rootDir: root });
    const child = await startListenerHelper(socketPath);

    try {
      expect(fs.lstatSync(socketPath).isSocket()).toBe(true);
      const exited = waitForChildExit(child);
      child.kill('SIGKILL');
      await exited;
      expect(fs.lstatSync(socketPath).isSocket()).toBe(true);

      recoverStaleGuardianTransportArtifacts({
        platform: 'linux',
        socketPath,
        priorMarker: staleGuardianMarker(root, 'helper-crash-marker', socketPath),
        liveness: () => 'dead',
      });
      expect(fs.existsSync(socketPath)).toBe(false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await waitForChildExit(child);
      }
    }
  });

  it.skipIf(process.platform === 'win32')('helper exits on parent IPC disconnect without unlinking its socket', async () => {
    const root = mkTmp('ipc-listener-helper-disconnect');
    const { socketPath } = defaultIpcPaths({ platform: 'linux', rootDir: root });
    const child = await startListenerHelper(socketPath);

    try {
      const exited = waitForChildExit(child);
      child.disconnect();
      await exited;
      expect(fs.lstatSync(socketPath).isSocket()).toBe(true);
      recoverStaleGuardianTransportArtifacts({
        platform: 'linux',
        socketPath,
        priorMarker: staleGuardianMarker(root, 'helper-disconnect-marker', socketPath),
        liveness: () => 'dead',
      });
      expect(fs.existsSync(socketPath)).toBe(false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await waitForChildExit(child);
      }
    }
  });

  it.skipIf(process.platform === 'win32' || Boolean(process.versions?.bun))('linux backend: listens on a Unix socket, forwards a real socket, and unlinks on close', async () => {
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

    // The public entry is a private Unix socket. The helper binds its listener
    // on the private owner pathname and atomically hard-links the public name;
    // both identities are the proof used by close/recovery.
    const stat = fs.statSync(socketPath);
    expect(stat.isSocket()).toBe(true);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(fs.lstatSync(`${socketPath}.owner`).isSocket()).toBe(true);
    expect(fs.statSync(`${socketPath}.owner`).ino).toBe(stat.ino);

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
        setTimeout(() => {
          client.end();
          client.destroy();
          resolve();
        }, 50);
      });
      client.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    // Forwarding a net.Socket over a child-process IPC channel takes more
    // than one parent event-loop turn under Node and Bun.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(receivedSocket).not.toBeNull();

    await transport.close();
    // After close, the socket file is unlinked on POSIX.
    expect(fs.existsSync(socketPath)).toBe(false);
    expect(fs.existsSync(`${socketPath}.owner`)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('fails closed for a replacement present before quarantine', async () => {
    const root = mkTmp('ipc-transport-posix-replacement-before-quarantine');
    const { socketPath } = defaultIpcPaths({ platform: 'linux', rootDir: root });
    const transport = createIpcServer({ platform: 'linux', socketPath, log: () => {} });
    const closeSpy = vi.spyOn(net.Server.prototype, 'close');
    await transport.listen({ onRequest: () => {} });
    fs.unlinkSync(socketPath);
    fs.writeFileSync(socketPath, 'replacement-before-quarantine');

    try {
      await expect(transport.close()).rejects.toMatchObject({
        code: 'GUARDIAN_TRANSPORT_CLEANUP_UNCERTAIN',
        artifact: 'POSIX guardian socket',
      });
      expect(closeSpy).not.toHaveBeenCalled();
      expect(fs.readFileSync(socketPath, 'utf8')).toBe('replacement-before-quarantine');
    } finally {
      closeSpy.mockRestore();
      fs.unlinkSync(socketPath);
    }

    // The public path was removed outside the transport. The surviving owner
    // alias is not enough to prove that the public pathname is safe to clean,
    // so close remains fail-closed and retains authority.
    await expect(transport.close()).rejects.toMatchObject({
      code: 'GUARDIAN_TRANSPORT_CLEANUP_UNCERTAIN',
    });
  });

  it.skipIf(process.platform === 'win32')('preserves a replacement that wins the quarantine rename race', async () => {
    const root = mkTmp('ipc-transport-posix-replacement-quarantine-race');
    const { socketPath } = defaultIpcPaths({ platform: 'linux', rootDir: root });
    const transport = createIpcServer({ platform: 'linux', socketPath, log: () => {} });
    const closeSpy = vi.spyOn(net.Server.prototype, 'close');
    const realRenameSync = fs.renameSync.bind(fs);
    let replaced = false;
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation((source, destination, ...args) => {
      if (source === socketPath && !replaced) {
        replaced = true;
        fs.unlinkSync(socketPath);
        fs.writeFileSync(socketPath, 'replacement-quarantine-race');
      }
      return realRenameSync(source, destination, ...args);
    });
    await transport.listen({ onRequest: () => {} });

    try {
      await expect(transport.close()).rejects.toMatchObject({
        code: 'GUARDIAN_TRANSPORT_CLEANUP_UNCERTAIN',
        artifact: 'POSIX guardian socket',
      });
      expect(closeSpy).not.toHaveBeenCalled();
      expect(fs.readFileSync(socketPath, 'utf8')).toBe('replacement-quarantine-race');
    } finally {
      renameSpy.mockRestore();
      closeSpy.mockRestore();
      fs.unlinkSync(socketPath);
    }

    await expect(transport.close()).rejects.toMatchObject({
      code: 'GUARDIAN_TRANSPORT_CLEANUP_UNCERTAIN',
    });
  });

  it.skipIf(process.platform === 'win32')('fails closed for a replacement during helper shutdown cleanup', async () => {
    const root = mkTmp('ipc-transport-posix-replacement-during-helper-shutdown');
    const { socketPath } = defaultIpcPaths({ platform: 'linux', rootDir: root });
    const transport = createIpcServer({ platform: 'linux', socketPath, log: () => {} });
    let replaceOnCleanup = false;
    let replaced = false;
    const realLstatSync = fs.lstatSync.bind(fs);
    const lstatSpy = vi.spyOn(fs, 'lstatSync').mockImplementation((target, ...args) => {
      if (target === socketPath && replaceOnCleanup && !replaced) {
        replaced = true;
        fs.unlinkSync(socketPath);
        fs.writeFileSync(socketPath, 'replacement-during-helper-shutdown');
      }
      return realLstatSync(target, ...args);
    });
    await transport.listen({ onRequest: () => {} });
    replaceOnCleanup = true;

    try {
      await expect(transport.close()).rejects.toMatchObject({
        code: 'GUARDIAN_TRANSPORT_CLEANUP_UNCERTAIN',
        artifact: 'POSIX guardian socket',
      });
      expect(replaced).toBe(true);
      expect(fs.readFileSync(socketPath, 'utf8')).toBe('replacement-during-helper-shutdown');
    } finally {
      lstatSpy.mockRestore();
      try { fs.unlinkSync(socketPath); } catch { /* cleanup */ }
    }

    await expect(transport.close()).rejects.toMatchObject({
      code: 'GUARDIAN_TRANSPORT_CLEANUP_UNCERTAIN',
    });
  });

  it.skipIf(process.platform === 'win32')('retains a replacement after helper shutdown', async () => {
    const root = mkTmp('ipc-transport-posix-replacement-after-helper-shutdown');
    const { socketPath } = defaultIpcPaths({ platform: 'linux', rootDir: root });
    const transport = createIpcServer({ platform: 'linux', socketPath, log: () => {} });
    let replaceOnCleanup = false;
    let replaced = false;
    const realLstatSync = fs.lstatSync.bind(fs);
    const lstatSpy = vi.spyOn(fs, 'lstatSync').mockImplementation((target, ...args) => {
      if (target === socketPath && replaceOnCleanup && !replaced) {
        replaced = true;
        fs.unlinkSync(socketPath);
        fs.writeFileSync(socketPath, 'replacement-after-helper-shutdown');
      }
      return realLstatSync(target, ...args);
    });
    await transport.listen({ onRequest: () => {} });
    replaceOnCleanup = true;

    try {
      await expect(transport.close()).rejects.toMatchObject({
        code: 'GUARDIAN_TRANSPORT_CLEANUP_UNCERTAIN',
        artifact: 'POSIX guardian socket',
      });
      expect(replaced).toBe(true);
      expect(fs.readFileSync(socketPath, 'utf8')).toBe('replacement-after-helper-shutdown');
    } finally {
      lstatSpy.mockRestore();
      try { fs.unlinkSync(socketPath); } catch { /* cleanup */ }
    }

    await expect(transport.close()).rejects.toMatchObject({
      code: 'GUARDIAN_TRANSPORT_CLEANUP_UNCERTAIN',
    });
  });

  it.skipIf(process.platform === 'win32')('rejects cleanup uncertainty, then converges on retry', async () => {
    const root = mkTmp('ipc-transport-posix-cleanup-retry');
    const { socketPath } = defaultIpcPaths({ platform: 'linux', rootDir: root });
    const transport = createIpcServer({ platform: 'linux', socketPath, log: () => {} });
    await transport.listen({ onRequest: () => {} });

    const unlinkSync = fs.unlinkSync.bind(fs);
    const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((target, ...args) => {
      if (typeof target === 'string' && target.endsWith('.remove')) {
        throw Object.assign(new Error('POSIX quarantine unlink denied'), { code: 'EACCES' });
      }
      return unlinkSync(target, ...args);
    });

    try {
      await expect(transport.close()).rejects.toMatchObject({
        code: 'GUARDIAN_TRANSPORT_CLEANUP_UNCERTAIN',
        message: 'Guardian IPC transport cleanup failed',
        artifact: 'POSIX guardian socket',
      });
      expect(unlinkSpy).toHaveBeenCalledWith(expect.stringContaining('.remove'));
      // A failed quarantine unlink restores the original socket entry. The
      // next close retry owns that same identity and removes it.
      expect(fs.existsSync(socketPath)).toBe(true);
      expect(fs.readdirSync(root).some((entry) => entry.endsWith('.remove'))).toBe(true);
    } finally {
      unlinkSpy.mockRestore();
    }

    await expect(transport.close()).resolves.toBeUndefined();
    expect(fs.existsSync(socketPath)).toBe(false);
    expect(fs.readdirSync(root).filter((entry) => entry.endsWith('.remove'))).toHaveLength(0);
  });

  it.skipIf(process.platform === 'win32')('normal close propagates ctime-only pair identity after each mutation', async () => {
    const root = mkTmp('ipc-transport-posix-ctime-pair-close');
    const { socketPath } = defaultIpcPaths({ platform: 'linux', rootDir: root });
    const realLstatSync = fs.lstatSync.bind(fs);
    const realFstatSync = fs.fstatSync.bind(fs);
    const lstatSpy = vi.spyOn(fs, 'lstatSync').mockImplementation((target, ...args) => (
      ctimeOnlyStat(realLstatSync(target, ...args))
    ));
    const fstatSpy = vi.spyOn(fs, 'fstatSync').mockImplementation((target, ...args) => (
      ctimeOnlyStat(realFstatSync(target, ...args))
    ));
    const { forkProcess } = createCtimeFakeForkProcess();
    const transport = createIpcServer({
      platform: 'linux',
      socketPath,
      forkProcess,
      log: () => {},
    });

    try {
      await transport.listen({ onRequest: () => {} });
      await expect(transport.close()).resolves.toBeUndefined();
      expect(fs.existsSync(socketPath)).toBe(false);
      expect(fs.existsSync(`${socketPath}.owner`)).toBe(false);
    } finally {
      fstatSpy.mockRestore();
      lstatSpy.mockRestore();
    }
  });

  it.skipIf(process.platform === 'win32')('rejects a ctime-only sibling replacement during Linux pair refresh', async () => {
    const root = mkTmp('ipc-transport-posix-ctime-sibling-replacement');
    const { socketPath } = defaultIpcPaths({ platform: 'linux', rootDir: root });
    const realLstatSync = fs.lstatSync.bind(fs);
    const realFstatSync = fs.fstatSync.bind(fs);
    const lstatSpy = vi.spyOn(fs, 'lstatSync').mockImplementation((target, ...args) => (
      ctimeOnlyStat(realLstatSync(target, ...args))
    ));
    const fstatSpy = vi.spyOn(fs, 'fstatSync').mockImplementation((target, ...args) => (
      ctimeOnlyStat(realFstatSync(target, ...args))
    ));
    const realRenameSync = fs.renameSync.bind(fs);
    let publicQuarantined = false;
    let injected = false;
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation((source, destination, ...args) => {
      const result = realRenameSync(source, destination, ...args);
      if (source === socketPath && destination.endsWith('.remove')) publicQuarantined = true;
      return result;
    });
    const siblingSpy = vi.spyOn(fs, 'lstatSync').mockImplementation((target, ...args) => {
      const stat = ctimeOnlyStat(realLstatSync(target, ...args));
      if (target === `${socketPath}.owner` && publicQuarantined && !injected) {
        injected = true;
        return Object.assign(stat, { ctimeMs: Number(stat.ctimeMs) + 1 });
      }
      return stat;
    });
    const { forkProcess } = createCtimeFakeForkProcess();
    const transport = createIpcServer({
      platform: 'linux',
      socketPath,
      forkProcess,
      log: () => {},
    });

    try {
      await transport.listen({ onRequest: () => {} });
      await expect(transport.close()).rejects.toMatchObject({
        code: 'GUARDIAN_TRANSPORT_CLEANUP_UNCERTAIN',
      });
      expect(injected).toBe(true);
      expect(fs.lstatSync(socketPath).isSocket()).toBe(true);
      expect(fs.lstatSync(`${socketPath}.owner`).isSocket()).toBe(true);
    } finally {
      await transport.close().catch(() => {});
      siblingSpy.mockRestore();
      renameSpy.mockRestore();
      fstatSpy.mockRestore();
      lstatSpy.mockRestore();
    }

    expect(fs.existsSync(socketPath)).toBe(false);
    expect(fs.existsSync(`${socketPath}.owner`)).toBe(false);
    expect(fs.readdirSync(root).filter((entry) => entry.endsWith('.remove'))).toHaveLength(0);
  });

  it.skipIf(process.platform === 'win32')('retains a non-Linux ctime-only publication without cleanup authority', async () => {
    const root = mkTmp('ipc-transport-posix-ctime-nonlinux');
    const { socketPath } = defaultIpcPaths({ platform: 'darwin', rootDir: root });
    const realLstatSync = fs.lstatSync.bind(fs);
    const realFstatSync = fs.fstatSync.bind(fs);
    const lstatSpy = vi.spyOn(fs, 'lstatSync').mockImplementation((target, ...args) => (
      ctimeOnlyStat(realLstatSync(target, ...args))
    ));
    const fstatSpy = vi.spyOn(fs, 'fstatSync').mockImplementation((target, ...args) => (
      ctimeOnlyStat(realFstatSync(target, ...args))
    ));
    const { forkProcess, helpers } = createCtimeFakeForkProcess();
    const transport = createIpcServer({
      platform: 'darwin',
      socketPath,
      forkProcess,
      log: () => {},
    });

    try {
      await expect(transport.listen({ onRequest: () => {} })).rejects.toMatchObject({
        code: 'GUARDIAN_TRANSPORT_CLEANUP_UNCERTAIN',
      });
      expect(fs.lstatSync(socketPath).isSocket()).toBe(true);
      expect(fs.lstatSync(`${socketPath}.owner`).isSocket()).toBe(true);
      await expect(transport.close()).rejects.toMatchObject({
        code: 'GUARDIAN_TRANSPORT_CLEANUP_UNCERTAIN',
      });
    } finally {
      for (const helper of helpers) {
        try { helper.server?.close?.(); } catch { /* test cleanup */ }
      }
      fstatSpy.mockRestore();
      lstatSpy.mockRestore();
    }
  });

  it.skipIf(process.platform === 'win32')('retries a ctime-only hard-linked pair after a transient owner cleanup failure', async () => {
    const root = mkTmp('ipc-transport-posix-ctime-pair-retry');
    const { socketPath } = defaultIpcPaths({ platform: 'linux', rootDir: root });
    const ownerPath = `${socketPath}.owner`;
    let ctimeGeneration = 0;
    const realLstatSync = fs.lstatSync.bind(fs);
    const realFstatSync = fs.fstatSync.bind(fs);
    const lstatSpy = vi.spyOn(fs, 'lstatSync').mockImplementation((target, ...args) => (
      Object.assign(ctimeOnlyStat(realLstatSync(target, ...args)), {
        ctimeMs: 10_000 + ctimeGeneration,
      })
    ));
    const fstatSpy = vi.spyOn(fs, 'fstatSync').mockImplementation((target, ...args) => (
      Object.assign(ctimeOnlyStat(realFstatSync(target, ...args)), {
        ctimeMs: 10_000 + ctimeGeneration,
      })
    ));
    const realLinkSync = fs.linkSync.bind(fs);
    const linkSpy = vi.spyOn(fs, 'linkSync').mockImplementation((source, destination, ...args) => {
      const result = realLinkSync(source, destination, ...args);
      ctimeGeneration += 1;
      return result;
    });
    const realRenameSync = fs.renameSync.bind(fs);
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation((source, destination, ...args) => {
      const result = realRenameSync(source, destination, ...args);
      ctimeGeneration += 1;
      return result;
    });
    const realUnlinkSync = fs.unlinkSync.bind(fs);
    const ownerQuarantinePrefix = `.${path.basename(ownerPath)}.`;
    let deniedUnlinks = 0;
    let unlinkSpyRestored = false;
    const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((target, ...args) => {
      if (
        deniedUnlinks < 2
        && typeof target === 'string'
        && path.basename(target).startsWith(ownerQuarantinePrefix)
      ) {
        deniedUnlinks += 1;
        throw Object.assign(new Error('ctime-only owner cleanup denied twice'), { code: 'EACCES' });
      }
      const result = realUnlinkSync(target, ...args);
      ctimeGeneration += 1;
      return result;
    });
    const { forkProcess } = createCtimeFakeForkProcess();
    const transport = createIpcServer({
      platform: 'linux',
      socketPath,
      forkProcess,
      log: () => {},
    });

    try {
      await transport.listen({ onRequest: () => {} });
      const beforeFirstClose = ctimeGeneration;
      await expect(transport.close()).rejects.toMatchObject({
        code: 'GUARDIAN_TRANSPORT_CLEANUP_UNCERTAIN',
      });
      expect(fs.existsSync(socketPath)).toBe(true);
      expect(fs.existsSync(ownerPath)).toBe(true);
      expect(deniedUnlinks).toBe(2);
      expect(fs.readdirSync(root).filter((entry) => entry.endsWith('.remove'))).not.toHaveLength(0);
      expect(ctimeGeneration).toBeGreaterThan(beforeFirstClose);
      unlinkSpy.mockRestore();
      unlinkSpyRestored = true;
      const beforeSecondClose = ctimeGeneration;
      await expect(transport.close()).resolves.toBeUndefined();
      expect(fs.existsSync(socketPath)).toBe(false);
      expect(fs.existsSync(ownerPath)).toBe(false);
      expect(fs.readdirSync(root).filter((entry) => entry.endsWith('.remove'))).toHaveLength(0);
      expect(ctimeGeneration).toBeGreaterThan(beforeSecondClose);
    } finally {
      if (!unlinkSpyRestored) unlinkSpy.mockRestore();
      renameSpy.mockRestore();
      linkSpy.mockRestore();
      fstatSpy.mockRestore();
      lstatSpy.mockRestore();
    }
  });

  it.skipIf(process.platform === 'win32')('does not let a sibling pathname overwrite descriptor identity during refresh', async () => {
    const root = mkTmp('ipc-transport-posix-sibling-refresh-fence');
    const { socketPath } = defaultIpcPaths({ platform: 'linux', rootDir: root });
    const ownerPath = `${socketPath}.owner`;
    const transport = createIpcServer({ platform: 'linux', socketPath, log: () => {} });
    await transport.listen({ onRequest: () => {} });

    const realLstatSync = fs.lstatSync.bind(fs);
    const realRenameSync = fs.renameSync.bind(fs);
    let publicQuarantined = false;
    let injected = false;
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation((source, destination, ...args) => {
      const result = realRenameSync(source, destination, ...args);
      if (source === socketPath && destination.endsWith('.remove')) publicQuarantined = true;
      return result;
    });
    const lstatSpy = vi.spyOn(fs, 'lstatSync').mockImplementation((target, ...args) => {
      const stat = realLstatSync(target, ...args);
      if (target === ownerPath && publicQuarantined && !injected) {
        injected = true;
        return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, {
          dev: `${stat.dev}:sibling-replacement`,
          ino: `${stat.ino}:sibling-replacement`,
        });
      }
      return stat;
    });

    try {
      await expect(transport.close()).rejects.toMatchObject({
        code: 'GUARDIAN_TRANSPORT_CLEANUP_UNCERTAIN',
      });
      expect(injected).toBe(true);
      expect(fs.lstatSync(socketPath).isSocket()).toBe(true);
      expect(fs.lstatSync(ownerPath).isSocket()).toBe(true);
      expect(fs.statSync(socketPath).ino).toBe(fs.statSync(ownerPath).ino);
    } finally {
      lstatSpy.mockRestore();
      renameSpy.mockRestore();
    }

    await expect(transport.close()).resolves.toBeUndefined();
    expect(fs.existsSync(socketPath)).toBe(false);
    expect(fs.existsSync(ownerPath)).toBe(false);
    expect(fs.readdirSync(root).filter((entry) => entry.endsWith('.remove'))).toHaveLength(0);
  });

  it.skipIf(process.platform === 'win32')('preserves a replacement attempt during identity-safe close', async () => {
    const root = mkTmp('ipc-transport-posix-replacement-during-close');
    const { socketPath } = defaultIpcPaths({ platform: 'linux', rootDir: root });
    const transport = createIpcServer({ platform: 'linux', socketPath, log: () => {} });
    let replaceOnCleanup = false;
    let replaced = false;
    const realLstatSync = fs.lstatSync.bind(fs);
    const lstatSpy = vi.spyOn(fs, 'lstatSync').mockImplementation((target, ...args) => {
      if (target === socketPath && replaceOnCleanup && !replaced) {
        replaced = true;
        fs.unlinkSync(socketPath);
        fs.writeFileSync(socketPath, 'replacement-during-close');
      }
      return realLstatSync(target, ...args);
    });
    await transport.listen({ onRequest: () => {} });
    replaceOnCleanup = true;

    try {
      await expect(transport.close()).rejects.toMatchObject({
        code: 'GUARDIAN_TRANSPORT_CLEANUP_UNCERTAIN',
        artifact: 'POSIX guardian socket',
      });
      expect(replaced).toBe(true);
      expect(fs.readFileSync(socketPath, 'utf8')).toBe('replacement-during-close');
    } finally {
      lstatSpy.mockRestore();
      try { fs.unlinkSync(socketPath); } catch { /* cleanup */ }
    }
  });

  it.skipIf(process.platform === 'win32')('normal close stops acceptance and releases the helper process', async () => {
    const root = mkTmp('ipc-transport-posix-detached-handle');
    const { socketPath } = defaultIpcPaths({ platform: 'linux', rootDir: root });
    const transport = createIpcServer({ platform: 'linux', socketPath, log: () => {} });

    try {
      await transport.listen({ onRequest: () => {} });
      await transport.close();

      expect(fs.existsSync(socketPath)).toBe(false);

      await new Promise((resolve, reject) => {
        const client = net.createConnection(socketPath);
        client.once('error', (error) => {
          expect(['ENOENT', 'ECONNREFUSED']).toContain(error.code);
          resolve();
        });
        client.once('connect', () => {
          client.destroy();
          reject(new Error('closed guardian socket accepted a connection'));
        });
      });

      // A fresh listener can bind the pathname after the helper has exited.
      const replacement = net.createServer();
      await new Promise((resolve, reject) => {
        replacement.once('error', reject);
        replacement.listen(socketPath, resolve);
      });
      await new Promise((resolve, reject) => {
        replacement.close((error) => (error ? reject(error) : resolve()));
      });
      expect(fs.existsSync(socketPath)).toBe(false);
    } finally {
      await transport.close();
    }
  });

  it.skipIf(process.platform === 'win32')('fails closed when the listener helper cannot start', async () => {
    const root = mkTmp('ipc-transport-posix-helper-start-failure');
    const { socketPath } = defaultIpcPaths({ platform: 'linux', rootDir: root });
    const transport = createIpcServer({
      platform: 'linux',
      socketPath,
      helperPath: path.join(root, 'missing-listener-helper.js'),
      log: () => {},
    });

    await expect(transport.listen({ onRequest: () => {} })).rejects.toMatchObject({
      code: 'GUARDIAN_TRANSPORT_HELPER_FAILED',
    });
    expect(fs.existsSync(socketPath)).toBe(false);
    await expect(transport.close()).resolves.toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')('does not clobber a pre-existing owner pathname during helper publication', async () => {
    const root = mkTmp('ipc-transport-posix-owner-no-clobber');
    const { socketPath } = defaultIpcPaths({ platform: 'linux', rootDir: root });
    const ownerPath = `${socketPath}.owner`;
    fs.writeFileSync(ownerPath, 'pre-existing-owner');
    const transport = createIpcServer({ platform: 'linux', socketPath, log: () => {} });

    await expect(transport.listen({ onRequest: () => {} })).rejects.toMatchObject({
      code: 'GUARDIAN_TRANSPORT_CLEANUP_UNCERTAIN',
      artifact: 'POSIX guardian socket',
    });
    expect(fs.readFileSync(ownerPath, 'utf8')).toBe('pre-existing-owner');
    expect(fs.existsSync(socketPath)).toBe(false);
    await expect(transport.close()).rejects.toMatchObject({
      code: 'GUARDIAN_TRANSPORT_CLEANUP_UNCERTAIN',
    });
  });

  it.skipIf(process.platform === 'win32')('retains authority when the helper identity snapshot is ambiguous', async () => {
    const root = mkTmp('ipc-transport-posix-helper-identity-uncertain');
    const { socketPath } = defaultIpcPaths({ platform: 'linux', rootDir: root });
    const transport = createIpcServer({ platform: 'linux', socketPath, log: () => {} });
    const realLstatSync = fs.lstatSync.bind(fs);
    let identityProbe = true;
    const lstatSpy = vi.spyOn(fs, 'lstatSync').mockImplementation((target, ...args) => {
      if (target === socketPath && identityProbe && fs.existsSync(socketPath)) {
        identityProbe = false;
        return { dev: 1, ino: 1, mode: 0o600, isSocket: () => false };
      }
      return realLstatSync(target, ...args);
    });

    let listenError;
    try {
      await transport.listen({ onRequest: () => {} });
    } catch (error) {
      listenError = error;
    } finally {
      lstatSpy.mockRestore();
    }

    expect(listenError).toMatchObject({
      code: 'GUARDIAN_TRANSPORT_CLEANUP_UNCERTAIN',
      artifact: 'POSIX guardian socket',
    });
    expect(fs.lstatSync(socketPath).isSocket()).toBe(true);
    // Startup failed closed before the parent received a verified ready
    // identity. Close must not adopt the now-readable pair as ownership.
    await expect(transport.close()).rejects.toMatchObject({
      code: 'GUARDIAN_TRANSPORT_CLEANUP_UNCERTAIN',
    });
    expect(fs.existsSync(socketPath)).toBe(true);
    expect(fs.existsSync(`${socketPath}.owner`)).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('closes safely when the public POSIX socket path is already missing', async () => {
    const root = mkTmp('ipc-transport-posix-absent-close');
    const { socketPath } = defaultIpcPaths({ platform: 'linux', rootDir: root });
    const transport = createIpcServer({ platform: 'linux', socketPath, log: () => {} });
    await transport.listen({ onRequest: () => {} });

    fs.unlinkSync(socketPath);
    await expect(transport.close()).rejects.toMatchObject({
      code: 'GUARDIAN_TRANSPORT_CLEANUP_UNCERTAIN',
      artifact: 'POSIX guardian socket',
    });
    expect(fs.existsSync(`${socketPath}.owner`)).toBe(true);
    expect(fs.existsSync(socketPath)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('fails closed when the POSIX owner alias is already missing', async () => {
    const root = mkTmp('ipc-transport-posix-owner-missing-close');
    const { socketPath } = defaultIpcPaths({ platform: 'linux', rootDir: root });
    const transport = createIpcServer({ platform: 'linux', socketPath, log: () => {} });
    await transport.listen({ onRequest: () => {} });

    fs.unlinkSync(`${socketPath}.owner`);
    await expect(transport.close()).rejects.toMatchObject({
      code: 'GUARDIAN_TRANSPORT_CLEANUP_UNCERTAIN',
      artifact: 'POSIX guardian socket',
    });
    expect(fs.lstatSync(socketPath).isSocket()).toBe(true);
    expect(fs.existsSync(`${socketPath}.owner`)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('fails closed when the POSIX owner alias is replaced', async () => {
    const root = mkTmp('ipc-transport-posix-owner-replaced-close');
    const { socketPath } = defaultIpcPaths({ platform: 'linux', rootDir: root });
    const ownerPath = `${socketPath}.owner`;
    const transport = createIpcServer({ platform: 'linux', socketPath, log: () => {} });
    await transport.listen({ onRequest: () => {} });

    fs.unlinkSync(ownerPath);
    fs.writeFileSync(ownerPath, 'replacement-owner');
    await expect(transport.close()).rejects.toMatchObject({
      code: 'GUARDIAN_TRANSPORT_CLEANUP_UNCERTAIN',
      artifact: 'POSIX guardian socket',
    });
    expect(fs.lstatSync(socketPath).isSocket()).toBe(true);
    expect(fs.readFileSync(ownerPath, 'utf8')).toBe('replacement-owner');
  });

  it.skipIf(process.platform !== 'linux')('returns native descriptor count to baseline across repeated transport lifecycles', async () => {
    const root = mkTmp('ipc-transport-posix-fd-baseline');
    const descriptorCount = () => fs.readdirSync('/proc/self/fd').length;
    const childCount = () => {
      const children = fs.readFileSync(`/proc/self/task/${process.pid}/children`, 'utf8').trim();
      return children ? children.split(/\s+/).length : 0;
    };
    const before = descriptorCount();
    const beforeChildren = childCount();

    for (let index = 0; index < 24; index += 1) {
      const socketPath = path.join(root, `guardian-${index}.sock`);
      const transport = createIpcServer({ platform: 'linux', socketPath, log: () => {} });
      await transport.listen({ onRequest: () => {} });
      await transport.close();
      expect(fs.existsSync(socketPath)).toBe(false);
    }

    await new Promise((resolve) => setImmediate(resolve));
    expect(descriptorCount()).toBeLessThanOrEqual(before + 1);
    expect(childCount()).toBeLessThanOrEqual(beforeChildren);
  }, 15_000);

  it.skipIf(process.platform === 'win32')('reports a socket replacement after unlink/recreate with reused dev+ino', async () => {
    const root = mkTmp('ipc-transport-posix-reused-dev-ino');
    const { socketPath } = defaultIpcPaths({ platform: 'linux', rootDir: root });
    const originalServer = net.createServer();
    await new Promise((resolve, reject) => {
      originalServer.once('error', reject);
      originalServer.listen(socketPath, resolve);
    });
    const originalStat = fs.lstatSync(socketPath);
    await new Promise((resolve) => originalServer.close(resolve));
    try { fs.unlinkSync(socketPath); } catch { /* close may already unlink it */ }

    const replacementServer = net.createServer();
    await new Promise((resolve, reject) => {
      replacementServer.once('error', reject);
      replacementServer.listen(socketPath, resolve);
    });
    const replacementStat = fs.lstatSync(socketPath);
    // Force the deterministic XFS identity-reuse shape: the replacement has
    // the same dev+ino but a new generation timestamp. Socket cleanup must
    // reject it without using content as an identity signal.
    Object.assign(replacementStat, {
      dev: originalStat.dev,
      ino: originalStat.ino,
      birthtimeMs: originalStat.birthtimeMs + 1,
      ctimeMs: originalStat.ctimeMs + 1,
    });
    const realLstatSync = fs.lstatSync.bind(fs);
    const lstatSpy = vi.spyOn(fs, 'lstatSync').mockImplementation((target, ...args) => (
      target === socketPath ? replacementStat : realLstatSync(target, ...args)
    ));

    try {
      expect(removeFileByIdentity(socketPath, originalStat, {
        label: 'POSIX guardian socket',
        expectedType: 'socket',
        returnResult: true,
      })).toMatchObject({ status: 'replaced' });
      expect(fs.existsSync(socketPath)).toBe(true);
    } finally {
      lstatSpy.mockRestore();
      await new Promise((resolve) => replacementServer.close(resolve));
      try { fs.unlinkSync(socketPath); } catch { /* cleanup */ }
    }
  });

  it.skipIf(process.platform === 'win32')('uses the POSIX pathname fallback for darwin', async () => {
    const platform = 'darwin';
    const root = mkTmp();
    const { socketPath } = defaultIpcPaths({ platform, rootDir: root });
    const transport = createIpcServer({
      platform,
      socketPath,
      log: () => {},
    });
    await transport.listen({ onRequest: () => {} });
    expect(fs.lstatSync(socketPath).isSocket()).toBe(true);
    expect(fs.lstatSync(`${socketPath}.owner`).isSocket()).toBe(true);
    await transport.close();
    expect(fs.existsSync(socketPath)).toBe(false);
    expect(fs.existsSync(`${socketPath}.owner`)).toBe(false);
  });

  it('fails closed instead of routing an unknown platform through POSIX', () => {
    expect(() => createIpcServer({ platform: 'plan9', socketPath: '/tmp/guardian.sock' }))
      .toThrow(/unsupported platform/);
    expect(() => createIpcDialer({ platform: 'plan9', socketPath: '/tmp/guardian.sock' }))
      .toThrow(/unsupported platform/);
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

  it.skipIf(process.platform === 'win32')('immediate listen+close rejects listen, drains helper startup, and permits relisten', async () => {
    const root = mkTmp('ipc-transport-posix-immediate-close');
    const { socketPath } = defaultIpcPaths({ platform: 'linux', rootDir: root });
    const transport = createIpcServer({ platform: 'linux', socketPath, log: () => {} });

    const listenPromise = transport.listen({ onRequest: () => {
      throw new Error('a connection must not reach the request layer after close begins');
    } });
    const closePromise = transport.close();

    await expect(listenPromise).rejects.toMatchObject({
      code: 'GUARDIAN_TRANSPORT_LISTEN_CANCELLED',
    });
    await expect(closePromise).resolves.toBeUndefined();
    expect(fs.existsSync(socketPath)).toBe(false);
    expect(fs.existsSync(`${socketPath}.owner`)).toBe(false);

    // A successful close must clear the cached close promise and all helper
    // state so a new listener can publish a fresh identity pair.
    await transport.listen({ onRequest: () => {} });
    expect(fs.existsSync(socketPath)).toBe(true);
    expect(fs.existsSync(`${socketPath}.owner`)).toBe(true);
    await transport.close();
  });

  it.skipIf(process.platform === 'win32')('ignores stale helper events after relisten and destroys late sockets', async () => {
    const root = mkTmp('ipc-transport-posix-relisten-generation');
    const { socketPath } = defaultIpcPaths({ platform: 'linux', rootDir: root });
    const helpers = [];
    const createPublicationHandle = (token) => {
      const handle = new net.Socket();
      handle.write = (value, callback) => {
        if (String(value).startsWith('guardian-ipc-publication-accept:')) {
          queueMicrotask(() => handle.emit(
            'data',
            Buffer.from(`guardian-ipc-publication-commit:${token}\n`),
          ));
        } else if (String(value).startsWith('guardian-ipc-publication-commit-ack:')) {
          queueMicrotask(() => handle.emit(
            'data',
            Buffer.from(`guardian-ipc-publication-commit-confirm:${token}\n`),
          ));
        }
        callback?.();
        return true;
      };
      handle.destroy = vi.fn(() => handle);
      return handle;
    };
    const forkProcess = () => {
      const child = new EventEmitter();
      child.connected = true;
      child.exitCode = null;
      child.signalCode = null;
      child.kill = vi.fn(() => {
        child.connected = false;
        child.signalCode = 'SIGKILL';
        queueMicrotask(() => {
          child.emit('exit', null, 'SIGKILL');
          child.emit('close', null, 'SIGKILL');
        });
      });
      child.send = (message, callback) => {
        if (message?.type === 'listen') {
           const server = net.createServer();
           child.server = server;
           child.socketPath = message.socketPath;
           const ownerPath = `${message.socketPath}.owner`;
           server.listen(ownerPath, () => {
             fs.chmodSync(ownerPath, 0o600);
             fs.linkSync(ownerPath, message.socketPath);
               const publicIdentity = snapshotFileIdentity(fs.lstatSync(message.socketPath));
               const ownerIdentity = snapshotFileIdentity(fs.lstatSync(ownerPath));
                const listenerIdentity = snapshotFileIdentity(fs.fstatSync(server._handle.fd));
                const publicationToken = 'b'.repeat(64);
                const publicationHandle = createPublicationHandle(publicationToken);
                child.publicationHandle = publicationHandle;
                child.emit('message', {
                  type: 'ready-candidate',
                  publicationHandle: 'accepted-probe',
                  publicationToken,
                  publicationProof: {
                   token: publicationToken,
                   listenerIdentity,
                   boundPathIdentity: ownerIdentity,
                   descriptorIdentity: publicIdentity,
                   publicIdentity,
                    ownerIdentity,
                  },
                }, publicationHandle);
              callback?.();
            });
            return true;
          }

          if (message?.type === 'publication-handle-ready') {
            queueMicrotask(() => child.publicationHandle?.emit(
              'data',
              Buffer.from(`guardian-ipc-publication-handle:${message.publicationToken}\n`),
            ));
            callback?.();
            return true;
          }

          if (message?.type === 'accept-ready') {
           const publicationToken = message.publicationToken;
           const publicIdentity = snapshotFileIdentity(fs.lstatSync(child.socketPath));
           const ownerIdentity = snapshotFileIdentity(fs.lstatSync(`${child.socketPath}.owner`));
           const listenerIdentity = snapshotFileIdentity(fs.fstatSync(child.server._handle.fd));
           child.emit('message', {
             type: 'ready',
             publicationToken,
             publicationProof: {
               token: publicationToken,
               listenerIdentity,
               boundPathIdentity: ownerIdentity,
               descriptorIdentity: publicIdentity,
               publicIdentity,
               ownerIdentity,
             },
           });
           callback?.();
           return true;
         }

         if (message?.type === 'shutdown') {
          callback?.();
           child.connected = false;
           // Close only the descriptor. The parent owns pathname removal.
           child.server?._handle?.close?.();
           if (child.socketPath && !fs.existsSync(`${child.socketPath}.owner`)) {
             fs.linkSync(child.socketPath, `${child.socketPath}.owner`);
           } else if (child.socketPath && !fs.existsSync(child.socketPath)) {
             fs.linkSync(`${child.socketPath}.owner`, child.socketPath);
           }
          child.server = null;
          child.exitCode = 0;
          queueMicrotask(() => {
            child.emit('exit', 0, null);
            child.emit('close', 0, null);
          });
        }
        return true;
      };
      helpers.push(child);
      return child;
    };

    const transport = createIpcServer({
      platform: 'linux',
      socketPath,
      forkProcess,
      log: () => {},
    });
    let requestCount = 0;

    await transport.listen({ onRequest: () => { requestCount += 1; } });
    const oldHelper = helpers[0];
    await transport.close();

    const relisten = transport.listen({ onRequest: () => { requestCount += 1; } });
    const lateSocket = new EventEmitter();
    lateSocket.end = vi.fn();
    lateSocket.destroy = vi.fn();
    oldHelper.emit('message', { type: 'connection' }, lateSocket);
    oldHelper.emit('error', new Error('stale helper error'));
    oldHelper.emit('disconnect');
    oldHelper.emit('exit', 1, 'SIGTERM');

    await expect(relisten).resolves.toMatchObject({
      publicIdentity: expect.any(Object),
      ownerIdentity: expect.any(Object),
    });
    expect(lateSocket.destroy).toHaveBeenCalled();
    expect(requestCount).toBe(0);
    await transport.close();
  });

  it.skipIf(process.platform === 'win32')('destroys a connection arriving after close begins instead of attaching it', async () => {
    const root = mkTmp('ipc-transport-posix-late-connection');
    const { socketPath } = defaultIpcPaths({ platform: 'linux', rootDir: root });
    let requestCount = 0;
    const transport = createIpcServer({ platform: 'linux', socketPath, log: () => {} });
    await transport.listen({ onRequest: () => { requestCount += 1; } });

    const closing = transport.close();
    const client = net.createConnection(socketPath);
    await new Promise((resolve) => {
      const finish = () => {
        client.destroy();
        resolve();
      };
      client.once('connect', finish);
      client.once('error', finish);
      client.once('close', finish);
      setTimeout(finish, 2_000).unref();
    });
    await closing;
    expect(requestCount).toBe(0);
    expect(fs.existsSync(socketPath)).toBe(false);
    expect(fs.existsSync(`${socketPath}.owner`)).toBe(false);
  });

  it.skipIf(process.platform === 'win32' || Boolean(process.versions?.bun))('recovers a stale socket after verified guardian death and accepts a new dial', async () => {
    const root = mkTmp('ipc-transport-crash-restart');
    const { socketPath } = defaultIpcPaths({ platform: 'linux', rootDir: root });
    await createCrashedSocket(socketPath);
    expect(fs.existsSync(socketPath)).toBe(true);

    const priorMarker = {
      status: 'valid',
      token: 'prior-token-posix-restart',
      pid: 42420,
      identity: {
        processStartTicks: '10',
        launch: { commandLine: 'node openchamber-guardian.js', cwd: root },
        owner: '1000',
      },
      transportIdentity: {
        publicIdentity: snapshotFileIdentity(fs.lstatSync(socketPath)),
        ownerIdentity: snapshotFileIdentity(fs.lstatSync(`${socketPath}.owner`)),
      },
    };
    expect(() => recoverStaleGuardianTransportArtifacts({
      platform: 'linux',
      socketPath,
      priorMarker,
      liveness: () => 'dead',
    })).not.toThrow();
    expect(fs.existsSync(socketPath)).toBe(false);

    const transport = createIpcServer({ platform: 'linux', socketPath, log: () => {} });
    let received = false;
    await transport.listen({ onRequest: () => { received = true; } });
    const dial = createIpcDialer({ platform: 'linux', socketPath });
    const client = dial();
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('restart dial timeout')), 2000);
        client.once('connect', () => {
          clearTimeout(timer);
          setTimeout(() => {
            client.destroy();
            resolve();
          }, 50);
        });
        client.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(received).toBe(true);
    } finally {
      await transport.close();
    }
  });

  it.skipIf(process.platform === 'win32')('restores a POSIX stale pair when owner cleanup fails, then retries successfully', async () => {
    const root = mkTmp('ipc-transport-posix-stale-cleanup-retry');
    const { socketPath } = defaultIpcPaths({ platform: 'linux', rootDir: root });
    await createCrashedSocket(socketPath);
    const ownerPath = `${socketPath}.owner`;
    const priorMarker = staleGuardianMarker(root, 'stale-cleanup-retry', socketPath);
    const realUnlinkSync = fs.unlinkSync.bind(fs);
    const ownerQuarantinePrefix = `.${path.basename(ownerPath)}.`;
    let failed = false;
    const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((target, ...args) => {
      if (
        !failed
        && typeof target === 'string'
        && path.basename(target).startsWith(ownerQuarantinePrefix)
      ) {
        failed = true;
        throw Object.assign(new Error('owner alias cleanup denied'), { code: 'EACCES' });
      }
      return realUnlinkSync(target, ...args);
    });

    try {
      expect(() => recoverStaleGuardianTransportArtifacts({
        platform: 'linux',
        socketPath,
        priorMarker,
        liveness: () => 'dead',
      })).toThrow(/owner alias cleanup denied/);
      expect(fs.lstatSync(socketPath).isSocket()).toBe(true);
      expect(fs.lstatSync(ownerPath).isSocket()).toBe(true);
      expect(fs.statSync(socketPath).ino).toBe(fs.statSync(ownerPath).ino);
    } finally {
      unlinkSpy.mockRestore();
    }

    expect(() => recoverStaleGuardianTransportArtifacts({
      platform: 'linux',
      socketPath,
      priorMarker,
      liveness: () => 'dead',
    })).not.toThrow();
    expect(fs.existsSync(socketPath)).toBe(false);
    expect(fs.existsSync(ownerPath)).toBe(false);
    expect(fs.readdirSync(root).some((entry) => entry.endsWith('.remove'))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('stale recovery refreshes ctime-only pair identity across rollback and retry', async () => {
    const root = mkTmp('ipc-transport-posix-ctime-stale-retry');
    const { socketPath } = defaultIpcPaths({ platform: 'linux', rootDir: root });
    const ownerPath = `${socketPath}.owner`;
    const server = net.createServer();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    fs.linkSync(socketPath, ownerPath);
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await new Promise((resolve) => setImmediate(resolve));
    // Recreate the public hard link after the listener's high-level close
    // removes its bound name; the stale marker represents this final pair.
    if (!fs.existsSync(socketPath)) fs.linkSync(ownerPath, socketPath);

    const realLstatSync = fs.lstatSync.bind(fs);
    const realFstatSync = fs.fstatSync.bind(fs);
    const lstatSpy = vi.spyOn(fs, 'lstatSync').mockImplementation((target, ...args) => (
      ctimeOnlyStat(realLstatSync(target, ...args))
    ));
    const fstatSpy = vi.spyOn(fs, 'fstatSync').mockImplementation((target, ...args) => (
      ctimeOnlyStat(realFstatSync(target, ...args))
    ));
    const priorMarker = staleGuardianMarker(root, 'ctime-stale-retry', socketPath);
    const realUnlinkSync = fs.unlinkSync.bind(fs);
    const ownerQuarantinePrefix = `.${path.basename(ownerPath)}.`;
    let failed = false;
    const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((target, ...args) => {
      if (
        !failed
        && typeof target === 'string'
        && path.basename(target).startsWith(ownerQuarantinePrefix)
      ) {
        failed = true;
        throw Object.assign(new Error('ctime-only owner cleanup denied'), { code: 'EACCES' });
      }
      return realUnlinkSync(target, ...args);
    });

    try {
      expect(() => recoverStaleGuardianTransportArtifacts({
        platform: 'linux',
        socketPath,
        priorMarker,
        liveness: () => 'dead',
      })).toThrow(/ctime-only owner cleanup denied/);
      expect(priorMarker.transportIdentity.publicIdentity.ctime).toBe(
        priorMarker.transportIdentity.ownerIdentity.ctime,
      );
      expect(fs.lstatSync(socketPath).isSocket()).toBe(true);
      expect(fs.lstatSync(ownerPath).isSocket()).toBe(true);
    } finally {
      unlinkSpy.mockRestore();
    }

    try {
      expect(() => recoverStaleGuardianTransportArtifacts({
        platform: 'linux',
        socketPath,
        priorMarker,
        liveness: () => 'dead',
      })).not.toThrow();
      expect(fs.existsSync(socketPath)).toBe(false);
      expect(fs.existsSync(ownerPath)).toBe(false);
      expect(fs.readdirSync(root).some((entry) => entry.endsWith('.remove'))).toBe(false);
    } finally {
      fstatSpy.mockRestore();
      lstatSpy.mockRestore();
      try { fs.unlinkSync(socketPath); } catch { /* cleanup */ }
      try { fs.unlinkSync(ownerPath); } catch { /* cleanup */ }
    }
  });

  it.skipIf(process.platform === 'win32')('refuses non-Linux ctime-only stale recovery before removing either sibling', async () => {
    const root = mkTmp('ipc-transport-posix-ctime-stale-nonlinux');
    const { socketPath } = defaultIpcPaths({ platform: 'darwin', rootDir: root });
    await createCrashedSocket(socketPath);
    const ownerPath = `${socketPath}.owner`;
    const priorMarker = staleGuardianMarker(root, 'ctime-stale-nonlinux', socketPath);
    priorMarker.transportIdentity = {
      publicIdentity: ctimeOnlyStat(fs.lstatSync(socketPath)),
      ownerIdentity: ctimeOnlyStat(fs.lstatSync(ownerPath)),
    };
    const realLstatSync = fs.lstatSync.bind(fs);
    const lstatSpy = vi.spyOn(fs, 'lstatSync').mockImplementation((target, ...args) => (
      ctimeOnlyStat(realLstatSync(target, ...args))
    ));

    try {
      expect(() => recoverStaleGuardianTransportArtifacts({
        platform: 'darwin',
        socketPath,
        priorMarker,
        liveness: () => 'dead',
      })).toThrowError(expect.objectContaining({ code: 'GUARDIAN_TRANSPORT_UNSUPPORTED' }));
      expect(fs.existsSync(socketPath)).toBe(true);
      expect(fs.existsSync(ownerPath)).toBe(true);
      expect(fs.readdirSync(root).filter((entry) => entry.endsWith('.remove'))).toHaveLength(0);
    } finally {
      lstatSpy.mockRestore();
    }
  });

  it.skipIf(process.platform === 'win32')('rejects and preserves a live replacement public/owner pair', async () => {
    const root = mkTmp('ipc-transport-posix-replacement-pair');
    const { socketPath } = defaultIpcPaths({ platform: 'linux', rootDir: root });
    const ownerPath = `${socketPath}.owner`;
    const previousServer = net.createServer();
    await new Promise((resolve, reject) => {
      previousServer.once('error', reject);
      previousServer.listen(socketPath, resolve);
    });
    fs.linkSync(socketPath, ownerPath);
    const persistedIdentity = {
      publicIdentity: snapshotFileIdentity(fs.lstatSync(socketPath)),
      ownerIdentity: snapshotFileIdentity(fs.lstatSync(ownerPath)),
    };
    await new Promise((resolve, reject) => previousServer.close((error) => (error ? reject(error) : resolve())));
    try { fs.unlinkSync(socketPath); } catch { /* close usually unlinks it */ }
    fs.unlinkSync(ownerPath);

    const replacementServer = net.createServer();
    await new Promise((resolve, reject) => {
      replacementServer.once('error', reject);
      replacementServer.listen(socketPath, resolve);
    });
    fs.linkSync(socketPath, ownerPath);
    const replacementPublic = snapshotFileIdentity(fs.lstatSync(socketPath));
    const replacementOwner = snapshotFileIdentity(fs.lstatSync(ownerPath));

    const priorMarker = {
      ...staleGuardianMarker(root, 'replacement-pair-marker', socketPath),
      transportIdentity: persistedIdentity,
    };

    try {
      expect(() => recoverStaleGuardianTransportArtifacts({
        platform: 'linux',
        socketPath,
        priorMarker,
        liveness: () => 'dead',
      })).toThrow(/persisted listener identity/);
      expect(fs.lstatSync(socketPath).isSocket()).toBe(true);
      expect(fs.lstatSync(ownerPath).isSocket()).toBe(true);
      expect(snapshotFileIdentity(fs.lstatSync(socketPath))).toEqual(replacementPublic);
      expect(snapshotFileIdentity(fs.lstatSync(ownerPath))).toEqual(replacementOwner);
    } finally {
      await new Promise((resolve) => replacementServer.close(resolve));
      try { fs.unlinkSync(socketPath); } catch { /* cleanup */ }
      try { fs.unlinkSync(ownerPath); } catch { /* cleanup */ }
    }
  });

  it.skipIf(process.platform === 'win32')('never removes a socket while the prior guardian identity is live', async () => {
    const root = mkTmp('ipc-transport-live-artifact');
    const { socketPath } = defaultIpcPaths({ platform: 'linux', rootDir: root });
    const server = net.createServer();
    await new Promise((resolve) => server.listen(socketPath, resolve));
    const priorMarker = {
      status: 'valid',
      token: 'prior-token-posix-live',
      pid: 42421,
      identity: {
        processStartTicks: '11',
        launch: { commandLine: 'node openchamber-guardian.js', cwd: root },
        owner: '1000',
      },
    };

    try {
      expect(() => recoverStaleGuardianTransportArtifacts({
        platform: 'linux',
        socketPath,
        priorMarker,
        liveness: () => 'alive',
        readIdentity: () => priorMarker.identity,
      })).toThrow(/requires verified prior guardian death/);
      expect(fs.existsSync(socketPath)).toBe(true);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      try { fs.unlinkSync(socketPath); } catch { /* ignore */ }
    }
  });

  it.skipIf(process.platform === 'win32')('fails closed when a POSIX recovery socket is replaced before quarantine', async () => {
    const root = mkTmp('ipc-transport-posix-recovery-replacement');
    const { socketPath } = defaultIpcPaths({ platform: 'linux', rootDir: root });
    const server = net.createServer();
    await new Promise((resolve) => server.listen(socketPath, resolve));
    fs.linkSync(socketPath, `${socketPath}.owner`);
    const priorMarker = {
      status: 'valid',
      token: 'prior-token-posix-replacement',
      pid: 42428,
      identity: {
        processStartTicks: '18',
        launch: { commandLine: 'node openchamber-guardian.js', cwd: root },
        owner: '1000',
      },
      transportIdentity: {
        publicIdentity: snapshotFileIdentity(fs.lstatSync(socketPath)),
        ownerIdentity: snapshotFileIdentity(fs.lstatSync(`${socketPath}.owner`)),
      },
    };
    const realRenameSync = fs.renameSync.bind(fs);
    let replaced = false;
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
      if (source === socketPath && !replaced) {
        replaced = true;
        fs.unlinkSync(socketPath);
        fs.writeFileSync(socketPath, 'replacement-recovery-transport');
      }
      return realRenameSync(source, destination);
    });

    try {
      await expect(Promise.resolve().then(() => recoverStaleGuardianTransportArtifacts({
        platform: 'linux',
        socketPath,
        priorMarker,
        liveness: () => 'dead',
      }))).rejects.toMatchObject({ code: 'GUARDIAN_TRANSPORT_ARTIFACT_REPLACED' });
      expect(fs.readFileSync(socketPath, 'utf8')).toBe('replacement-recovery-transport');
    } finally {
      renameSpy.mockRestore();
      await new Promise((resolve) => server.close(resolve));
      try { fs.unlinkSync(socketPath); } catch { /* cleanup */ }
      try { fs.unlinkSync(`${socketPath}.owner`); } catch { /* cleanup */ }
    }
  });

  it.skipIf(process.platform === 'win32')('rejects legacy POSIX recovery when the owner alias is absent', async () => {
    const root = mkTmp('ipc-transport-posix-recovery-no-owner');
    const { socketPath } = defaultIpcPaths({ platform: 'linux', rootDir: root });
    const server = net.createServer();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    fs.linkSync(socketPath, `${socketPath}.owner`);
    const priorMarker = staleGuardianMarker(root, 'legacy-no-owner', socketPath);
    fs.unlinkSync(`${socketPath}.owner`);

    try {
      expect(() => recoverStaleGuardianTransportArtifacts({
        platform: 'linux',
        socketPath,
        priorMarker,
        liveness: () => 'dead',
      })).toThrow(/owner alias is missing/);
      expect(fs.existsSync(socketPath)).toBe(true);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      try { fs.unlinkSync(socketPath); } catch { /* cleanup */ }
    }
  });

  it.skipIf(process.platform === 'win32')('recovers a pre-ready stale marker when no POSIX artifacts remain', () => {
    const root = mkTmp('ipc-transport-posix-pre-ready-no-artifacts');
    const { socketPath } = defaultIpcPaths({ platform: 'linux', rootDir: root });
    const priorMarker = staleGuardianMarker(root, 'pre-ready-no-artifacts', socketPath);
    expect(priorMarker.transportIdentity).toBeNull();

    expect(recoverStaleGuardianTransportArtifacts({
      platform: 'linux',
      socketPath,
      priorMarker,
      liveness: () => 'dead',
    })).toEqual({ recovered: true, platform: 'linux' });
    expect(fs.existsSync(socketPath)).toBe(false);
    expect(fs.existsSync(`${socketPath}.owner`)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('refuses POSIX cleanup for an old marker without transport identity', async () => {
    const root = mkTmp('ipc-transport-posix-legacy-marker');
    const { socketPath } = defaultIpcPaths({ platform: 'linux', rootDir: root });
    const server = net.createServer();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    fs.linkSync(socketPath, `${socketPath}.owner`);

    try {
      expect(() => recoverStaleGuardianTransportArtifacts({
        platform: 'linux',
        socketPath,
         priorMarker: {
          status: 'valid',
          token: 'legacy-marker-without-transport',
          pid: 42429,
          identity: {
            processStartTicks: '19',
            launch: { commandLine: 'node openchamber-guardian.js', cwd: root },
          },
        },
        liveness: () => 'dead',
      })).toThrow(/persisted POSIX transport identity/);
      expect(fs.lstatSync(socketPath).isSocket()).toBe(true);
      expect(fs.lstatSync(`${socketPath}.owner`).isSocket()).toBe(true);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      try { fs.unlinkSync(socketPath); } catch { /* cleanup */ }
      try { fs.unlinkSync(`${socketPath}.owner`); } catch { /* cleanup */ }
    }
  });

  it.skipIf(process.platform === 'win32')('rejects stale recovery when the owner alias names a different socket inode', async () => {
    const root = mkTmp('ipc-transport-posix-recovery-owner-mismatch');
    const { socketPath } = defaultIpcPaths({ platform: 'linux', rootDir: root });
    const ownerPath = `${socketPath}.owner`;
    const publicServer = net.createServer();
    const ownerServer = net.createServer();
    await new Promise((resolve, reject) => {
      publicServer.once('error', reject);
      publicServer.listen(socketPath, resolve);
    });
    await new Promise((resolve, reject) => {
      ownerServer.once('error', reject);
      ownerServer.listen(ownerPath, resolve);
    });
    const persistedPublicIdentity = snapshotFileIdentity(fs.lstatSync(socketPath));
    const priorMarker = {
      ...staleGuardianMarker(root, 'owner-mismatch', socketPath),
      transportIdentity: {
        publicIdentity: persistedPublicIdentity,
        ownerIdentity: persistedPublicIdentity,
      },
    };

    try {
      expect(() => recoverStaleGuardianTransportArtifacts({
        platform: 'linux',
        socketPath,
        priorMarker,
        liveness: () => 'dead',
      })).toThrow(/does not match its owner alias/);
      expect(fs.existsSync(socketPath)).toBe(true);
      expect(fs.existsSync(ownerPath)).toBe(true);
    } finally {
      await new Promise((resolve) => publicServer.close(resolve));
      await new Promise((resolve) => ownerServer.close(resolve));
      try { fs.unlinkSync(socketPath); } catch { /* cleanup */ }
      try { fs.unlinkSync(ownerPath); } catch { /* cleanup */ }
    }
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

  it('rejects close when a same-port discovery replacement is present', async () => {
    const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    const dir = mkTmp('ipc-transport-win32-same-port-replacement');
    const portPath = path.join(dir, 'port');
    const transport = createIpcServer({
      platform: 'win32', portPath, username: 'alice', aclInspector, log: () => {},
    });

    try {
      await transport.listen({ onRequest: () => {} });
      const original = fs.readFileSync(portPath, 'utf8');
      fs.unlinkSync(portPath);
      fs.writeFileSync(portPath, original);

      await expect(transport.close()).rejects.toMatchObject({
        code: 'GUARDIAN_TRANSPORT_CLEANUP_FAILED',
        artifact: 'Windows guardian discovery file',
      });
      expect(fs.readFileSync(portPath, 'utf8')).toBe(original);
    } finally {
      if (originalPlatformDescriptor) {
        Object.defineProperty(process, 'platform', originalPlatformDescriptor);
      } else {
        delete process.platform;
      }
    }
  });

  it.each([
    { label: 'content', body: 'localhost:4096\n' },
    { label: 'port', body: '127.0.0.1:4100\n' },
  ])('rejects close when the discovery file is mutated in place by $label', async ({ body }) => {
    const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    const dir = mkTmp(`ipc-transport-win32-in-place-${body.includes('localhost') ? 'content' : 'port'}`);
    const portPath = path.join(dir, 'port');
    const transport = createIpcServer({
      platform: 'win32', portPath, username: 'alice', aclInspector, log: () => {},
    });

    try {
      await transport.listen({ onRequest: () => {} });
      fs.writeFileSync(portPath, body);

      await expect(transport.close()).rejects.toMatchObject({
        code: 'GUARDIAN_TRANSPORT_CLEANUP_FAILED',
        artifact: 'Windows guardian discovery file',
      });
      expect(fs.readFileSync(portPath, 'utf8')).toBe(body);

      // Ownership remains retained; a second close cannot silently accept the
      // same mutated artifact either.
      await expect(transport.close()).rejects.toMatchObject({
        code: 'GUARDIAN_TRANSPORT_CLEANUP_FAILED',
      });
      expect(fs.existsSync(portPath)).toBe(true);
    } finally {
      if (originalPlatformDescriptor) {
        Object.defineProperty(process, 'platform', originalPlatformDescriptor);
      } else {
        delete process.platform;
      }
    }
  });

  it('rejects close when removing the owned discovery file fails, then retries cleanup', async () => {
    const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    const dir = mkTmp('ipc-transport-win32-discovery-removal-failure');
    const portPath = path.join(dir, 'port');
    const transport = createIpcServer({
      platform: 'win32', portPath, username: 'alice', aclInspector, log: () => {},
    });
    await transport.listen({ onRequest: () => {} });

    const unlinkSync = fs.unlinkSync.bind(fs);
    const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((target, ...args) => {
      if (typeof target === 'string' && target.endsWith('.remove')) {
        throw Object.assign(new Error('discovery unlink denied'), { code: 'EACCES' });
      }
      return unlinkSync(target, ...args);
    });

    try {
      await expect(transport.close()).rejects.toMatchObject({
        code: 'GUARDIAN_TRANSPORT_CLEANUP_UNCERTAIN',
        message: 'Guardian IPC transport cleanup failed',
        artifact: 'Windows guardian discovery file',
      });
      expect(fs.existsSync(portPath)).toBe(true);
    } finally {
      unlinkSpy.mockRestore();
      if (originalPlatformDescriptor) {
        Object.defineProperty(process, 'platform', originalPlatformDescriptor);
      } else {
        delete process.platform;
      }
    }

    // The transport retains the validated publication identity and can retry
    // after the transient removal failure is gone.
    await expect(transport.close()).resolves.toBeUndefined();
    expect(fs.existsSync(portPath)).toBe(false);
  });

  it.each([
    { label: 'temp', prefix: '.port.tmp.', leftover: 'tmp' },
    { label: 'lock', prefix: '.port.lock.', leftover: 'lock' },
  ])('retains ownership when post-publication $label cleanup is uncertain', async ({ prefix, leftover }) => {
    const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    const dir = mkTmp(`ipc-transport-win32-persistent-${leftover}`);
    const portPath = path.join(dir, 'port');
    const realUnlinkSync = fs.unlinkSync.bind(fs);
    const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((target, ...args) => {
      if (typeof target === 'string' && path.basename(target).startsWith(prefix)) {
        throw Object.assign(new Error(`${leftover} cleanup denied`), { code: 'EACCES' });
      }
      return realUnlinkSync(target, ...args);
    });
    const transport = createIpcServer({
      platform: 'win32', portPath, username: 'alice', aclInspector, log: () => {},
    });

    try {
      await expect(transport.listen({ onRequest: () => {} })).rejects.toMatchObject({
        code: 'GUARDIAN_TRANSPORT_CLEANUP_UNCERTAIN',
      });
      expect(fs.existsSync(portPath)).toBe(false);
      expect(fs.existsSync(`${portPath}.tmp`)).toBe(leftover === 'tmp');
      expect(fs.existsSync(`${portPath}.lock`)).toBe(leftover === 'lock');

      await expect(transport.close()).rejects.toMatchObject({
        code: 'GUARDIAN_TRANSPORT_CLEANUP_UNCERTAIN',
      });
      expect(fs.existsSync(portPath)).toBe(false);
      expect(fs.existsSync(`${portPath}.tmp`)).toBe(leftover === 'tmp');
      expect(fs.existsSync(`${portPath}.lock`)).toBe(leftover === 'lock');
    } finally {
      unlinkSpy.mockRestore();
    }

    await expect(transport.close()).resolves.toBeUndefined();
    expect(fs.existsSync(portPath)).toBe(false);
    expect(fs.existsSync(`${portPath}.tmp`)).toBe(false);
    expect(fs.existsSync(`${portPath}.lock`)).toBe(false);
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    } else {
      delete process.platform;
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

  it('retains Windows transport authority for an unknown pre-existing discovery artifact', async () => {
    const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    const dir = mkTmp('ipc-transport-win32-unknown-final');
    const portPath = path.join(dir, 'port');
    fs.writeFileSync(portPath, 'pre-existing-discovery-artifact');
    const transport = createIpcServer({
      platform: 'win32', portPath, username: 'alice', aclInspector, log: () => {},
    });

    try {
      await expect(transport.listen({ onRequest: () => {} })).rejects.toMatchObject({
        code: 'GUARDIAN_TRANSPORT_CLEANUP_UNCERTAIN',
        artifact: 'Windows guardian discovery file',
      });
      expect(fs.readFileSync(portPath, 'utf8')).toBe('pre-existing-discovery-artifact');
      await expect(transport.close()).rejects.toMatchObject({
        code: 'GUARDIAN_TRANSPORT_CLEANUP_UNCERTAIN',
      });

      fs.unlinkSync(portPath);
      expect(fs.existsSync(portPath)).toBe(false);
      await expect(transport.close()).resolves.toBeUndefined();
    } finally {
      try { fs.unlinkSync(portPath); } catch { /* cleanup */ }
      try { await transport.close(); } catch { /* preserve the assertion failure */ }
      if (originalPlatformDescriptor) {
        Object.defineProperty(process, 'platform', originalPlatformDescriptor);
      } else {
        delete process.platform;
      }
    }
  });

  it('rejects startup after post-link cleanup failure without leaving an unowned final artifact', async () => {
    const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    const dir = mkTmp('ipc-transport-win32-post-link-cleanup');
    const portPath = path.join(dir, 'port');
    const realUnlinkSync = fs.unlinkSync.bind(fs);
    let injected = false;
    const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((target, ...args) => {
      if (
        typeof target === 'string'
        && path.basename(target).startsWith('.port.tmp.')
        && !injected
      ) {
        injected = true;
        throw Object.assign(new Error('temporary cleanup denied during publish'), { code: 'EACCES' });
      }
      return realUnlinkSync(target, ...args);
    });
    const transport = createIpcServer({
      platform: 'win32', portPath, username: 'alice', aclInspector, log: () => {},
    });

    try {
      await expect(transport.listen({ onRequest: () => {} })).rejects.toThrow(/temporary cleanup denied during publish/);
      expect(fs.existsSync(portPath)).toBe(false);
      expect(fs.existsSync(`${portPath}.tmp`)).toBe(false);
      expect(fs.existsSync(`${portPath}.lock`)).toBe(false);
      await expect(transport.close()).resolves.toBeUndefined();
    } finally {
      unlinkSpy.mockRestore();
      if (originalPlatformDescriptor) {
        Object.defineProperty(process, 'platform', originalPlatformDescriptor);
      } else {
        delete process.platform;
      }
    }
  });

  it('retains an uncertain Windows publication for an explicit cleanup retry', async () => {
    const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    const dir = mkTmp('ipc-transport-win32-publication-uncertain');
    const portPath = path.join(dir, 'port');
    let published = false;
    const realLinkSync = fs.linkSync.bind(fs);
    const linkSpy = vi.spyOn(fs, 'linkSync').mockImplementation((source, destination, ...args) => {
      const result = realLinkSync(source, destination, ...args);
      if (destination === portPath) published = true;
      return result;
    });
    const realUnlinkSync = fs.unlinkSync.bind(fs);
    const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((target, ...args) => {
      const name = typeof target === 'string' ? path.basename(target) : '';
      if (name.startsWith('.port.') && !name.startsWith('.port.tmp.') && !name.startsWith('.port.lock.')) {
        throw Object.assign(new Error('final rollback denied'), { code: 'EACCES' });
      }
      return realUnlinkSync(target, ...args);
    });
    const transport = createIpcServer({
      platform: 'win32',
      portPath,
      username: 'alice',
      aclInspector,
      reparseChecker: (candidate) => {
        if (published && candidate === portPath) throw new Error('post-link validation denied');
        return false;
      },
      log: () => {},
    });

    try {
      await expect(transport.listen({ onRequest: () => {} })).rejects.toMatchObject({
        code: 'GUARDIAN_TRANSPORT_CLEANUP_UNCERTAIN',
        message: 'Guardian discovery publication cleanup is uncertain',
      });
      expect(fs.existsSync(portPath)).toBe(true);
    } finally {
      unlinkSpy.mockRestore();
      linkSpy.mockRestore();
    }

    published = false;
    await expect(transport.close()).resolves.toBeUndefined();
    expect(fs.existsSync(portPath)).toBe(false);
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    } else {
      delete process.platform;
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

  it('recovers stale lock/tmp/discovery artifacts only after verified guardian death', () => {
    const dir = mkTmp('ipc-transport-win32-crash-restart');
    const portPath = path.join(dir, 'port');
    fs.writeFileSync(portPath, '127.0.0.1:4096\n');
    fs.writeFileSync(`${portPath}.lock`, 'stale-lock');
    fs.writeFileSync(`${portPath}.tmp`, 'stale-temp');
    const priorMarker = {
      status: 'valid',
      token: 'prior-token-win-restart',
      pid: 42422,
      identity: {
        processStartTicks: '12',
        launch: { commandLine: 'node openchamber-guardian.js', cwd: dir },
        owner: 'alice',
      },
    };

    recoverStaleGuardianTransportArtifacts({
      platform: 'win32',
      portPath,
      priorMarker,
      liveness: () => 'dead',
      username: 'alice',
      aclInspector,
    });
    expect(fs.existsSync(portPath)).toBe(false);
    expect(fs.existsSync(`${portPath}.lock`)).toBe(false);
    expect(fs.existsSync(`${portPath}.tmp`)).toBe(false);

    writeDiscoveryFileAtomic(portPath, 4100, {
      platform: 'win32', username: 'alice', aclInspector,
    });
    expect(fs.readFileSync(portPath, 'utf8')).toBe('127.0.0.1:4100\n');
  });

  it('rejects recovery when the final discovery file is replaced immediately before removal', () => {
    const dir = mkTmp('ipc-transport-win32-discovery-recovery-toctou');
    const portPath = path.join(dir, 'port');
    fs.writeFileSync(portPath, '127.0.0.1:4096\n');
    fs.writeFileSync(`${portPath}.lock`, 'stale-lock');
    fs.writeFileSync(`${portPath}.tmp`, 'stale-temp');
    const priorMarker = {
      status: 'valid',
      token: 'prior-token-win-discovery-recovery-toctou',
      pid: 42427,
      identity: {
        processStartTicks: '17',
        launch: { commandLine: 'node openchamber-guardian.js', cwd: dir },
        owner: 'alice',
      },
    };
    const replacementBody = '127.0.0.1:4101\n';
    let replaced = false;

    let recoveryError;
    try {
      recoverStaleGuardianTransportArtifacts({
        platform: 'win32',
        portPath,
        priorMarker,
        liveness: () => 'dead',
        username: 'alice',
        aclInspector,
        reparseChecker: (candidate) => {
          if (candidate === portPath && !replaced) {
            replaced = true;
            fs.unlinkSync(portPath);
            fs.writeFileSync(portPath, replacementBody);
          }
          return false;
        },
      });
    } catch (error) {
      recoveryError = error;
    }

    expect(recoveryError).toMatchObject({
      code: 'GUARDIAN_TRANSPORT_ARTIFACT_REPLACED',
    });

    expect(fs.readFileSync(portPath, 'utf8')).toBe(replacementBody);
  });

  it('leaves Windows transport artifacts untouched when the prior identity is live', () => {
    const dir = mkTmp('ipc-transport-win32-live-artifact');
    const portPath = path.join(dir, 'port');
    fs.writeFileSync(portPath, '127.0.0.1:4096\n');
    fs.writeFileSync(`${portPath}.lock`, 'live-lock');
    fs.writeFileSync(`${portPath}.tmp`, 'live-temp');
    const priorMarker = {
      status: 'valid',
      token: 'prior-token-win-live',
      pid: 42423,
      identity: {
        processStartTicks: '13',
        launch: { commandLine: 'node openchamber-guardian.js', cwd: dir },
        owner: 'alice',
      },
    };

    expect(() => recoverStaleGuardianTransportArtifacts({
      platform: 'win32',
      portPath,
      priorMarker,
      liveness: () => 'alive',
      readIdentity: () => priorMarker.identity,
      username: 'alice',
      aclInspector,
    })).toThrow(/requires verified prior guardian death/);
    expect(fs.existsSync(portPath)).toBe(true);
    expect(fs.existsSync(`${portPath}.lock`)).toBe(true);
    expect(fs.existsSync(`${portPath}.tmp`)).toBe(true);
  });

  it('validates existing ancestors before removing Windows lock/tmp artifacts', () => {
    const dir = mkTmp('ipc-transport-win32-ancestor-reparse');
    const unsafeParent = path.join(dir, 'unsafe-parent');
    const portPath = path.join(unsafeParent, 'nested', 'port');
    fs.mkdirSync(path.dirname(portPath), { recursive: true });
    fs.writeFileSync(portPath, '127.0.0.1:4096\n');
    fs.writeFileSync(`${portPath}.lock`, 'stale-lock');
    fs.writeFileSync(`${portPath}.tmp`, 'stale-temp');
    const priorMarker = {
      status: 'valid',
      token: 'prior-token-win-ancestor-reparse',
      pid: 42424,
      identity: {
        processStartTicks: '14',
        launch: { commandLine: 'node openchamber-guardian.js', cwd: dir },
        owner: 'alice',
      },
    };

    expect(() => recoverStaleGuardianTransportArtifacts({
      platform: 'win32',
      portPath,
      priorMarker,
      liveness: () => 'dead',
      username: 'alice',
      aclInspector,
      reparseChecker: (candidate) => candidate === unsafeParent,
    })).toThrow(/ancestor.*reparse point/);
    expect(fs.existsSync(portPath)).toBe(true);
    expect(fs.existsSync(`${portPath}.lock`)).toBe(true);
    expect(fs.existsSync(`${portPath}.tmp`)).toBe(true);
  });

  it('does not remove a Windows lock replaced after validation', () => {
    const dir = mkTmp('ipc-transport-win32-lock-toctou');
    const portPath = path.join(dir, 'port');
    fs.writeFileSync(portPath, '127.0.0.1:4096\n');
    const lockPath = `${portPath}.lock`;
    fs.writeFileSync(lockPath, 'stale-lock');
    fs.writeFileSync(`${portPath}.tmp`, 'stale-temp');
    const priorMarker = {
      status: 'valid',
      token: 'prior-token-win-toctou',
      pid: 42425,
      identity: {
        processStartTicks: '15',
        launch: { commandLine: 'node openchamber-guardian.js', cwd: dir },
        owner: 'alice',
      },
    };
    let replaced = false;

    expect(() => recoverStaleGuardianTransportArtifacts({
      platform: 'win32',
      portPath,
      priorMarker,
      liveness: () => 'dead',
      username: 'alice',
      aclInspector,
      reparseChecker: (candidate) => {
        if (candidate === lockPath && !replaced) {
          replaced = true;
          fs.unlinkSync(lockPath);
          fs.writeFileSync(lockPath, 'replacement-lock');
        }
        return false;
      },
    })).toThrow(/replaced guardian transport artifact/);
    expect(fs.readFileSync(lockPath, 'utf8')).toBe('replacement-lock');
    expect(fs.existsSync(`${portPath}.tmp`)).toBe(true);
    expect(fs.existsSync(portPath)).toBe(true);
  });

  it('does not remove a Windows temp artifact replaced immediately before quarantine', () => {
    const dir = mkTmp('ipc-transport-win32-temp-quarantine-toctou');
    const portPath = path.join(dir, 'port');
    const tempPath = `${portPath}.tmp`;
    fs.writeFileSync(tempPath, 'stale-temp');
    const priorMarker = {
      status: 'valid',
      token: 'prior-token-win-temp-quarantine-toctou',
      pid: 42426,
      identity: {
        processStartTicks: '16',
        launch: { commandLine: 'node openchamber-guardian.js', cwd: dir },
        owner: 'alice',
      },
    };
    const renameSync = fs.renameSync.bind(fs);
    let replaced = false;
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
      if (source === tempPath && !replaced) {
        replaced = true;
        fs.unlinkSync(tempPath);
        fs.writeFileSync(tempPath, 'replacement-temp');
      }
      return renameSync(source, destination);
    });

    try {
      expect(() => recoverStaleGuardianTransportArtifacts({
        platform: 'win32',
        portPath,
        priorMarker,
        liveness: () => 'dead',
        username: 'alice',
        aclInspector,
      })).toThrow(/replaced guardian transport artifact/);
      expect(fs.readFileSync(tempPath, 'utf8')).toBe('replacement-temp');
    } finally {
      renameSpy.mockRestore();
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
