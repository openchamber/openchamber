import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2/client';
import { UsageCard } from './UsageCard';
import { QuotaCredentials } from './QuotaCredentials';
import { UsageAreaChart } from './UsageAreaChart';
import {
  QUOTA_PROVIDERS,
  buildPeriodUsageSummary,
  collectConnectedQuotaProviderIds,
  colorForProviderIndex,
  formatCompactNumber,
  formatUsd,
  type UsageMetricMode,
  type UsagePeriodDays,
} from '@/lib/quota';
import { useQuotaAutoRefresh, useQuotaStore } from '@/stores/useQuotaStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { updateDesktopSettings } from '@/lib/persistence';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import type { UsageWindows, QuotaProviderId } from '@/types';
import { getAllModelFamilies, getDisplayModelName, sortModelFamilies, groupModelsByFamilyWithGetter } from '@/lib/quota/model-families';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { formatTimeForPreference } from '@/lib/timeFormat';
import { useUIStore, type TimeFormatPreference } from '@/stores/useUIStore';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import {
  SettingsSection,
  SettingsCheckboxRow,
  SettingsChipGroup,
} from '@/components/sections/shared/SettingsSection';
import { getAllSyncSessions } from '@/sync/sync-refs';

const formatTime = (timestamp: number | null, timeFormatPreference: TimeFormatPreference) => {
  if (!timestamp) return '-';
  try {
    return formatTimeForPreference(timestamp, timeFormatPreference, { fallback: '-' });
  } catch {
    return '-';
  }
};

interface ModelInfo {
  name: string;
  windows: UsageWindows;
}

interface UsageProviderDetailProps {
  providerId: QuotaProviderId;
}

