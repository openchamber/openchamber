/**
 * The webview only leaves its initial loading screen once it receives a
 * `connectionStatus: connected` message. VS Code drops postMessage calls made
 * before the webview's acquireVsCodeApi bridge is ready (common in
 * code-server / slow or flaky networks), so a single send can be lost
 * forever. Re-sending the cached state at staggered delays bounds the wait
 * without needing a webview-side ack protocol; the payload is idempotent
 * (connection status + window focus), so duplicate deliveries are harmless.
 */
const CACHED_STATE_RETRY_DELAYS_MS = [500, 1500, 3500, 7000, 12000, 20000];

export function scheduleCachedStateRetries<Target>(input: {
  /** The panel/view the retries belong to. */
  target: Target | undefined;
  /** Reads the provider's CURRENT panel/view, so a replaced target stops its stale retries. */
  getCurrent: () => Target | undefined;
  /** Retries only make sense for the connected transition. */
  isConnected: () => boolean;
  /** Re-sends the provider's cached state. */
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
