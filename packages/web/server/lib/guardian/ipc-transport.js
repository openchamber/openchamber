import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { resolveManagedOpenCodeHandoffV2Root } from '../opencode/managed-opencode-handoff-v2/filesystem.js';
import { readDiscoveryFile, removeDiscoveryFile, writeDiscoveryFileAtomic } from './discovery-file.js';

/**
 * IPC transport abstraction (W-A factory + W-B Windows backend).
 *
 * Single seam for the guardian IPC transport. On Linux/POSIX the
 * factory wraps the existing `net.createServer(path)` + `chmodSync(0o600)`
 * + umask `0o077` + remove-socket-on-stop logic that previously lived
 * inline in `ipc-server.js`. On Windows (W-B) the factory binds a
 * localhost TCP server on an ephemeral port, publishes a per-user-ACL'd
 * discovery file, and removes the file on close.
 *
 * The factory is the ONLY place in `packages/web/server/lib/guardian/`
 * that calls `net.createServer`, `net.createConnection`, `chmodSync`,
 * `process.umask`, or knows about platform-specific socket path
 * semantics. Consumers (`GuardianIpcServer`, `GuardianClient`,
 * `isGuardianRunning`) use the returned `{ listen, close }` and dialer
 * handle without any platform knowledge.
 */

const DEFAULT_SOCKET_MODE = 0o600;
const DEFAULT_UMASK = 0o077;
const LOOPBACK_HOST = '127.0.0.1';

const POSIX_PLATFORMS = new Set(['linux', 'darwin', 'freebsd', 'openbsd', 'netbsd', 'sunos', 'aix']);

const isPosixPlatform = (platform) => POSIX_PLATFORMS.has(platform);

/**
 * Resolve the default per-platform IPC paths used by the guardian
 * entrypoint and consumers. The result intentionally has `undefined`
 * for the slot the platform does not use so callers can detect which
 * transport to dial.
 *
 * @param {object} options
 * @param {NodeJS.Platform} options.platform
 * @param {string} [options.rootDir] - POSIX v2 root (for `socketPath`).
 * @param {string} [options.portDir] - Windows v2 root (for `portPath`).
 * @returns {{ socketPath: string|undefined, portPath: string|undefined }}
 */
export function defaultIpcPaths({ platform, rootDir, portDir } = {}) {
  if (platform === 'win32') {
    if (typeof portDir !== 'string' || portDir.length === 0) {
      throw new TypeError('defaultIpcPaths: Windows portDir is required');
    }
    return {
      socketPath: undefined,
      portPath: path.join(resolveManagedOpenCodeHandoffV2Root(portDir), 'port'),
    };
  }

  if (isPosixPlatform(platform)) {
    if (typeof rootDir !== 'string' || rootDir.length === 0) {
      throw new TypeError('defaultIpcPaths: POSIX rootDir is required');
    }
    return {
      socketPath: path.join(resolveManagedOpenCodeHandoffV2Root(rootDir), 'guardian.sock'),
      portPath: undefined,
    };
  }

  // FIXME: extend the factory for any new platform. Failing closed
  // here is intentional: a silently-misrouted transport is a security
  // bug.
  throw new Error(`defaultIpcPaths: unsupported platform: ${String(platform)}`);
}

/**
 * Construct a platform-specific IPC server backend.
 *
 * The returned object exposes a transport-agnostic
 * `{ listen({ onRequest }), close() }` surface. `onRequest(socket)` is
 * invoked once per accepted connection with a duplex `net.Socket`-like
 * object whose `on('data')` / `write(line)` work the same on every
 * transport — the JSON-line protocol layer in `GuardianIpcServer` is
 * therefore platform-independent.
 *
 * @param {object} options
 * @param {NodeJS.Platform} options.platform
 * @param {string} [options.socketPath] - POSIX Unix-domain socket path.
 * @param {string} [options.portPath] - Windows discovery-file path.
 * @param {string} [options.username] - Windows-only: current user
 *   for the discovery-file ACL. Required on Windows so the per-user
 *   trust boundary is established before the listener publishes the
 *   port.
 * @param {(message: string) => void} [options.log]
 */
