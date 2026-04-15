import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
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

import { RiArrowLeftSLine, RiChat4Line, RiChatNewLine, RiCheckLine, RiCloseLine, RiCommandLine, RiFileTextLine, RiFolder6Line, RiGitBranchLine, RiGithubFill, RiLayoutLeftLine, RiLayoutRightLine, RiPlayListAddLine, RiRefreshLine, RiServerLine, RiStackLine, RiTerminalBoxLine, RiTimerLine, type RemixiconComponentType } from '@remixicon/react';
import { DiffIcon } from '@/components/icons/DiffIcon';
import { useUIStore, type MainTab } from '@/stores/useUIStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSession, useSessionMessagesResolved } from '@/sync/sync-context';
import { getAllSyncSessions } from '@/sync/sync-refs';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useQuotaAutoRefresh, useQuotaStore } from '@/stores/useQuotaStore';
import { useFilesViewTabsStore } from '@/stores/useFilesViewTabsStore';
import { useGitBranchLabel } from '@/stores/useGitStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useFeatureFlagsStore } from '@/stores/useFeatureFlagsStore';

import { useGitHubAuthStore } from '@/stores/useGitHubAuthStore';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { ContextUsageDisplay } from '@/components/ui/ContextUsageDisplay';
import { useDeviceInfo } from '@/lib/device';
import { cn, hasModifier } from '@/lib/utils';
import { McpDropdownContent } from '@/components/mcp/McpDropdown';
import { McpIcon } from '@/components/icons/McpIcon';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { formatPercent, formatWindowLabel, QUOTA_PROVIDERS, calculatePace, calculateExpectedUsagePercent } from '@/lib/quota';
import { UsageProgressBar } from '@/components/sections/usage/UsageProgressBar';
import { PaceIndicator } from '@/components/sections/usage/PaceIndicator';
import { updateDesktopSettings } from '@/lib/persistence';
import { eventMatchesShortcut, formatShortcutForDisplay, getEffectiveShortcutCombo } from '@/lib/shortcuts';
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
import { RiArrowDownSLine, RiArrowRightSLine } from '@remixicon/react';
import type { UsageWindow } from '@/types';
import type { GitHubAuthStatus } from '@/lib/api/types';
import type { SessionContextUsage } from '@/stores/types/sessionTypes';
import { DesktopHostSwitcherDialog } from '@/components/desktop/DesktopHostSwitcher';
import { OpenInAppButton } from '@/components/desktop/OpenInAppButton';
import { ProjectActionsButton } from '@/components/layout/ProjectActionsButton';
import { isDesktopShell, isVSCodeRuntime, startDesktopWindowDrag } from '@/lib/desktop';
import { desktopHostsGet, locationMatchesHost, redactSensitiveUrl } from '@/lib/desktopHosts';
import { resolveSessionDiffStats } from '@/components/session/sidebar/utils';
import type { Session } from '@opencode-ai/sdk/v2/client';

const DESKTOP_HEADER_ICON_BUTTON_CLASS = 'app-region-no-drag inline-flex h-8 w-8 items-center justify-center gap-2 rounded-md typography-ui-label font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:pointer-events-none disabled:opacity-50 hover:bg-interactive-hover transition-colors';
const MOBILE_HEADER_ICON_BUTTON_CLASS = 'app-region-no-drag inline-flex h-9 w-9 items-center justify-center gap-2 p-2 rounded-md typography-ui-label font-medium text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:pointer-events-none disabled:opacity-50 hover:text-foreground hover:bg-interactive-hover transition-colors';

type HeaderIconActionButtonProps = {
  visible?: boolean;
  title: string;
  ariaLabel: string;
  onClick: () => void;
  className?: string;
  Icon: RemixiconComponentType;
  iconClassName?: string;
};

