import React from 'react';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { ButtonSmall } from '@/components/ui/button-small';
import { Checkbox } from '@/components/ui/checkbox';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { QUOTA_PROVIDERS, resolveUsageTone } from '@/lib/quota';
import { useQuotaStore } from '@/stores/useQuotaStore';
import { updateDesktopSettings } from '@/lib/persistence';
import { RiRefreshLine } from '@remixicon/react';

interface UsageSidebarProps {
  onItemSelect?: () => void;
}

const getUsagePercent = (usage: { windows?: Record<string, { usedPercent: number | null }> } | null | undefined) => {
  const windows = usage?.windows ?? {};
  const values = Object.values(windows)
    .map((window) => window.usedPercent)
    .filter((value): value is number => typeof value === 'number');
  if (values.length === 0) {
    return null;
  }
  return Math.max(...values);
};

export const UsageSidebar: React.FC<UsageSidebarProps> = ({ onItemSelect }) => {
  const results = useQuotaStore((state) => state.results);
  const selectedProviderId = useQuotaStore((state) => state.selectedProviderId);
  const setSelectedProvider = useQuotaStore((state) => state.setSelectedProvider);
  const fetchAllQuotas = useQuotaStore((state) => state.fetchAllQuotas);
  const isLoading = useQuotaStore((state) => state.isLoading);
  const usageAutoRefresh = useQuotaStore((state) => state.autoRefresh);
  const usageRefreshIntervalMs = useQuotaStore((state) => state.refreshIntervalMs);
  const usageDisplayMode = useQuotaStore((state) => state.displayMode);
  const setUsageAutoRefresh = useQuotaStore((state) => state.setAutoRefresh);
  const setUsageRefreshInterval = useQuotaStore((state) => state.setRefreshInterval);
  const setUsageDisplayMode = useQuotaStore((state) => state.setDisplayMode);
  const loadUsageSettings = useQuotaStore((state) => state.loadSettings);

  React.useEffect(() => {
    void loadUsageSettings();
  }, [loadUsageSettings]);

  const persistUsageSettings = React.useCallback(async (changes: { usageAutoRefresh?: boolean; usageRefreshIntervalMs?: number; usageDisplayMode?: 'usage' | 'remaining'; usageDropdownProviders?: string[] }) => {
    try {
      await updateDesktopSettings(changes);
    } catch (error) {
      console.warn('Failed to save usage settings:', error);
    }
  }, []);

  const handleUsageAutoRefreshChange = React.useCallback((enabled: boolean) => {
    setUsageAutoRefresh(enabled);
    void persistUsageSettings({ usageAutoRefresh: enabled });
  }, [persistUsageSettings, setUsageAutoRefresh]);

  const handleUsageRefreshIntervalChange = React.useCallback((value: string) => {
    const next = Number(value);
    if (!Number.isFinite(next)) {
      return;
    }
    setUsageRefreshInterval(next);
    void persistUsageSettings({ usageRefreshIntervalMs: next });
  }, [persistUsageSettings, setUsageRefreshInterval]);

  const handleUsageDisplayModeChange = React.useCallback((value: string) => {
    if (value !== 'usage' && value !== 'remaining') {
      return;
    }
    setUsageDisplayMode(value);
    void persistUsageSettings({ usageDisplayMode: value });
  }, [persistUsageSettings, setUsageDisplayMode]);

  const bgClass = 'bg-background';

  return (
    <div className={cn('flex h-full flex-col', bgClass)}>
      <div className="border-b px-3 pt-4 pb-3">
        <h2 className="text-base font-semibold text-foreground mb-3">Usage</h2>
        <div className="flex items-center justify-between gap-2">
          <span className="typography-meta text-muted-foreground">Total {QUOTA_PROVIDERS.length}</span>
          <div className="flex items-center gap-2">
            <Tooltip delayDuration={700}>
              <TooltipTrigger asChild>
                <span className="inline-flex">
                  <Checkbox
                    checked={usageAutoRefresh}
                    onChange={handleUsageAutoRefreshChange}
                    ariaLabel="Toggle auto refresh"
                  />
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                Auto-refresh usage data at set interval
              </TooltipContent>
            </Tooltip>
            <Select
              value={String(usageRefreshIntervalMs)}
              onValueChange={handleUsageRefreshIntervalChange}
              disabled={!usageAutoRefresh}
            >
              <SelectTrigger className="w-fit">
                <SelectValue placeholder="Interval" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="30000">30s</SelectItem>
                <SelectItem value="60000">1m</SelectItem>
                <SelectItem value="300000">5m</SelectItem>
              </SelectContent>
            </Select>
            <ButtonSmall
              variant="ghost"
              className="h-7 w-7 px-0 text-muted-foreground"
              onClick={() => fetchAllQuotas()}
              aria-label="Refresh usage"
              title="Refresh usage"
              disabled={isLoading}
            >
              <RiRefreshLine className={cn('h-3.5 w-3.5', isLoading && 'animate-spin')} />
            </ButtonSmall>
          </div>
        </div>
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="typography-micro text-muted-foreground">Display</span>
          <Select value={usageDisplayMode} onValueChange={handleUsageDisplayModeChange}>
            <SelectTrigger className="w-fit">
              <SelectValue placeholder="Display mode" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="usage">Usage</SelectItem>
              <SelectItem value="remaining">Quota remaining</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <ScrollableOverlay outerClassName="flex-1 min-h-0" className="space-y-1 px-3 py-2 overflow-x-hidden">
        {QUOTA_PROVIDERS.map((provider) => {
          const result = results.find((entry) => entry.providerId === provider.id);
          const percent = getUsagePercent(result?.usage);
          const tone = resolveUsageTone(percent);
          const isSelected = provider.id === selectedProviderId;
          const configured = result?.configured ?? false;

          const statusStyle = !configured
            ? { backgroundColor: 'var(--surface-muted-foreground)', opacity: 0.4 }
            : tone === 'critical'
              ? { backgroundColor: 'var(--status-error)' }
              : tone === 'warn'
                ? { backgroundColor: 'var(--status-warning)' }
                : { backgroundColor: 'var(--status-success)' };

          return (
            <div
              key={provider.id}
              className={cn(
                'group relative flex items-center rounded-md px-1.5 py-1 transition-all duration-200',
                isSelected ? 'bg-interactive-selection' : 'hover:bg-interactive-hover'
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
              {!configured && (
                <span className="typography-micro text-muted-foreground/60 flex-shrink-0">Not set</span>
              )}
            </button>
          </div>
          );
        })}
      </ScrollableOverlay>
    </div>
  );
};