export function createIpcServer({ platform, socketPath, portPath, username, log = () => {} } = {}) {
  if (platform === 'win32') {
    return createWindowsIpcServer({ portPath, username, log });
  }

  // POSIX backend. Preserve the byte-for-byte behavior the previous
  // `ipc-server.js` had: `umask(0o077)` around the listen call, then
  // explicit `chmodSync(path, 0o600)`, and `unlinkSync(path)` on close.
  if (typeof socketPath !== 'string' || socketPath.length === 0) {
    throw new TypeError('createIpcServer: POSIX socketPath is required');
  }

  let server = null;
  const sockets = new Set();

  const listen = ({ onRequest }) => new Promise((resolve, reject) => {
    if (server) {
      reject(new Error('createIpcServer: already listening'));
      return;
    }

    const onConnection = (socket) => {
      sockets.add(socket);
      socket.on('close', () => {
        sockets.delete(socket);
      });
      socket.on('error', (error) => {
        log(`[guardian-ipc] socket error: ${error.message}`);
        sockets.delete(socket);
      });
      if (typeof onRequest === 'function') {
        onRequest(socket);
      }
    };

    server = net.createServer(onConnection);

    server.on('error', (error) => {
      if (error.code === 'EADDRINUSE') {
        reject(new Error(`Guardian IPC socket already in use: ${socketPath}`));
        return;
      }
      reject(error);
    });

    const previousUmask = process.umask(DEFAULT_UMASK);
    server.listen(socketPath, () => {
      process.umask(previousUmask);
      if (platform !== 'win32') {
        try {
          fs.chmodSync(socketPath, DEFAULT_SOCKET_MODE);
        } catch (chmodError) {
          log(`[guardian-ipc] failed to chmod socket: ${chmodError.message}`);
        }
      }
      log(`[guardian-ipc] listening on ${socketPath}`);
      resolve();
    });
  });

  const close = () => new Promise((resolve) => {
    if (!server) {
      resolve();
      return;
    }
    for (const socket of sockets) {
      try {
        socket.end();
        socket.destroy();
      } catch {
        // Ignore.
      }
    }
    sockets.clear();

    const activeServer = server;
    server = null;

    activeServer.close(() => {
      resolve();
    });

    if (platform !== 'win32') {
      try {
        fs.unlinkSync(socketPath);
      } catch {
        // Ignore.
      }
    }
  });

  return { listen, close };
}

/**
 * Windows backend of `createIpcServer`. Binds loopback TCP on an
 * ephemeral port, atomically publishes a per-user-ACL'd discovery
 * file at `<portPath>` BEFORE resolving `listen()`, and removes the
 * discovery file as the LAST step of `close()`.
 *
 * Ordering invariants (closes F-6):
 *   - `listen()` resolves only after the discovery file is published.
 *   - `close()` removes the discovery file only after the listener
 *     stops accepting; a client observing `portPath` is therefore
 *     guaranteed the listener is up.
 *   - The discovery file is created with O_EXCL and ACL'd to the
 *     current user before the atomic rename to its final name.
 *
 * @param {object} options
 * @param {string} options.portPath
 * @param {string} [options.username]
 * @param {(message: string) => void} [options.log]
 */
