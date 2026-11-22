
import type { RelayTunnelClient, RelayTunnelStatus } from '@/lib/relay/tunnel-client';

type RelayFetchOutcome = {
  response: Response | null;
  failure: string | null;
};

type RelayFetchTunnel = Pick<RelayTunnelClient, 'fetch' | 'getStatus' | 'subscribeStatus'>;

const settleWithin = async (
  timeoutMs: number,
  request: Promise<Response>,
  onTimeout?: () => void,
): Promise<RelayFetchOutcome> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<RelayFetchOutcome>((resolve) => {
    timer = setTimeout(() => {
      // Cancel the attempt itself, not just the wait (#2229): an
      // un-aborted request keeps its tunnel stream alive after the
      // caller has already been told the attempt timed out.
      onTimeout?.();
      resolve({ response: null, failure: 'timeout' });
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      request.then(
        (response): RelayFetchOutcome => ({ response, failure: null }),
        (error): RelayFetchOutcome => ({ response: null, failure: error instanceof Error ? error.message : String(error) }),
      ),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

const waitForReconnect = (tunnel: RelayFetchTunnel, timeoutMs: number): Promise<boolean> =>
  new Promise((resolve) => {
    const finish = (connected: boolean) => {
      clearTimeout(timer);
      unsubscribe();
      resolve(connected);
    };
    const check = (status: RelayTunnelStatus) => {
      if (status.state === 'connected') finish(true);
      else if (status.state === 'idle' || status.terminal) finish(false);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    const unsubscribe = tunnel.subscribeStatus(check);
    check(tunnel.getStatus());
  });

export const fetchThroughRelayOnce = (
  tunnel: RelayFetchTunnel,
  path: string,
  init: RequestInit | undefined,
  budgetMs: number,
): Promise<RelayFetchOutcome> => {
  // A fresh controller per attempt (#2229): the timeout aborts this
  // attempt's signal -- which makes the tunnel client remove the stream
  // and send StreamAbort -- and a retry through this function gets a new,
  // un-aborted signal. A caller-provided signal is linked, not replaced,
  // so caller cancellation still reaches the request.
  const controller = new AbortController();
  const callerSignal = init?.signal;
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort();
    else callerSignal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  return settleWithin(
    budgetMs,
    tunnel.fetch(path, { ...init, signal: controller.signal }),
    () => controller.abort(),
  );
};

export const fetchThroughRelayWithRetry = async (
  tunnel: RelayFetchTunnel,
  path: string,
  init: RequestInit | undefined,
  budgetMs: number,
): Promise<RelayFetchOutcome> => {
  const deadline = Date.now() + budgetMs;
  let outcome = await fetchThroughRelayOnce(tunnel, path, init, budgetMs);
  while (!outcome.response && outcome.failure !== 'timeout' && tunnel.getStatus().state !== 'connected') {
    const remaining = deadline - Date.now();
    if (remaining <= 0 || !await waitForReconnect(tunnel, remaining)) return outcome;
    const retryBudget = deadline - Date.now();
    if (retryBudget <= 0) return outcome;
    outcome = await fetchThroughRelayOnce(tunnel, path, init, retryBudget);
  }
  return outcome;
};
