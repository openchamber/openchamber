
import type { RelayTunnelClient, RelayTunnelStatus } from '@/lib/relay/tunnel-client';

type RelayFetchOutcome = {
  response: Response | null;
  failure: string | null;
};

type RelayFetchTunnel = Pick<RelayTunnelClient, 'fetch' | 'getStatus' | 'subscribeStatus'>;

const settleWithin = async (
  timeoutMs: number,
  request: Promise<Response>,
): Promise<RelayFetchOutcome> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<RelayFetchOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ response: null, failure: 'timeout' }), timeoutMs);
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
): Promise<RelayFetchOutcome> => settleWithin(budgetMs, tunnel.fetch(path, init));

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
