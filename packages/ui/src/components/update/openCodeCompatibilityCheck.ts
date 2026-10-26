import { hasCompatibleManagedDesktopOpenCode } from '@/lib/desktop';
import { getRuntimeApiBaseUrl, getRuntimeKey } from '@/lib/runtime-switch';
import { fetchOpenCodeCompatibility, type OpenCodeCompatibility } from '@/lib/opencode/compatibility';

/** `null` when the desktop shell already knows its managed OpenCode is compatible. */
export type CompatibilityCheck = Promise<OpenCodeCompatibility | null>;

class StaleCompatibilityCheck extends Error {}

export const runCompatibilityCheck = async (): CompatibilityCheck => {
  const runtimeKey = getRuntimeKey();
  const apiBaseUrl = getRuntimeApiBaseUrl();
  if (await hasCompatibleManagedDesktopOpenCode()) return null;
  // A runtime switch during the native preflight makes this check stale; the
  // switch starts its own, and this one must not send a request for it.
  if (getRuntimeKey() !== runtimeKey || getRuntimeApiBaseUrl() !== apiBaseUrl) throw new StaleCompatibilityCheck();
  return fetchOpenCodeCompatibility();
};

let prefetchedCheck: { runtimeKey: string; check: CompatibilityCheck } | null = null;

/**
 * Starts the compatibility check at page load, alongside authentication, so
 * the gate has its answer when it mounts. On a server that still wants a
 * sign-in the early read fails, and the gate asks again once it mounts.
 */
export const prefetchOpenCodeCompatibility = (): void => {
  const check = runCompatibilityCheck();
  check.catch(() => undefined);
  prefetchedCheck = { runtimeKey: getRuntimeKey(), check };
};

export const takeCompatibilityCheck = (): CompatibilityCheck => {
  const prefetched = prefetchedCheck;
  prefetchedCheck = null;
  if (prefetched && prefetched.runtimeKey === getRuntimeKey()) {
    return prefetched.check.catch(runCompatibilityCheck);
  }
  return runCompatibilityCheck();
};
