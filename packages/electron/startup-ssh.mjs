// Connecting the default SSH instance while the app starts.
//
// An SSH instance's host entry points at a local forward that exists only
// while its tunnel runs, so probing it at boot always failed and the app
// opened Local instead. Startup now opens the tunnel first, bounded so a
// slow or unreachable host cannot hold the splash indefinitely; on failure
// the attempt is torn down and the caller falls back to Local.

const STARTUP_SSH_CONNECT_TIMEOUT_MS = 30_000;

/** The id of the default host when it is an SSH instance, else null. */
export const resolveDefaultSshInstanceId = (defaultHostId, instances) => {
  const id = String(defaultHostId || '').trim();
  if (!id) return null;
  return instances.some((instance) => instance?.id === id) ? id : null;
};

/**
 * Connect `instanceId` through `sshManager`, waiting at most `timeoutMs`.
 * Resolves `{ ok: true }` once the tunnel is ready, or `{ ok: false, reason }`
 * after disconnecting a failed or timed-out attempt. Never rejects.
 */
export const connectDefaultSshInstanceAtStartup = async ({
  sshManager,
  instanceId,
  timeoutMs = STARTUP_SSH_CONNECT_TIMEOUT_MS,
}) => {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, reason: 'timeout' }), timeoutMs);
  });
  const attempt = sshManager.connect(instanceId).then(
    () => ({ ok: true }),
    (error) => ({ ok: false, reason: error instanceof Error ? error.message : String(error) }),
  );
  const result = await Promise.race([attempt, timeout]);
  clearTimeout(timer);
  if (!result.ok) {
    // A timed-out attempt is still running; stop it so the switcher does not
    // later report a connection the user was told had failed.
    await sshManager.disconnect(instanceId).catch(() => {});
  }
  return result;
};
