import { setTimeout as delay } from 'node:timers/promises';

export async function waitForHmrApi(port, { fetchImpl = fetch, now = Date.now, sleep = delay, timeoutMs = 60_000 } = {}) {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    try {
      const response = await fetchImpl(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1_000) });
      await response.body?.cancel();
      if (response.ok) return;
    } catch {
      // The server may still be starting.
    }
    await sleep(250);
  }
  throw new Error('Timed out waiting for the HMR API');
}
