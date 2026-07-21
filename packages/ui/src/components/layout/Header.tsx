import React, { useEffect } from 'react';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SortableTabsStrip, type SortableTabsStripItem } from '@/components/ui/sortable-tabs-strip';

import { DiffIcon } from '@/components/icons/DiffIcon';
import { useUIStore, type ContextPanelMode, type MainTab } from '@/stores/useUIStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessionWorktreeStore } from '@/sync/session-worktree-store';
import { formatSessionWorktreeBadge } from '@/sync/session-worktree-contract';
import { useAllLiveSessions, useSession, useSessionMessagesResolved } from '@/sync/sync-context';
import { getAllSyncSessions } from '@/sync/sync-refs';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useQuotaAutoRefresh, useQuotaStore } from '@/stores/useQuotaStore';
import { useGitBranchLabel } from '@/stores/useGitStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useFeatureFlagsStore } from '@/stores/useFeatureFlagsStore';

import { useGitHubAuthStore } from '@/stores/useGitHubAuthStore';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useDesktopWindowControlsLayout } from '@/hooks/useDesktopWindowControlsLayout';
import { ContextUsageDisplay } from '@/components/ui/ContextUsageDisplay';
import { WindowsWindowControls } from '@/components/desktop/WindowsWindowControls';
import { UpdateDialog } from '@/components/ui/UpdateDialog';
import { useDeviceInfo, useTabletStandalonePwaRuntime } from '@/lib/device';
import { cn, hasModifier } from '@/lib/utils';
import { McpDropdownContent } from '@/components/mcp/McpDropdown';
import { McpIcon } from '@/components/icons/McpIcon';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { formatQuotaValueLabel, formatQuotaResetLabel, formatWindowLabel, QUOTA_PROVIDERS, calculatePace, calculateExpectedUsagePercent } from '@/lib/quota';
import { UsageProgressBar } from '@/components/sections/usage/UsageProgressBar';
import { PaceIndicator } from '@/components/sections/usage/PaceIndicator';
import { updateDesktopSettings } from '@/lib/persistence';
import { formatTimeForPreference } from '@/lib/timeFormat';
import { eventMatchesShortcut, formatShortcutForDisplay, getEffectiveShortcutCombo } from '@/lib/shortcuts';
import type { TimeFormatPreference } from '@/stores/useUIStore';
import {
  getAllModelFamilies,
  getDisplayModelName,
  groupModelsByFamily,
  sortModelFamilies,
} from '@/lib/quota/model-families';

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import type { UsageWindow } from '@/types';
import type { GitHubAuthStatus } from '@/lib/api/types';
import type { SessionContextUsage } from '@/stores/types/sessionTypes';
import { DesktopHostSwitcherDialog } from '@/components/desktop/DesktopHostSwitcher';
import { OpenInAppButton } from '@/components/desktop/OpenInAppButton';
import { useTerminalStore } from '@/stores/useTerminalStore';
import { ProjectActionsButton } from '@/components/layout/ProjectActionsButton';
import { SessionSwitcherDropdown } from '@/components/session/SessionSwitcherDropdown';
import { canUseElectronDesktopIPC, invokeDesktop, isDesktopShell, isVSCodeRuntime, startDesktopWindowDrag, type UpdateInfo } from '@/lib/desktop';
import { desktopHostsGet, redactSensitiveUrl } from '@/lib/desktopHosts';
import { Icon } from "@/components/icon/Icon";
import { useI18n } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeBearerTokenSync } from '@/lib/runtime-auth';
import { getRuntimeApiBaseUrl, getRuntimeKey } from '@/lib/runtime-switch';
import { resolveDesktopInstanceDisplay } from '@/lib/instanceDisplay';
import type { Session } from '@opencode-ai/sdk/v2/client';
import type { IconName } from "@/components/icon/icons";

const DESKTOP_HEADER_ICON_BUTTON_CLASS = 'app-region-no-drag inline-flex h-8 w-8 items-center justify-center gap-2 rounded-md typography-ui-label font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:pointer-events-none disabled:opacity-50 hover:bg-interactive-hover transition-colors';
const MOBILE_HEADER_ICON_BUTTON_CLASS = 'app-region-no-drag inline-flex h-9 w-9 items-center justify-center gap-2 p-2 rounded-md typography-ui-label font-medium text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:pointer-events-none disabled:opacity-50 hover:text-foreground hover:bg-interactive-hover transition-colors';

type HeaderIconActionButtonProps = {
  visible?: boolean;
  title: string;
  ariaLabel: string;
  onClick: React.MouseEventHandler<HTMLButtonElement>;
  className?: string;
  Icon: IconName;
  iconClassName?: string;
  pressed?: boolean;
};

const HeaderIconActionButton = React.memo(function HeaderIconActionButton({
  visible = true,
  title,
  ariaLabel,
  onClick,
  className,
  Icon: iconName,
  iconClassName,
  pressed = false,
}: HeaderIconActionButtonProps) {
  if (!visible) {
    return null;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          aria-label={ariaLabel}
          aria-pressed={pressed}
          className={cn(
            className ?? DESKTOP_HEADER_ICON_BUTTON_CLASS,
            pressed && 'bg-interactive-selection text-interactive-selection-foreground'
          )}
        >
          <Icon name={iconName} className={iconClassName ?? 'h-[18px] w-[18px]'} />
        </button>
      </TooltipTrigger>
      <TooltipContent>
        <p>{title}</p>
      </TooltipContent>
    </Tooltip>
  );
});

type DesktopGitHubControlProps = {
  isMobile: boolean;
  githubAuthStatus: GitHubAuthStatus | null;
  githubAccounts: Array<NonNullable<GitHubAuthStatus['accounts']>[number]>;
  githubAvatarUrl: string | null;
  githubLogin: string | null;
  isSwitchingGitHubAccount: boolean;
  handleGitHubAccountSwitch: (accountId: string) => Promise<void>;
};