export const UsageProviderDetail: React.FC<UsageProviderDetailProps> = ({ providerId }) => {
  const { t } = useI18n();
  const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);
  const results = useQuotaStore((state) => state.results);
  const authConfiguredProviderIds = useQuotaStore((state) => state.authConfiguredProviderIds);
  const setSelectedProvider = useQuotaStore((state) => state.setSelectedProvider);
  const loadSettings = useQuotaStore((state) => state.loadSettings);
  const fetchAllQuotas = useQuotaStore((state) => state.fetchAllQuotas);
  const isLoading = useQuotaStore((state) => state.isLoading);
  const lastUpdated = useQuotaStore((state) => state.lastUpdated);
  const error = useQuotaStore((state) => state.error);
  const dropdownProviderIds = useQuotaStore((state) => state.dropdownProviderIds);
  const setDropdownProviderIds = useQuotaStore((state) => state.setDropdownProviderIds);
  const hideUsageProvider = useQuotaStore((state) => state.hideUsageProvider);
  const selectedModels = useQuotaStore((state) => state.selectedModels);
  const toggleModelSelected = useQuotaStore((state) => state.toggleModelSelected);
  const applyDefaultSelections = useQuotaStore((state) => state.applyDefaultSelections);
  const configProviders = useConfigStore((state) => state.providers);
  const loadProviders = useConfigStore((state) => state.loadProviders);

  const [periodDays, setPeriodDays] = React.useState<UsagePeriodDays>(7);
  const [metric, setMetric] = React.useState<UsageMetricMode>('tokens');
  const [sessionTick, setSessionTick] = React.useState(0);

  useQuotaAutoRefresh();

  React.useEffect(() => {
    void loadSettings();
    void loadProviders({ source: 'usageProviderDetail' });
    void fetchAllQuotas();
  }, [loadSettings, loadProviders, fetchAllQuotas]);

  const connectedQuotaIds = React.useMemo(
    () => collectConnectedQuotaProviderIds(configProviders.map((provider) => provider.id)),
    [configProviders],
  );

  const selectedResult = results.find((entry) => entry.providerId === providerId) ?? null;
  const providerMeta = QUOTA_PROVIDERS.find((provider) => provider.id === providerId);
  const providerName = providerMeta?.name ?? providerId;
  const usage = selectedResult?.usage;
  const selectedProviderError = selectedResult?.configured && !selectedResult.ok
    ? selectedResult.error
    : null;
  const showInDropdown = dropdownProviderIds.includes(providerId);
  const hasCredentialsForm = providerId === 'ollama-cloud' || providerId === 'cursor';
  const isOpenCodeConnected = connectedQuotaIds.has(providerId)
    || authConfiguredProviderIds.includes(providerId);

  const handleDropdownToggle = React.useCallback((enabled: boolean) => {
    const next = enabled
      ? Array.from(new Set([...dropdownProviderIds, providerId]))
      : dropdownProviderIds.filter((id) => id !== providerId);
    setDropdownProviderIds(next);
    void updateDesktopSettings({ usageDropdownProviders: next });
  }, [dropdownProviderIds, providerId, setDropdownProviderIds]);

  const providerModels = React.useMemo((): ModelInfo[] => {
    if (!usage?.models) return [];
    return Object.entries(usage.models)
      .map(([name, modelUsage]) => ({ name, windows: modelUsage }))
      .filter((model) => Object.keys(model.windows.windows).length > 0);
  }, [usage?.models]);

  React.useEffect(() => {
    if (providerModels.length > 0) {
      applyDefaultSelections(providerId, providerModels.map((m) => m.name));
    }
  }, [providerId, providerModels, applyDefaultSelections]);

  const modelsByFamily = React.useMemo(() => {
    if (providerModels.length === 0) {
      return new Map<string | null, ModelInfo[]>();
    }
    return groupModelsByFamilyWithGetter(
      providerModels,
      (model) => model.name,
      providerId,
    );
  }, [providerModels, providerId]);

  const sortedFamilies = React.useMemo(() => {
    const families = getAllModelFamilies(providerId);
    return sortModelFamilies(families);
  }, [providerId]);

  const [collapsedFamilies, setCollapsedFamilies] = React.useState<Record<string, boolean>>({});

  const toggleFamilyCollapsed = React.useCallback((familyId: string) => {
    setCollapsedFamilies((prev) => ({
      ...prev,
      [familyId]: !prev[familyId],
    }));
  }, []);

  const handleModelToggle = React.useCallback((modelName: string) => {
    toggleModelSelected(providerId, modelName);
    const currentSelected = selectedModels[providerId] ?? [];
    const isSelected = currentSelected.includes(modelName);
    const nextSelected = isSelected
      ? currentSelected.filter((m) => m !== modelName)
      : [...currentSelected, modelName];
    const nextSettings: Record<string, string[]> = { ...selectedModels, [providerId]: nextSelected };
    void updateDesktopSettings({ usageSelectedModels: nextSettings });
  }, [providerId, selectedModels, toggleModelSelected]);

  const providerSelectedModels = selectedModels[providerId] ?? [];

  const periodSummary = React.useMemo(() => {
    void sessionTick;
    const sessions = getAllSyncSessions() as Session[];
    return buildPeriodUsageSummary(sessions, { periodDays, providerFilter: providerId });
  }, [periodDays, providerId, sessionTick]);

  // Prefer cost chart when the provider has spend in the window; otherwise tokens.
  React.useEffect(() => {
    if (periodSummary.totals.cost > 0) {
      setMetric('cost');
    } else {
      setMetric('tokens');
    }
  }, [providerId]); // eslint-disable-line react-hooks/exhaustive-deps -- seed once per provider

  const chartSeries = React.useMemo(() => ([{
    id: providerId,
    label: providerName,
    color: colorForProviderIndex(0),
  }]), [providerId, providerName]);

  return (
    <SettingsPageLayout
      title={t('settings.usage.page.header.providerUsage', { provider: providerName })}
      titleLeading={(
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            className="h-8 w-8 px-0"
            aria-label={t('settings.usage.page.backToOverviewAria')}
            onClick={() => setSelectedProvider(null)}
          >
            <Icon name="arrow-left-s" className="h-4 w-4" />
          </Button>
          <ProviderLogo providerId={providerId} className="h-5 w-5 shrink-0" />
        </div>
      )}
      description={
        isLoading ? (
          <span className="animate-pulse typography-settings-description text-muted-foreground">{t('settings.usage.page.header.refreshing')}</span>
        ) : (
          t('settings.usage.page.header.lastUpdated', { time: formatTime(lastUpdated, timeFormatPreference) })
        )
      }
      showSaveStatus
    >
      <SettingsSection divider={false} settingsItem="usage.work-status-panel">
        <SettingsCheckboxRow
          checked={showInDropdown}
          onChange={handleDropdownToggle}
          label={t('settings.usage.page.options.showInWorkStatus')}
          ariaLabel={t('settings.usage.page.options.showInWorkStatusAria')}
          info={t('settings.usage.page.options.showInWorkStatusTooltip')}
        />
        <div className="mt-3">
          <Button
            size="sm"
            variant="outline"
            onClick={() => hideUsageProvider(providerId)}
          >
            {t('settings.usage.page.actions.removeFromUsage')}
          </Button>
        </div>
      </SettingsSection>

      <SettingsSection title={t('settings.usage.page.section.periodUsage')} settingsItem="usage.period-stats">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <SettingsChipGroup
            aria-label={t('settings.usage.overview.period.aria')}
            value={String(periodDays)}
            onChange={(value) => setPeriodDays(Number(value) as UsagePeriodDays)}
            options={[
              { value: '7', label: t('settings.usage.overview.period.7d') },
              { value: '30', label: t('settings.usage.overview.period.30d') },
            ]}
          />
          <SettingsChipGroup
            aria-label={t('settings.usage.overview.chart.metricAria')}
            value={metric}
            onChange={(value) => setMetric(value as UsageMetricMode)}
            options={[
              { value: 'tokens', label: t('settings.usage.overview.chart.metric.tokens') },
              { value: 'cost', label: t('settings.usage.overview.chart.metric.cost') },
              { value: 'requests', label: t('settings.usage.overview.chart.metric.requests') },
            ]}
          />
          <Button
            size="sm"
            variant="ghost"
            className="h-8 w-8 px-0"
            aria-label={t('settings.usage.sidebar.actions.refreshAria')}
            onClick={() => setSessionTick((value) => value + 1)}
          >
            <Icon name="refresh" className="h-3.5 w-3.5" />
          </Button>
        </div>

        <div className="mb-4 grid gap-3 @xl:grid-cols-3">
          <div className="rounded-lg border border-[var(--interactive-border)] px-3 py-2">
            <div className="typography-micro text-muted-foreground">{t('settings.usage.overview.metric.totalSpend')}</div>
            <div className="typography-ui-label tabular-nums text-foreground">{formatUsd(periodSummary.totals.cost)}</div>
          </div>
          <div className="rounded-lg border border-[var(--interactive-border)] px-3 py-2">
            <div className="typography-micro text-muted-foreground">{t('settings.usage.overview.metric.totalTokens')}</div>
            <div className="typography-ui-label tabular-nums text-foreground">{formatCompactNumber(periodSummary.totals.tokens)}</div>
          </div>
          <div className="rounded-lg border border-[var(--interactive-border)] px-3 py-2">
            <div className="typography-micro text-muted-foreground">{t('settings.usage.overview.metric.requests')}</div>
            <div className="typography-ui-label tabular-nums text-foreground">{formatCompactNumber(periodSummary.totals.requests)}</div>
          </div>
        </div>

        <UsageAreaChart
          days={periodSummary.days}
          metric={metric}
          series={chartSeries}
          ariaLabel={t('settings.usage.overview.chart.usageOverTime')}
          emptyLabel={t('settings.usage.overview.chart.empty')}
        />
      </SettingsSection>

      {!selectedResult && (
        <p className="typography-ui-label text-foreground pb-8">{t('settings.usage.page.state.noData')}</p>
      )}

      {(error || selectedProviderError) && (
        <div className="mb-8 rounded-lg border border-[var(--status-error-border)] bg-[var(--status-error-background)] px-4 py-3">
          <p className="typography-ui-label font-medium text-[var(--status-error)]">{t('settings.usage.page.state.refreshFailedTitle')}</p>
          <p className="typography-meta text-[var(--status-error)]/80 mt-1">{error ?? selectedProviderError}</p>
        </div>
      )}

      {selectedResult && !selectedResult.configured && !hasCredentialsForm && !isOpenCodeConnected && (
        <div className="mb-8 rounded-lg border border-[var(--status-warning-border)] bg-[var(--status-warning-background)] px-4 py-3">
          <p className="typography-ui-label font-medium text-[var(--status-warning)]">{t('settings.usage.page.state.providerNotConfiguredTitle')}</p>
          <p className="typography-meta text-[var(--status-warning)]/80 mt-1">
            {t('settings.usage.page.state.providerNotConfiguredDescription')}
          </p>
        </div>
      )}

      {(providerId === 'ollama-cloud' || providerId === 'cursor') && (
        <QuotaCredentials providerId={providerId} providerName={providerName} />
      )}

      {usage?.windows && Object.keys(usage.windows).length > 0 && (
        <SettingsSection title={t('settings.usage.page.section.remainingLimits')} settingsItem="usage.model-quotas">
          <div className="divide-y divide-[var(--surface-subtle)]">
            {Object.entries(usage.windows).map(([label, window]) => (
              <UsageCard key={label} title={label} window={window} />
            ))}
          </div>
        </SettingsSection>
      )}

      {providerModels.length > 0 && (
        <SettingsSection
          title={t('settings.usage.page.section.modelQuotas')}
          contentClassName="space-y-3"
        >
          {sortedFamilies.map((family) => {
            const familyModels = modelsByFamily.get(family.id) ?? [];
            if (familyModels.length === 0) return null;

            const isCollapsed = collapsedFamilies[family.id] ?? false;

            return (
              <section key={family.id} className="p-2">
                <Collapsible
                  open={!isCollapsed}
                  onOpenChange={() => toggleFamilyCollapsed(family.id)}
                >
                  <CollapsibleTrigger className="flex w-full items-center justify-between py-0.5 group">
                    <div className="flex items-center gap-1.5 text-left">
                      <span className="typography-ui-label font-normal text-foreground">{family.label}</span>
                      <span className="typography-micro text-muted-foreground">
                        ({familyModels.length})
                      </span>
                    </div>
                    {isCollapsed ? (
                      <Icon name="arrow-right-s" className="h-4 w-4 text-muted-foreground group-hover:text-foreground transition-colors" />
                    ) : (
                      <Icon name="arrow-down-s" className="h-4 w-4 text-muted-foreground group-hover:text-foreground transition-colors" />
                    )}
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="divide-y divide-[var(--surface-subtle)] mt-1">
                      {familyModels.map((model) => {
                        const entries = Object.entries(model.windows.windows);
                        if (entries.length === 0) return null;
                        const [label, window] = entries[0];
                        const isSelected = providerSelectedModels.includes(model.name);

                        return (
                          <UsageCard
                            key={model.name}
                            title={label}
                            subtitle={getDisplayModelName(model.name)}
                            window={window}
                            showToggle
                            toggleEnabled={isSelected}
                            onToggle={() => handleModelToggle(model.name)}
                          />
                        );
                      })}
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              </section>
            );
          })}

          {(() => {
            const otherModels = modelsByFamily.get(null) ?? [];
            if (otherModels.length === 0) return null;

            const isCollapsed = collapsedFamilies.other ?? false;

            return (
              <section className="p-2">
                <Collapsible
                  open={!isCollapsed}
                  onOpenChange={() => toggleFamilyCollapsed('other')}
                >
                  <CollapsibleTrigger className="flex w-full items-center justify-between py-0.5 group">
                    <div className="flex items-center gap-1.5 text-left">
                      <span className="typography-ui-label font-normal text-foreground">{t('settings.usage.page.section.otherModels')}</span>
                      <span className="typography-micro text-muted-foreground">
                        ({otherModels.length})
                      </span>
                    </div>
                    {isCollapsed ? (
                      <Icon name="arrow-right-s" className="h-4 w-4 text-muted-foreground group-hover:text-foreground transition-colors" />
                    ) : (
                      <Icon name="arrow-down-s" className="h-4 w-4 text-muted-foreground group-hover:text-foreground transition-colors" />
                    )}
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="divide-y divide-[var(--surface-subtle)] mt-1">
                      {otherModels.map((model) => {
                        const entries = Object.entries(model.windows.windows);
                        if (entries.length === 0) return null;
                        const [label, window] = entries[0];
                        const isSelected = providerSelectedModels.includes(model.name);

                        return (
                          <UsageCard
                            key={model.name}
                            title={label}
                            subtitle={getDisplayModelName(model.name)}
                            window={window}
                            showToggle
                            toggleEnabled={isSelected}
                            onToggle={() => handleModelToggle(model.name)}
                          />
                        );
                      })}
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              </section>
            );
          })()}
        </SettingsSection>
      )}

      {selectedResult?.configured && usage && Object.keys(usage.windows ?? {}).length === 0 &&
        providerModels.length === 0 && (
        <div className="pb-8">
          <p className="typography-ui-label text-foreground">{t('settings.usage.page.state.noQuotaWindowsTitle')}</p>
          <p className="typography-meta text-muted-foreground mt-1">{t('settings.usage.page.state.noQuotaWindowsDescription')}</p>
        </div>
      )}
    </SettingsPageLayout>
  );
};
