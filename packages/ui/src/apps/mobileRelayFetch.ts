// Relay requests made while connecting a mobile device (health, session,
// pairing redeem, login). Each returns the failure reason next to the response
// so the connect trail says WHY a relay transport was rejected, and idempotent
// probes survive one dropped relay socket inside their time budget.

import type { RelayTunnelClient, RelayTunnelStatus } from '@/lib/relay/tunnel-client';

type RelayFetchOutcome = {
  response: Response | null;
  /** Why no response arrived: the tunnel error message or `timeout`. */
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

// True once the tunnel's own reconnect brings a channel back; false when the
// budget runs out, the tunnel is closed, or it parks in a terminal error that
// only an online/foreground wake retries.
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

/** One request, no retry: for non-idempotent calls such as pairing redeem. */
export const fetchThroughRelayOnce = (
  tunnel: RelayFetchTunnel,
  path: string,
  init: RequestInit | undefined,
  budgetMs: number,
): Promise<RelayFetchOutcome> => settleWithin(budgetMs, tunnel.fetch(path, init));

/**
 * An idempotent probe. When the relay socket drops before answering, the tunnel
 * reconnects on its own backoff; the probe waits for that and asks again, as
 * long as the budget lasts. A failure while the channel stays up is final.
 */
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
