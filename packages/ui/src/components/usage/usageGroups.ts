import React from 'react';
import { useI18n } from '@/lib/i18n';
import { formatWindowLabel, QUOTA_PROVIDERS } from '@/lib/quota';
import { getDisplayModelName } from '@/lib/quota/model-families';
import { useQuotaStore } from '@/stores/useQuotaStore';
import type { QuotaProviderId, UsageWindow } from '@/types';

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
  rows: UsageLimitRow[];
  /** Provider-level message: a fetch error, or "nothing reported". */
  status: string | null;
};

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

  return React.useMemo<UsageProviderGroup[]>(() => {
    const resultsByProvider = new Map(quotaResults.map((result) => [result.providerId, result]));
    return QUOTA_PROVIDERS
      .filter((providerMeta) => dropdownProviderIds.includes(providerMeta.id))
      .filter((providerMeta) => {
        const result = resultsByProvider.get(providerMeta.id);
        return result?.configured === true || (!result && Boolean(refreshErrors[providerMeta.id]));
      })
      .map((providerMeta) => {
        const result = resultsByProvider.get(providerMeta.id);
        const rows: UsageLimitRow[] = [];

        for (const [label, window] of Object.entries(result?.usage?.windows ?? {})) {
          rows.push({ key: `window-${label}`, label: formatWindowLabel(label), window });
        }

        const modelEntries = Object.entries(result?.usage?.models ?? {});
        const providerSelectedModels = selectedQuotaModels[providerMeta.id] ?? [];
        const visibleModelEntries = providerSelectedModels.length > 0
          ? modelEntries.filter(([modelName]) => providerSelectedModels.includes(modelName))
          : modelEntries;
        for (const [modelName, modelUsage] of visibleModelEntries) {
          const entries = Object.entries(modelUsage.windows ?? {});
          if (entries.length === 0) continue;
          const [label, window] = entries[0];
          rows.push({
            key: `model-${modelName}-${label}`,
            label: formatWindowLabel(label),
            subtitle: getDisplayModelName(modelName),
            window,
          });
        }

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
          rows,
          status,
        };
      });
  }, [dropdownProviderIds, quotaResults, refreshErrors, selectedQuotaModels, t]);
};