const DesktopGitHubControl = React.memo(function DesktopGitHubControl({
  isMobile,
  githubAuthStatus,
  githubAccounts,
  githubAvatarUrl,
  githubLogin,
  isSwitchingGitHubAccount,
  handleGitHubAccountSwitch,
}: DesktopGitHubControlProps) {
  const { t } = useI18n();
  if (!githubAuthStatus?.connected || isMobile) {
    return null;
  }

  if (githubAccounts.length > 1) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={cn(
              DESKTOP_HEADER_ICON_BUTTON_CLASS,
              'h-7 w-7 overflow-hidden rounded-full border border-border/60 bg-muted/80 p-0'
            )}
            title={githubLogin ? t('header.github.connectedWithLogin', { login: githubLogin }) : t('header.github.connected')}
            disabled={isSwitchingGitHubAccount}
          >
            {githubAvatarUrl ? (
              <img
                src={githubAvatarUrl}
                alt={githubLogin ? t('header.github.avatarWithLogin', { login: githubLogin }) : t('header.github.avatar')}
                className="h-full w-full object-cover"
                loading="lazy"
                referrerPolicy="no-referrer"
              />
            ) : (
              <Icon name="github-fill" className="h-3.5 w-3.5 text-foreground" />
            )}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuLabel className="typography-ui-header font-semibold text-foreground">
            {t('header.github.accountsTitle')}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {githubAccounts.map((account) => {
            const accountUser = account.user;
            const isCurrent = Boolean(account.current);
            const sourceLabel = account.source === 'gh-cli'
              ? t('header.github.accountSource.cli')
              : t('header.github.accountSource.oauth');
            return (
              <DropdownMenuItem
                key={account.id}
                className="gap-2"
                disabled={isSwitchingGitHubAccount}
                onSelect={() => {
                  if (!isCurrent) {
                    void handleGitHubAccountSwitch(account.id);
                  }
                }}
              >
                {accountUser?.avatarUrl ? (
                  <img
                    src={accountUser.avatarUrl}
                    alt={accountUser.login ? t('header.github.avatarWithLogin', { login: accountUser.login }) : t('header.github.avatar')}
                    className="h-6 w-6 rounded-full border border-border/60 bg-muted object-cover"
                    loading="lazy"
                    referrerPolicy="no-referrer"
                  />
                ) : (
                  <div className="flex h-6 w-6 items-center justify-center rounded-full border border-border/60 bg-muted">
                    <Icon name="github-fill" className="h-3 w-3 text-muted-foreground" />
                  </div>
                )}
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate typography-ui-label text-foreground">
                    {accountUser?.name?.trim() || accountUser?.login || 'GitHub'}
                  </span>
                  {accountUser?.login ? (
                    <span className="truncate typography-micro text-muted-foreground">
                      <span className="font-mono">{accountUser.login}</span>
                      <span className="mx-1 opacity-50">·</span>
                      <span>{sourceLabel}</span>
                    </span>
                  ) : null}
                </span>
                {isCurrent ? <Icon name="check" className="h-4 w-4 text-primary" /> : null}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  return (
    <div
      className="app-region-no-drag flex h-7 w-7 items-center justify-center overflow-hidden rounded-full border border-border/60 bg-muted/80"
      title={githubLogin ? t('header.github.connectedWithLogin', { login: githubLogin }) : t('header.github.connected')}
    >
      {githubAvatarUrl ? (
        <img
          src={githubAvatarUrl}
          alt={githubLogin ? t('header.github.avatarWithLogin', { login: githubLogin }) : t('header.github.avatar')}
          className="h-full w-full object-cover"
          loading="lazy"
          referrerPolicy="no-referrer"
        />
      ) : (
        <Icon name="github-fill" className="h-3.5 w-3.5 text-foreground" />
      )}
    </div>
  );
});

type DesktopServicesMenuProps = {
  isDesktopApp: boolean;
  currentInstanceLabel: string;
  compactCurrentInstanceLabel: string;
  currentInstanceIsLocal: boolean;
  isDesktopServicesOpen: boolean;
  setIsDesktopServicesOpen: React.Dispatch<React.SetStateAction<boolean>>;
  refreshCurrentInstanceLabel: () => Promise<void>;
  desktopServicesTab: 'instance' | 'usage' | 'mcp';
  setDesktopServicesTab: React.Dispatch<React.SetStateAction<'instance' | 'usage' | 'mcp'>>;
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

const DesktopServicesMenu = React.memo(function DesktopServicesMenu({
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
                const value = tabID as 'instance' | 'usage' | 'mcp';
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

            {/* One elevated card per provider (same card language as the mobile
                usage popover) instead of a flat run of divider-separated rows. */}
            <div className="space-y-2 px-3 py-2.5">
              {rateLimitGroups.map((group) => {
                const providerExpandedFamilies = expandedFamilies[group.providerId] ?? [];
                return (
                  <div key={group.providerId} className="min-w-0 rounded-xl bg-[var(--surface-muted)] p-3">
                    <div className="flex items-center gap-2 pb-2">
                      <ProviderLogo providerId={group.providerId} className="h-4 w-4" />
                      <span className="typography-ui-label font-medium text-foreground">{group.providerName}</span>
                    </div>
                    {group.entries.length === 0 && (!group.modelFamilies || group.modelFamilies.length === 0) ? (
                      <div>
                        <span className="typography-ui-label text-muted-foreground">{group.error ?? t('header.services.noRateLimitsReported')}</span>
                      </div>
                    ) : (
                      <div className="space-y-3">
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
                  </div>
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

const isSameContextUsage = (
  a: SessionContextUsage | null,
  b: SessionContextUsage | null,
): boolean => {
  if (a === b) return true;
  if (!a || !b) return false;

  return a.totalTokens === b.totalTokens
    && a.percentage === b.percentage
    && a.contextLimit === b.contextLimit
    && (a.outputLimit ?? 0) === (b.outputLimit ?? 0)
    && (a.normalizedOutput ?? 0) === (b.normalizedOutput ?? 0)
    && a.thresholdLimit === b.thresholdLimit
    && (a.lastMessageId ?? '') === (b.lastMessageId ?? '');
};

const formatCompactHeaderLabel = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }

  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    const first = words[0];
    const second = words[1].slice(0, 3);
    const shortTwoWord = `${first} ${second}`.trim();
    if (words.length > 2 || shortTwoWord.length < trimmed.length) {
      return `${shortTwoWord}...`;
    }
    return shortTwoWord;
  }

  return trimmed.length > 12 ? `${trimmed.slice(0, 9).trimEnd()}...` : trimmed;
};

const formatTime = (timestamp: number | null, timeFormatPreference: 'auto' | '12h' | '24h') => {
  if (!timestamp) return '-';
  try {
    return formatTimeForPreference(timestamp, timeFormatPreference, { fallback: '-' });
  } catch {
    return '-';
  }
};

const normalize = (value: string): string => {
  if (!value) return '';
  const replaced = value.replace(/\\/g, '/');
  return replaced === '/' ? '/' : replaced.replace(/\/+$/, '');
};

const getActiveContextMode = (panelState: {
  isOpen: boolean;
  activeTabId: string | null;
  tabs: Array<{ id: string; mode: ContextPanelMode }>;
} | undefined): ContextPanelMode | null => {
  if (!panelState?.isOpen || !Array.isArray(panelState.tabs) || panelState.tabs.length === 0) {
    return null;
  }

  const activeTab = panelState.tabs.find((tab) => tab.id === panelState.activeTabId) ?? panelState.tabs[panelState.tabs.length - 1];
  return activeTab?.mode ?? null;
};

interface TabConfig {
  id: MainTab;
  label: string;
  icon: IconName | 'diff';
  badge?: number;
  showDot?: boolean;
}

interface RateLimitGroup {
  providerId: string;
  providerName: string;
  entries: Array<[string, UsageWindow]>;
  error?: string;
  modelFamilies?: Array<{
    familyId: string | null;
    familyLabel: string;
    models: Array<[string, UsageWindow]>;
  }>;
}

interface HeaderProps {
  onToggleLeftDrawer?: () => void;
  onToggleRightDrawer?: () => void;
  leftDrawerOpen?: boolean;
  rightDrawerOpen?: boolean;
}

export const Header: React.FC<HeaderProps> = ({
  onToggleLeftDrawer,
  onToggleRightDrawer,
  leftDrawerOpen,
  rightDrawerOpen,
}) => {
  const { t } = useI18n();
  const setSessionSwitcherOpen = useUIStore((state) => state.setSessionSwitcherOpen);
  const toggleSidebar = useUIStore((state) => state.toggleSidebar);
  const isSidebarOpen = useUIStore((state) => state.isSidebarOpen);
  const toggleBottomTerminal = useUIStore((state) => state.toggleBottomTerminal);
  const toggleRightSidebar = useUIStore((state) => state.toggleRightSidebar);
  const openContextOverview = useUIStore((state) => state.openContextOverview);
  const openContextPlan = useUIStore((state) => state.openContextPlan);
  const openContextBrowser = useUIStore((state) => state.openContextBrowser);
  const openContextPanelTab = useUIStore((state) => state.openContextPanelTab);
  const closeContextPanel = useUIStore((state) => state.closeContextPanel);
  const contextPanelByDirectory = useUIStore((state) => state.contextPanelByDirectory);
  const activeMainTab = useUIStore((state) => state.activeMainTab);
  const setActiveMainTab = useUIStore((state) => state.setActiveMainTab);
  const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);
  const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);

  const getCurrentModel = useConfigStore((state) => state.getCurrentModel);
  const runtimeApis = useRuntimeAPIs();
  const [isDevShutdownInFlight, setIsDevShutdownInFlight] = React.useState(false);

  const getContextUsage = useSessionUIStore((state) => state.getContextUsage);
  const isNewSessionDraftOpen = useSessionUIStore((state) => Boolean(state.newSessionDraft?.open));
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const currentSessionMessagesResolved = useSessionMessagesResolved(currentSessionId ?? '');
  const currentSyncedSession = useSession(currentSessionId ?? null);
  const globalActiveSessions = useGlobalSessionsStore((state) => state.activeSessions);
  const liveSessions = useAllLiveSessions();
  const activeProject = useProjectsStore((state) => {
    if (!state.activeProjectId) {
      return null;
    }
    return state.projects.find((project) => project.id === state.activeProjectId) ?? null;
  });
  const activeProjectLabel = React.useMemo(() => {
    if (!activeProject) {
      return null;
    }

    const trimmedLabel = activeProject.label?.trim();
    if (trimmedLabel) {
      return trimmedLabel;
    }

    const pathSegments = activeProject.path.split(/[\\/]/).filter(Boolean);
    return pathSegments[pathSegments.length - 1] ?? null;
  }, [activeProject]);
  const quotaResults = useQuotaStore((state) => state.results);
  const fetchAllQuotas = useQuotaStore((state) => state.fetchAllQuotas);
  const isQuotaLoading = useQuotaStore((state) => state.isLoading);
  const quotaLastUpdated = useQuotaStore((state) => state.lastUpdated);
  const quotaDisplayMode = useQuotaStore((state) => state.displayMode);
  const showPredValues = useQuotaStore((state) => state.showPredValues);
  const dropdownProviderIds = useQuotaStore((state) => state.dropdownProviderIds);
  const loadQuotaSettings = useQuotaStore((state) => state.loadSettings);
  const setQuotaDisplayMode = useQuotaStore((state) => state.setDisplayMode);

  const { isMobile } = useDeviceInfo();
  const githubAuthStatus = useGitHubAuthStore((state) => state.status);
  const setGitHubAuthStatus = useGitHubAuthStore((state) => state.setStatus);

  const headerRef = React.useRef<HTMLElement | null>(null);

  const [isDesktopApp, setIsDesktopApp] = React.useState<boolean>(() => {
    if (typeof window === 'undefined') {
      return false;
    }
    return isDesktopShell();
  });
  const hasElectronDesktopIPC = React.useMemo(() => canUseElectronDesktopIPC(), []);
  const isTabletStandalonePwa = useTabletStandalonePwaRuntime();
  const [isDesktopWindowFullscreen, setIsDesktopWindowFullscreen] = React.useState(false);

  const isMacPlatform = React.useMemo(() => {
    if (typeof navigator === 'undefined') {
      return false;
    }
    return /Macintosh|Mac OS X/.test(navigator.userAgent || '');
  }, []);

  const { usesFramelessChrome, side: windowControlsSide } = useDesktopWindowControlsLayout();

  const macosMajorVersion = React.useMemo(() => {
    if (typeof window === 'undefined') {
      return null;
    }

    const injected = (window as unknown as { __OPENCHAMBER_MACOS_MAJOR__?: unknown }).__OPENCHAMBER_MACOS_MAJOR__;
    if (typeof injected === 'number' && Number.isFinite(injected) && injected > 0) {
      return injected;
    }

    // Fallback: WebKit reports "Mac OS X 10_15_7" format where 10 is legacy prefix
    if (typeof navigator === 'undefined') {
      return null;
    }
    const match = (navigator.userAgent || '').match(/Mac OS X (\d+)[._](\d+)/);
    if (!match) {
      return null;
    }
    const first = Number.parseInt(match[1], 10);
    const second = Number.parseInt(match[2], 10);
    if (Number.isNaN(first)) {
      return null;
    }
    return first === 10 ? second : first;
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    setIsDesktopApp(isDesktopShell());
  }, []);

  const currentModel = getCurrentModel();
  const limit = currentModel && typeof currentModel.limit === 'object' && currentModel.limit !== null
    ? (currentModel.limit as Record<string, unknown>)
    : null;
  const contextLimit = (limit && typeof limit.context === 'number' ? limit.context : 0);
  const outputLimit = (limit && typeof limit.output === 'number' ? limit.output : 0);
  const contextUsage = getContextUsage(contextLimit, outputLimit);
  const [stableDesktopContextUsage, setStableDesktopContextUsage] = React.useState<SessionContextUsage | null>(null);
  const isContextUsageResolvedForSession = !currentSessionId || currentSessionMessagesResolved;

  useEffect(() => {
    if (!currentSessionId) {
      setStableDesktopContextUsage((prev) => (prev === null ? prev : null));
      return;
    }

    if (contextUsage && contextUsage.totalTokens > 0) {
      setStableDesktopContextUsage((prev) => (isSameContextUsage(prev, contextUsage) ? prev : contextUsage));
      return;
    }

    if (isContextUsageResolvedForSession) {
      setStableDesktopContextUsage((prev) => (prev === null ? prev : null));
    }
  }, [contextUsage, currentSessionId, isContextUsageResolvedForSession]);

  const isSessionSwitcherOpen = useUIStore((state) => state.isSessionSwitcherOpen);
  const githubAvatarUrl = githubAuthStatus?.connected ? (githubAuthStatus.user?.avatarUrl ?? null) : null;
  const githubLogin = githubAuthStatus?.connected ? (githubAuthStatus.user?.login ?? null) : null;
  const githubAccounts = githubAuthStatus?.accounts ?? [];
  const [isSwitchingGitHubAccount, setIsSwitchingGitHubAccount] = React.useState(false);
  const [isMobileRateLimitsOpen, setIsMobileRateLimitsOpen] = React.useState(false);
  const [isDesktopServicesOpen, setIsDesktopServicesOpen] = React.useState(false);
  const [isUsageRefreshSpinning, setIsUsageRefreshSpinning] = React.useState(false);
  const [currentInstanceLabel, setCurrentInstanceLabel] = React.useState(() => t('desktopHostSwitcher.instance.local'));
  const [currentInstanceIsLocal, setCurrentInstanceIsLocal] = React.useState(true);
  const [remoteUpdateDialogOpen, setRemoteUpdateDialogOpen] = React.useState(false);
  const [remoteUpdateInfo, setRemoteUpdateInfo] = React.useState<UpdateInfo | null>(null);
  const [remoteUpdateChecking, setRemoteUpdateChecking] = React.useState(false);
  const [remoteUpdateError, setRemoteUpdateError] = React.useState<string | null>(null);
  const compactCurrentInstanceLabel = React.useMemo(() => formatCompactHeaderLabel(currentInstanceLabel), [currentInstanceLabel]);
  const [desktopServicesTab, setDesktopServicesTab] = React.useState<'instance' | 'usage' | 'mcp'>(
    isDesktopApp ? 'instance' : 'usage'
  );
  const [mobileServicesTab, setMobileServicesTab] = React.useState<'usage' | 'mcp'>('usage');
  useEffect(() => {
    if (!isDesktopApp && desktopServicesTab === 'instance') {
      setDesktopServicesTab('usage');
    }
  }, [desktopServicesTab, isDesktopApp]);

  const isVSCode = React.useMemo(() => isVSCodeRuntime(), []);
  const showDesktopHeaderContextUsage = !isVSCode && activeMainTab === 'chat' && !!stableDesktopContextUsage && stableDesktopContextUsage.totalTokens > 0;
  const desktopHeaderDisplayPercentage = stableDesktopContextUsage && stableDesktopContextUsage.contextLimit > 0
    ? Math.min(999, (stableDesktopContextUsage.totalTokens / stableDesktopContextUsage.contextLimit) * 100)
    : 0;

  const refreshCurrentInstanceLabel = React.useCallback(async () => {
    if (typeof window === 'undefined' || !isDesktopApp) {
      return;
    }

    try {
      const cfg = await desktopHostsGet();
      const display = resolveDesktopInstanceDisplay({
        isPackagedElectronPage: window.location.origin === 'openchamber-ui://app',
        runtimeKey: getRuntimeKey(),
        runtimeApiBaseUrl: getRuntimeApiBaseUrl(),
        localOrigin: cfg.localOrigin || window.__OPENCHAMBER_LOCAL_ORIGIN__ || '',
        hosts: cfg.hosts,
      });

      if (display.kind === 'local') {
        setCurrentInstanceLabel(t('desktopHostSwitcher.instance.local'));
        setCurrentInstanceIsLocal(true);
        return;
      }

      setCurrentInstanceIsLocal(false);
      setCurrentInstanceLabel(
        display.kind === 'host'
          ? redactSensitiveUrl(display.label)
          : t('desktopHostSwitcher.instance.fallback'),
      );
    } catch {
      // Preserve the last resolved display identity when the authoritative host
      // config is temporarily unavailable.
    }
  }, [isDesktopApp, t]);

  useEffect(() => {
    void refreshCurrentInstanceLabel();
  }, [refreshCurrentInstanceLabel]);

  const checkRemoteInstanceUpdate = React.useCallback(async () => {
    if (currentInstanceIsLocal) {
      setRemoteUpdateInfo(null);
      setRemoteUpdateError(null);
      return;
    }

    setRemoteUpdateChecking(true);
    setRemoteUpdateError(null);
    try {
      const params = new URLSearchParams({ appType: 'web', instanceMode: 'remote' });
      const response = await runtimeFetch(`/api/openchamber/update-check?${params.toString()}`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        throw new Error(`Server responded with ${response.status}`);
      }
      const data = await response.json();
      setRemoteUpdateInfo({
        available: data.available ?? false,
        version: data.version,
        currentVersion: data.currentVersion ?? 'unknown',
        body: data.body,
        nextSuggestedCheckInSec: typeof data.nextSuggestedCheckInSec === 'number' ? data.nextSuggestedCheckInSec : undefined,
        packageManager: data.packageManager,
        updateCommand: data.updateCommand,
      });
    } catch (error) {
      setRemoteUpdateInfo(null);
      setRemoteUpdateError(error instanceof Error ? error.message : t('header.services.remoteUpdate.error'));
    } finally {
      setRemoteUpdateChecking(false);
    }
  }, [currentInstanceIsLocal, t]);

  React.useEffect(() => {
    setRemoteUpdateInfo(null);
    setRemoteUpdateError(null);
    setRemoteUpdateDialogOpen(false);
  }, [currentInstanceIsLocal, currentInstanceLabel]);

  React.useEffect(() => {
    if (!isDesktopApp || currentInstanceIsLocal) {
      return;
    }

    const initialDelayMs = 3000;
    const intervalMs = 60 * 60 * 1000;
    let disposed = false;
    let timer: number | null = null;

    const schedule = (delayMs: number) => {
      timer = window.setTimeout(() => {
        if (disposed || (typeof document !== 'undefined' && document.visibilityState !== 'visible')) {
          schedule(intervalMs);
          return;
        }
        void checkRemoteInstanceUpdate().finally(() => {
          if (!disposed) {
            schedule(intervalMs);
          }
        });
      }, delayMs);
    };

    schedule(initialDelayMs);

    return () => {
      disposed = true;
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    };
  }, [checkRemoteInstanceUpdate, currentInstanceIsLocal, currentInstanceLabel, isDesktopApp]);

  const openRemoteInstanceUpdate = React.useCallback(() => {
    if (remoteUpdateInfo?.available) {
      setRemoteUpdateDialogOpen(true);
      return;
    }
    void checkRemoteInstanceUpdate();
  }, [checkRemoteInstanceUpdate, remoteUpdateInfo?.available]);

  useQuotaAutoRefresh();
  const selectedModels = useQuotaStore((state) => state.selectedModels);
  const expandedFamilies = useQuotaStore((state) => state.expandedFamilies);
  const toggleFamilyExpanded = useQuotaStore((state) => state.toggleFamilyExpanded);

  const rateLimitGroups = React.useMemo(() => {
    const groups: RateLimitGroup[] = [];

    for (const provider of QUOTA_PROVIDERS) {
      if (!dropdownProviderIds.includes(provider.id)) {
        continue;
      }
      const result = quotaResults.find((entry) => entry.providerId === provider.id);
      const windows = (result?.usage?.windows ?? {}) as Record<string, UsageWindow>;
      const models = result?.usage?.models;
      const entries = Object.entries(windows);

      const group: RateLimitGroup = {
        providerId: provider.id,
        providerName: provider.name,
        entries,
        error: (result && !result.ok && result.configured) ? result.error : undefined,
      };

      // Add model families if provider has per-model quotas
      if (models && Object.keys(models).length > 0) {
        const providerSelectedModels = selectedModels[provider.id] ?? [];
        // hasExplicitSelection = true means user has selected specific models to show
        // If the array exists but is empty, treat as "show all" (user cleared selection)
        const hasExplicitSelection = providerSelectedModels.length > 0;
        const modelGroups = groupModelsByFamily(models, provider.id);
        const families = getAllModelFamilies(provider.id);
        const sortedFamilies = sortModelFamilies(families);

        group.modelFamilies = [];

        // Add predefined families first
        for (const family of sortedFamilies) {
          const modelNames = modelGroups.get(family.id) ?? [];
          if (modelNames.length === 0) continue;

          // Filter to selected models only, OR show all if nothing selected
          const selectedModelNames = hasExplicitSelection
            ? modelNames.filter((m: string) => providerSelectedModels.includes(m))
            : modelNames;
          if (selectedModelNames.length === 0) continue;

          const familyModels: Array<[string, UsageWindow]> = [];
          for (const modelName of selectedModelNames) {
            const modelUsage = models[modelName] as { windows?: Record<string, UsageWindow> } | undefined;
            if (modelUsage?.windows) {
              const windowEntries = Object.entries(modelUsage.windows);
              if (windowEntries.length > 0) {
                familyModels.push([modelName, windowEntries[0][1]]);
              }
            }
          }

          if (familyModels.length > 0) {
            group.modelFamilies.push({
              familyId: family.id,
              familyLabel: family.label,
              models: familyModels,
            });
          }
        }

        // Add "Other" family for remaining models
        const otherModelNames = modelGroups.get(null) ?? [];
        const selectedOtherModels = hasExplicitSelection
          ? otherModelNames.filter((m: string) => providerSelectedModels.includes(m))
          : otherModelNames;
        if (selectedOtherModels.length > 0) {
          const otherModels: Array<[string, UsageWindow]> = [];
          for (const modelName of selectedOtherModels) {
            const modelUsage = models[modelName] as { windows?: Record<string, UsageWindow> } | undefined;
            if (modelUsage?.windows) {
              const windowEntries = Object.entries(modelUsage.windows);
              if (windowEntries.length > 0) {
                otherModels.push([modelName, windowEntries[0][1]]);
              }
            }
          }
          if (otherModels.length > 0) {
            group.modelFamilies.push({
              familyId: null,
              familyLabel: t('header.services.modelFamily.other'),
              models: otherModels,
            });
          }
        }
      }

      if (entries.length > 0 || (group.modelFamilies && group.modelFamilies.length > 0) || group.error) {
        groups.push(group);
      }
    }

    return groups;
  }, [dropdownProviderIds, quotaResults, selectedModels, t]);
  const hasRateLimits = rateLimitGroups.length > 0;
  React.useEffect(() => {
    void loadQuotaSettings();
  }, [loadQuotaSettings]);
  const handleDisplayModeChange = React.useCallback(async (mode: 'usage' | 'remaining') => {
    setQuotaDisplayMode(mode);
    try {
      await updateDesktopSettings({ usageDisplayMode: mode });
    } catch (error) {
      console.warn('Failed to update usage display mode:', error);
    }
  }, [setQuotaDisplayMode]);

  const handleUsageRefresh = React.useCallback(() => {
    if (isUsageRefreshSpinning) return;
    setIsUsageRefreshSpinning(true);
    const minSpinPromise = new Promise(resolve => setTimeout(resolve, 500));
    Promise.all([fetchAllQuotas(), minSpinPromise]).finally(() => {
      setIsUsageRefreshSpinning(false);
    });
  }, [fetchAllQuotas, isUsageRefreshSpinning]);

  const currentSessionLive = React.useMemo(() => {
    if (!currentSessionId) return null;
    return liveSessions.find((s) => s.id === currentSessionId)
      ?? globalActiveSessions.find((s) => s.id === currentSessionId)
      ?? currentSyncedSession
      ?? getAllSyncSessions().find((s) => s.id === currentSessionId)
      ?? null;
  }, [currentSessionId, currentSyncedSession, globalActiveSessions, liveSessions]);

  const lastResolvedSessionRef = React.useRef<{
    sessionId: string;
    session: Session;
    expiresAt: number;
  } | null>(null);
  const [sessionFallbackVersion, setSessionFallbackVersion] = React.useState(0);

  React.useEffect(() => {
    if (!currentSessionId) {
      if (lastResolvedSessionRef.current) {
        lastResolvedSessionRef.current = null;
        setSessionFallbackVersion((value) => value + 1);
      }
      return;
    }

    if (currentSessionLive) {
      lastResolvedSessionRef.current = {
        sessionId: currentSessionId,
        session: currentSessionLive,
        expiresAt: Date.now() + 2000,
      };
      return;
    }

    const cached = lastResolvedSessionRef.current;
    if (!cached || cached.sessionId !== currentSessionId) {
      return;
    }

    const remainingMs = cached.expiresAt - Date.now();
    if (remainingMs <= 0) {
      lastResolvedSessionRef.current = null;
      setSessionFallbackVersion((value) => value + 1);
      return;
    }

    const timeoutId = window.setTimeout(() => {
      if (lastResolvedSessionRef.current?.sessionId === currentSessionId) {
        lastResolvedSessionRef.current = null;
      }
      setSessionFallbackVersion((value) => value + 1);
    }, remainingMs);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [currentSessionId, currentSessionLive]);

  void sessionFallbackVersion;
  const currentSession = (() => {
    if (currentSessionLive) {
      return currentSessionLive;
    }

    if (!currentSessionId) {
      return null;
    }

    const cached = lastResolvedSessionRef.current;
    if (cached && cached.sessionId === currentSessionId && cached.expiresAt > Date.now()) {
      return cached.session;
    }

    return null;
  })();

  const worktreePath = useSessionUIStore((state) => {
    if (!currentSessionId) return '';
    return state.worktreeMetadata.get(currentSessionId)?.path ?? '';
  });
  const currentSessionWorktreeBranch = useSessionUIStore((state) => {
    if (!currentSessionId) return null;
    return state.worktreeMetadata.get(currentSessionId)?.branch?.trim() ?? null;
  });

  // Authoritative session↔worktree attachment from session-worktree-store
  const worktreeAttachment = useSessionWorktreeStore((state) =>
    currentSessionId ? state.getAttachment(currentSessionId) : undefined
  );

  const worktreeBadge = React.useMemo(() => {
    if (!worktreeAttachment) return null;
    return formatSessionWorktreeBadge(worktreeAttachment, {
      pending: t('gitView.empty.worktreeSetupInProgress'),
    });
  }, [t, worktreeAttachment]);

  const worktreeBadgeKind = React.useMemo(() => {
    if (!worktreeAttachment) return null;
    if (worktreeAttachment.legacy) return 'legacy';
    if (worktreeAttachment.degraded) return 'degraded';
    if (worktreeAttachment.worktreeStatus === 'pending') return 'pending';
    if (worktreeAttachment.worktreeStatus === 'missing') return 'missing';
    if (worktreeAttachment.worktreeStatus === 'invalid') return 'invalid';
    if (worktreeAttachment.attentionReason) return 'attention';
    return null;
  }, [worktreeAttachment]);
  const worktreeDirectory = React.useMemo(() => {
    return normalize(worktreePath || '');
  }, [worktreePath]);

  const sessionDirectory = React.useMemo(() => {
    const raw = typeof currentSession?.directory === 'string' ? currentSession.directory : '';
    return normalize(raw || '');
  }, [currentSession?.directory]);

  const draftDirectory = useSessionUIStore((state) => {
    if (!state.newSessionDraft?.open) {
      return '';
    }
    return normalize(state.newSessionDraft.bootstrapPendingDirectory ?? state.newSessionDraft.directoryOverride ?? '');
  });

  const openDirectory = React.useMemo(() => {
    return worktreeDirectory || sessionDirectory || draftDirectory;
  }, [draftDirectory, sessionDirectory, worktreeDirectory]);

  const catalogWorktreeBranch = useSessionUIStore((state) => {
    const candidateDirectory = normalize(worktreeDirectory || sessionDirectory || '');
    if (!candidateDirectory) {
      return null;
    }

    for (const worktrees of state.availableWorktreesByProject.values()) {
      const match = worktrees.find((worktree) => normalize(worktree.path) === candidateDirectory);
      const branch = match?.branch?.trim();
      if (branch) {
        return branch;
      }
    }

    return null;
  });

  const gitBranchForDirectory = useGitBranchLabel(openDirectory || null);
  const currentBranchLabel = gitBranchForDirectory || currentSessionWorktreeBranch || catalogWorktreeBranch;

  const currentSessionTitle = React.useMemo(() => {
    if (!currentSessionId) {
      return activeProjectLabel ?? 'OpenChamber';
    }
    const trimmedTitle = currentSession?.title?.trim();
    return trimmedTitle && trimmedTitle.length > 0 ? trimmedTitle : 'Untitled Session';
  }, [activeProjectLabel, currentSession?.title, currentSessionId]);


  const actionDirectory = React.useMemo(() => {
    return normalize(openDirectory || activeProject?.path || '');
  }, [activeProject?.path, openDirectory]);

  const activeProjectRef = React.useMemo(() => {
    if (!activeProject) {
      return null;
    }
    return { id: activeProject.id, path: activeProject.path };
  }, [activeProject]);

  const lastProjectActionsContextRef = React.useRef<{
    projectRef: { id: string; path: string };
    directory: string;
  } | null>(null);

  React.useEffect(() => {
    if (!activeProjectRef || !actionDirectory) {
      return;
    }
    lastProjectActionsContextRef.current = {
      projectRef: activeProjectRef,
      directory: actionDirectory,
    };
  }, [actionDirectory, activeProjectRef]);

  const projectActionsContext = React.useMemo(() => {
    if (activeProjectRef && actionDirectory) {
      return { projectRef: activeProjectRef, directory: actionDirectory };
    }
    return lastProjectActionsContextRef.current;
  }, [actionDirectory, activeProjectRef]);

  const planModeEnabled = useFeatureFlagsStore((state) => state.planModeEnabled);
  const isSessionPlanAvailable = useSessionUIStore((state) => state.isSessionPlanAvailable);
  const planTabAvailable = planModeEnabled && currentSessionId ? isSessionPlanAvailable(currentSessionId) : false;
  const showPlanTab = planTabAvailable;
  const lastPlanSessionKeyRef = React.useRef<string>('');

  // Reset plan tab availability when session changes
  React.useEffect(() => {
    if (!planModeEnabled) {
      if (useUIStore.getState().activeMainTab === 'plan') {
        useUIStore.getState().setActiveMainTab('chat');
      }
      return;
    }

    if (!currentSessionId) return;

    const sessionKey = `${currentSessionId || 'none'}:${sessionDirectory || 'none'}:${currentSession?.time?.created || 0}:${currentSession?.slug || 'none'}`;
    if (lastPlanSessionKeyRef.current !== sessionKey) {
      lastPlanSessionKeyRef.current = sessionKey;
    }

    // If plan is not available but user is on plan tab, switch them back to chat
    if (!planTabAvailable && useUIStore.getState().activeMainTab === 'plan') {
      useUIStore.getState().setActiveMainTab('chat');
    }
  }, [
    planModeEnabled,
    planTabAvailable,
    currentSession?.slug,
    currentSession?.time?.created,
    currentSessionId,
    sessionDirectory,
  ]);

  const handleGitHubAccountSwitch = React.useCallback(async (accountId: string) => {
    if (!accountId || isSwitchingGitHubAccount) return;
    setIsSwitchingGitHubAccount(true);
    try {
      const payload = runtimeApis.github
        ? await runtimeApis.github.authActivate(accountId)
        : await (async () => {
          const response = await runtimeFetch('/api/github/auth/activate', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
            body: JSON.stringify({ accountId }),
          });
          const body = (await response.json().catch(() => null)) as
            | (GitHubAuthStatus & { error?: string })
            | null;
          if (!response.ok || !body) {
            throw new Error(body?.error || response.statusText);
          }
          return body;
        })();

      setGitHubAuthStatus(payload);
    } catch (error) {
      console.error('Failed to switch GitHub account:', error);
    } finally {
      setIsSwitchingGitHubAccount(false);
    }
  }, [isSwitchingGitHubAccount, runtimeApis.github, setGitHubAuthStatus]);

  const blurActiveElement = React.useCallback(() => {
    if (typeof document === 'undefined') {
      return;
    }

    const active = document.activeElement as HTMLElement | null;
    if (!active) {
      return;
    }

    const tagName = active.tagName;
    const isInput = tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT';

    if (isInput || active.isContentEditable) {
      active.blur();
    }
  }, []);

  const handleOpenSessionSwitcher = React.useCallback(() => {
    if (isMobile) {
      blurActiveElement();
      setSessionSwitcherOpen(!isSessionSwitcherOpen);
      return;
    }
    toggleSidebar();
  }, [blurActiveElement, isMobile, isSessionSwitcherOpen, setSessionSwitcherOpen, toggleSidebar]);

  const handleOpenDraftMiniChat = React.useCallback(() => {
    void invokeDesktop('desktop_open_draft_mini_chat_window', {
      directory: normalize(openDirectory || activeProject?.path || ''),
      projectId: activeProject?.id ?? null,
      apiBaseUrl: getRuntimeApiBaseUrl(),
      clientToken: getRuntimeBearerTokenSync(),
    }).catch((error) => {
      console.warn('[header] failed to open draft mini chat window', error);
    });
  }, [activeProject?.id, activeProject?.path, openDirectory]);

  const handleOpenCurrentMiniChat = React.useCallback(() => {
    if (isNewSessionDraftOpen) {
      handleOpenDraftMiniChat();
      return;
    }

    if (!currentSessionId) {
      return;
    }
    void invokeDesktop('desktop_open_session_mini_chat_window', {
      sessionId: currentSessionId,
      directory: normalize(openDirectory || activeProject?.path || ''),
      apiBaseUrl: getRuntimeApiBaseUrl(),
      clientToken: getRuntimeBearerTokenSync(),
    }).catch((error) => {
      console.warn('[header] failed to open session mini chat window', error);
    });
  }, [activeProject?.path, currentSessionId, handleOpenDraftMiniChat, isNewSessionDraftOpen, openDirectory]);

  const handleOpenContextPanel = React.useCallback(() => {
    const directory = normalize(openDirectory || '');
    if (!directory) {
      return;
    }

    const panelState = contextPanelByDirectory[directory];
    if (getActiveContextMode(panelState) === 'context') {
      closeContextPanel(directory);
      return;
    }

    openContextOverview(directory);
  }, [closeContextPanel, contextPanelByDirectory, openContextOverview, openDirectory]);

  const isContextPanelActive = React.useMemo(() => {
    const directory = normalize(openDirectory || '');
    if (!directory) {
      return false;
    }
    const panelState = contextPanelByDirectory[directory];
    return getActiveContextMode(panelState) === 'context';
  }, [contextPanelByDirectory, openDirectory]);

  const handleOpenContextPlan = React.useCallback(() => {
    const directory = normalize(openDirectory || '');
    if (!directory) {
      return;
    }

    const panelState = contextPanelByDirectory[directory];
    if (getActiveContextMode(panelState) === 'plan') {
      closeContextPanel(directory);
      return;
    }

    openContextPlan(directory);
  }, [closeContextPanel, contextPanelByDirectory, openContextPlan, openDirectory]);

  const handleOpenContextChanges = React.useCallback(() => {
    const directory = normalize(openDirectory || '');
    if (!directory) {
      return;
    }

    const panelState = contextPanelByDirectory[directory];
    if (getActiveContextMode(panelState) === 'diff') {
      closeContextPanel(directory);
      return;
    }

    openContextPanelTab(directory, { mode: 'diff', stagedDiff: false });
  }, [closeContextPanel, contextPanelByDirectory, openContextPanelTab, openDirectory]);

  const handleOpenContextBrowser = React.useCallback(() => {
    const directory = normalize(openDirectory || '');
    if (!directory) {
      return;
    }

    const panelState = contextPanelByDirectory[directory];
    if (getActiveContextMode(panelState) === 'browser') {
      closeContextPanel(directory);
      return;
    }

    openContextBrowser(directory);
  }, [closeContextPanel, contextPanelByDirectory, openContextBrowser, openDirectory]);

  const isContextPlanActive = React.useMemo(() => {
    const directory = normalize(openDirectory || '');
    if (!directory) {
      return false;
    }
    const panelState = contextPanelByDirectory[directory];
    return getActiveContextMode(panelState) === 'plan';
  }, [contextPanelByDirectory, openDirectory]);

  const isContextChangesActive = React.useMemo(() => {
    const directory = normalize(openDirectory || '');
    if (!directory) {
      return false;
    }
    const panelState = contextPanelByDirectory[directory];
    return getActiveContextMode(panelState) === 'diff';
  }, [contextPanelByDirectory, openDirectory]);

  const isContextBrowserActive = React.useMemo(() => {
    const directory = normalize(openDirectory || '');
    if (!directory) {
      return false;
    }
    const panelState = contextPanelByDirectory[directory];
    return getActiveContextMode(panelState) === 'browser';
  }, [contextPanelByDirectory, openDirectory]);

  const desktopHeaderIconButtonClass = DESKTOP_HEADER_ICON_BUTTON_CLASS;
  const mobileHeaderIconButtonClass = MOBILE_HEADER_ICON_BUTTON_CLASS;
  const mobileActiveHeaderItem = React.useMemo(() => {
    if (isMobileRateLimitsOpen) {
      return 'services';
    }
    if (leftDrawerOpen) {
      return 'sessions';
    }
    if (rightDrawerOpen) {
      return 'git';
    }
    return activeMainTab;
  }, [activeMainTab, isMobileRateLimitsOpen, leftDrawerOpen, rightDrawerOpen]);

  const closeMobileHeaderPanels = React.useCallback(() => {
    setIsMobileRateLimitsOpen(false);
    if (leftDrawerOpen && onToggleLeftDrawer) {
      onToggleLeftDrawer();
    }
    if (rightDrawerOpen && onToggleRightDrawer) {
      onToggleRightDrawer();
    }
    if (!onToggleLeftDrawer && isSessionSwitcherOpen) {
      setSessionSwitcherOpen(false);
    }
  }, [isSessionSwitcherOpen, leftDrawerOpen, onToggleLeftDrawer, onToggleRightDrawer, rightDrawerOpen, setSessionSwitcherOpen]);

  const handleMobileLeftDrawerToggle = React.useCallback(() => {
    if (!leftDrawerOpen) {
      setIsMobileRateLimitsOpen(false);
    }
    onToggleLeftDrawer?.();
  }, [leftDrawerOpen, onToggleLeftDrawer]);

  const handleMobileRightDrawerToggle = React.useCallback(() => {
    if (!rightDrawerOpen) {
      setIsMobileRateLimitsOpen(false);
    }
    onToggleRightDrawer?.();
  }, [onToggleRightDrawer, rightDrawerOpen]);

  // Left padding the header needs to clear the OS window controls (macOS
  // traffic lights / window-controls-overlay). When the sidebar is open this
  // space is owned by the sidebar's top strip instead, so the header drops back
  // to its normal content padding. The full value is published as
  // `--oc-titlebar-left-inset` so the sidebar strip can mirror it.
  const titlebarLeftInset = React.useMemo(() => {
    if (isDesktopApp && isMacPlatform && !isDesktopWindowFullscreen) {
      return '5.5rem';
    }
    if (isTabletStandalonePwa) {
      return 'max(calc(0.75rem + var(--oc-wco-left-inset, 0px)), 5.5rem)';
    }
    if ((!isDesktopApp || usesFramelessChrome) && !isVSCode) {
      return 'calc(0.75rem + var(--oc-wco-left-inset, 0px))';
    }
    return '0.75rem';
  }, [isDesktopApp, isDesktopWindowFullscreen, isMacPlatform, isTabletStandalonePwa, isVSCode, usesFramelessChrome]);

  useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }
    document.documentElement.style.setProperty('--oc-titlebar-left-inset', titlebarLeftInset);
  }, [titlebarLeftInset]);

  // Space reserved on the header's left for the persistent overlay when the
  // sidebar is collapsed (the overlay sits over the header then). Split into two
  // spacers so the strip stays a window drag area while the buttons stay
  // clickable: a drag region for the window-controls inset (traffic lights) and
  // a no-drag carve under the control cluster. Both animate so the session title
  // slides in/out in lockstep with the sidebar. When the sidebar is open the
  // overlay is over the sidebar, so the header only keeps normal content padding.
  const headerInsetSpacerWidth = isSidebarOpen ? '0.75rem' : 'var(--oc-titlebar-left-inset, 0.75rem)';
  const headerControlsSpacerWidth = isSidebarOpen
    ? '0px'
    : 'calc(var(--oc-titlebar-controls-width, 5.5rem) + 0.5rem)';

  useEffect(() => {
    if (!isDesktopApp || !isMacPlatform) {
      setIsDesktopWindowFullscreen(false);
      return;
    }

    let disposed = false;

    const syncFullscreenState = async () => {
      try {
        const fullscreen = await invokeDesktop<boolean>('desktop_is_window_fullscreen');
        if (!disposed) {
          setIsDesktopWindowFullscreen(fullscreen === true);
        }
      } catch {
        if (!disposed) {
          setIsDesktopWindowFullscreen(false);
        }
      }
    };

    const onResize = () => {
      void syncFullscreenState();
    };

    void syncFullscreenState();
    window.addEventListener('openchamber:window-resized', onResize);

    return () => {
      disposed = true;
      window.removeEventListener('openchamber:window-resized', onResize);
    };
  }, [isDesktopApp, isMacPlatform]);

  const macosHeaderSizeClass = React.useMemo(() => {
    if (!isDesktopApp || !isMacPlatform || macosMajorVersion === null) {
      return '';
    }
    if (macosMajorVersion >= 26) {
      return 'h-12';
    }
    if (macosMajorVersion <= 15) {
      return 'h-14';
    }
    return '';
  }, [isDesktopApp, isMacPlatform, macosMajorVersion]);

  const webWindowControlsOverlayStyle = React.useMemo<React.CSSProperties | undefined>(() => {
    if ((isDesktopApp && !usesFramelessChrome) || isVSCode) {
      return undefined;
    }

    return {
      // Left inset is handled by the no-drag spacer (see renderDesktop); only
      // the right inset / titlebar height are owned by the window-controls overlay.
      paddingRight: 'calc(0.75rem + var(--oc-wco-right-inset, 0px))',
      minHeight: 'max(3rem, var(--oc-wco-titlebar-height, 0px))',
      height: 'max(3rem, var(--oc-wco-titlebar-height, 0px))',
    };
  }, [isDesktopApp, isVSCode, usesFramelessChrome]);

  const updateHeaderHeight = React.useCallback(() => {
    if (typeof document === 'undefined') {
      return;
    }

    const height = headerRef.current?.getBoundingClientRect().height;
    if (height) {
      document.documentElement.style.setProperty('--oc-header-height', `${height}px`);
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    updateHeaderHeight();

    const node = headerRef.current;
    if (!node || typeof ResizeObserver === 'undefined') {
      return () => { };
    }

    let rafId = 0;
    const scheduleUpdate = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        updateHeaderHeight();
      });
    };

    const observer = new ResizeObserver(scheduleUpdate);

    observer.observe(node);
    window.addEventListener('resize', scheduleUpdate);
    window.addEventListener('orientationchange', scheduleUpdate);

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      observer.disconnect();
      window.removeEventListener('resize', scheduleUpdate);
      window.removeEventListener('orientationchange', scheduleUpdate);
    };
  }, [updateHeaderHeight]);

  useEffect(() => {
    updateHeaderHeight();
  }, [updateHeaderHeight, isMobile, macosHeaderSizeClass]);

  const handleDragStart = React.useCallback(async (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('.app-region-no-drag')) {
      return;
    }
    if (target.closest('button, a, input, select, textarea')) {
      return;
    }
    if (e.button !== 0) {
      return;
    }
    if (isDesktopApp) {
      await startDesktopWindowDrag();
    }
  }, [isDesktopApp]);

  const tabs: TabConfig[] = React.useMemo(() => {
    if (isMobile) {
      const base: TabConfig[] = [
        { id: 'chat', label: t('layout.mainTab.chat'), icon: "chat-4" },
      ];

      if (showPlanTab) {
        base.push({ id: 'plan', label: t('layout.mainTab.plan'), icon: "file-text" });
      }

      base.push(
        { id: 'diff', label: t('layout.mainTab.diff'), icon: 'diff' },
        { id: 'files', label: t('layout.mainTab.files'), icon: "folder-6" },
        { id: 'terminal', label: t('layout.mainTab.terminal'), icon: "terminal-box" },
        { id: 'context', label: t('layout.mainTab.context'), icon: "file-list-2" },
        { id: 'diagram', label: t('layout.mainTab.diagram'), icon: 'file' },
      );

      return base;
    }

    // Desktop: no tabs in header
    return [];
  }, [isMobile, showPlanTab, t]);

  const shortcutLabel = React.useCallback((actionId: string) => {
    return formatShortcutForDisplay(getEffectiveShortcutCombo(actionId, shortcutOverrides));
  }, [shortcutOverrides]);

  useEffect(() => {
    // Project actions may intentionally promote the terminal to the desktop main view.
    if (!isMobile && (activeMainTab === 'git' || activeMainTab === 'diff' || activeMainTab === 'files' || activeMainTab === 'context')) {
      setActiveMainTab('chat');
    }
  }, [activeMainTab, isMobile, setActiveMainTab]);

  const servicesTabs = React.useMemo(() => {
    const base: Array<{ value: 'instance' | 'usage' | 'mcp'; label: string; icon: React.ReactNode }> = [];
    if (isDesktopApp) {
      base.push({ value: 'instance', label: t('layout.services.instance'), icon: <Icon name="server" className="h-3.5 w-3.5" /> });
    }
    base.push(
      { value: 'usage', label: t('layout.services.usage'), icon: <Icon name="timer" className="h-3.5 w-3.5" /> },
      { value: 'mcp', label: 'MCP', icon: <McpIcon className="h-3.5 w-3.5" /> }
    );
    return base;
  }, [isDesktopApp, t]);

  const servicesTabItems = React.useMemo(() => {
    return servicesTabs.map((tab) => ({
      id: tab.value,
      label: tab.label,
      icon: tab.icon,
    }));
  }, [servicesTabs]);

  const showDevShutdown = React.useMemo(() => {
    if (typeof window === 'undefined') return false;
    if (isDesktopApp) return false;
    if (isVSCode) return false;
    const host = window.location.hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  }, [isDesktopApp, isVSCode]);

  const handleDevShutdown = React.useCallback(async () => {
    if (isDevShutdownInFlight) return;
    setIsDevShutdownInFlight(true);
    setIsDesktopServicesOpen(false);

    const previewUrls: string[] = [];
    let shutdownRequested = false;
    try {
      try {
        for (const [, dirState] of useTerminalStore.getState().sessions.entries()) {
          for (const tab of dirState.tabs) {
            if (tab.previewUrl) {
              previewUrls.push(tab.previewUrl);
            }
          }
        }
      } catch {
        // ignore
      }

      try {
        // Ensure preview/dev terminals don't linger.
        await runtimeApis.terminal.forceKill?.({});
      } catch {
        // ignore
      }

      try {
        const devRes = await runtimeFetch('/api/system/dev-shutdown', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ previewUrls }),
        });
        if (devRes.ok) {
          shutdownRequested = true;
        } else {
          const shutdownRes = await runtimeFetch('/api/system/shutdown', { method: 'POST' });
          shutdownRequested = shutdownRes.ok;
        }
      } catch {
        // ignore
      }
    } finally {
      if (!shutdownRequested) {
        setIsDevShutdownInFlight(false);
      }
    }
  }, [isDevShutdownInFlight, runtimeApis.terminal, setIsDesktopServicesOpen]);

  const quotaDisplayTabs = React.useMemo(() => {
    return [
      { value: 'usage' as const, label: t('header.services.used') },
      { value: 'remaining' as const, label: t('header.services.remaining') },
    ];
  }, [t]);

  const quotaDisplayTabItems = React.useMemo(() => {
    return quotaDisplayTabs.map((tab) => ({ id: tab.value, label: tab.label }));
  }, [quotaDisplayTabs]);

  const mobileServicesTabItems = React.useMemo<SortableTabsStripItem[]>(() => {
    return [
      { id: 'usage', label: t('layout.services.usage'), icon: <Icon name="timer" className="h-3.5 w-3.5" /> },
      { id: 'mcp', label: 'MCP', icon: <McpIcon className="h-3.5 w-3.5" /> },
    ];
  }, [t]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (hasModifier(e) && !e.shiftKey && !e.altKey) {
        const num = parseInt(e.key, 10);
        if (num >= 1 && num <= tabs.length) {
          e.preventDefault();
          if (isMobile) {
            blurActiveElement();
            closeMobileHeaderPanels();
          }
          setActiveMainTab(tabs[num - 1].id);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [blurActiveElement, closeMobileHeaderPanels, isMobile, setActiveMainTab, tabs]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const toggleServicesCombo = getEffectiveShortcutCombo('toggle_services_menu', shortcutOverrides);
      if (eventMatchesShortcut(e, toggleServicesCombo)) {
        e.preventDefault();

        if (isDesktopServicesOpen) {
          setIsDesktopServicesOpen(false);
        } else {
          setIsDesktopServicesOpen(true);
          void refreshCurrentInstanceLabel();
          if (desktopServicesTab === 'usage' && quotaResults.length === 0) {
            void fetchAllQuotas();
          }
        }
        return;
      }

      const cycleServicesCombo = getEffectiveShortcutCombo('cycle_services_tab', shortcutOverrides);
      if (eventMatchesShortcut(e, cycleServicesCombo)) {
        e.preventDefault();

        const tabValues = servicesTabs.map((tab) => tab.value) as Array<'instance' | 'usage' | 'mcp'>;
        if (tabValues.length === 0) {
          return;
        }

        const currentIndex = tabValues.indexOf(desktopServicesTab);
        const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % tabValues.length;
        const nextTab = tabValues[nextIndex];
        setDesktopServicesTab(nextTab);
        setIsDesktopServicesOpen(true);
        void refreshCurrentInstanceLabel();
        if (nextTab === 'usage' && quotaResults.length === 0) {
          void fetchAllQuotas();
        }
        return;
      }

      const toggleContextPlanCombo = getEffectiveShortcutCombo('toggle_context_plan', shortcutOverrides);
      if (eventMatchesShortcut(e, toggleContextPlanCombo)) {
        e.preventDefault();
        handleOpenContextPlan();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    shortcutOverrides,
    isDesktopServicesOpen,
    desktopServicesTab,
    servicesTabs,
    quotaResults.length,
    fetchAllQuotas,
    refreshCurrentInstanceLabel,
    handleOpenContextPlan,
  ]);

  const renderTab = (tab: TabConfig) => {
    const isActive = activeMainTab === tab.id;
    const isDiffTab = tab.icon === 'diff';
    const tabIconName = isDiffTab ? null : (tab.icon as IconName);
    const isChatTab = tab.id === 'chat';

    const renderIcon = (iconSize: number) => {
      if (isDiffTab) {
        return <DiffIcon size={iconSize} />;
      }
      return tabIconName ? <Icon name={tabIconName} className={`h-${iconSize/4} w-${iconSize/4}`} /> : null;
    };

    const tabButton = (
      <button
        type="button"
        onClick={() => setActiveMainTab(tab.id)}
          className={cn(
            'relative flex h-8 items-center gap-2 px-3 rounded-lg typography-ui-label font-medium transition-colors',
            isActive
              ? 'app-region-no-drag bg-interactive-selection text-interactive-selection-foreground shadow-none'
              : 'app-region-no-drag text-muted-foreground hover:bg-interactive-hover/50 hover:text-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
            isChatTab && !isMobile && 'min-w-[100px] justify-center'
          )}
        aria-label={tab.label}
        aria-selected={isActive}
        role="tab"
      >
        {isMobile ? (
          renderIcon(20)
        ) : (
          <>
            {renderIcon(16)}
            <span className="header-tab-label">{tab.label}</span>
          </>
        )}

        {tab.badge !== undefined && tab.badge > 0 && (
          <span className="header-tab-badge typography-micro text-status-info font-medium">
            {tab.badge}
          </span>
        )}
      </button>
    );

    return <React.Fragment key={tab.id}>{tabButton}</React.Fragment>;
  };

  const desktopChangesPanelAction = !isVSCode ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={t('header.actions.toggleChangesPanelAria')}
          aria-pressed={isContextChangesActive}
          onClick={handleOpenContextChanges}
          className={desktopHeaderIconButtonClass}
        >
          <span className="relative h-5 w-5 overflow-hidden rounded-[2px]">
            <span className="absolute left-[4px] top-[4px] h-3 w-[5px] bg-[var(--status-error)]/25" />
            <span className="absolute right-[4px] top-[4px] h-3 w-[5px] bg-[var(--status-success)]/25" />
            <Icon name="layout-column" className="absolute inset-0 h-5 w-5" />
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent>
        <p>{t('header.actions.toggleChangesPanel')}</p>
      </TooltipContent>
    </Tooltip>
  ) : null;

  const desktopSidebarActions = (
    <>
      {showPlanTab && (
        <Tooltip>
          <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={t('header.actions.openPlanAria')}
                onClick={handleOpenContextPlan}
                className={cn(desktopHeaderIconButtonClass, isContextPlanActive && 'bg-[var(--interactive-hover)]')}
              >
              <Icon name="file-text" className="h-[18px] w-[18px]" />
            </button>
          </TooltipTrigger>
          <TooltipContent>
            <p>{t('header.actions.planWithShortcut', { shortcut: shortcutLabel('toggle_context_plan') })}</p>
          </TooltipContent>
          </Tooltip>
      )}
      <OpenInAppButton directory={actionDirectory} className="mr-1" />
      <DesktopServicesMenu
        isDesktopApp={isDesktopApp}
        currentInstanceLabel={currentInstanceLabel}
        compactCurrentInstanceLabel={compactCurrentInstanceLabel}
        currentInstanceIsLocal={currentInstanceIsLocal}
        isDesktopServicesOpen={isDesktopServicesOpen}
        setIsDesktopServicesOpen={setIsDesktopServicesOpen}
        refreshCurrentInstanceLabel={refreshCurrentInstanceLabel}
        desktopServicesTab={desktopServicesTab}
        setDesktopServicesTab={setDesktopServicesTab}
        quotaResultsLength={quotaResults.length}
        fetchAllQuotas={fetchAllQuotas}
        servicesTabItems={servicesTabItems}
        quotaLastUpdated={quotaLastUpdated}
        quotaDisplayMode={quotaDisplayMode}
        showPredValues={showPredValues}
        quotaDisplayTabItems={quotaDisplayTabItems}
        handleDisplayModeChange={handleDisplayModeChange}
        handleUsageRefresh={handleUsageRefresh}
        isQuotaLoading={isQuotaLoading}
        isUsageRefreshSpinning={isUsageRefreshSpinning}
        hasRateLimits={hasRateLimits}
        rateLimitGroups={rateLimitGroups}
        expandedFamilies={expandedFamilies}
        toggleFamilyExpanded={toggleFamilyExpanded}
        shortcutLabel={shortcutLabel}
        showDevShutdown={showDevShutdown}
        isDevShutdownInFlight={isDevShutdownInFlight}
        onDevShutdown={handleDevShutdown}
        remoteUpdateInfo={remoteUpdateInfo}
        remoteUpdateChecking={remoteUpdateChecking}
        remoteUpdateError={remoteUpdateError}
        onOpenRemoteUpdate={openRemoteInstanceUpdate}
        timeFormatPreference={timeFormatPreference}
      />
      <HeaderIconActionButton
        title={t('header.actions.terminalPanelWithShortcut', { shortcut: shortcutLabel('toggle_terminal') })}
        ariaLabel={t('header.actions.toggleTerminalPanelAria')}
        onClick={toggleBottomTerminal}
        Icon={'terminal-box'}
      />
      {!isMobile ? (
        <HeaderIconActionButton
          title={t('contextPanel.browser.open')}
          ariaLabel={t('contextPanel.browser.open')}
          onClick={handleOpenContextBrowser}
          pressed={isContextBrowserActive}
          Icon={'global'}
        />
      ) : null}
      <HeaderIconActionButton
        title={t('header.actions.rightSidebarWithShortcut', { shortcut: shortcutLabel('toggle_right_sidebar') })}
        ariaLabel={t('header.actions.toggleRightSidebarAria')}
        onClick={toggleRightSidebar}
        Icon={'layout-right'}
      />
      <DesktopGitHubControl
        isMobile={isMobile}
        githubAuthStatus={githubAuthStatus}
        githubAccounts={githubAccounts}
        githubAvatarUrl={githubAvatarUrl}
        githubLogin={githubLogin}
        isSwitchingGitHubAccount={isSwitchingGitHubAccount}
        handleGitHubAccountSwitch={handleGitHubAccountSwitch}
      />
    </>
  );

  const showMiniChatHeaderAction = hasElectronDesktopIPC && (isNewSessionDraftOpen || Boolean(currentSessionId));

  const renderDesktop = () => (
    <div
      onMouseDown={handleDragStart}
      className={cn(
        'app-region-drag relative flex h-12 select-none items-center pr-3',
        macosHeaderSizeClass
      )}
      style={webWindowControlsOverlayStyle}
      role="tablist"
      aria-label={t('header.navigation.mainAria')}
    >
      {/* Drag region for the window-controls inset (traffic lights) to the left
          of the overlay buttons — stays a window drag area. */}
      <div
        aria-hidden
        className="shrink-0 self-stretch transition-[width] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
        style={{ width: headerInsetSpacerWidth }}
      />
      {/* No-drag carve under the persistent TitlebarLeftControls overlay so its
          buttons stay clickable. Width animates with the sidebar so the session
          title slides in lockstep instead of snapping. */}
      <div
        aria-hidden
        className="app-region-no-drag shrink-0 self-stretch transition-[width] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
        style={{ width: headerControlsSpacerWidth }}
      />
      {/* Sidebar toggle + project actions live in the persistent
          TitlebarLeftControls overlay; the header reserves matching left space
          via padding (see headerStyle) when the sidebar is collapsed. */}
      <div className="flex min-w-0 flex-1 items-center">
        <SessionSwitcherDropdown>
          <button
            type="button"
            aria-label={t('sessions.switcher.openAria')}
            className="app-region-no-drag mr-3 flex min-w-0 flex-col items-start rounded-md px-1 py-0.5 -my-0.5 text-left transition-colors hover:bg-interactive-hover/60 focus-visible:outline-none focus-visible:bg-interactive-hover/60"
          >
            <span className="truncate typography-ui-label text-[14px] font-normal leading-tight text-foreground max-w-full">
              {isNewSessionDraftOpen ? t('sessions.switcher.draftTitle') : currentSessionTitle}
            </span>
            {(activeProjectLabel || currentBranchLabel || (!isNewSessionDraftOpen && worktreeBadgeKind)) ? (
              <span className="flex min-w-0 max-w-full items-center gap-1.5 truncate typography-micro text-[10.5px] font-normal leading-tight text-muted-foreground/75">
                {activeProjectLabel ? <span className="truncate">{activeProjectLabel}</span> : null}
                {currentBranchLabel ? (
                  <span className="inline-flex min-w-0 items-center gap-0.5">
                    <Icon name="git-branch" className="h-3 w-3 flex-shrink-0 text-muted-foreground/70" />
                    <span className="truncate">{currentBranchLabel}</span>
                  </span>
                ) : null}
                {!isNewSessionDraftOpen && worktreeBadgeKind ? (
                  <span className={cn(
                    "inline-flex min-w-0 items-center gap-0.5",
                    worktreeBadgeKind === 'attention' || worktreeBadgeKind === 'invalid' || worktreeBadgeKind === 'missing' ? 'text-status-warning' : 'text-muted-foreground/60'
                  )}>
                    <Icon name="alert" className="h-3 w-3 flex-shrink-0" />
                    <span className="truncate">{worktreeBadge}</span>
                  </span>
                ) : null}
              </span>
            ) : null}
          </button>
        </SessionSwitcherDropdown>

        {tabs.length > 0 && (
          <div className="flex items-center gap-1 rounded-lg bg-[var(--surface-muted)]/50 p-1">
            {tabs.map((tab) => renderTab(tab))}
          </div>
        )}

        <div className="flex-1" />

        <div className="flex shrink-0 items-center gap-1">
          {showDesktopHeaderContextUsage && stableDesktopContextUsage ? (
            <ContextUsageDisplay
              totalTokens={stableDesktopContextUsage.totalTokens}
              percentage={desktopHeaderDisplayPercentage}
              colorPercentage={stableDesktopContextUsage.percentage}
              contextLimit={stableDesktopContextUsage.contextLimit}
              outputLimit={stableDesktopContextUsage.outputLimit ?? 0}
              size="compact"
              hideIcon
              showPercentIcon
              onClick={handleOpenContextPanel}
              pressed={isContextPanelActive}
              className={!showMiniChatHeaderAction ? 'mr-3.5' : ''}
              valueClassName="typography-ui-label font-medium leading-none text-foreground"
              percentIconClassName="h-4.5 w-4.5"
            />
          ) : null}
          {desktopChangesPanelAction}
          <HeaderIconActionButton
            visible={showMiniChatHeaderAction}
            title={isNewSessionDraftOpen ? t('header.actions.newMiniChat') : t('header.actions.openSessionMiniChat')}
            ariaLabel={isNewSessionDraftOpen ? t('header.actions.newMiniChatAria') : t('header.actions.openSessionMiniChatAria')}
            onClick={handleOpenCurrentMiniChat}
            className={cn(desktopHeaderIconButtonClass, 'mr-1')}
            Icon={'picture-in-picture-2'}
          />
          {desktopSidebarActions}
          <WindowsWindowControls visible={usesFramelessChrome && windowControlsSide === 'right'} position="right" />
        </div>
      </div>
    </div>
  );

  const renderMobile = () => (
    <div className="app-region-drag relative flex items-center gap-2 px-3 py-2 select-none">
      <div className="flex items-center gap-2 shrink-0">
        {/* Use drawer toggle when onToggleLeftDrawer is provided, otherwise use legacy session switcher */}
        {onToggleLeftDrawer ? (
          <button
            type="button"
            onClick={handleMobileLeftDrawerToggle}
            className={cn(
              mobileHeaderIconButtonClass,
              mobileActiveHeaderItem === 'sessions' && 'bg-interactive-selection text-interactive-selection-foreground'
            )}
            aria-label={leftDrawerOpen ? t('header.actions.closeSessionsAria') : t('header.actions.openSessionsAria')}
          >
            <Icon name="layout-left" className="h-5 w-5" />
          </button>
        ) : isSessionSwitcherOpen ? (
          <button
            type="button"
            onClick={() => setSessionSwitcherOpen(false)}
            className="app-region-no-drag h-9 w-9 p-2 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-md active:bg-interactive-active"
            aria-label={t('header.actions.backAria')}
          >
            <Icon name="arrow-left-s" className="h-5 w-5" />
          </button>
        ) : (
          <button
            type="button"
            onClick={handleOpenSessionSwitcher}
            className="app-region-no-drag h-9 w-9 p-2 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-md active:bg-interactive-active"
            aria-label={t('header.actions.openSessionsAria')}
          >
            <Icon name="play-list-add" className="h-5 w-5" />
          </button>
        )}

        {!onToggleLeftDrawer && isSessionSwitcherOpen && (
          <span className="typography-ui-label font-semibold text-foreground">{t('header.sessions.title')}</span>
        )}
      </div>

      {(!isSessionSwitcherOpen || Boolean(onToggleLeftDrawer)) && (
        <>
          <div className="app-region-no-drag flex min-w-0 flex-1 items-center">
            <div className="flex min-w-0 flex-1 overflow-x-auto overflow-y-hidden scrollbar-hidden touch-pan-x overscroll-x-contain">
              <div className="flex w-max items-center gap-1 pr-1">
                <div
                  className="flex items-center gap-0.5 rounded-lg bg-[var(--surface-muted)]/50 p-0.5"
                  role="tablist"
                  aria-label={t('header.navigation.mainAria')}
                >
                  {tabs.map((tab) => {
                    const isActive = activeMainTab === tab.id;
                    const isDiffTab = tab.icon === 'diff';
                    const tabIconName = isDiffTab ? null : (tab.icon as IconName);
                    return (
                      <Tooltip key={tab.id}>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            onClick={() => {
                              if (isMobile) {
                                blurActiveElement();
                                closeMobileHeaderPanels();
                              }
                              setActiveMainTab(tab.id);
                            }}
                            aria-label={tab.label}
                            aria-selected={isActive}
                            role="tab"
                            className={cn(
                              mobileHeaderIconButtonClass,
                              'relative rounded-lg',
                              mobileActiveHeaderItem === tab.id && 'bg-interactive-selection text-interactive-selection-foreground'
                            )}
                          >
                            {isDiffTab ? (
                              <DiffIcon className="h-5 w-5" />
                            ) : tabIconName ? (
                              <Icon name={tabIconName} className="h-5 w-5" />
                            ) : null}
                            {tab.badge !== undefined && tab.badge > 0 && (
                              <span className="absolute -top-1 -right-1 text-[10px] font-semibold text-primary">
                                {tab.badge}
                              </span>
                            )}
                            {tab.showDot && (
                              <span
                                className="absolute top-1.5 right-1.5 h-2 w-2 rounded-full bg-primary"
                                aria-label={t('header.changes.availableAria')}
                              />
                            )}
                          </button>
                        </TooltipTrigger>
                        <TooltipContent>
                          <p>{tab.label}</p>
                        </TooltipContent>
                      </Tooltip>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            {projectActionsContext && (
              <ProjectActionsButton
                projectRef={projectActionsContext.projectRef}
                directory={projectActionsContext.directory}
                compact
                allowMobile
                className="h-9"
              />
            )}

            {/* Mobile Services Menu (Usage + MCP) */}
            <DropdownMenu
              open={isMobileRateLimitsOpen}
              onOpenChange={(open) => {
                if (open) {
                  if (leftDrawerOpen && onToggleLeftDrawer) {
                    onToggleLeftDrawer();
                  }
                  if (rightDrawerOpen && onToggleRightDrawer) {
                    onToggleRightDrawer();
                  }
                }
                setIsMobileRateLimitsOpen(open);
                if (open && quotaResults.length === 0) {
                  fetchAllQuotas();
                }
              }}
            >
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label={t('header.services.viewAria')}
                      className={cn(
                        mobileHeaderIconButtonClass,
                        mobileActiveHeaderItem === 'services' && 'bg-interactive-selection text-interactive-selection-foreground'
                      )}
                    >
                      <Icon name="stack" className="h-5 w-5" />
                    </button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent>
                  <p>{t('header.services.title')}</p>
                </TooltipContent>
              </Tooltip>
              <DropdownMenuContent
                align="end"
                sideOffset={0}
                positionerClassName="!fixed !bottom-0 !left-0 !right-0 !top-[var(--oc-header-height,56px)] !transform-none"
                className="h-full w-screen max-h-none rounded-none border-0 p-0 pt-1 overflow-hidden"
              >
                <div className="flex h-full flex-col bg-[var(--surface-elevated)]">
                  <div className="sticky top-0 z-20 bg-[var(--surface-elevated)] px-2 py-px">
                    <div className="flex items-center justify-between gap-2 px-3 py-0">
                      <div className="h-10 min-w-0 flex-1">
                        <SortableTabsStrip
                          items={mobileServicesTabItems}
                          activeId={mobileServicesTab}
                          onSelect={(tabID) => {
                            const value = tabID as 'usage' | 'mcp';
                            setMobileServicesTab(value);
                            if (value === 'usage' && quotaResults.length === 0) {
                              fetchAllQuotas();
                            }
                          }}
                          layoutMode="fit"
                          variant="active-pill"
                          activePillInsetClassName="gap-0.5 px-px py-0"
                          activePillButtonClassName="h-8"
                          className="h-full"
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() => setIsMobileRateLimitsOpen(false)}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-interactive-hover"
                        aria-label={t('header.services.closeAria')}
                      >
                        <Icon name="close" className="h-5 w-5" />
                      </button>
                    </div>
                  </div>

                  {mobileServicesTab === 'mcp' && (
                    <McpDropdownContent active={isMobileRateLimitsOpen && mobileServicesTab === 'mcp'} />
                  )}

                  {mobileServicesTab === 'usage' && (
                    <div className="flex-1 overflow-y-auto overflow-x-hidden pb-[calc(4rem+env(safe-area-inset-bottom))]">
                      {/* Mobile usage header */}
                      <div className="border-b border-[var(--interactive-border)]">
                        <div className="flex items-center justify-between gap-3 px-4 py-3">
                          <div className="flex flex-col min-w-0 gap-0.5">
                            <span className="typography-ui-header font-semibold text-foreground">{t('header.services.rateLimits')}</span>
                            <span className="truncate typography-micro text-muted-foreground">
                              {formatTime(quotaLastUpdated, timeFormatPreference)}
                            </span>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            <div className="flex items-center h-6">
                              <button
                                type="button"
                                onClick={() => handleDisplayModeChange('usage')}
                                className={cn(
                                  'typography-ui-label px-1 pb-0.5 transition-colors',
                                  quotaDisplayMode === 'usage'
                                    ? 'text-foreground border-b-2 border-[var(--primary-base)]'
                                    : 'text-muted-foreground hover:text-foreground'
                                )}
                              >
                                {t('header.services.used')}
                              </button>
                              <span className="text-muted-foreground typography-ui-label px-0.5">·</span>
                              <button
                                type="button"
                                onClick={() => handleDisplayModeChange('remaining')}
                                className={cn(
                                  'typography-ui-label px-1 pb-0.5 transition-colors',
                                  quotaDisplayMode === 'remaining'
                                    ? 'text-foreground border-b-2 border-[var(--primary-base)]'
                                    : 'text-muted-foreground hover:text-foreground'
                                )}
                              >
                                {t('header.services.remaining')}
                              </button>
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
                      </div>

                      {!hasRateLimits && (
                        <div className="px-4 py-6 text-center">
                          <span className="typography-ui-label text-muted-foreground">{t('header.services.noRateLimits')}</span>
                        </div>
                      )}

                      {/* Mobile provider groups */}
                      <div className="py-1">
                        {rateLimitGroups.map((group, index) => (
                          <React.Fragment key={group.providerId}>
                            {index > 0 ? (
                              <div className="mx-4 my-1 border-t border-[var(--interactive-border)]" />
                            ) : null}

                            {/* Provider header */}
                            <div className="flex items-center gap-2 px-4 py-2">
                              <ProviderLogo providerId={group.providerId} className="h-4 w-4" />
                              <span className="typography-ui-label font-medium text-foreground">{group.providerName}</span>
                            </div>

                            {group.entries.length === 0 && (!group.modelFamilies || group.modelFamilies.length === 0) ? (
                              <div className="px-4 pb-2">
                                <span className="typography-ui-label text-muted-foreground">
                                  {group.error ?? t('header.services.noRateLimitsReported')}
                                </span>
                              </div>
                            ) : (
                              <div className="space-y-3 px-4 pb-2">
                                {/* Window-level entries */}
                                {group.entries.map(([label, window]) => {
                                  const displayPercent = quotaDisplayMode === 'remaining'
                                    ? window.remainingPercent
                                    : window.usedPercent;
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
                                        <span className="typography-ui-label text-foreground tabular-nums">
                                          {metricLabel === '-' ? '' : metricLabel}
                                        </span>
                                      </div>
                                      <UsageProgressBar
                                        percent={displayPercent}
                                        tonePercent={window.usedPercent}
                                        className="h-1.5"
                                        expectedMarkerPercent={expectedMarker}
                                      />
                                      {paceInfo && showPredValues ? (
                                        <PaceIndicator paceInfo={paceInfo} compact />
                                      ) : null}
                                    </div>
                                  );
                                })}

                                {/* Model family collapsibles */}
                                {group.modelFamilies && group.modelFamilies.length > 0 && (
                                  <div className="space-y-0.5">
                                    {group.modelFamilies.map((family) => {
                                      const providerExpandedFamilies = expandedFamilies[group.providerId] ?? [];
                                      const isExpanded = providerExpandedFamilies.includes(family.familyId ?? 'other');

                                      return (
                                        <Collapsible
                                          key={family.familyId ?? 'other'}
                                          open={isExpanded}
                                          onOpenChange={() => toggleFamilyExpanded(group.providerId, family.familyId ?? 'other')}
                                        >
                                          <CollapsibleTrigger className="flex w-full items-center justify-between rounded-md px-1 py-1.5 text-left hover:bg-[var(--interactive-hover)]/50 transition-colors">
                                            <span className="typography-ui-label font-medium text-foreground">
                                              {family.familyLabel}
                                            </span>
                                            {isExpanded ? (
                                              <Icon name="arrow-down-s" className="h-4 w-4 text-muted-foreground" />
                                            ) : (
                                              <Icon name="arrow-right-s" className="h-4 w-4 text-muted-foreground" />
                                            )}
                                          </CollapsibleTrigger>
                                          <CollapsibleContent>
                                            <div className="space-y-2.5 pb-1 pl-1 pt-1">
                                              {family.models.map(([modelName, window]) => {
                                                const displayPercent = quotaDisplayMode === 'remaining'
                                                  ? window.remainingPercent
                                                  : window.usedPercent;
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
                                                      <span className="typography-ui-label text-foreground tabular-nums">
                                                        {metricLabel === '-' ? '' : metricLabel}
                                                      </span>
                                                    </div>
                                                    <UsageProgressBar
                                                      percent={displayPercent}
                                                      tonePercent={window.usedPercent}
                                                      className="h-1.5"
                                                      expectedMarkerPercent={expectedMarker}
                                                    />
                                                    {paceInfo && showPredValues ? (
                                                      <PaceIndicator paceInfo={paceInfo} compact />
                                                    ) : null}
                                                  </div>
                                                );
                                              })}
                                            </div>
                                          </CollapsibleContent>
                                        </Collapsible>
                                      );
                                    })}
                                  </div>
                                )}
                              </div>
                            )}
                          </React.Fragment>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </DropdownMenuContent>
            </DropdownMenu>

            {onToggleRightDrawer ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={handleMobileRightDrawerToggle}
                    className={cn(
                      mobileHeaderIconButtonClass,
                      'relative',
                      mobileActiveHeaderItem === 'git' && 'bg-interactive-selection text-interactive-selection-foreground'
                    )}
                    aria-label={rightDrawerOpen ? 'Close git sidebar' : 'Open git sidebar'}
                  >
                    <Icon name="layout-right" className="h-5 w-5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>{rightDrawerOpen ? 'Close git sidebar' : 'Open git sidebar'}</p>
                </TooltipContent>
              </Tooltip>
            ) : null}
          </div>
        </>
      )}
    </div>
  );

  const headerClassName = cn(
    'header-safe-area relative z-10 bg-background',
    // Mobile keeps a full-width divider. On desktop the divider lives on the chat
    // content wrapper instead, so it doesn't run between the header and the right
    // sidebar (they read as one continuous surface).
    isMobile && 'border-b border-border/50'
  );

  return (
    <>
      <header
        ref={headerRef}
        className={headerClassName}
        style={{ ['--padding-scale' as string]: '1' } as React.CSSProperties}
      >
        {isMobile ? renderMobile() : renderDesktop()}
      </header>
      <UpdateDialog
        open={remoteUpdateDialogOpen}
        onOpenChange={setRemoteUpdateDialogOpen}
        info={remoteUpdateInfo}
        downloading={false}
        downloaded={false}
        progress={null}
        error={remoteUpdateError}
        onDownload={() => {}}
        onRestart={() => {}}
        runtimeType="web"
      />
    </>
  );
};
