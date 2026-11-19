
const STARTUP_SSH_CONNECT_TIMEOUT_MS = 30_000;

export const resolveDefaultSshInstanceId = (defaultHostId, instances) => {
  const id = String(defaultHostId || '').trim();
  if (!id) return null;
  return instances.some((instance) => instance?.id === id) ? id : null;
};

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
    await sshManager.disconnect(instanceId).catch(() => {});
  }
  return result;
};
