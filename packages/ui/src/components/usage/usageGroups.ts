import React from 'react';
import { useI18n } from '@/lib/i18n';
import { formatWindowLabel } from '@/lib/quota';
import { getDisplayModelName } from '@/lib/quota/model-families';
import { useQuotaProviders, useQuotaStore } from '@/stores/useQuotaStore';
import type { ProviderResult, QuotaProviderId, UsageWindow } from '@/types';
import { selectVisibleModelEntries } from './usageModelSelection';

export type UsageLimitRow = {
  key: string;
  label: string;
  subtitle?: string;
  window: UsageWindow;
};

export type UsageProviderGroup = {
  providerId: QuotaProviderId;
  providerName: string;
  planLabel?: string | null;
  accountLabel?: string | null;
  accountSource?: ProviderResult['accountSource'];
  providers: string[];
  rows: UsageLimitRow[];
  /** Provider-level message: a fetch error, or "nothing reported". */
  status: string | null;
};

export function usageRows(
  providerId: QuotaProviderId,
  usage: ProviderResult['usage'] | undefined,
  selectedModels: readonly string[],
): UsageLimitRow[] {
  const rows = Object.entries(usage?.windows ?? {}).map(([label, window]): UsageLimitRow =>
    ({ key: `window-${label}`, label: formatWindowLabel(label), window }),
  );
  const modelEntries = Object.entries(usage?.models ?? {});
  for (const [modelName, modelUsage] of selectVisibleModelEntries(providerId, modelEntries, selectedModels)) {
    const first = Object.entries(modelUsage.windows ?? {})[0];
    if (!first) continue;
    const [label, window] = first;
    rows.push({
      key: `model-${modelName}-${label}`,
      label: formatWindowLabel(label),
      subtitle: getDisplayModelName(modelName),
      window,
    });
  }
  return rows;
}

/**
 * Quota windows grouped by provider, shaped for the compact usage list.
 *
 * Shared by the mobile session-metadata popover and the work-status panel so
 * the two cannot drift on which providers appear, how model rows are filtered,
 * or what counts as a provider-level status.
 *
 * Include selected, configured providers and first-load failures whose
 * configuration is still unknown. Confirmed unconfigured providers stay hidden.
 */
export const useUsageProviderGroups = (): UsageProviderGroup[] => {
  const { t } = useI18n();
  const quotaResults = useQuotaStore((state) => state.results);
  const refreshErrors = useQuotaStore((state) => state.refreshErrors);
  const dropdownProviderIds = useQuotaStore((state) => state.dropdownProviderIds);
  const selectedQuotaModels = useQuotaStore((state) => state.selectedModels);
  const providers = useQuotaProviders();

  return React.useMemo<UsageProviderGroup[]>(() => {
    const resultsByProvider = new Map(quotaResults.map((result) => [result.providerId, result]));
    return providers
      .filter((providerMeta) => dropdownProviderIds.includes(providerMeta.id))
      .filter((providerMeta) => {
        const result = resultsByProvider.get(providerMeta.id);
        return result?.configured === true || (!result && Boolean(refreshErrors[providerMeta.id]));
      })
      .map((providerMeta) => {
        const result = resultsByProvider.get(providerMeta.id);
        const rows = usageRows(providerMeta.id, result?.usage, selectedQuotaModels[providerMeta.id] ?? []);
        const refreshError = refreshErrors[providerMeta.id];
        let status: string | null = null;
        if (refreshError) {
          status = result?.usage
            ? t('header.services.usageRefreshFailedStale', { error: refreshError })
            : refreshError;
        } else if (!result?.ok && result?.error) {
          status = result.error;
        } else if (rows.length === 0) {
          status = t('header.services.noRateLimitsReported');
        }

        return {
          providerId: providerMeta.id,
          providerName: providerMeta.name,
          planLabel: result?.planLabel,
          accountLabel: result?.accountLabel,
          accountSource: result?.accountSource,
          providers: providerMeta.providers ?? [],
          rows,
          status,
        };
      });
  }, [dropdownProviderIds, providers, quotaResults, refreshErrors, selectedQuotaModels, t]);
};
