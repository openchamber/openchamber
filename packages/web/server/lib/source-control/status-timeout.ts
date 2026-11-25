export const STATUS_RESOLVE_TIMEOUT_MS = 12_000;

export const withTimeout = async <Value>(promise: Promise<Value>, timeoutMs: number, label: string) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(Object.assign(new Error(`${label} timed out after ${timeoutMs}ms`), { code: 'ETIMEDOUT' }));
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
};
