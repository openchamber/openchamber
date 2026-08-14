import React from 'react';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import {
  QUOTA_PROVIDERS,
  USAGE_ADD_PROVIDER_ID,
  collectConnectedQuotaProviderIds,
  resolveUsageTone,
} from '@/lib/quota';
import { useQuotaStore } from '@/stores/useQuotaStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { useI18n } from '@/lib/i18n';
import { SETTINGS_PANEL_TITLE_CLASS } from '@/components/sections/shared/SettingsSection';
import {
  getProviderRemainingDisplay,
  getProviderUsedPercent,
  isIncludedUsageProvider,
  isVisibleUsageProvider,
} from './usageProviderHelpers';

interface UsageSidebarProps {
  onItemSelect?: () => void;
}

export const UsageSidebar: React.FC<UsageSidebarProps> = ({ onItemSelect }) => {
  const { t } = useI18n();
  const results = useQuotaStore((state) => state.results);
  const authConfiguredProviderIds = useQuotaStore((state) => state.authConfiguredProviderIds);
  const hiddenProviderIds = useQuotaStore((state) => state.hiddenProviderIds);
  const selectedProviderId = useQuotaStore((state) => state.selectedProviderId);
  const setSelectedProvider = useQuotaStore((state) => state.setSelectedProvider);
  const hideUsageProvider = useQuotaStore((state) => state.hideUsageProvider);
  const fetchAllQuotas = useQuotaStore((state) => state.fetchAllQuotas);
  const isLoading = useQuotaStore((state) => state.isLoading);
  const loadUsageSettings = useQuotaStore((state) => state.loadSettings);
  const configProviders = useConfigStore((state) => state.providers);
  const loadProviders = useConfigStore((state) => state.loadProviders);

  React.useEffect(() => {
    void loadUsageSettings();
    void loadProviders({ source: 'usageSidebar' });
  }, [loadProviders, loadUsageSettings]);

  const hiddenSet = React.useMemo(() => new Set(hiddenProviderIds), [hiddenProviderIds]);
  const authConfiguredSet = React.useMemo(
    () => new Set(authConfiguredProviderIds),
    [authConfiguredProviderIds],
  );
  const connectedQuotaIds = React.useMemo(
    () => collectConnectedQuotaProviderIds(configProviders.map((provider) => provider.id)),
    [configProviders],
  );

  const visibleProviders = React.useMemo(() => {
    return QUOTA_PROVIDERS.filter((provider) => {
      const result = results.find((entry) => entry.providerId === provider.id);
      return isVisibleUsageProvider(provider.id, {
        configured: result?.configured,
        authConfiguredQuotaProviderIds: authConfiguredSet,
        connectedQuotaProviderIds: connectedQuotaIds,
        hiddenProviderIds: hiddenSet,
      });
    });
  }, [authConfiguredSet, connectedQuotaIds, hiddenSet, results]);

  const availableCount = React.useMemo(() => {
    return QUOTA_PROVIDERS.filter((provider) => {
      const result = results.find((entry) => entry.providerId === provider.id);
      const included = isIncludedUsageProvider(provider.id, {
        configured: result?.configured,
        authConfiguredQuotaProviderIds: authConfiguredSet,
        connectedQuotaProviderIds: connectedQuotaIds,
      });
      if (!included) return true;
      return hiddenSet.has(provider.id);
    }).length;
  }, [authConfiguredSet, connectedQuotaIds, hiddenSet, results]);

  const isOverviewSelected = selectedProviderId === null;
  const isAddSelected = selectedProviderId === USAGE_ADD_PROVIDER_ID;

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="border-b px-3 pt-4 pb-3">
        <h2 className={`${SETTINGS_PANEL_TITLE_CLASS} mb-3`}>{t('settings.usage.sidebar.title')}</h2>
        <div className="flex items-center justify-between gap-2">
          <span className="typography-meta text-muted-foreground">
            {t('settings.usage.sidebar.activeTotal', { count: visibleProviders.length })}
          </span>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 px-0 text-muted-foreground"
            onClick={() => fetchAllQuotas()}
            aria-label={t('settings.usage.sidebar.actions.refreshAria')}
            title={t('settings.usage.sidebar.actions.refreshTitle')}
            disabled={isLoading}
          >
            <Icon name="refresh" className={cn('h-3.5 w-3.5', isLoading && 'animate-spin')} />
          </Button>
        </div>
      </div>

      <ScrollableOverlay outerClassName="flex-1 min-h-0" className="space-y-1 px-3 py-2 overflow-x-hidden">
        <button
          type="button"
          onClick={() => {
            setSelectedProvider(null);
            onItemSelect?.();
          }}
          className={cn(
            'flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left transition-colors',
            isOverviewSelected ? 'bg-interactive-selection' : 'hover:bg-interactive-hover',
          )}
        >
          <Icon name="bar-chart-2" className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="typography-ui-label font-normal truncate text-foreground">
            {t('settings.usage.sidebar.overview')}
          </span>
        </button>

        {visibleProviders.length > 0 && (
          <div className="px-1.5 pt-3 pb-1 typography-micro text-muted-foreground">
            {t('settings.usage.sidebar.activeProviders')}
          </div>
        )}

        {visibleProviders.map((provider) => {
          const result = results.find((entry) => entry.providerId === provider.id);
          const usedPercent = getProviderUsedPercent(result?.usage);
          const remainingDisplay = getProviderRemainingDisplay(result?.usage);
          const tone = resolveUsageTone(usedPercent);
          const isSelected = provider.id === selectedProviderId;

          const statusStyle = tone === 'critical'
            ? { backgroundColor: 'var(--status-error)' }
            : tone === 'warn'
              ? { backgroundColor: 'var(--status-warning)' }
              : { backgroundColor: 'var(--status-success)' };

          return (
            <div
              key={provider.id}
              className={cn(
                'group relative flex items-center rounded-md px-1.5 py-1 transition-all duration-200',
                isSelected ? 'bg-interactive-selection' : 'hover:bg-interactive-hover',
              )}
            >
              <button
                type="button"
                onClick={() => {
                  setSelectedProvider(provider.id);
                  onItemSelect?.();
                }}
                className="flex min-w-0 flex-1 items-center gap-2 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
              >
                <span className="h-2.5 w-2.5 rounded-full flex-shrink-0" style={statusStyle} />
                <ProviderLogo providerId={provider.id} className="h-4 w-4 flex-shrink-0" />
                <span className="typography-ui-label font-normal truncate flex-1 min-w-0 text-foreground">
                  {provider.name}
                </span>
                {remainingDisplay?.kind === 'percent' && (
                  <span className="shrink-0 max-w-[4.75rem] truncate text-[0.625rem] leading-none tabular-nums text-muted-foreground group-hover:hidden">
                    {t('settings.usage.sidebar.remainingPct', { percent: remainingDisplay.percent })}
                  </span>
                )}
                {remainingDisplay?.kind === 'amount' && (
                  <span
                    className="shrink-0 max-w-[4.75rem] truncate text-[0.625rem] leading-none tabular-nums text-muted-foreground group-hover:hidden"
                    title={remainingDisplay.label}
                  >
                    {remainingDisplay.label}
                  </span>
                )}
              </button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 w-7 px-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                aria-label={t('settings.usage.sidebar.removeProviderAria', { provider: provider.name })}
                title={t('settings.usage.sidebar.removeProviderTitle')}
                onClick={() => hideUsageProvider(provider.id)}
              >
                <Icon name="close" className="h-3.5 w-3.5" />
              </Button>
            </div>
          );
        })}

        <button
          type="button"
          onClick={() => {
            setSelectedProvider(USAGE_ADD_PROVIDER_ID);
            onItemSelect?.();
          }}
          className={cn(
            'mt-2 flex w-full items-center gap-2 rounded-md border border-dashed border-[var(--interactive-border)] px-1.5 py-2 text-left transition-colors',
            isAddSelected ? 'bg-interactive-selection' : 'hover:bg-interactive-hover',
          )}
          data-settings-item="usage.add-provider"
        >
          <span className="flex h-5 w-5 items-center justify-center rounded-md bg-[var(--surface-muted)]">
            <Icon name="add" className="h-3.5 w-3.5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block typography-ui-label font-normal text-foreground">
              {t('settings.usage.sidebar.addProvider')}
            </span>
            {availableCount > 0 && (
              <span className="block typography-micro text-muted-foreground">
                {t('settings.usage.sidebar.availableCount', { count: availableCount })}
              </span>
            )}
          </span>
        </button>
      </ScrollableOverlay>
    </div>
  );
};
