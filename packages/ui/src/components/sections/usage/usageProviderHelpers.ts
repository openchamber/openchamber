import type { ProviderResult, QuotaProviderId, UsageWindow } from '@/types';
import { clampPercent } from '@/lib/quota';

export const getProviderUsedPercent = (
  usage: ProviderResult['usage'] | null | undefined,
): number | null => {
  const windows = usage?.windows ?? {};
  const values = Object.values(windows)
    .map((window) => window.usedPercent)
    .filter((value): value is number => typeof value === 'number');
  if (values.length === 0) return null;
  return Math.max(...values);
};

export const getProviderRemainingPercent = (
  usage: ProviderResult['usage'] | null | undefined,
): number | null => {
  const used = getProviderUsedPercent(usage);
  if (used === null) return null;
  const remaining = 100 - used;
  return clampPercent(remaining);
};

const COST_REMAINING_WINDOW_KEYS = [
  'credits',
  'credits_balance',
  'plan_limit',
  'billing_cycle',
  'on_demand',
] as const;

/**
 * Compact remaining readout for provider lists (sidebar): percent when available,
 * otherwise the cost/credit `valueLabel` from the primary quota window.
 */
export const getProviderRemainingDisplay = (
  usage: ProviderResult['usage'] | null | undefined,
): { kind: 'percent'; percent: number } | { kind: 'amount'; label: string } | null => {
  const remainingPercent = getProviderRemainingPercent(usage);
  if (remainingPercent !== null) {
    return { kind: 'percent', percent: remainingPercent };
  }

  const windows = usage?.windows ?? {};
  for (const key of COST_REMAINING_WINDOW_KEYS) {
    const label = windows[key]?.valueLabel?.trim();
    if (label) return { kind: 'amount', label };
  }
  for (const window of Object.values(windows)) {
    const label = window.valueLabel?.trim();
    if (label) return { kind: 'amount', label };
  }
  return null;
};

export const listProviderWindows = (
  usage: ProviderResult['usage'] | null | undefined,
): Array<{ label: string; window: UsageWindow }> => {
  if (!usage?.windows) return [];
  return Object.entries(usage.windows).map(([label, window]) => ({ label, window }));
};

const hasProviderId = (
  providerIds: ReadonlySet<string> | readonly string[] | undefined,
  providerId: string,
): boolean => {
  if (!providerIds) return false;
  if ('has' in providerIds) return providerIds.has(providerId);
  return providerIds.includes(providerId);
};

export type UsageProviderInclusionOptions = {
  configured?: boolean;
  /**
   * Quota IDs reported by GET /api/quota/providers (auth.json / managed
   * credentials). Authoritative for plugin OAuth and credential-backed quotas
   * even when a per-provider fetch fails or returns configured:false.
   */
  authConfiguredQuotaProviderIds?: ReadonlySet<string> | readonly string[];
  /** Quota IDs mapped from OpenCode-connected providers (Settings → Providers). */
  connectedQuotaProviderIds?: ReadonlySet<string> | readonly string[];
};

/** Provider is eligible for Usage (quota-configured and/or OpenCode-connected). */
export const isIncludedUsageProvider = (
  providerId: QuotaProviderId,
  options: UsageProviderInclusionOptions,
): boolean => {
  if (options.configured) return true;
  if (hasProviderId(options.authConfiguredQuotaProviderIds, providerId)) return true;
  return hasProviderId(options.connectedQuotaProviderIds, providerId);
};

export const isActiveProviderResult = (result: ProviderResult | undefined): boolean =>
  Boolean(result?.configured);

/**
 * Included providers appear in Usage unless the user explicitly removed them.
 * Auth-configured (plugin OAuth / auth.json) and OpenCode-connected providers
 * count even when a per-provider quota fetch reports not configured.
 */
export const isVisibleUsageProvider = (
  providerId: QuotaProviderId,
  options: UsageProviderInclusionOptions & {
    hiddenProviderIds: ReadonlySet<string> | readonly string[];
  },
): boolean => {
  if (!isIncludedUsageProvider(providerId, options)) return false;
  return !hasProviderId(options.hiddenProviderIds, providerId);
};
