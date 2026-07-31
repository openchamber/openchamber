import net from 'node:net';
import path from 'node:path';
import { GuardianClient } from './guardian-client.js';
import { resolveGuardianPaths } from './paths.js';
import { readDiscoveryFile } from './discovery-file.js';

/**
 * Guardian detection and bootstrap adoption.
 *
 * Intentional list-trust decision (Phase 2B):
 *   `detectAndAdoptGuardianChild()` calls `GuardianClient.list()` and trusts
 *   only the returned `Active` child whose stable owner/runtime identity
 *   exactly matches this OpenChamber instance. Ownerless records and multiple
 *   matches fail closed; list order is never an ownership decision.
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
const isCanonicalProcessStartTicks = (value) => typeof value === 'string'
  && /^(?:0|[1-9]\d*)$/.test(value);

export function selectGuardianChild(children, { expectedOwner } = {}) {
  if (!Array.isArray(children) || children.length === 0) return null;

  const activeChildren = children.filter((child) => child?.state === 'active');
  const hasExpectedOwner = typeof expectedOwner?.ownerInstanceId === 'string'
    && expectedOwner.ownerInstanceId.length > 0
    && typeof expectedOwner?.runtimeIdentity === 'string'
    && expectedOwner.runtimeIdentity.length > 0;
  if (!hasExpectedOwner) {
    const error = new Error('Guardian adoption requires a stable expected owner identity');
    error.code = 'GUARDIAN_ADOPTION_OWNER_REQUIRED';
    throw error;
  }

  const hasCompleteOwner = (child) => typeof child?.ownerInstanceId === 'string'
    && child.ownerInstanceId.length > 0
    && typeof child?.runtimeIdentity === 'string'
    && child.runtimeIdentity.length > 0;
  const isExactOwner = (child) => hasCompleteOwner(child)
    && child.ownerInstanceId === expectedOwner.ownerInstanceId
    && child.runtimeIdentity === expectedOwner.runtimeIdentity;
  // A complete, different owner is unrelated to this startup and must not
  // block it.  Ownerless records remain globally ambiguous and therefore
  // continue to fail closed rather than being guessed as foreign.
  const isRelevantToExpectedOwner = (child) => !hasCompleteOwner(child) || isExactOwner(child);

  const unresolvedChild = children.find((child) =>
    isRelevantToExpectedOwner(child)
    && (
      child?.state === 'attention'
      || child?.state === 'stopping'
      || child?.state === 'handoff-prepared'
      || child?.state === 'unknown'
    )
  );
  if (unresolvedChild) {
    const error = new Error(
      `Guardian adoption requires attention: child ${unresolvedChild.incarnation || 'unknown'} is in unresolved ${unresolvedChild.state || 'unknown'} state`,
    );
    error.code = 'GUARDIAN_ADOPTION_ATTENTION';
    throw error;
  }

  const ownerlessActive = activeChildren.find((child) =>
    typeof child?.ownerInstanceId !== 'string'
    || typeof child?.runtimeIdentity !== 'string'
    || typeof child?.launchFingerprint !== 'string'
    || child.ownerInstanceId.length === 0
    || child.runtimeIdentity.length === 0
    || child.launchFingerprint.length === 0
  );
  if (ownerlessActive) {
    const error = new Error(
      `Guardian adoption refused: active child ${ownerlessActive.incarnation || 'unknown'} has no complete owner identity`,
    );
    error.code = 'GUARDIAN_ADOPTION_OWNER_INVALID';
    throw error;
  }

  const incompleteLaunchIdentity = activeChildren.find((child) =>
    isRelevantToExpectedOwner(child)
    && (
    !child?.launchSpec
    || typeof child.launchSpec !== 'object'
    || !Number.isSafeInteger(child?.pid)
    || child.pid <= 0
    || !Number.isSafeInteger(child?.port)
    || child.port <= 0
    || child.port > 65535
    || !isCanonicalProcessStartTicks(child?.processStartTicks)
    )
  );
  if (incompleteLaunchIdentity) {
    const error = new Error(
      `Guardian adoption refused: active child ${incompleteLaunchIdentity.incarnation || 'unknown'} has no complete launch identity`,
    );
    error.code = 'GUARDIAN_ADOPTION_RECORD_INVALID';
    throw error;
  }

  const matchingChildren = activeChildren.filter((child) =>
    child.ownerInstanceId === expectedOwner.ownerInstanceId
    && child.runtimeIdentity === expectedOwner.runtimeIdentity
    && child.pid
    && child.port
  );
  if (matchingChildren.length > 1) {
    const error = new Error(
      `Guardian adoption conflict: ${matchingChildren.length} active children match owner ${expectedOwner.ownerInstanceId}`,
    );
    error.code = 'GUARDIAN_ADOPTION_CONFLICT';
    throw error;
  }
  return matchingChildren[0] || null;
}

export function getGuardianSocketPath(rootDir) {
  const paths = resolveGuardianPaths(rootDir === undefined ? {} : { rootDir });
  // Windows uses `portPath` for transport, but retain a deterministic socket
  // label for CLI/status callers and cross-platform client construction.
  return paths.socketPath ?? path.join(paths.rootDir, 'guardian.sock');
}

export function isGuardianRunning(socketPath, portPath) {
  return new Promise((resolve, reject) => {
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
      } catch (error) {
        if (error?.code === 'ENOENT') {
          resolve(false);
        } else {
          reject(error);
        }
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

export async function detectAndAdoptGuardianChild(socketPath, portPath, { expectedOwner } = {}) {
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
    authSecretPath: resolveGuardianPaths({
      socketPath: targetSocketPath,
      portPath: targetPortPath,
    }).authSecretPath,
    connectTimeoutMs: 500,
    requestTimeoutMs: 1000,
  });
  try {
    await client.connect();
    const children = await client.list();
    if (!Array.isArray(children)) {
      const error = new Error('Guardian adoption refused: child list is malformed');
      error.code = 'GUARDIAN_ADOPTION_RECORD_INVALID';
      throw error;
    }
    if (children.length === 0) {
      return null;
    }

    const activeChild = selectGuardianChild(children, { expectedOwner });
    if (!activeChild) {
      return null;
    }

    const health = await client.health({ incarnation: activeChild.incarnation });
    if (health?.healthy !== true) {
      const error = new Error(
        `Guardian adoption refused: active child ${activeChild.incarnation || 'unknown'} is not healthy`,
      );
      error.code = 'GUARDIAN_ADOPTION_UNHEALTHY';
      throw error;
    }

    return {
      incarnation: activeChild.incarnation,
      pid: activeChild.pid,
      port: activeChild.port,
      url: `http://127.0.0.1:${activeChild.port}`,
      ...(activeChild.ownerInstanceId && activeChild.runtimeIdentity && activeChild.launchFingerprint
        ? {
          owner: {
            ownerInstanceId: activeChild.ownerInstanceId,
            runtimeIdentity: activeChild.runtimeIdentity,
            launchFingerprint: activeChild.launchFingerprint,
          },
        }
        : {}),
      launchSpec: activeChild.launchSpec,
    };
  } catch (error) {
    if (typeof error?.code === 'string' && error.code.startsWith('GUARDIAN_ADOPTION_')) {
      throw error;
    }
    const adoptionError = new Error(
      `Guardian adoption inspection failed: ${error?.message || String(error)}`,
    );
    adoptionError.code = 'GUARDIAN_ADOPTION_UNAVAILABLE';
    throw adoptionError;
  } finally {
    try {
      if (typeof client.detach === 'function') {
        client.detach();
      } else {
        client.disconnect();
      }
    } catch {
      // Ignore.
    }
  }
}
