import net from 'node:net';
import path from 'node:path';
import { GuardianClient } from './guardian-client.js';
import { resolveManagedOpenCodeHandoffV2Root } from '../opencode/managed-opencode-handoff-v2/filesystem.js';

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
 *   protocol-level credential:
 *     - v2 root dir is mode `0700` (UID-scoped)
 *     - the IPC Unix-domain socket is mode `0600` (umask `0o077` + explicit
 *       `chmodSync` in `GuardianIpcServer.start()`)
 *     - the atomic PID-file singleton guarantees one guardian per host
 *       per UID
 *     - same-UID local processes are the documented trust boundary
 *
 *   Cross-process adoption with a `claimCapability` (i.e. authenticating a
 *   caller that holds the spawn-time credential) is intentionally out of
 *   scope here and is tracked separately for a later handoff design.
 */

const DEFAULT_CONNECT_TIMEOUT_MS = 100;

export function getGuardianSocketPath(rootDir) {
  return path.join(resolveManagedOpenCodeHandoffV2Root(rootDir), 'guardian.sock');
}

export function isGuardianRunning(socketPath) {
  return new Promise((resolve) => {
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

export async function detectAndAdoptGuardianChild(socketPath) {
  if (process.platform === 'win32') {
    return null;
  }

  const targetSocketPath = socketPath ?? getGuardianSocketPath();

  const running = await isGuardianRunning(targetSocketPath);
  if (!running) {
    return null;
  }

  const client = new GuardianClient({ socketPath: targetSocketPath, connectTimeoutMs: 500 });
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
