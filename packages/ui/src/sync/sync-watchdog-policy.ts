

export const ACTIVE_SESSION_WATCHDOG_INTERVAL_MS = 5_000

export const ACTIVE_SESSION_STATUS_POLL_INTERVAL_MS = 5_000

export const ACTIVE_SESSION_STATUS_POLL_HEALTHY_INTERVAL_MS = 30_000

export const ACTIVE_SESSION_STATUS_POLL_MAX_BACKOFF_MS = 60_000

export const ACTIVE_SESSION_STALE_EVENT_MS = 20_000

export const ACTIVE_SESSION_FULL_RESYNC_COOLDOWN_MS = 15_000

export const CHILD_SESSION_DISCOVERY_RETRY_MS = 15_000

export const CHILD_SESSION_DISCOVERY_WAIT_MS = 30_000

const WATCHDOG_READ_MAX_BACKOFF_MS = 60_000

export type DirectoryReadBackoff = Map<string, { delay: number; retryAt: number }>

export function recordWatchdogReadFailure(backoff: DirectoryReadBackoff, directory: string, interval: number): void {
  const delay = Math.min((backoff.get(directory)?.delay ?? interval) * 2, WATCHDOG_READ_MAX_BACKOFF_MS)
  backoff.set(directory, { delay, retryAt: Date.now() + delay })
}

export function shouldTriggerStaleResync(
  lastStreamActivityAt: number,
  lastFullResyncAt: number,
  now: number,
  staleThresholdMs: number = ACTIVE_SESSION_STALE_EVENT_MS,
  resyncCooldownMs: number = ACTIVE_SESSION_FULL_RESYNC_COOLDOWN_MS,
): boolean {
  if (lastStreamActivityAt <= 0) return false
  if (now - lastStreamActivityAt < staleThresholdMs) return false
  if (now - lastFullResyncAt < resyncCooldownMs) return false
  return true
}
