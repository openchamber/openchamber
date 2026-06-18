import React from 'react';

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SortableTabsStrip, type SortableTabsStripItem } from '@/components/ui/sortable-tabs-strip';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { McpDropdownContent } from '@/components/mcp/McpDropdown';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { PluginStatusPage } from '@/components/sections/plugin-status/PluginStatusPage';
import {
  formatQuotaValueLabel,
  formatQuotaResetLabel,
  formatWindowLabel,
  calculatePace,
  calculateExpectedUsagePercent,
} from '@/lib/quota';
import { UsageProgressBar } from '@/components/sections/usage/UsageProgressBar';
import { PaceIndicator } from '@/components/sections/usage/PaceIndicator';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  getDisplayModelName,
} from '@/lib/quota/model-families';
import { DesktopHostSwitcherDialog } from '@/components/desktop/DesktopHostSwitcher';
import type { UpdateInfo } from '@/lib/desktop';
import type { TimeFormatPreference } from '@/stores/useUIStore';
import { DESKTOP_HEADER_ICON_BUTTON_CLASS, formatTime, type RateLimitGroup } from './useHeaderState';

type DesktopServicesMenuProps = {
  isDesktopApp: boolean;
  currentInstanceLabel: string;
  compactCurrentInstanceLabel: string;
  currentInstanceIsLocal: boolean;
  isDesktopServicesOpen: boolean;
  setIsDesktopServicesOpen: React.Dispatch<React.SetStateAction<boolean>>;
  refreshCurrentInstanceLabel: () => Promise<void>;
  desktopServicesTab: 'instance' | 'usage' | 'mcp' | 'plugin-status' | null;
  setDesktopServicesTab: React.Dispatch<React.SetStateAction<'instance' | 'usage' | 'mcp' | 'plugin-status' | null>>;
  quotaResultsLength: number;
  fetchAllQuotas: () => Promise<unknown>;
  servicesTabItems: SortableTabsStripItem[];
  quotaLastUpdated: number | null;
  quotaDisplayMode: 'usage' | 'remaining';
  quotaDisplayTabItems: SortableTabsStripItem[];
  handleDisplayModeChange: (mode: 'usage' | 'remaining') => Promise<void>;
  handleUsageRefresh: () => void;
  isQuotaLoading: boolean;
  isUsageRefreshSpinning: boolean;
  hasRateLimits: boolean;
  rateLimitGroups: RateLimitGroup[];
  expandedFamilies: Record<string, string[]>;
  toggleFamilyExpanded: (providerId: string, familyId: string) => void;
  shortcutLabel: (actionId: string) => string;
  showDevShutdown: boolean;
  isDevShutdownInFlight: boolean;
  onDevShutdown: () => Promise<void>;
  remoteUpdateInfo: UpdateInfo | null;
  remoteUpdateChecking: boolean;
  remoteUpdateError: string | null;
  onOpenRemoteUpdate: () => void;
  showPredValues: boolean;
  timeFormatPreference: TimeFormatPreference;
};

