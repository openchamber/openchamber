import net from 'node:net';
import path from 'node:path';
import { GuardianClient } from './guardian-client.js';
import { resolveManagedOpenCodeHandoffV2Root } from '../opencode/managed-opencode-handoff-v2/filesystem.js';
import { readDiscoveryFile } from './discovery-file.js';

/**
 * Guardian detection and bootstrap adoption.
 *
 * Intentional list-trust decision (Phase 2B):
 *   `detectAndAdoptGuardianChild()` calls `GuardianClient.list()` and trusts
 *   the returned `(pid, port, incarnation)` tuple for an `Active` child.
 *   This is the canonical bootstrap adoption path: the spawned child has
 *   already reached `Active`, so no spawn-time `claimCapability` is
 *   available to authenticate against.
 *
 *   The trust boundary is enforced by the IPC permissioning model, not by a
 *   protocol-level credential. The model differs per platform:
 *
 *     - Linux/POSIX (sub-phase W-A): v2 root dir is mode `0700` (UID-scoped);
 *       the IPC Unix-domain socket is mode `0600` (umask `0o077` + explicit
 *       `chmodSync` in the IPC transport factory); the atomic PID-file
 *       singleton guarantees one guardian per host per UID. Same-UID local
 *       processes are the documented trust boundary.
 *
 *     - Windows (sub-phase W-B, T2): the discovery file under
 *       `%LOCALAPPDATA%\openchamber\managed-opencode-handoff-v2\port` is
 *       ACL'd to the current Windows user via `icacls`; the IPC server
 *       binds `127.0.0.1` only on an ephemeral port and atomically publishes
 *       the port in the discovery file. Trust boundary: same-Windows-user
 *       local processes. This is **weaker** than the Linux `0600` socket
 *       model because any process running as that user can read the
 *       discovery file and dial the loopback port; the Linux trust boundary
 *       additionally requires the caller to own the socket file. Documented
 *       in `plans/vscode-handoff-design-notes.md` ("T2 trust model" section).
 *
 *   Cross-process adoption with a `claimCapability` (i.e. authenticating a
 *   caller that holds the spawn-time credential) is intentionally out of
 *   scope here and is tracked separately for a later handoff design.
 *
 * W-C: the `process.platform === 'win32'` early-return that previously
 * short-circuited `detectAndAdoptGuardianChild` on Windows is removed;
 * the function now attempts the loopback-TCP probe via `portPath`. The
 * two-arg form (`socketPath`, `portPath`) is the canonical call shape so
 * lifecycle wiring can dispatch per platform without a branch.
 */

const DEFAULT_CONNECT_TIMEOUT_MS = 100;

export function getGuardianSocketPath(rootDir) {
  return path.join(resolveManagedOpenCodeHandoffV2Root(rootDir), 'guardian.sock');
}

export function isGuardianRunning(socketPath, portPath) {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      // W-A: Windows branch. Preliminary; gated behind the same
      // `process.platform === 'win32'` early-return W-C removes. The
      // loopback dialer does not throw on construction so callers can
      // safely pass `portPath: undefined`; the read fails at probe
      // time with ENOENT, which we translate to "not running".
      if (typeof portPath !== 'string' || portPath.length === 0) {
        resolve(false);
        return;
      }
      let parsed;
      try {
        parsed = readDiscoveryFile(portPath, { platform: 'win32' });
      } catch {
        resolve(false);
        return;
      }
      if (!parsed || typeof parsed.port !== 'number') {
        resolve(false);
        return;
      }
      const socket = net.createConnection({ host: '127.0.0.1', port: parsed.port });
      const timer = setTimeout(() => {
        socket.destroy();
        resolve(false);
      }, DEFAULT_CONNECT_TIMEOUT_MS);
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => {
        clearTimeout(timer);
        socket.destroy();
        resolve(false);
      });
      return;
    }

    // POSIX path. Preserve the original `net.createConnection(path)`
    // behavior byte-for-byte.
    if (typeof socketPath !== 'string' || socketPath.length === 0) {
      resolve(false);
      return;
    }
    const socket = net.createConnection(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, DEFAULT_CONNECT_TIMEOUT_MS);

    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });

    socket.once('error', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(false);
    });
  });
}

export async function detectAndAdoptGuardianChild(socketPath, portPath) {
  // W-C: previously returned `null` on Windows before the W-B backend
  // shipped. The transport factory now handles both platforms; on
  // Windows we dial via `portPath` (loopback-TCP + discovery file),
  // on Linux we dial via `socketPath` (Unix-domain socket). The caller
  // picks which to pass; this function is platform-agnostic.
  const targetSocketPath = socketPath ?? getGuardianSocketPath();
  const targetPortPath = portPath;

  const running = await isGuardianRunning(targetSocketPath, targetPortPath);
  if (!running) {
    return null;
  }

  const client = new GuardianClient({
    socketPath: targetSocketPath,
    portPath: targetPortPath,
    connectTimeoutMs: 500,
  });
  try {
    await client.connect();
    const children = await client.list();
    if (!Array.isArray(children) || children.length === 0) {
      return null;
    }

    // Find the first active child with identity.
    const activeChild = children.find((child) =>
      child.state === 'active' && child.pid && child.port
    );
    if (!activeChild) {
      return null;
    }

    return {
      incarnation: activeChild.incarnation,
      pid: activeChild.pid,
      port: activeChild.port,
      url: `http://127.0.0.1:${activeChild.port}`,
    };
  } catch {
    return null;
  } finally {
    try {
      client.disconnect();
    } catch {
      // Ignore.
    }
  }
}