function createWindowsIpcServer({ portPath, username, log } = {}) {
  if (typeof portPath !== 'string' || portPath.length === 0) {
    throw new TypeError('createIpcServer: Windows portPath is required');
  }

  let server = null;
  const sockets = new Set();
  let discoveryPublished = false;

  const listen = ({ onRequest }) => new Promise((resolve, reject) => {
    if (server) {
      reject(new Error('createIpcServer: already listening'));
      return;
    }

    const onConnection = (socket) => {
      sockets.add(socket);
      socket.on('close', () => {
        sockets.delete(socket);
      });
      socket.on('error', (error) => {
        log(`[guardian-ipc] socket error: ${error.message}`);
        sockets.delete(socket);
      });
      if (typeof onRequest === 'function') {
        onRequest(socket);
      }
    };

    server = net.createServer(onConnection);

    server.on('error', (error) => {
      if (error.code === 'EADDRINUSE') {
        reject(new Error(`Guardian IPC TCP port is already in use (EADDRINUSE)`));
        return;
      }
      reject(error);
    });

    server.listen({ host: LOOPBACK_HOST, port: 0 }, () => {
      // Capture the ephemeral port the OS assigned.
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      if (typeof port !== 'number' || port <= 0 || port > 65535) {
        const err = new Error(`createIpcServer: bound to invalid TCP port ${port}`);
        try { server.close(); } catch { /* ignore */ }
        server = null;
        reject(err);
        return;
      }

      // Publish the discovery file BEFORE resolving. If the ACL fails,
      // we tear down the listener and reject; the user sees a clear
      // "icacls failed" error instead of a phantom listener.
      try {
        writeDiscoveryFileAtomic(portPath, port, { platform: 'win32', username, log });
      } catch (publishError) {
        try { server.close(); } catch { /* ignore */ }
        server = null;
        reject(publishError);
        return;
      }
      discoveryPublished = true;
      log(`[guardian-ipc] listening on 127.0.0.1:${port} (discovery at ${portPath})`);
      resolve();
    });
  });

  const close = () => new Promise((resolve) => {
    // No-op if listen() never ran.
    if (!server) {
      resolve();
      return;
    }

    for (const socket of sockets) {
      try {
        socket.end();
        socket.destroy();
      } catch {
        // Ignore.
      }
    }
    sockets.clear();

    const activeServer = server;
    server = null;
    const hadPublished = discoveryPublished;
    discoveryPublished = false;

    activeServer.close(() => {
      // Remove the discovery file LAST, after the listener is fully
      // closed. The Windows backend order matters: if the file were
      // removed before the listener closed, a client could observe
      // the port and dial a dying listener.
      if (hadPublished) {
        try {
          removeDiscoveryFile(portPath, { platform: 'win32' });
        } catch (error) {
          log(`[guardian-ipc] failed to remove discovery file: ${error.message}`);
        }
      }
      resolve();
    });
  });

  return { listen, close };
}

/**
 * Construct a platform-specific IPC dialer handle.
 *
 * Returns a function `dial() => Promise<net.Socket>` that, when called,
 * yields a connected duplex socket. Errors surface at call time so
 * `GuardianClient` can wrap them in its own `GuardianClientError`
 * shape.
 *
 * Construction itself never throws on Windows with a non-existent
 * `portPath`; the missing file is a runtime concern handled by the
 * consumer's connect-time error path.
 *
 * @param {object} options
 * @param {NodeJS.Platform} options.platform
 * @param {string} [options.socketPath]
 * @param {string} [options.portPath]
 */
export function createIpcDialer({ platform, socketPath, portPath } = {}) {
  if (platform === 'win32') {
    return async function dial() {
      if (typeof portPath !== 'string' || portPath.length === 0) {
        throw new Error('createIpcDialer: Windows portPath is required');
      }
      // Throws on missing/unreadable file. Caller (`GuardianClient`)
      // wraps this in its own error shape.
      const parsed = readDiscoveryFile(portPath, { platform: 'win32' });
      if (!parsed || typeof parsed.port !== 'number' || !Number.isFinite(parsed.port)) {
        throw new Error(`createIpcDialer: discovery file at ${portPath} is malformed`);
      }
      // Hard-bind to 127.0.0.1 (Design Invariant #6). The discovery
      // file is the only thing that points at the guardian; the
      // resolved `host` is always loopback.
      return net.createConnection({ host: LOOPBACK_HOST, port: parsed.port });
    };
  }

  if (typeof socketPath !== 'string' || socketPath.length === 0) {
    throw new TypeError('createIpcDialer: POSIX socketPath is required');
  }

  return function dial() {
    return net.createConnection(socketPath);
  };
}
