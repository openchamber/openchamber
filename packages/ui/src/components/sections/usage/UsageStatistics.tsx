import React from 'react';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import { useI18n, getCurrentIntlLocale } from '@/lib/i18n';
import type { I18nKey } from '@/lib/i18n/messages/en';
import type { ProviderUsageStatistics, UsageStatistics as UsageStatisticsData } from '@/types';

const formatCompactNumber = (value: number): string => {
  const formatted = new Intl.NumberFormat(getCurrentIntlLocale(), {
    notation: 'compact',
    compactDisplay: 'short',
    maximumFractionDigits: 1,
    minimumFractionDigits: 0,
  }).format(value);
  return formatted.endsWith('.0') ? formatted.slice(0, -2) : formatted;
};

const formatCount = (value: number): string => formatCompactNumber(value);

const formatTokens = (value: number): string => {
  if (value === 0) {
    return '0';
  }
  return formatCompactNumber(value);
};

const formatCost = (value: number, unit: string | null): string => {
  const formatted = value.toFixed(2);
  const unitName = unit || 'USD';
  return unitName === 'USD' ? `$${formatted}` : `${formatted} ${unitName}`;
};

type MetricKey = Exclude<keyof UsageStatisticsData, never>;

const METRICS: Array<{ key: MetricKey; labelKey: I18nKey; format: (value: number, unit: string | null) => string | null }> = [
  { key: 'requests', labelKey: 'usage.statistics.requests', format: (value) => formatCount(value) },
  { key: 'inputTokens', labelKey: 'usage.statistics.inputTokens', format: (value) => formatTokens(value) },
  { key: 'outputTokens', labelKey: 'usage.statistics.outputTokens', format: (value) => formatTokens(value) },
  { key: 'cacheReadTokens', labelKey: 'usage.statistics.cacheReadTokens', format: (value) => formatTokens(value) },
  { key: 'totalTokens', labelKey: 'usage.statistics.totalTokens', format: (value) => formatTokens(value) },
  { key: 'actualCost', labelKey: 'usage.statistics.actualCost', format: (value, unit) => formatCost(value, unit) },
];

const StatisticsRow: React.FC<{
  name: string;
  stats: UsageStatisticsData;
  unit: string | null;
}> = ({ name, stats, unit }) => {
  const { t } = useI18n();
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <span className="w-28 shrink-0 truncate typography-ui-label text-foreground">{name}</span>
      {METRICS.map(({ key, labelKey, format }) => {
        const value = stats[key];
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          return null;
        }
        const formatted = format(value, unit);
        if (formatted === null) {
          return null;
        }
        return (
          <span key={key} className="typography-meta text-muted-foreground">
            {t(labelKey)}{' '}
            <span className="tabular-nums text-foreground">{formatted}</span>
          </span>
        );
      })}
    </div>
  );
};

export const UsageStatistics: React.FC<{ statistics: ProviderUsageStatistics }> = ({ statistics }) => {
  const { t } = useI18n();
  const unit = statistics.unit;
  const modelEntries = Object.entries(statistics.models ?? {});
  const hasSummary = statistics.today != null || statistics.total != null;

  return (
    <SettingsSection
      title={t('usage.statistics.title')}
      info={t('usage.statistics.info')}
      settingsItem="usage.statistics"
    >
      {hasSummary || modelEntries.length > 0 ? (
        <div className="divide-y divide-[var(--surface-subtle)]">
          {statistics.today != null ? (
            <div className="py-1.5">
              <StatisticsRow name={t('usage.statistics.today')} stats={statistics.today} unit={unit} />
            </div>
          ) : null}
          {statistics.total != null ? (
            <div className="py-1.5">
              <StatisticsRow name={t('usage.statistics.total')} stats={statistics.total} unit={unit} />
            </div>
          ) : null}
          {modelEntries.map(([modelName, stats]) => (
            <div key={modelName} className="py-1.5">
              <StatisticsRow name={modelName} stats={stats} unit={unit} />
            </div>
          ))}
        </div>
      ) : (
        <p className="typography-meta text-muted-foreground">{t('usage.statistics.empty')}</p>
      )}
    </SettingsSection>
  );
};