const HeaderIconActionButton = React.memo(function HeaderIconActionButton({
  visible = true,
  title,
  ariaLabel,
  onClick,
  className,
  Icon,
  iconClassName,
}: HeaderIconActionButtonProps) {
  if (!visible) {
    return null;
  }

  return (
    <Tooltip delayDuration={500}>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          aria-label={ariaLabel}
          className={className ?? DESKTOP_HEADER_ICON_BUTTON_CLASS}
        >
          <Icon className={iconClassName ?? 'h-[18px] w-[18px]'} />
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
            title={githubLogin ? `GitHub: ${githubLogin}` : 'GitHub connected'}
            disabled={isSwitchingGitHubAccount}
          >
            {githubAvatarUrl ? (
              <img
                src={githubAvatarUrl}
                alt={githubLogin ? `${githubLogin} avatar` : 'GitHub avatar'}
                className="h-full w-full object-cover"
                loading="lazy"
                referrerPolicy="no-referrer"
              />
            ) : (
              <RiGithubFill className="h-3.5 w-3.5 text-foreground" />
            )}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuLabel className="typography-ui-header font-semibold text-foreground">
            GitHub Accounts
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {githubAccounts.map((account) => {
            const accountUser = account.user;
            const isCurrent = Boolean(account.current);
            return (
              <DropdownMenuItem
                key={account.id}
                className="gap-2"
                disabled={isCurrent || isSwitchingGitHubAccount}
                onSelect={() => {
                  if (!isCurrent) {
                    void handleGitHubAccountSwitch(account.id);
                  }
                }}
              >
                {accountUser?.avatarUrl ? (
                  <img
                    src={accountUser.avatarUrl}
                    alt={accountUser.login ? `${accountUser.login} avatar` : 'GitHub avatar'}
                    className="h-6 w-6 rounded-full border border-border/60 bg-muted object-cover"
                    loading="lazy"
                    referrerPolicy="no-referrer"
                  />
                ) : (
                  <div className="flex h-6 w-6 items-center justify-center rounded-full border border-border/60 bg-muted">
                    <RiGithubFill className="h-3 w-3 text-muted-foreground" />
                  </div>
                )}
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate typography-ui-label text-foreground">
                    {accountUser?.name?.trim() || accountUser?.login || 'GitHub'}
                  </span>
                  {accountUser?.login ? (
                    <span className="truncate typography-micro font-mono text-muted-foreground">
                      {accountUser.login}
                    </span>
                  ) : null}
                </span>
                {isCurrent ? <RiCheckLine className="h-4 w-4 text-primary" /> : null}
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
      title={githubLogin ? `GitHub: ${githubLogin}` : 'GitHub connected'}
    >
      {githubAvatarUrl ? (
        <img
          src={githubAvatarUrl}
          alt={githubLogin ? `${githubLogin} avatar` : 'GitHub avatar'}
          className="h-full w-full object-cover"
          loading="lazy"
          referrerPolicy="no-referrer"
        />
      ) : (
        <RiGithubFill className="h-3.5 w-3.5 text-foreground" />
      )}
    </div>
  );
});

type DesktopServicesMenuProps = {
  isDesktopApp: boolean;
  currentInstanceLabel: string;
  compactCurrentInstanceLabel: string;
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
};

const DesktopServicesMenu = React.memo(function DesktopServicesMenu({
  isDesktopApp,
  currentInstanceLabel,
  compactCurrentInstanceLabel,
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
}: DesktopServicesMenuProps) {
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
      <Tooltip delayDuration={500}>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={isDesktopApp
                ? `Open instance, usage and MCP (current: ${currentInstanceLabel})`
                : 'Open services, usage and MCP'}
              className={cn(
                DESKTOP_HEADER_ICON_BUTTON_CLASS,
                isDesktopApp ? 'w-auto max-w-[14rem] justify-start gap-1.5 px-2.5' : 'h-8 w-8'
              )}
            >
              <RiStackLine className="h-[18px] w-[18px]" />
              {isDesktopApp ? (
                <span className="truncate typography-ui-label font-medium text-foreground">{compactCurrentInstanceLabel}</span>
              ) : null}
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>
          <p>
            {isDesktopApp ? `Current instance: ${currentInstanceLabel}` : 'Services'} ({shortcutLabel('toggle_services_menu')}; next tab {shortcutLabel('cycle_services_tab')})
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
          <DesktopHostSwitcherDialog
            embedded
            open={isDesktopServicesOpen && desktopServicesTab === 'instance'}
            onOpenChange={() => {}}
            onHostSwitched={() => setIsDesktopServicesOpen(false)}
          />
        ) : null}

        {desktopServicesTab === 'mcp' ? (
          <McpDropdownContent active={isDesktopServicesOpen && desktopServicesTab === 'mcp'} />
        ) : null}

        {desktopServicesTab === 'usage' ? (
          <div className="overflow-x-hidden">
            <div className="flex items-center justify-between gap-3 border-b border-[var(--interactive-border)] px-4 py-2.5">
              <div className="flex min-w-0 items-baseline gap-2">
                <span className="typography-ui-header font-semibold text-foreground">Rate limits</span>
                <span className="truncate typography-micro text-muted-foreground">{formatTime(quotaLastUpdated)}</span>
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
                  aria-label="Refresh rate limits"
                >
                  <RiRefreshLine className={cn('h-4 w-4', isUsageRefreshSpinning && 'animate-spin')} />
                </button>
              </div>
            </div>

            {!hasRateLimits ? (
              <div className="px-4 py-5 text-center">
                <span className="typography-ui-label text-muted-foreground">No rate limits available.</span>
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
                        <span className="typography-ui-label text-muted-foreground">{group.error ?? 'No rate limits reported.'}</span>
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
                          return (
                            <div key={`${group.providerId}-${label}`} className="flex flex-col gap-1.5">
                              <div className="flex min-w-0 items-center justify-between gap-3">
                                <div className="min-w-0 flex items-center gap-2">
                                  <span className="truncate typography-ui-label text-foreground">{formatWindowLabel(label)}</span>
                                  {window.resetAfterFormatted ?? window.resetAtFormatted ? (
                                    <span className="truncate typography-micro text-muted-foreground">
                                      {window.resetAfterFormatted ?? window.resetAtFormatted}
                                    </span>
                                  ) : null}
                                </div>
                                <span className="typography-ui-label tabular-nums text-foreground">
                                  {formatPercent(displayPercent) === '-' ? '' : formatPercent(displayPercent)}
                                </span>
                              </div>
                              <UsageProgressBar
                                percent={displayPercent}
                                tonePercent={window.usedPercent}
                                className="h-1.5"
                                expectedMarkerPercent={expectedMarker}
                              />
                              {paceInfo ? <PaceIndicator paceInfo={paceInfo} compact /> : null}
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
                                    {isExpanded ? <RiArrowDownSLine className="h-4 w-4 text-muted-foreground" /> : <RiArrowRightSLine className="h-4 w-4 text-muted-foreground" />}
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
                                        return (
                                          <div key={`${group.providerId}-${modelName}`} className="flex flex-col gap-1.5">
                                            <div className="flex min-w-0 items-center justify-between gap-3">
                                              <span className="truncate typography-micro text-muted-foreground">{getDisplayModelName(modelName)}</span>
                                              <span className="typography-ui-label tabular-nums text-foreground">
                                                {formatPercent(displayPercent) === '-' ? '' : formatPercent(displayPercent)}
                                              </span>
                                            </div>
                                            <UsageProgressBar
                                              percent={displayPercent}
                                              tonePercent={window.usedPercent}
                                              className="h-1.5"
                                              expectedMarkerPercent={expectedMarker}
                                            />
                                            {paceInfo ? <PaceIndicator paceInfo={paceInfo} compact /> : null}
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

const formatTime = (timestamp: number | null) => {
  if (!timestamp) return '-';
  try {
    return new Date(timestamp).toLocaleTimeString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    });
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
  tabs: Array<{ id: string; mode: 'diff' | 'file' | 'context' | 'plan' | 'chat' }>;
} | undefined): 'diff' | 'file' | 'context' | 'plan' | 'chat' | null => {
  if (!panelState?.isOpen || !Array.isArray(panelState.tabs) || panelState.tabs.length === 0) {
    return null;
  }

  const activeTab = panelState.tabs.find((tab) => tab.id === panelState.activeTabId) ?? panelState.tabs[panelState.tabs.length - 1];
  return activeTab?.mode ?? null;
};

interface TabConfig {
  id: MainTab;
  label: string;
  icon: RemixiconComponentType | 'diff';
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
  desktopRightSidebarActionsHost?: HTMLElement | null;
}

export const Header: React.FC<HeaderProps> = ({
  onToggleLeftDrawer,
  onToggleRightDrawer,
  leftDrawerOpen,
  rightDrawerOpen,
  desktopRightSidebarActionsHost = null,
}) => {
  const setSessionSwitcherOpen = useUIStore((state) => state.setSessionSwitcherOpen);
  const toggleSidebar = useUIStore((state) => state.toggleSidebar);
  const isSidebarOpen = useUIStore((state) => state.isSidebarOpen);
  const isRightSidebarOpen = useUIStore((state) => state.isRightSidebarOpen);
  const toggleBottomTerminal = useUIStore((state) => state.toggleBottomTerminal);
  const toggleRightSidebar = useUIStore((state) => state.toggleRightSidebar);
  const openContextOverview = useUIStore((state) => state.openContextOverview);
  const openContextPlan = useUIStore((state) => state.openContextPlan);
  const closeContextPanel = useUIStore((state) => state.closeContextPanel);
  const contextPanelByDirectory = useUIStore((state) => state.contextPanelByDirectory);
  const activeMainTab = useUIStore((state) => state.activeMainTab);
  const setActiveMainTab = useUIStore((state) => state.setActiveMainTab);
  const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);

  const getCurrentModel = useConfigStore((state) => state.getCurrentModel);
  const runtimeApis = useRuntimeAPIs();

  const getContextUsage = useSessionUIStore((state) => state.getContextUsage);
  const openNewSessionDraft = useSessionUIStore((state) => state.openNewSessionDraft);
  const isNewSessionDraftOpen = useSessionUIStore((state) => Boolean(state.newSessionDraft?.open));
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const currentSessionMessagesResolved = useSessionMessagesResolved(currentSessionId ?? '');
  const currentSyncedSession = useSession(currentSessionId ?? null);
  const globalActiveSessions = useGlobalSessionsStore((state) => state.activeSessions);
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
  const [isDesktopWindowFullscreen, setIsDesktopWindowFullscreen] = React.useState(false);

  const isMacPlatform = React.useMemo(() => {
    if (typeof navigator === 'undefined') {
      return false;
    }
    return /Macintosh|Mac OS X/.test(navigator.userAgent || '');
  }, []);

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
  const [currentInstanceLabel, setCurrentInstanceLabel] = React.useState('Local');
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
  const isLeftSidebarOpen = React.useMemo(() => {
    if (!isMobile) {
      return isSidebarOpen;
    }
    if (typeof onToggleLeftDrawer === 'function') {
      return Boolean(leftDrawerOpen);
    }
    return isSessionSwitcherOpen;
  }, [isMobile, isSessionSwitcherOpen, isSidebarOpen, leftDrawerOpen, onToggleLeftDrawer]);
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
      const currentHref = window.location.href;
      const localOrigin = window.__OPENCHAMBER_LOCAL_ORIGIN__ || window.location.origin;

      if (locationMatchesHost(currentHref, localOrigin)) {
        setCurrentInstanceLabel('Local');
        return;
      }

      const match = cfg.hosts.find((host) => {
        return locationMatchesHost(currentHref, host.url);
      });

      if (match?.label?.trim()) {
        setCurrentInstanceLabel(redactSensitiveUrl(match.label.trim()));
        return;
      }

      setCurrentInstanceLabel('Instance');
    } catch {
      setCurrentInstanceLabel('Local');
    }
  }, [isDesktopApp]);

  useEffect(() => {
    void refreshCurrentInstanceLabel();
  }, [refreshCurrentInstanceLabel]);
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
              familyLabel: 'Other',
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
  }, [dropdownProviderIds, quotaResults, selectedModels]);
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
    // Resolve from the global sessions snapshot first (same source as sidebar).
    // Child-store lists are intentionally partial/truncated during bootstrap.
    return globalActiveSessions.find((s) => s.id === currentSessionId)
      ?? currentSyncedSession
      ?? getAllSyncSessions().find((s) => s.id === currentSessionId)
      ?? null;
  }, [currentSessionId, currentSyncedSession, globalActiveSessions]);

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

  const currentSessionDiffStats = React.useMemo(() => {
    return resolveSessionDiffStats(currentSession?.summary as Parameters<typeof resolveSessionDiffStats>[0]);
  }, [currentSession?.summary]);

  const currentSessionChanges = React.useMemo(() => {
    if (currentSessionDiffStats) {
      return currentSessionDiffStats;
    }
    return { additions: 0, deletions: 0 };
  }, [currentSessionDiffStats]);
  const hasNonZeroSessionChanges = currentSessionChanges.additions > 0 || currentSessionChanges.deletions > 0;

  const selectedFilePath = useFilesViewTabsStore((state) => {
    const directory = normalize(openDirectory || '');
    if (!directory) {
      return null;
    }
    return state.byRoot[directory]?.selectedPath ?? null;
  });

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
          const response = await fetch('/api/github/auth/activate', {
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

  const handleHeaderNewSession = React.useCallback(() => {
    setActiveMainTab('chat');
    setSessionSwitcherOpen(false);
    openNewSessionDraft();
  }, [openNewSessionDraft, setActiveMainTab, setSessionSwitcherOpen]);

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

  const isContextPlanActive = React.useMemo(() => {
    const directory = normalize(openDirectory || '');
    if (!directory) {
      return false;
    }
    const panelState = contextPanelByDirectory[directory];
    return getActiveContextMode(panelState) === 'plan';
  }, [contextPanelByDirectory, openDirectory]);

  const desktopHeaderIconButtonClass = DESKTOP_HEADER_ICON_BUTTON_CLASS;
  const mobileHeaderIconButtonClass = MOBILE_HEADER_ICON_BUTTON_CLASS;

  const desktopPaddingClass = React.useMemo(() => {
    if (!isSidebarOpen && isDesktopApp && isMacPlatform && !isDesktopWindowFullscreen) {
      return 'pl-[5.5rem]';
    }
    return 'pl-3';
  }, [isDesktopApp, isDesktopWindowFullscreen, isMacPlatform, isSidebarOpen]);

  useEffect(() => {
    if (!isDesktopApp || !isMacPlatform) {
      setIsDesktopWindowFullscreen(false);
      return;
    }

    let disposed = false;
    let unlistenResize: (() => void) | null = null;

    const syncFullscreenState = async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const currentWindow = getCurrentWindow();
        const fullscreen = await currentWindow.isFullscreen();
        if (!disposed) {
          setIsDesktopWindowFullscreen(fullscreen);
        }
      } catch {
        if (!disposed) {
          setIsDesktopWindowFullscreen(false);
        }
      }
    };

    const attach = async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const currentWindow = getCurrentWindow();
        unlistenResize = await currentWindow.onResized(() => {
          void syncFullscreenState();
        });
      } catch {
        // Ignore listener setup failures; fallback state remains false.
      }
    };

    void syncFullscreenState();
    void attach();

    return () => {
      disposed = true;
      if (unlistenResize) {
        unlistenResize();
      }
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
        { id: 'chat', label: 'Chat', icon: RiChat4Line },
      ];

      if (showPlanTab) {
        base.push({ id: 'plan', label: 'Plan', icon: RiFileTextLine });
      }

      base.push(
        { id: 'diff', label: 'Diff', icon: 'diff' },
        { id: 'files', label: 'Files', icon: RiFolder6Line },
        { id: 'terminal', label: 'Terminal', icon: RiTerminalBoxLine },
      );

      return base;
    }

    // Desktop: no tabs in header
    return [];
  }, [isMobile, showPlanTab]);

  const shortcutLabel = React.useCallback((actionId: string) => {
    return formatShortcutForDisplay(getEffectiveShortcutCombo(actionId, shortcutOverrides));
  }, [shortcutOverrides]);

  useEffect(() => {
    if (!isMobile && (activeMainTab === 'git' || activeMainTab === 'terminal' || activeMainTab === 'diff' || activeMainTab === 'files')) {
      setActiveMainTab('chat');
    }
  }, [activeMainTab, isMobile, setActiveMainTab]);

  const servicesTabs = React.useMemo(() => {
    const base: Array<{ value: 'instance' | 'usage' | 'mcp'; label: string; icon: RemixiconComponentType }> = [];
    if (isDesktopApp) {
      base.push({ value: 'instance', label: 'Instance', icon: RiServerLine });
    }
    base.push(
      { value: 'usage', label: 'Usage', icon: RiTimerLine },
      { value: 'mcp', label: 'MCP', icon: McpIcon as unknown as RemixiconComponentType }
    );
    return base;
  }, [isDesktopApp]);

  const servicesTabItems = React.useMemo(() => {
    return servicesTabs.map((tab) => ({
      id: tab.value,
      label: tab.label,
      icon: <tab.icon className="h-3.5 w-3.5" />,
    }));
  }, [servicesTabs]);

  const quotaDisplayTabs = React.useMemo(() => {
    return [
      { value: 'usage' as const, label: 'Used' },
      { value: 'remaining' as const, label: 'Remaining' },
    ];
  }, []);

  const quotaDisplayTabItems = React.useMemo(() => {
    return quotaDisplayTabs.map((tab) => ({ id: tab.value, label: tab.label }));
  }, [quotaDisplayTabs]);

  const mobileServicesTabItems = React.useMemo<SortableTabsStripItem[]>(() => {
    return [
      { id: 'usage', label: 'Usage', icon: <RiTimerLine className="h-3.5 w-3.5" /> },
      { id: 'mcp', label: 'MCP', icon: <RiCommandLine className="h-3.5 w-3.5" /> },
    ];
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (hasModifier(e) && !e.shiftKey && !e.altKey) {
        const num = parseInt(e.key, 10);
        if (num >= 1 && num <= tabs.length) {
          e.preventDefault();
          setActiveMainTab(tabs[num - 1].id);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [tabs, setActiveMainTab]);

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
    const Icon = isDiffTab ? null : (tab.icon as RemixiconComponentType);
    const isChatTab = tab.id === 'chat';

    const renderIcon = (iconSize: number) => {
      if (isDiffTab) {
        return <DiffIcon size={iconSize} />;
      }
      return Icon ? <Icon size={iconSize} /> : null;
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

  const desktopSidebarActions = (
    <>
      {showPlanTab && (
        <Tooltip delayDuration={500}>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="Open plan"
              onClick={handleOpenContextPlan}
              className={cn(desktopHeaderIconButtonClass, isContextPlanActive && 'bg-[var(--interactive-hover)]')}
            >
              <RiFileTextLine className="h-[18px] w-[18px]" />
            </button>
          </TooltipTrigger>
          <TooltipContent>
            <p>Plan ({shortcutLabel('toggle_context_plan')})</p>
          </TooltipContent>
        </Tooltip>
      )}
      <OpenInAppButton directory={openDirectory} activeFilePath={selectedFilePath} className="mr-1" />
      <DesktopServicesMenu
        isDesktopApp={isDesktopApp}
        currentInstanceLabel={currentInstanceLabel}
        compactCurrentInstanceLabel={compactCurrentInstanceLabel}
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
      />
      <HeaderIconActionButton
        title={`Terminal panel (${shortcutLabel('toggle_terminal')})`}
        ariaLabel="Toggle terminal panel"
        onClick={toggleBottomTerminal}
        Icon={RiTerminalBoxLine}
      />
      <HeaderIconActionButton
        title={`Right sidebar (${shortcutLabel('toggle_right_sidebar')})`}
        ariaLabel="Toggle right sidebar"
        onClick={toggleRightSidebar}
        Icon={RiLayoutRightLine}
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

  const desktopSidebarActionsInline = !isRightSidebarOpen || !desktopRightSidebarActionsHost;

  const renderDesktop = () => (
    <div
      onMouseDown={handleDragStart}
      className={cn(
        'app-region-drag relative flex h-12 select-none items-center pr-3',
        desktopPaddingClass,
        macosHeaderSizeClass
      )}
      role="tablist"
      aria-label="Main navigation"
    >
      <HeaderIconActionButton
        visible={!isSidebarOpen}
        title={`Open sessions (${shortcutLabel('toggle_sidebar')})`}
        ariaLabel="Open sessions"
        onClick={handleOpenSessionSwitcher}
        className={`${desktopHeaderIconButtonClass} shrink-0`}
        Icon={RiLayoutLeftLine}
      />

      <div className={cn('flex min-w-0 flex-1 items-center', !isSidebarOpen && 'pl-3')}>
        {!isLeftSidebarOpen ? (
          <Tooltip delayDuration={500}>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="New session"
                onClick={handleHeaderNewSession}
                className={cn(desktopHeaderIconButtonClass, 'mr-6 shrink-0')}
              >
                <RiChatNewLine className="h-[18px] w-[18px]" />
              </button>
            </TooltipTrigger>
            <TooltipContent>
              <p>New session ({shortcutLabel('new_chat')})</p>
            </TooltipContent>
          </Tooltip>
        ) : null}
        {projectActionsContext && (
          <ProjectActionsButton
            projectRef={projectActionsContext.projectRef}
            directory={projectActionsContext.directory}
            className="mr-2"
          />
        )}
        {!isNewSessionDraftOpen ? (
          <div className="mr-3 min-w-0">
            <div className="truncate pl-1 typography-ui-label text-[14px] font-normal leading-tight text-foreground">
              {currentSessionTitle}
            </div>
            {(activeProjectLabel || currentBranchLabel || hasNonZeroSessionChanges) ? (
              <div className="flex min-w-0 items-center gap-1.5 truncate pl-1 typography-micro text-[10.5px] font-normal leading-tight text-muted-foreground/75">
                {activeProjectLabel ? <span className="truncate">{activeProjectLabel}</span> : null}
                {currentBranchLabel ? (
                  <span className="inline-flex min-w-0 items-center gap-0.5">
                    <RiGitBranchLine className="h-3 w-3 flex-shrink-0 text-muted-foreground/70" />
                    <span className="truncate">{currentBranchLabel}</span>
                  </span>
                ) : null}
                {hasNonZeroSessionChanges ? (
                  <span className="inline-flex flex-shrink-0 items-center gap-0 text-[0.92em]">
                    <span className="text-status-success/80">+{currentSessionChanges.additions}</span>
                    <span className="text-muted-foreground/60">/</span>
                    <span className="text-status-error/65">-{currentSessionChanges.deletions}</span>
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}

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
              className={desktopSidebarActionsInline ? 'mr-3.5' : ''}
              valueClassName="typography-ui-label font-medium leading-none text-foreground"
              percentIconClassName="h-5 w-5"
            />
          ) : null}
          {desktopSidebarActionsInline ? desktopSidebarActions : null}
          {!desktopSidebarActionsInline && desktopRightSidebarActionsHost
            ? createPortal(desktopSidebarActions, desktopRightSidebarActionsHost)
            : null}
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
            onClick={onToggleLeftDrawer}
            className={cn(
              mobileHeaderIconButtonClass,
              leftDrawerOpen && 'bg-interactive-selection text-interactive-selection-foreground'
            )}
            aria-label={leftDrawerOpen ? 'Close sessions' : 'Open sessions'}
          >
            <RiLayoutLeftLine className="h-5 w-5" />
          </button>
        ) : isSessionSwitcherOpen ? (
          <button
            type="button"
            onClick={() => setSessionSwitcherOpen(false)}
            className="app-region-no-drag h-9 w-9 p-2 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-md active:bg-interactive-active"
            aria-label="Back"
          >
            <RiArrowLeftSLine className="h-5 w-5" />
          </button>
        ) : (
          <button
            type="button"
            onClick={handleOpenSessionSwitcher}
            className="app-region-no-drag h-9 w-9 p-2 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-md active:bg-interactive-active"
            aria-label="Open sessions"
          >
            <RiPlayListAddLine className="h-5 w-5" />
          </button>
        )}

        {isSessionSwitcherOpen && (
          <span className="typography-ui-label font-semibold text-foreground">Sessions</span>
        )}
      </div>

      {/* Hide tabs and right-side buttons when sessions sidebar is open */}
      {!isSessionSwitcherOpen && (
        <>
          <div className="app-region-no-drag flex min-w-0 flex-1 items-center">
            <div className="flex min-w-0 flex-1 overflow-x-auto overflow-y-hidden scrollbar-hidden touch-pan-x overscroll-x-contain">
              <div className="flex w-max items-center gap-1 pr-1">
                <div
                  className="flex items-center gap-0.5 rounded-lg bg-[var(--surface-muted)]/50 p-0.5"
                  role="tablist"
                  aria-label="Main navigation"
                >
                  {tabs.map((tab) => {
                    const isActive = activeMainTab === tab.id;
                    const isDiffTab = tab.icon === 'diff';
                    const Icon = isDiffTab ? null : (tab.icon as RemixiconComponentType);
                    return (
                      <Tooltip key={tab.id} delayDuration={500}>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            onClick={() => {
                              if (isMobile) {
                                blurActiveElement();
                              }
                              setActiveMainTab(tab.id);
                            }}
                            aria-label={tab.label}
                            aria-selected={isActive}
                            role="tab"
                            className={cn(
                              mobileHeaderIconButtonClass,
                              'relative rounded-lg',
                              isActive && 'bg-interactive-selection text-interactive-selection-foreground'
                            )}
                          >
                            {isDiffTab ? (
                              <DiffIcon className="h-5 w-5" />
                            ) : Icon ? (
                              <Icon className="h-5 w-5" />
                            ) : null}
                            {tab.badge !== undefined && tab.badge > 0 && (
                              <span className="absolute -top-1 -right-1 text-[10px] font-semibold text-primary">
                                {tab.badge}
                              </span>
                            )}
                            {tab.showDot && (
                              <span
                                className="absolute top-1.5 right-1.5 h-2 w-2 rounded-full bg-primary"
                                aria-label="Changes available"
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
                setIsMobileRateLimitsOpen(open);
                if (open && quotaResults.length === 0) {
                  fetchAllQuotas();
                }
              }}
            >
              <Tooltip delayDuration={500}>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label="View services"
                      className={mobileHeaderIconButtonClass}
                    >
                      <RiStackLine className="h-5 w-5" />
                    </button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent>
                  <p>Services</p>
                </TooltipContent>
              </Tooltip>
              <DropdownMenuContent
                align="end"
                sideOffset={0}
                className="h-dvh w-[100vw] max-h-none rounded-none border-0 p-0 overflow-hidden"
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
                        aria-label="Close services"
                      >
                        <RiCloseLine className="h-5 w-5" />
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
                            <span className="typography-ui-header font-semibold text-foreground">Rate limits</span>
                            <span className="truncate typography-micro text-muted-foreground">
                              {formatTime(quotaLastUpdated)}
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
                                Used
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
                                Remaining
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
                              aria-label="Refresh rate limits"
                            >
                              <RiRefreshLine className={cn('h-4 w-4', isUsageRefreshSpinning && 'animate-spin')} />
                            </button>
                          </div>
                        </div>
                      </div>

                      {!hasRateLimits && (
                        <div className="px-4 py-6 text-center">
                          <span className="typography-ui-label text-muted-foreground">No rate limits available.</span>
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
                                  {group.error ?? 'No rate limits reported.'}
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
                                  return (
                                    <div key={`${group.providerId}-${label}`} className="flex flex-col gap-1.5">
                                      <div className="flex min-w-0 items-center justify-between gap-3">
                                        <div className="min-w-0 flex items-center gap-2">
                                          <span className="truncate typography-ui-label text-foreground">{formatWindowLabel(label)}</span>
                                          {(window.resetAfterFormatted ?? window.resetAtFormatted) ? (
                                            <span className="truncate typography-micro text-muted-foreground">
                                              {window.resetAfterFormatted ?? window.resetAtFormatted}
                                            </span>
                                          ) : null}
                                        </div>
                                        <span className="typography-ui-label text-foreground tabular-nums">
                                          {formatPercent(displayPercent) === '-' ? '' : formatPercent(displayPercent)}
                                        </span>
                                      </div>
                                      <UsageProgressBar
                                        percent={displayPercent}
                                        tonePercent={window.usedPercent}
                                        className="h-1.5"
                                        expectedMarkerPercent={expectedMarker}
                                      />
                                      {paceInfo ? (
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
                                              <RiArrowDownSLine className="h-4 w-4 text-muted-foreground" />
                                            ) : (
                                              <RiArrowRightSLine className="h-4 w-4 text-muted-foreground" />
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
                                                return (
                                                  <div key={`${group.providerId}-${modelName}`} className="flex flex-col gap-1.5">
                                                    <div className="flex min-w-0 items-center justify-between gap-3">
                                                      <span className="truncate typography-micro text-muted-foreground">{getDisplayModelName(modelName)}</span>
                                                      <span className="typography-ui-label text-foreground tabular-nums">
                                                        {formatPercent(displayPercent) === '-' ? '' : formatPercent(displayPercent)}
                                                      </span>
                                                    </div>
                                                    <UsageProgressBar
                                                      percent={displayPercent}
                                                      tonePercent={window.usedPercent}
                                                      className="h-1.5"
                                                      expectedMarkerPercent={expectedMarker}
                                                    />
                                                    {paceInfo ? (
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
              <Tooltip delayDuration={500}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={onToggleRightDrawer}
                    className={cn(
                      mobileHeaderIconButtonClass,
                      'relative',
                      rightDrawerOpen && 'bg-interactive-selection text-interactive-selection-foreground'
                    )}
                    aria-label={rightDrawerOpen ? 'Close git sidebar' : 'Open git sidebar'}
                  >
                    <RiLayoutRightLine className="h-5 w-5" />
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
    'header-safe-area relative z-10',
    isMobile && 'border-b border-border/50',
    'bg-background'
  );

  return (
    <header
      ref={headerRef}
      className={headerClassName}
      style={{ ['--padding-scale' as string]: '1' } as React.CSSProperties}
    >
      {isMobile ? renderMobile() : renderDesktop()}
    </header>
  );
};
