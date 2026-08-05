/**
 * Shared concurrency gate for background network traffic.
 *
 * The browser allows only ~6 concurrent HTTP/1.1 connections per origin, and
 * every runtime (web, desktop loopback, VS Code, mobile host) funnels API
 * traffic through one origin. During startup many subsystems fan out at once —
 * per-directory session/status polls, git checks per project and worktree,
 * command/skill discovery, global session pages — and several of those calls
 * are slow while the OpenCode server is still warming up. Uncapped, they
 * occupy the whole connection pool and interactive traffic (opening a session
 * and fetching its messages) queues for seconds behind them.
 *
 * Every poll/prefetch-shaped background call should run through
 * {@link runBackgroundNetworkTask} so the aggregate background footprint stays
 * bounded and sockets remain free for the critical path. GitHub PR status has
 * its own dedicated gate (see useGitHubPrStatusStore) because a single PR
 * request can hold a socket for up to 12s and must not starve other
 * background work either; the two caps combined still leave sockets free.
 */

const BACKGROUND_NETWORK_CONCURRENCY = 3

let backgroundNetworkActive = 0
const backgroundNetworkWaiters: Array<() => void> = []

const acquireBackgroundNetworkSlot = (): Promise<void> => {
  if (backgroundNetworkActive < BACKGROUND_NETWORK_CONCURRENCY) {
    backgroundNetworkActive += 1
    return Promise.resolve()
  }
  return new Promise<void>((resolve) => {
    backgroundNetworkWaiters.push(resolve)
  })
}

const releaseBackgroundNetworkSlot = (): void => {
  const next = backgroundNetworkWaiters.shift()
  if (next) {
    // Hand the slot directly to the next waiter — keep the active count steady.
    next()
    return
  }
  backgroundNetworkActive = Math.max(0, backgroundNetworkActive - 1)
}

/** Run one background network call under the shared concurrency gate. */
export const runBackgroundNetworkTask = async <T>(task: () => Promise<T>): Promise<T> => {
  await acquireBackgroundNetworkSlot()
  try {
    return await task()
  } finally {
    releaseBackgroundNetworkSlot()
  }
}

/** Test-only visibility into the gate. */
export const getBackgroundNetworkState = () => ({
  active: backgroundNetworkActive,
  waiting: backgroundNetworkWaiters.length,
  limit: BACKGROUND_NETWORK_CONCURRENCY,
})
