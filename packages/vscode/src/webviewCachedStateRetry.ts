const CACHED_STATE_RETRY_DELAYS_MS = [500, 1500, 3500, 7000, 12000, 20000];

export function scheduleCachedStateRetries<Target>(input: {
  target: Target | undefined;
  getCurrent: () => Target | undefined;
  isConnected: () => boolean;
  send: () => void;
}): void {
  if (!input.isConnected()) return;
  const target = input.target;
  if (!target) return;
  for (const delayMs of CACHED_STATE_RETRY_DELAYS_MS) {
    setTimeout(() => {
      if (input.getCurrent() !== target) return;
      input.send();
    }, delayMs);
  }
}