export const DesktopServicesMenu = React.memo(function DesktopServicesMenu({
  isDesktopApp,
  currentInstanceLabel,
  compactCurrentInstanceLabel,
  currentInstanceIsLocal,
  isDesktopServicesOpen,
  setIsDesktopServicesOpen,
  refreshCurrentInstanceLabel,
  desktopServicesTab,
  setDesktopServicesTab,
  quotaResultsLength,
  fetchAllQuotas,
  servicesTabItems,
  quotaLastUpdated,
  quotaDisplayMode,
  quotaDisplayTabItems,
  handleDisplayModeChange,
  handleUsageRefresh,
  isQuotaLoading,
  isUsageRefreshSpinning,
  hasRateLimits,
  rateLimitGroups,
  expandedFamilies,
  toggleFamilyExpanded,
  shortcutLabel,
  showDevShutdown,
  isDevShutdownInFlight,
  onDevShutdown,
  remoteUpdateInfo,
  remoteUpdateChecking,
  remoteUpdateError,
  onOpenRemoteUpdate,
  showPredValues,
  timeFormatPreference,
}: DesktopServicesMenuProps) {
  const { t } = useI18n();
  return (
    <DropdownMenu
      open={isDesktopServicesOpen}
      onOpenChange={(open) => {
        setIsDesktopServicesOpen(open);
        if (open) {
          void refreshCurrentInstanceLabel();
          if (desktopServicesTab === 'usage' && quotaResultsLength === 0) {
            void fetchAllQuotas();
          }
        }
      }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={isDesktopApp
                ? t('header.services.openWithCurrent', { current: currentInstanceLabel })
                : t('header.services.open')}
              className={cn(
                DESKTOP_HEADER_ICON_BUTTON_CLASS,
                isDesktopApp ? 'w-auto max-w-[14rem] justify-start gap-1.5 px-2.5' : 'h-8 w-8'
              )}
            >
              <Icon name="stack" className="h-[18px] w-[18px]" />
              {isDesktopApp ? (
                <span className="truncate typography-ui-label font-medium text-foreground">{compactCurrentInstanceLabel}</span>
              ) : null}
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>
          <p>
            {isDesktopApp
              ? t('header.services.tooltip.currentInstanceWithShortcuts', {
                  current: currentInstanceLabel,
                  toggle: shortcutLabel('toggle_services_menu'),
                  nextTab: shortcutLabel('cycle_services_tab'),
                })
              : t('header.services.tooltip.servicesWithShortcuts', {
                  toggle: shortcutLabel('toggle_services_menu'),
                  nextTab: shortcutLabel('cycle_services_tab'),
                })}
          </p>
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        align="end"
        className="w-[min(27rem,calc(100vw-2rem))] max-h-[75vh] overflow-y-auto bg-[var(--surface-elevated)] p-0"
      >
        <div className="sticky top-0 z-20 px-2 pt-1.5 pb-px">
          <div className="h-9">
            <SortableTabsStrip
              items={servicesTabItems}
              activeId={desktopServicesTab}
              onSelect={(tabID) => {
                const value = tabID as 'instance' | 'usage' | 'mcp' | 'plugin-status';
                setDesktopServicesTab(value);
                if (value === 'usage' && quotaResultsLength === 0) {
                  void fetchAllQuotas();
                }
              }}
              layoutMode="fit"
              variant="active-pill"
              activePillInsetClassName="gap-0.5 px-px py-0"
              activePillButtonClassName="h-8"
              className="h-full"
            />
          </div>
        </div>

        {isDesktopApp && desktopServicesTab === 'instance' ? (
          <div>
            {!currentInstanceIsLocal ? (
              <div className="border-b border-[var(--interactive-border)] px-4 py-2.5">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="typography-ui-label font-medium text-foreground">{t('header.services.remoteUpdate.title')}</div>
                    <div className="typography-micro text-muted-foreground">
                      {remoteUpdateInfo?.available
                        ? t('header.services.remoteUpdate.available', { version: remoteUpdateInfo.version || '' })
                        : remoteUpdateChecking
                          ? t('header.services.remoteUpdate.checking')
                          : remoteUpdateError || t('header.services.remoteUpdate.upToDate')}
                    </div>
                  </div>
                  {remoteUpdateInfo?.available ? (
                    <button
                      type="button"
                      className="shrink-0 rounded-md bg-[var(--primary-base)] px-3 py-1.5 typography-ui-label font-medium text-[var(--primary-foreground)] hover:opacity-90"
                      onClick={onOpenRemoteUpdate}
                    >
                      {t('header.services.remoteUpdate.actions.open')}
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}
            <DesktopHostSwitcherDialog
              embedded
              open={isDesktopServicesOpen && desktopServicesTab === 'instance'}
              onOpenChange={() => {}}
              onHostSwitched={() => setIsDesktopServicesOpen(false)}
            />
          </div>
        ) : null}

        {desktopServicesTab === 'mcp' ? (
          <McpDropdownContent active={isDesktopServicesOpen && desktopServicesTab === 'mcp'} />
        ) : null}

        {desktopServicesTab === 'plugin-status' ? (
	  			<div className="max-h-[60vh] overflow-y-auto px-2 py-2">
            <PluginStatusPage onClose={() => setDesktopServicesTab(null)} showHeader={false} />
					</div>
        ) : null}
        {desktopServicesTab === 'usage' ? (
          <div className="overflow-x-hidden">
            <div className="flex items-center justify-between gap-3 border-b border-[var(--interactive-border)] px-4 py-2.5">
              <div className="flex min-w-0 items-baseline gap-2">
                <span className="typography-ui-header font-semibold text-foreground">{t('header.services.rateLimits')}</span>
                <span className="truncate typography-micro text-muted-foreground">{formatTime(quotaLastUpdated, timeFormatPreference)}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="h-7 w-[10.5rem]">
                  <SortableTabsStrip
                    items={quotaDisplayTabItems}
                    activeId={quotaDisplayMode}
                    onSelect={(tabID) => void handleDisplayModeChange(tabID as 'usage' | 'remaining')}
                    layoutMode="fit"
                    variant="active-pill"
                    activePillInsetClassName="gap-0.5 px-px py-0"
                    className="h-full"
                  />
                </div>
                <button
                  type="button"
                  className={cn(
                    'inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors',
                    'hover:text-foreground hover:bg-interactive-hover',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary'
                  )}
                  onClick={handleUsageRefresh}
                  disabled={isQuotaLoading || isUsageRefreshSpinning}
                  aria-label={t('header.services.refreshRateLimitsAria')}
                >
                  <Icon name="refresh" className={cn('h-4 w-4', isUsageRefreshSpinning && 'animate-spin')} />
                </button>
              </div>
            </div>

            {!hasRateLimits ? (
              <div className="px-4 py-5 text-center">
                <span className="typography-ui-label text-muted-foreground">{t('header.services.noRateLimits')}</span>
              </div>
            ) : null}

            <div className="py-2">
              {rateLimitGroups.map((group, index) => {
                const providerExpandedFamilies = expandedFamilies[group.providerId] ?? [];
                return (
                  <React.Fragment key={group.providerId}>
                    {index > 0 ? <div className="mx-4 my-2 border-t border-[var(--interactive-border)]" /> : null}
                    <div className="flex items-center gap-2 px-4 py-2">
                      <ProviderLogo providerId={group.providerId} className="h-4 w-4" />
                      <span className="typography-ui-label font-medium text-foreground">{group.providerName}</span>
                    </div>
                    {group.entries.length === 0 && (!group.modelFamilies || group.modelFamilies.length === 0) ? (
                      <div className="px-4 pb-2">
                        <span className="typography-ui-label text-muted-foreground">{group.error ?? t('header.services.noRateLimitsReported')}</span>
                      </div>
                    ) : (
                      <div className="space-y-3 px-4 pb-2">
                        {group.entries.map(([label, window]) => {
                          const displayPercent = quotaDisplayMode === 'remaining' ? window.remainingPercent : window.usedPercent;
                          const paceInfo = calculatePace(window.usedPercent, window.resetAt, window.windowSeconds, label);
                          const expectedMarker = paceInfo?.dailyAllocationPercent != null
                            ? (quotaDisplayMode === 'remaining'
                                ? 100 - calculateExpectedUsagePercent(paceInfo.elapsedRatio)
                                : calculateExpectedUsagePercent(paceInfo.elapsedRatio))
                            : null;
                          const metricLabel = formatQuotaValueLabel(window.valueLabel, displayPercent);
                          const resetLabel = formatQuotaResetLabel(window.resetAt, window.resetAfterFormatted ?? window.resetAtFormatted, timeFormatPreference);
                          return (
                            <div key={`${group.providerId}-${label}`} className="flex flex-col gap-1.5">
                              <div className="flex min-w-0 items-center justify-between gap-3">
                                <div className="min-w-0 flex items-center gap-2">
                                  <span className="truncate typography-ui-label text-foreground">{formatWindowLabel(label)}</span>
                                  {resetLabel ? (
                                    <span className="truncate typography-micro text-muted-foreground">
                                      {resetLabel}
                                    </span>
                                  ) : null}
                                </div>
                                <span className="typography-ui-label tabular-nums text-foreground">
                                  {metricLabel === '-' ? '' : metricLabel}
                                </span>
                              </div>
                              <UsageProgressBar
                                percent={displayPercent}
                                tonePercent={window.usedPercent}
                                className="h-1.5"
                                expectedMarkerPercent={expectedMarker}
                              />
                              {paceInfo && showPredValues ? <PaceIndicator paceInfo={paceInfo} compact /> : null}
                            </div>
                          );
                        })}
                        {group.modelFamilies && group.modelFamilies.length > 0 ? (
                          <div className="space-y-0.5">
                            {group.modelFamilies.map((family) => {
                              const familyKey = family.familyId ?? 'other';
                              const isExpanded = providerExpandedFamilies.includes(familyKey);
                              return (
                                <Collapsible
                                  key={familyKey}
                                  open={isExpanded}
                                  onOpenChange={() => toggleFamilyExpanded(group.providerId, familyKey)}
                                >
                                  <CollapsibleTrigger className="flex w-full items-center justify-between rounded-md px-1 py-1.5 text-left hover:bg-[var(--interactive-hover)]/50 transition-colors">
                                    <span className="typography-ui-label font-medium text-foreground">{family.familyLabel}</span>
                                    {isExpanded ? <Icon name="arrow-down-s" className="h-4 w-4 text-muted-foreground" /> : <Icon name="arrow-right-s" className="h-4 w-4 text-muted-foreground" />}
                                  </CollapsibleTrigger>
                                  <CollapsibleContent>
                                    <div className="space-y-2.5 pb-1 pl-1 pt-1">
                                      {family.models.map(([modelName, window]) => {
                                        const displayPercent = quotaDisplayMode === 'remaining' ? window.remainingPercent : window.usedPercent;
                                        const paceInfo = calculatePace(window.usedPercent, window.resetAt, window.windowSeconds);
                                        const expectedMarker = paceInfo?.dailyAllocationPercent != null
                                          ? (quotaDisplayMode === 'remaining'
                                              ? 100 - calculateExpectedUsagePercent(paceInfo.elapsedRatio)
                                              : calculateExpectedUsagePercent(paceInfo.elapsedRatio))
                                          : null;
                                        const metricLabel = formatQuotaValueLabel(window.valueLabel, displayPercent);
                                        return (
                                          <div key={`${group.providerId}-${modelName}`} className="flex flex-col gap-1.5">
                                            <div className="flex min-w-0 items-center justify-between gap-3">
                                              <span className="truncate typography-micro text-muted-foreground">{getDisplayModelName(modelName)}</span>
                                              <span className="typography-ui-label tabular-nums text-foreground">
                                                {metricLabel === '-' ? '' : metricLabel}
                                              </span>
                                            </div>
                                            <UsageProgressBar
                                              percent={displayPercent}
                                              tonePercent={window.usedPercent}
                                              className="h-1.5"
                                              expectedMarkerPercent={expectedMarker}
                                            />
                                            {paceInfo && showPredValues ? <PaceIndicator paceInfo={paceInfo} compact /> : null}
                                          </div>
                                        );
                                      })}
                                    </div>
                                  </CollapsibleContent>
                                </Collapsible>
                              );
                            })}
                          </div>
                        ) : null}
                      </div>
                    )}
                  </React.Fragment>
                );
              })}
            </div>
          </div>
        ) : null}

        {showDevShutdown ? (
          <>
            <div className="mx-4 my-2 border-t border-[var(--interactive-border)]" />
            <div className="px-2 pb-2">
              <DropdownMenuItem
                disabled={isDevShutdownInFlight}
                onSelect={() => {
                  void onDevShutdown();
                }}
              >
                {t('header.services.shutdownDev')}
              </DropdownMenuItem>
            </div>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
});
