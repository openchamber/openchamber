import { hasCompatibleManagedDesktopOpenCode } from '@/lib/desktop';
import { getRuntimeApiBaseUrl, getRuntimeKey } from '@/lib/runtime-switch';
import { fetchOpenCodeCompatibility, type OpenCodeCompatibility } from '@/lib/opencode/compatibility';

export type CompatibilityCheck = Promise<OpenCodeCompatibility | null>;

class StaleCompatibilityCheck extends Error {}

export const runCompatibilityCheck = async (): CompatibilityCheck => {
  const runtimeKey = getRuntimeKey();
  const apiBaseUrl = getRuntimeApiBaseUrl();
  if (await hasCompatibleManagedDesktopOpenCode()) return null;
  if (getRuntimeKey() !== runtimeKey || getRuntimeApiBaseUrl() !== apiBaseUrl) throw new StaleCompatibilityCheck();
  return fetchOpenCodeCompatibility();
};

let prefetchedCheck: { runtimeKey: string; check: CompatibilityCheck } | null = null;

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
