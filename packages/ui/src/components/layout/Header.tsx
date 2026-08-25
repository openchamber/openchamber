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

import { useUIStore, type ContextPanelMode } from '@/stores/useUIStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessionWorktreeStore } from '@/sync/session-worktree-store';
import { formatSessionWorktreeBadge } from '@/sync/session-worktree-contract';
import { buildSessionMessageRecordsSnapshot, useDirectoryStore, useGlobalSessionStatus, useSessionMessagesResolved } from '@/sync/sync-context';
import { useDirectoryStore as useAppDirectoryStore } from '@/stores/useDirectoryStore';
import { isChatDirectoryForHome } from '@/lib/chatDirectories';
import { useSync } from '@/sync/use-sync';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useQuotaAutoRefresh, useQuotaStore } from '@/stores/useQuotaStore';
import { useGitBranchLabel } from '@/stores/useGitStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { streamPerfCount } from '@/stores/utils/streamDebug';
import { useFeatureFlagsStore } from '@/stores/useFeatureFlagsStore';

import { useGitHubAuthStore } from '@/stores/useGitHubAuthStore';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useDesktopWindowControlsLayout } from '@/hooks/useDesktopWindowControlsLayout';
import { ContextUsageDisplay } from '@/components/ui/ContextUsageDisplay';
import { WindowsWindowControls } from '@/components/desktop/WindowsWindowControls';
import { UpdateDialog } from '@/components/ui/UpdateDialog';
import { useDeviceInfo, useTabletStandalonePwaRuntime } from '@/lib/device';
import { cn } from '@/lib/utils';
import { eventMatchesShortcut, formatShortcutForDisplay, getEffectiveShortcutCombo } from '@/lib/shortcuts';
import {
} from '@/lib/quota/model-families';

import {
} from '@/components/ui/collapsible';
import type { GitHubAuthStatus } from '@/lib/api/types';
import type { SessionContextUsage } from '@/stores/types/sessionTypes';
import { DesktopHostSwitcherDialog } from '@/components/desktop/DesktopHostSwitcher';
import { OpenInAppButton } from '@/components/desktop/OpenInAppButton';
import { SessionSwitcherDropdown } from '@/components/session/SessionSwitcherDropdown';
import { SessionTabsStrip, type SessionTabMenuArgs } from './SessionTabsStrip';
import { canUseElectronDesktopIPC, invokeDesktop, isDesktopLocalOriginActive, isDesktopShell, isVSCodeRuntime, startDesktopWindowDrag, type UpdateInfo } from '@/lib/desktop';
import { desktopHostsGet, redactSensitiveUrl } from '@/lib/desktopHosts';
import {
  LOCAL_HOST_ID,
  buildLocalDesktopHost,
  getLocalDesktopOrigin,
  resolveCurrentDesktopHost,
} from '@/lib/desktopCurrentHost';
import { Icon } from "@/components/icon/Icon";
import { useI18n } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeBearerTokenSync } from '@/lib/runtime-auth';
import { getRuntimeApiBaseUrl, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { useShallow } from 'zustand/react/shallow';
import type { IconName } from "@/components/icon/icons";
import { toast } from '@/components/ui';
import { copyTextToClipboard } from '@/lib/clipboard';
import { buildExportFilename, downloadAsMarkdown, formatSessionAsMarkdown, saveAsMarkdownDesktop } from '@/lib/exportSession';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { startSessionTreeWorktreeMove, useIsSessionWorktreeMovePending } from '@/lib/worktrees/sessionWorktreeMove';

const DESKTOP_HEADER_ICON_BUTTON_CLASS = 'app-region-no-drag inline-flex h-8 w-8 items-center justify-center gap-2 rounded-md typography-ui-label font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:pointer-events-none disabled:opacity-50 hover:bg-interactive-hover transition-colors';

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
  shortcutLabel: (actionId: string) => string;
  remoteUpdateInfo: UpdateInfo | null;
  remoteUpdateChecking: boolean;
  remoteUpdateError: string | null;
  onOpenRemoteUpdate: () => void;
};

const DesktopServicesMenu = React.memo(function DesktopServicesMenu({
  isDesktopApp,
  currentInstanceLabel,
  compactCurrentInstanceLabel,
  currentInstanceIsLocal,
  isDesktopServicesOpen,
  setIsDesktopServicesOpen,
  refreshCurrentInstanceLabel,
  shortcutLabel,
  remoteUpdateInfo,
  remoteUpdateChecking,
  remoteUpdateError,
  onOpenRemoteUpdate,
}: DesktopServicesMenuProps) {
  const { t } = useI18n();
  return (
    <DropdownMenu
      open={isDesktopServicesOpen}
      onOpenChange={(open) => {
        setIsDesktopServicesOpen(open);
        if (open) {
          void refreshCurrentInstanceLabel();
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
              <Icon name="server" className="h-[18px] w-[18px]" />
              {isDesktopApp ? (
                <span className="truncate typography-ui-label font-medium text-foreground">{compactCurrentInstanceLabel}</span>
              ) : null}
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>
          <p>
            {t('header.services.tooltip.currentInstance', {
              current: currentInstanceLabel,
              toggle: shortcutLabel('toggle_services_menu'),
            })}
          </p>
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        align="end"
        className="w-[min(27rem,calc(100vw-2rem))] max-h-[75vh] overflow-y-auto p-0"
      >
        {isDesktopApp ? (
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
              open={isDesktopServicesOpen}
              onOpenChange={() => {}}
              onHostSwitched={() => setIsDesktopServicesOpen(false)}
            />
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


type HeaderSessionSnapshot = {
  title: string | null;
  directory: string | null;
  created: number | null;
  slug: string | null;
  shareUrl: string | null;
  parentId: string | null;
};

export const Header: React.FC = () => {
  streamPerfCount('ui.header.render');
  const { t } = useI18n();
  const isSidebarOpen = useUIStore((state) => state.isSidebarOpen);
  const openContextOverview = useUIStore((state) => state.openContextOverview);
  const openContextPlan = useUIStore((state) => state.openContextPlan);
  const closeContextPanel = useUIStore((state) => state.closeContextPanel);
  const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);
  const sessionTabsEnabled = useUIStore((state) => state.sessionTabsEnabled);

  const getCurrentModel = useConfigStore((state) => state.getCurrentModel);
  const runtimeApis = useRuntimeAPIs();

  const getContextUsage = useSessionUIStore((state) => state.getContextUsage);
  const isNewSessionDraftOpen = useSessionUIStore((state) => Boolean(state.newSessionDraft?.open));
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const currentSessionMessagesResolved = useSessionMessagesResolved(currentSessionId ?? '');
  const currentSessionStatus = useGlobalSessionStatus(currentSessionId ?? '');
  const isCurrentSessionMovingToWorktree = useIsSessionWorktreeMovePending(currentSessionId ?? '');
  const currentGlobalSession = useGlobalSessionsStore(useShallow(React.useCallback(
    (state): HeaderSessionSnapshot | null => {
      if (!currentSessionId) return null;
       const session = [...state.activeSessions, ...state.archivedSessions]
         .find((candidate) => candidate.id === currentSessionId);
      if (!session) return null;
      const record = session as typeof session & { directory?: string | null; slug?: string | null };
      return {
        title: session.title ?? null,
        directory: record.directory ?? null,
        created: session.time?.created ?? null,
        slug: record.slug ?? null,
        shareUrl: session.share?.url ?? null,
        parentId: session.parentID ?? null,
      };
    },
    [currentSessionId],
  )));
  const activeProject = useProjectsStore(useShallow((state) => {
    if (!state.activeProjectId) {
      return null;
    }
    const project = state.projects.find((candidate) => candidate.id === state.activeProjectId);
    return project ? { id: project.id, path: project.path, label: project.label } : null;
  }));
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
  const loadQuotaSettings = useQuotaStore((state) => state.loadSettings);

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

  const githubAvatarUrl = githubAuthStatus?.connected ? (githubAuthStatus.user?.avatarUrl ?? null) : null;
  const githubLogin = githubAuthStatus?.connected ? (githubAuthStatus.user?.login ?? null) : null;
  const githubAccounts = githubAuthStatus?.accounts ?? [];
  const [isSwitchingGitHubAccount, setIsSwitchingGitHubAccount] = React.useState(false);
  const [isDesktopServicesOpen, setIsDesktopServicesOpen] = React.useState(false);
  const [currentInstanceLabel, setCurrentInstanceLabel] = React.useState('Local');
  const [currentInstanceIsLocal, setCurrentInstanceIsLocal] = React.useState(true);
  const [remoteUpdateDialogOpen, setRemoteUpdateDialogOpen] = React.useState(false);
  const [remoteUpdateInfo, setRemoteUpdateInfo] = React.useState<UpdateInfo | null>(null);
  const [remoteUpdateChecking, setRemoteUpdateChecking] = React.useState(false);
  const [remoteUpdateError, setRemoteUpdateError] = React.useState<string | null>(null);
  const compactCurrentInstanceLabel = React.useMemo(() => formatCompactHeaderLabel(currentInstanceLabel), [currentInstanceLabel]);
  const isVSCode = React.useMemo(() => isVSCodeRuntime(), []);
  // While the work-status panel is on screen it already reports the project,
  // the branch and the context fill — three paces away in the same window.
  // These yield to it rather than saying the same thing twice, and return the
  // moment the panel is switched off or squeezed out by a narrow chat.
  const workStatusPanelVisible = useUIStore((state) => state.workStatusPanelVisible);
  const workStatusPanelEnabled = useUIStore((state) => state.workStatusPanelEnabled);
  const setWorkStatusPanelEnabled = useUIStore((state) => state.setWorkStatusPanelEnabled);
  const workStatusPanelFits = useUIStore((state) => state.workStatusPanelFits);
  const workStatusOverlayOpen = useUIStore((state) => state.workStatusOverlayOpen);
  const setWorkStatusOverlayOpen = useUIStore((state) => state.setWorkStatusOverlayOpen);

  // Two meanings for one button. With room beside the chat it switches the
  // panel on and off. Without room it cannot be shown inline at all, so it
  // reads as off and opens the panel over the chat instead — the stored
  // preference is left alone, so the panel comes back on its own once the
  // window is wide enough again.
  const workStatusPanelShownInline = workStatusPanelEnabled && workStatusPanelFits;
  const workStatusToggleActive = workStatusPanelShownInline || workStatusOverlayOpen;
  const handleWorkStatusToggle = React.useCallback(() => {
    if (workStatusPanelEnabled && !workStatusPanelFits) {
      setWorkStatusOverlayOpen(!workStatusOverlayOpen);
      return;
    }
    setWorkStatusPanelEnabled(!workStatusPanelEnabled);
  }, [setWorkStatusOverlayOpen, setWorkStatusPanelEnabled, workStatusOverlayOpen, workStatusPanelEnabled, workStatusPanelFits]);
  const showDesktopHeaderContextUsage = !isVSCode
    && !workStatusPanelVisible
    && !!stableDesktopContextUsage
    && stableDesktopContextUsage.totalTokens > 0;
  const desktopHeaderDisplayPercentage = stableDesktopContextUsage && stableDesktopContextUsage.contextLimit > 0
    ? Math.min(999, (stableDesktopContextUsage.totalTokens / stableDesktopContextUsage.contextLimit) * 100)
    : 0;

  const refreshCurrentInstanceLabel = React.useCallback(async () => {
    if (typeof window === 'undefined' || !isDesktopApp) {
      return;
    }

    try {
      if (isDesktopLocalOriginActive()) {
        setCurrentInstanceLabel('Local');
        setCurrentInstanceIsLocal(true);
        return;
      }
      setCurrentInstanceIsLocal(false);

      // Same resolution the host switcher's own header uses, so the button and
      // the panel it opens can never disagree about which instance this is.
      const cfg = await desktopHostsGet();
      const localOrigin = getLocalDesktopOrigin();
      const resolved = resolveCurrentDesktopHost([buildLocalDesktopHost(localOrigin), ...cfg.hosts]);

      if (resolved.id === LOCAL_HOST_ID) {
        setCurrentInstanceLabel('Local');
        setCurrentInstanceIsLocal(true);
        return;
      }

      setCurrentInstanceLabel(redactSensitiveUrl(resolved.label.trim() || 'Instance'));
    } catch {
      setCurrentInstanceLabel('Local');
      setCurrentInstanceIsLocal(true);
    }
  }, [isDesktopApp]);

  useEffect(() => {
    void refreshCurrentInstanceLabel();
    // Switching instances does not remount the header, so without this the
    // button would keep naming the instance the window left behind.
    return subscribeRuntimeEndpointChanged(() => {
      void refreshCurrentInstanceLabel();
    });
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
      // Status-only poll: must not count as usage on the remote server's install id.
      const params = new URLSearchParams({ appType: 'web', instanceMode: 'remote', reportUsage: 'false' });
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

  React.useEffect(() => {
    void loadQuotaSettings();
  }, [loadQuotaSettings]);


  const currentSessionSnapshot = currentSessionId
    ? currentGlobalSession ?? null
    : null;

  const lastResolvedSessionRef = React.useRef<{
    sessionId: string;
    session: HeaderSessionSnapshot;
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

    if (currentSessionSnapshot) {
      lastResolvedSessionRef.current = {
        sessionId: currentSessionId,
        session: currentSessionSnapshot,
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
  }, [currentSessionId, currentSessionSnapshot]);

  void sessionFallbackVersion;
  const currentSession = (() => {
    if (currentSessionSnapshot) {
      return currentSessionSnapshot;
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
  const draftTarget = useSessionUIStore((state) => state.newSessionDraft.target);
  const draftProjectId = useSessionUIStore((state) => state.newSessionDraft.selectedProjectId);
  const selectedSessionDirectory = useSessionUIStore((state) => state.currentSessionDirectory);
  const homeDirectory = useAppDirectoryStore((state) => state.homeDirectory);

  const openDirectory = React.useMemo(() => {
    return worktreeDirectory || sessionDirectory || draftDirectory;
  }, [draftDirectory, sessionDirectory, worktreeDirectory]);
  const activeContextMode = useUIStore(React.useCallback((state) => {
    const directory = normalize(openDirectory || '');
    return directory ? getActiveContextMode(state.contextPanelByDirectory[directory]) : null;
  }, [openDirectory]));

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
  const isChatContext = isNewSessionDraftOpen
    ? draftTarget === 'chat'
    : isChatDirectoryForHome(sessionDirectory || selectedSessionDirectory, homeDirectory);

  // Whether the title carries a second line under it. Hoisted because the
  // session menu's vertical alignment depends on the same answer.
  const showHeaderMetaRow = !isChatContext && !workStatusPanelVisible
    && Boolean(activeProjectLabel || currentBranchLabel || (!isNewSessionDraftOpen && worktreeBadgeKind));


  const currentSessionTitle = React.useMemo(() => {
    if (!currentSessionId) {
      return activeProjectLabel ?? 'OpenChamber';
    }
    const trimmedTitle = currentSession?.title?.trim();
    return trimmedTitle && trimmedTitle.length > 0 ? trimmedTitle : 'Untitled Session';
  }, [activeProjectLabel, currentSession?.title, currentSessionId]);
  const headerDirectoryStore = useDirectoryStore(openDirectory || undefined, { bootstrap: false });
  const sync = useSync();
  const updateSessionTitle = useSessionUIStore((state) => state.updateSessionTitle);
  const shareSession = useSessionUIStore((state) => state.shareSession);
  const unshareSession = useSessionUIStore((state) => state.unshareSession);
  const archiveSessions = useSessionUIStore((state) => state.archiveSessions);
  const deleteSessions = useSessionUIStore((state) => state.deleteSessions);
  const [isRenamingHeaderSession, setIsRenamingHeaderSession] = React.useState(false);
  const [isHeaderSessionMenuOpen, setIsHeaderSessionMenuOpen] = React.useState(false);
  /** Session id whose rename was requested from a tab menu; survives the
      activation that a Rename on an inactive tab performs first. */
  const pendingHeaderRenameRef = React.useRef<string | null>(null);
  const [headerSessionTitleDraft, setHeaderSessionTitleDraft] = React.useState('');
  const [pendingHeaderRetentionAction, setPendingHeaderRetentionAction] = React.useState<{ action: 'archive' | 'delete'; sessionId: string } | null>(null);
  const headerRenameFormRef = React.useRef<HTMLFormElement | null>(null);


  const beginHeaderSessionRename = React.useCallback(() => {
    if (!currentSessionId) return;
    setHeaderSessionTitleDraft(currentSession?.title?.trim() || currentSessionTitle);
    setIsRenamingHeaderSession(true);
  }, [currentSession?.title, currentSessionId, currentSessionTitle]);

  const beginHeaderSessionRenameRef = React.useRef(beginHeaderSessionRename);
  beginHeaderSessionRenameRef.current = beginHeaderSessionRename;

  React.useEffect(() => {
    setIsHeaderSessionMenuOpen(false);
    setPendingHeaderRetentionAction(null);
    if (currentSessionId && pendingHeaderRenameRef.current === currentSessionId) {
      // Rename on an inactive tab activates it first; the switch itself is
      // when the rename can begin (the menu may close before or after it).
      pendingHeaderRenameRef.current = null;
      beginHeaderSessionRenameRef.current();
      return;
    }
    setIsRenamingHeaderSession(false);
    setHeaderSessionTitleDraft('');
  }, [currentSessionId]);

  const saveHeaderSessionRename = React.useCallback(async () => {
    if (!currentSessionId) return;
    const title = headerSessionTitleDraft.trim();
    if (title && title !== currentSession?.title?.trim()) {
      await updateSessionTitle(currentSessionId, title);
    }
    setIsRenamingHeaderSession(false);
  }, [currentSession?.title, currentSessionId, headerSessionTitleDraft, updateSessionTitle]);

  React.useEffect(() => {
    if (!isRenamingHeaderSession) return;
    const handleDocumentMouseDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target || !headerRenameFormRef.current?.contains(target)) {
        void saveHeaderSessionRename();
      }
    };
    document.addEventListener('mousedown', handleDocumentMouseDown);
    return () => document.removeEventListener('mousedown', handleDocumentMouseDown);
  }, [isRenamingHeaderSession, saveHeaderSessionRename]);

  const copySessionIdFor = React.useCallback((sessionId: string) => {
    if (!sessionId) return;
    void copyTextToClipboard(sessionId).then((result) => {
      toast[result.ok ? 'success' : 'error'](t(result.ok
        ? 'sessions.sidebar.session.copyId.success'
        : 'sessions.sidebar.session.copyId.error'));
    }).catch(() => toast.error(t('sessions.sidebar.session.copyId.error')));
  }, [t]);

  const shareSessionFor = React.useCallback(async (sessionId: string) => {
    if (!sessionId) return;
    const result = await shareSession(sessionId);
    if (result?.share?.url) {
      const copied = await copyTextToClipboard(result.share.url);
      toast[copied.ok ? 'success' : 'warning'](t('sessions.sidebar.session.share.successTitle'), {
        description: t(copied.ok
          ? 'sessions.sidebar.session.share.successDescription'
          : 'sessions.sidebar.session.share.copyUrlError'),
      });
      return;
    }
    toast.error(t('sessions.sidebar.session.share.error'));
  }, [shareSession, t]);

  const copySessionShareUrl = React.useCallback((shareUrl: string | null | undefined) => {
    if (!shareUrl) return;
    void copyTextToClipboard(shareUrl).then((result) => {
      toast[result.ok ? 'success' : 'error'](t(result.ok
        ? 'sessions.sidebar.session.menu.copied'
        : 'sessions.sidebar.session.share.copyUrlError'));
    }).catch(() => toast.error(t('sessions.sidebar.session.share.copyUrlError')));
  }, [t]);

  const unshareSessionFor = React.useCallback(async (sessionId: string) => {
    if (!sessionId) return;
    const result = await unshareSession(sessionId);
    toast[result ? 'success' : 'error'](t(result
      ? 'sessions.sidebar.session.unshare.success'
      : 'sessions.sidebar.session.unshare.error'));
  }, [t, unshareSession]);

  const exportCurrentSession = React.useCallback(async () => {
    if (!currentSessionId || !openDirectory) {
      toast.error(t('sessions.sidebar.session.export.nothingToExport'));
      return;
    }
    try {
      await sync.loadCompleteHistory(currentSessionId, openDirectory);
    } catch {
      toast.error(t('sessions.sidebar.session.export.failedLoadHistory'));
      return;
    }
    const records = buildSessionMessageRecordsSnapshot(headerDirectoryStore.getState(), currentSessionId).list;
    if (records.length === 0) {
      toast.error(t('sessions.sidebar.session.export.nothingToExport'));
      return;
    }
    const markdown = formatSessionAsMarkdown(records, currentSession?.title ?? null);
    const filename = buildExportFilename(currentSession?.title ?? null);
    const savedPath = await saveAsMarkdownDesktop(markdown, filename);
    if (!savedPath) downloadAsMarkdown(markdown, filename);
    toast.success(t('sessions.sidebar.session.export.success'));
  }, [currentSession?.title, currentSessionId, headerDirectoryStore, openDirectory, sync, t]);

  const isCurrentSessionActive = currentSessionStatus?.type === 'busy' || currentSessionStatus?.type === 'retry';
  const moveCurrentSessionToWorktree = React.useCallback(() => {
    if (!currentSessionId || !sessionDirectory || isCurrentSessionActive || isCurrentSessionMovingToWorktree) return;
    const sessions = useGlobalSessionsStore.getState().activeSessions;
    const root = sessions.find((session) => session.id === currentSessionId);
    if (!root) return;

    const descendants: typeof sessions = [];
    const pendingParentIds = [currentSessionId];
    for (let index = 0; index < pendingParentIds.length; index += 1) {
      const parentId = pendingParentIds[index];
      for (const session of sessions) {
        if (session.parentID !== parentId) continue;
        descendants.push(session);
        pendingParentIds.push(session.id);
      }
    }

    startSessionTreeWorktreeMove({
      root,
      descendants,
      sourceDirectory: sessionDirectory,
      successMessage: t('sessions.sidebar.session.moveToWorktree.success'),
      failureMessage: t('sessions.sidebar.session.moveToWorktree.failed'),
    });
  }, [currentSessionId, isCurrentSessionActive, isCurrentSessionMovingToWorktree, sessionDirectory, t]);

  const confirmHeaderRetentionAction = React.useCallback(async () => {
    if (!pendingHeaderRetentionAction) return;
    const sessions = useGlobalSessionsStore.getState().activeSessions;
    const ids = [pendingHeaderRetentionAction.sessionId];
    for (let index = 0; index < ids.length; index += 1) {
      const parentId = ids[index];
      for (const session of sessions) {
        if ((session as typeof session & { parentID?: string | null }).parentID === parentId && !ids.includes(session.id)) {
          ids.push(session.id);
        }
      }
    }
    const action = pendingHeaderRetentionAction.action;
    setPendingHeaderRetentionAction(null);
    const result = action === 'archive' ? await archiveSessions(ids) : await deleteSessions(ids);
    const failedIds = result.failedIds;
    if (failedIds.length > 0) {
      toast.error(t(action === 'archive'
        ? 'sessions.sidebar.session.archive.error'
        : 'sessions.sidebar.session.delete.error'));
      return;
    }
    toast.success(t(action === 'archive'
      ? 'sessions.sidebar.session.archive.success'
      : 'sessions.sidebar.session.delete.success'));
  }, [archiveSessions, deleteSessions, pendingHeaderRetentionAction, t]);

  // Full-page surfaces (Scheduled, Archive, Worktrees, Multi-run) replace the
  // chat area; while one is open the header shows the surface identity
  // instead of the session switcher.
  const isScheduledSurfaceOpen = useUIStore((state) => state.isScheduledTasksDialogOpen);
  const isArchiveSurfaceOpen = useUIStore((state) => state.isArchivePageOpen);
  const worktreesSurfaceProjectId = useUIStore((state) => state.worktreesPageProjectId);
  const isMultiRunSurfaceOpen = useUIStore((state) => state.isMultiRunLauncherOpen);
  const worktreesSurfaceProjectLabel = useProjectsStore((state) => {
    if (!worktreesSurfaceProjectId) return null;
    const project = state.projects.find((entry) => entry.id === worktreesSurfaceProjectId);
    return project?.label?.trim() || project?.path?.split('/').pop() || null;
  });
  const activeSurfaceHeader = React.useMemo<{ title: string; subtitle: string | null } | null>(() => {
    if (isScheduledSurfaceOpen) {
      return { title: t('sessions.scheduledTasks.dialog.title'), subtitle: null };
    }
    if (isArchiveSurfaceOpen) {
      return { title: t('sessions.archivePage.title'), subtitle: null };
    }
    if (worktreesSurfaceProjectId) {
      return {
        title: t('sessions.worktreesPage.title', { project: worktreesSurfaceProjectLabel ?? '' }),
        subtitle: null,
      };
    }
    if (isMultiRunSurfaceOpen) {
      return { title: t('sessions.sidebar.header.actions.newMultiRun'), subtitle: null };
    }
    return null;
  }, [isArchiveSurfaceOpen, isMultiRunSurfaceOpen, isScheduledSurfaceOpen, t, worktreesSurfaceProjectId, worktreesSurfaceProjectLabel]);


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


  const planModeEnabled = useFeatureFlagsStore((state) => state.planModeEnabled);
  const isSessionPlanAvailable = useSessionUIStore((state) => state.isSessionPlanAvailable);
  const planTabAvailable = planModeEnabled && currentSessionId ? isSessionPlanAvailable(currentSessionId) : false;
  const lastPlanSessionKeyRef = React.useRef<string>('');

  // Reset plan tab availability when session changes
  React.useEffect(() => {
    if (!planModeEnabled) {
      return;
    }

    if (!currentSessionId) return;

    const sessionKey = `${currentSessionId || 'none'}:${sessionDirectory || 'none'}:${currentSession?.created || 0}:${currentSession?.slug || 'none'}`;
    if (lastPlanSessionKeyRef.current !== sessionKey) {
      lastPlanSessionKeyRef.current = sessionKey;
    }
  }, [
    planModeEnabled,
    planTabAvailable,
    currentSession?.slug,
    currentSession?.created,
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



  const handleOpenDraftMiniChat = React.useCallback(() => {
    void invokeDesktop('desktop_open_draft_mini_chat_window', {
      directory: isChatContext ? '' : draftDirectory,
      projectId: isChatContext ? null : draftProjectId,
      apiBaseUrl: getRuntimeApiBaseUrl(),
      clientToken: getRuntimeBearerTokenSync(),
    }).catch((error) => {
      console.warn('[header] failed to open draft mini chat window', error);
    });
  }, [draftDirectory, draftProjectId, isChatContext]);

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
      directory: sessionDirectory || normalize(selectedSessionDirectory || '') || worktreeDirectory,
      apiBaseUrl: getRuntimeApiBaseUrl(),
      clientToken: getRuntimeBearerTokenSync(),
    }).catch((error) => {
      console.warn('[header] failed to open session mini chat window', error);
    });
  }, [currentSessionId, handleOpenDraftMiniChat, isNewSessionDraftOpen, selectedSessionDirectory, sessionDirectory, worktreeDirectory]);

  const handleOpenContextPanel = React.useCallback(() => {
    const directory = normalize(openDirectory || '');
    if (!directory) {
      return;
    }

    const panelState = useUIStore.getState().contextPanelByDirectory[directory];
    if (getActiveContextMode(panelState) === 'context') {
      closeContextPanel(directory);
      return;
    }

    openContextOverview(directory);
  }, [closeContextPanel, openContextOverview, openDirectory]);

  const isContextPanelActive = activeContextMode === 'context';


  const handleOpenContextPlan = React.useCallback(() => {
    const directory = normalize(openDirectory || '');
    if (!directory) {
      return;
    }

    const panelState = useUIStore.getState().contextPanelByDirectory[directory];
    if (getActiveContextMode(panelState) === 'plan') {
      closeContextPanel(directory);
      return;
    }

    openContextPlan(directory);
  }, [closeContextPanel, openContextPlan, openDirectory]);


  const desktopHeaderIconButtonClass = DESKTOP_HEADER_ICON_BUTTON_CLASS;
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

  const shortcutLabel = React.useCallback((actionId: string) => {
    return formatShortcutForDisplay(getEffectiveShortcutCombo(actionId, shortcutOverrides));
  }, [shortcutOverrides]);

  // Desktop keeps instances only: quota and MCP now live in the work-status
  // panel, which reports them per session rather than per window. The mobile
  // menu below is untouched — it has no panel to defer to.
  const servicesTabs = React.useMemo(() => {
    const base: Array<{ value: 'instance' | 'usage' | 'mcp'; label: string; icon: React.ReactNode }> = [];
    if (isDesktopApp) {
      base.push({ value: 'instance', label: t('layout.services.instance'), icon: <Icon name="server" className="h-3.5 w-3.5" /> });
    }
    return base;
  }, [isDesktopApp, t]);


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
        }
        return;
      }

      // The desktop menu holds one destination now, so this shortcut opens it
      // rather than cycling. The binding is kept: it is user-configurable and
      // silently dropping it would break existing setups.
      const cycleServicesCombo = getEffectiveShortcutCombo('cycle_services_tab', shortcutOverrides);
      if (eventMatchesShortcut(e, cycleServicesCombo)) {
        e.preventDefault();
        if (servicesTabs.length === 0) return;
        setIsDesktopServicesOpen(true);
        void refreshCurrentInstanceLabel();
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
    servicesTabs,
    quotaResults.length,
    fetchAllQuotas,
    refreshCurrentInstanceLabel,
    handleOpenContextPlan,
  ]);

  const desktopSidebarActions = (
    <>
      <OpenInAppButton directory={actionDirectory} className="mr-1" />
      {/* Instances only exist in the desktop app. On web the menu was left
          holding a single dev-only shutdown action, which is not a reason to
          keep a dropdown in the header. */}
      {isDesktopApp ? (
      <DesktopServicesMenu
        isDesktopApp={isDesktopApp}
        currentInstanceLabel={currentInstanceLabel}
        compactCurrentInstanceLabel={compactCurrentInstanceLabel}
        currentInstanceIsLocal={currentInstanceIsLocal}
        isDesktopServicesOpen={isDesktopServicesOpen}
        setIsDesktopServicesOpen={setIsDesktopServicesOpen}
        refreshCurrentInstanceLabel={refreshCurrentInstanceLabel}
        shortcutLabel={shortcutLabel}
        remoteUpdateInfo={remoteUpdateInfo}
        remoteUpdateChecking={remoteUpdateChecking}
        remoteUpdateError={remoteUpdateError}
        onOpenRemoteUpdate={openRemoteInstanceUpdate}
      />
      ) : null}
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

  const renderSessionTabMenu = React.useCallback(({ session, isActive, select, closeOtherTabs, components }: SessionTabMenuArgs) => {
    const { Item, Separator } = components;
    const shareUrl = session.share?.url ?? null;
    const canMoveToWorktree = isActive && !isVSCode && !isChatContext && currentSession && !currentSession.parentId;
    return (
      <>
        <Item onClick={() => { if (!isActive) select(); pendingHeaderRenameRef.current = session.id; }}>
          <Icon name="pencil-ai" className="mr-2 size-4" />{t('sessions.sidebar.session.menu.rename')}
        </Item>
        <Item onClick={() => copySessionIdFor(session.id)}>
          <Icon name="file-copy" className="mr-2 size-4" />{t('sessions.sidebar.session.menu.copyId')}
        </Item>
        <Separator />
        {shareUrl ? (
          <>
            <Item onClick={() => copySessionShareUrl(shareUrl)}>
              <Icon name="file-copy" className="mr-2 size-4" />{t('sessions.sidebar.session.menu.copyLink')}
            </Item>
            <Item onClick={() => void unshareSessionFor(session.id)}>
              <Icon name="link-unlink-m" className="mr-2 size-4" />{t('sessions.sidebar.session.menu.unshare')}
            </Item>
          </>
        ) : (
          <Item onClick={() => void shareSessionFor(session.id)}>
            <Icon name="share-2" className="mr-2 size-4" />{t('sessions.sidebar.session.menu.share')}
          </Item>
        )}
        {isActive ? (
          <Item onClick={() => void exportCurrentSession()}>
            <Icon name="download" className="mr-2 size-4" />{t('sessions.sidebar.session.menu.exportMarkdown')}
          </Item>
        ) : null}
        {canMoveToWorktree ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="block">
                <Item
                  disabled={!sessionDirectory || isCurrentSessionActive || isCurrentSessionMovingToWorktree}
                  onClick={moveCurrentSessionToWorktree}
                  className="w-full"
                >
                  <Icon name="folder-shared" className="mr-2 size-4" />
                  {t('sessions.sidebar.session.menu.moveToWorktree')}
                </Item>
              </span>
            </TooltipTrigger>
            <TooltipContent side="right" className="max-w-72">
              {isCurrentSessionMovingToWorktree
                ? t('sessions.sidebar.session.moveToWorktree.tooltipMoving')
                : isCurrentSessionActive
                  ? t('sessions.sidebar.session.moveToWorktree.tooltipBusy')
                  : t('sessions.sidebar.session.moveToWorktree.tooltip')}
            </TooltipContent>
          </Tooltip>
        ) : null}
        <Separator />
        <Item onClick={closeOtherTabs}>
          <Icon name="close-circle" className="mr-2 size-4" />{t('header.sessionTabs.closeOtherTabs')}
        </Item>
        <Separator />
        <Item onClick={() => setPendingHeaderRetentionAction({ action: 'archive', sessionId: session.id })}>
          <Icon name="inbox-archive" className="mr-2 size-4" />{t('sessions.sidebar.bulkActions.archive')}
        </Item>
        <Item className="text-destructive focus:text-destructive" onClick={() => setPendingHeaderRetentionAction({ action: 'delete', sessionId: session.id })}>
          <Icon name="delete-bin" className="mr-2 size-4" />{t('sessions.sidebar.bulkActions.delete')}
        </Item>
      </>
    );
  }, [copySessionIdFor, copySessionShareUrl, currentSession, exportCurrentSession, isChatContext, isCurrentSessionActive, isCurrentSessionMovingToWorktree, isVSCode, moveCurrentSessionToWorktree, sessionDirectory, shareSessionFor, t, unshareSessionFor]);

  const renderDesktop = () => (
    <div
      onMouseDown={handleDragStart}
      className={cn(
        'app-region-drag relative flex h-12 select-none items-center',
        usesFramelessChrome && windowControlsSide === 'right' ? 'pr-0' : 'pr-3',
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
          TitlebarLeftControls overlay; the spacers above reserve its footprint
          while the sidebar is closed. */}
      <div className="flex min-w-0 flex-1 items-center">
        {activeSurfaceHeader ? (
          <div className="mr-3 flex min-w-0 flex-col items-start px-1 py-0.5 -my-0.5 text-left">
            <span className="truncate typography-ui-label text-[14px] font-normal leading-tight text-foreground max-w-full">
              {activeSurfaceHeader.title}
            </span>
            {activeSurfaceHeader.subtitle ? (
              <span className="truncate typography-micro text-[10.5px] font-normal leading-tight text-muted-foreground/75 max-w-full">
                {activeSurfaceHeader.subtitle}
              </span>
            ) : null}
          </div>
        ) : (isVSCode || !sessionTabsEnabled) ? (
          <div className="app-region-no-drag mr-3 flex min-w-0 max-w-full items-center gap-0.5 py-0.5 -my-0.5 text-left">
            {!isSidebarOpen ? (
              <SessionSwitcherDropdown align="start">
                <button
                  type="button"
                  className={desktopHeaderIconButtonClass}
                  aria-label={t('sessions.switcher.openAria')}
                >
                  <Icon name="history" className="h-[18px] w-[18px]" />
                </button>
              </SessionSwitcherDropdown>
            ) : null}
            <div className="flex min-w-0 flex-col justify-center px-1">
              {isRenamingHeaderSession ? (
                <form
                  ref={headerRenameFormRef}
                  className="flex w-full min-w-0 items-center gap-2 leading-tight"
                  onPointerDown={(event) => event.stopPropagation()}
                  onSubmit={(event) => {
                    event.preventDefault();
                    void saveHeaderSessionRename();
                  }}
                >
                  <input
                    value={headerSessionTitleDraft}
                    onChange={(event) => setHeaderSessionTitleDraft(event.target.value)}
                    autoFocus
                    onKeyDown={(event) => {
                      event.stopPropagation();
                      if (event.key === 'Escape') {
                        setIsRenamingHeaderSession(false);
                      }
                    }}
                    placeholder={t('sessions.sidebar.session.menu.rename')}
                    className="min-w-0 flex-1 bg-transparent typography-ui-label text-[14px] font-normal leading-tight outline-none placeholder:text-muted-foreground"
                  />
                  <button
                    type="submit"
                    aria-label={t('sessions.sidebar.session.rename.save')}
                    title={t('sessions.sidebar.session.rename.save')}
                    className="shrink-0 text-muted-foreground hover:text-foreground"
                  >
                    <Icon name="check" className="size-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setIsRenamingHeaderSession(false)}
                    aria-label={t('sessions.sidebar.session.rename.cancel')}
                    title={t('sessions.sidebar.session.rename.cancel')}
                    className="shrink-0 text-muted-foreground hover:text-foreground"
                  >
                    <Icon name="close" className="size-4" />
                  </button>
                </form>
              ) : (
                <span className="truncate typography-ui-label text-[14px] font-normal leading-tight text-foreground max-w-full">
                  {isNewSessionDraftOpen ? t('sessions.switcher.draftTitle') : currentSessionTitle}
                </span>
              )}
              {showHeaderMetaRow ? (
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
            </div>
            <div className={cn(
              'flex h-[18px] shrink-0 items-center justify-center',
              // Top-aligned only when the title has a metadata line under it;
              // alone, the title is centred and the button must follow.
              showHeaderMetaRow ? 'self-start' : 'self-center',
            )}>
              {currentSessionId && !isNewSessionDraftOpen && !isRenamingHeaderSession ? (
                <DropdownMenu
                  open={isHeaderSessionMenuOpen}
                  onOpenChange={setIsHeaderSessionMenuOpen}
                  onOpenChangeComplete={(open) => {
                    if (!open && pendingHeaderRenameRef.current && pendingHeaderRenameRef.current === currentSessionId) {
                      pendingHeaderRenameRef.current = null;
                      beginHeaderSessionRename();
                    }
                  }}
                >
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="xs" className="h-[18px] w-6 px-0 text-muted-foreground hover:bg-transparent hover:text-foreground" aria-label={t('header.sessionActions.openAria')}>
                      <Icon name="more" className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-[190px]">
                    <DropdownMenuItem onClick={() => { pendingHeaderRenameRef.current = currentSessionId; }}><Icon name="pencil-ai" className="mr-2 size-4" />{t('sessions.sidebar.session.menu.rename')}</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => currentSessionId && copySessionIdFor(currentSessionId)}><Icon name="file-copy" className="mr-2 size-4" />{t('sessions.sidebar.session.menu.copyId')}</DropdownMenuItem>
                    <DropdownMenuSeparator />
                    {currentSession?.shareUrl ? (
                      <>
                        <DropdownMenuItem onClick={() => copySessionShareUrl(currentSession?.shareUrl)}><Icon name="file-copy" className="mr-2 size-4" />{t('sessions.sidebar.session.menu.copyLink')}</DropdownMenuItem>
                        <DropdownMenuItem onClick={() => { if (currentSessionId) void unshareSessionFor(currentSessionId); }}><Icon name="link-unlink-m" className="mr-2 size-4" />{t('sessions.sidebar.session.menu.unshare')}</DropdownMenuItem>
                      </>
                    ) : (
                      <DropdownMenuItem onClick={() => { if (currentSessionId) void shareSessionFor(currentSessionId); }}><Icon name="share-2" className="mr-2 size-4" />{t('sessions.sidebar.session.menu.share')}</DropdownMenuItem>
                    )}
                    <DropdownMenuItem onClick={() => void exportCurrentSession()}><Icon name="download" className="mr-2 size-4" />{t('sessions.sidebar.session.menu.exportMarkdown')}</DropdownMenuItem>
                    {!isVSCode && !isChatContext && currentSession && !currentSession.parentId ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="block">
                            <DropdownMenuItem
                              disabled={!sessionDirectory || isCurrentSessionActive || isCurrentSessionMovingToWorktree}
                              onClick={moveCurrentSessionToWorktree}
                              className="w-full"
                            >
                              <Icon name="folder-shared" className="mr-2 size-4" />
                              {t('sessions.sidebar.session.menu.moveToWorktree')}
                            </DropdownMenuItem>
                          </span>
                        </TooltipTrigger>
                        <TooltipContent side="right" className="max-w-72">
                          {isCurrentSessionMovingToWorktree
                            ? t('sessions.sidebar.session.moveToWorktree.tooltipMoving')
                            : isCurrentSessionActive
                              ? t('sessions.sidebar.session.moveToWorktree.tooltipBusy')
                              : t('sessions.sidebar.session.moveToWorktree.tooltip')}
                        </TooltipContent>
                      </Tooltip>
                    ) : null}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => { if (currentSessionId) setPendingHeaderRetentionAction({ action: 'archive', sessionId: currentSessionId }); }}><Icon name="inbox-archive" className="mr-2 size-4" />{t('sessions.sidebar.bulkActions.archive')}</DropdownMenuItem>
                    <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => { if (currentSessionId) setPendingHeaderRetentionAction({ action: 'delete', sessionId: currentSessionId }); }}><Icon name="delete-bin" className="mr-2 size-4" />{t('sessions.sidebar.bulkActions.delete')}</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="app-region-no-drag flex h-full min-w-0 flex-1 items-center gap-0.5 text-left">
            {!isSidebarOpen ? (
              <SessionSwitcherDropdown align="start">
                <button
                  type="button"
                  className={desktopHeaderIconButtonClass}
                  aria-label={t('sessions.switcher.openAria')}
                >
                  <Icon name="history" className="h-[18px] w-[18px]" />
                </button>
              </SessionSwitcherDropdown>
            ) : null}
            <SessionTabsStrip
              renderMenu={renderSessionTabMenu}
              suppressActiveTabControls={isRenamingHeaderSession}
              onMenuOpenChangeComplete={(open) => {
                if (!open && pendingHeaderRenameRef.current && pendingHeaderRenameRef.current === currentSessionId) {
                  pendingHeaderRenameRef.current = null;
                  beginHeaderSessionRename();
                }
              }}
            >
            <div className="flex min-w-0 flex-col justify-center">
              {isRenamingHeaderSession ? (
                <form
                  ref={headerRenameFormRef}
                  className="flex w-full min-w-0 items-center gap-2 leading-tight"
                  onPointerDown={(event) => event.stopPropagation()}
                  onSubmit={(event) => {
                    event.preventDefault();
                    void saveHeaderSessionRename();
                  }}
                >
                  <input
                    value={headerSessionTitleDraft}
                    onChange={(event) => setHeaderSessionTitleDraft(event.target.value)}
                    autoFocus
                    onKeyDown={(event) => {
                      event.stopPropagation();
                      if (event.key === 'Escape') {
                        setIsRenamingHeaderSession(false);
                      }
                    }}
                    placeholder={t('sessions.sidebar.session.menu.rename')}
                    className="min-w-0 flex-1 bg-transparent text-[13px] font-medium leading-4 outline-none placeholder:text-muted-foreground"
                  />
                  <button
                    type="submit"
                    aria-label={t('sessions.sidebar.session.rename.save')}
                    title={t('sessions.sidebar.session.rename.save')}
                    className="shrink-0 text-muted-foreground hover:text-foreground"
                  >
                    <Icon name="check" className="size-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setIsRenamingHeaderSession(false)}
                    aria-label={t('sessions.sidebar.session.rename.cancel')}
                    title={t('sessions.sidebar.session.rename.cancel')}
                    className="shrink-0 text-muted-foreground hover:text-foreground"
                  >
                    <Icon name="close" className="size-4" />
                  </button>
                </form>
              ) : (
                <span className="block overflow-hidden whitespace-nowrap text-[13px] font-medium leading-4 text-foreground max-w-full">
                  {isNewSessionDraftOpen ? t('sessions.switcher.draftTitle') : currentSessionTitle}
                </span>
              )}
            </div>
            </SessionTabsStrip>
          </div>
        )}

        {activeSurfaceHeader || isVSCode || !sessionTabsEnabled ? <div className="flex-1" /> : null}

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

          <HeaderIconActionButton
            visible={showMiniChatHeaderAction}
            title={isNewSessionDraftOpen ? t('header.actions.newMiniChat') : t('header.actions.openSessionMiniChat')}
            ariaLabel={isNewSessionDraftOpen ? t('header.actions.newMiniChatAria') : t('header.actions.openSessionMiniChatAria')}
            onClick={handleOpenCurrentMiniChat}
            className={cn(desktopHeaderIconButtonClass, 'mr-1')}
            Icon={'picture-in-picture-2'}
          />
          {!isVSCode ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  data-work-status-toggle="true"
                  aria-pressed={workStatusToggleActive}
                  aria-label={t('header.workStatusPanel.toggleAria')}
                  onClick={handleWorkStatusToggle}
                  className={cn(
                    DESKTOP_HEADER_ICON_BUTTON_CLASS,
                    // Trailing gap before the sidebar actions; it moved here
                    // with the button when this took the last position.
                    'mr-1',
                    // On is the resting state and carries no chrome; off is the
                    // one worth signalling, so it dims instead of filling.
                    workStatusToggleActive ? 'text-foreground' : 'text-muted-foreground/50',
                  )}
                >
                  <Icon name="list-indefinite" className="h-[18px] w-[18px]" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {workStatusPanelEnabled && !workStatusPanelFits
                  ? (workStatusOverlayOpen
                    ? t('header.workStatusPanel.hide')
                    : t('header.workStatusPanel.showOverlay'))
                  : workStatusPanelEnabled
                    ? t('header.workStatusPanel.hide')
                    : t('header.workStatusPanel.show')}
              </TooltipContent>
            </Tooltip>
          ) : null}

          {desktopSidebarActions}
          <WindowsWindowControls visible={usesFramelessChrome && windowControlsSide === 'right'} position="right" />
        </div>
      </div>
    </div>
  );

  // The divider lives on the chat content wrapper instead of the header, so it
  // doesn't run between the header and the right sidebar (they read as one
  // continuous surface).
  const headerClassName = 'header-safe-area relative z-10 bg-background';

  return (
    <>
      <header
        ref={headerRef}
        className={headerClassName}
        style={{ ['--padding-scale' as string]: '1' } as React.CSSProperties}
      >
        {renderDesktop()}
      </header>
      <Dialog open={pendingHeaderRetentionAction !== null} onOpenChange={(open) => { if (!open) setPendingHeaderRetentionAction(null); }}>
        <DialogContent showCloseButton={false} className="max-w-sm gap-5">
          <DialogHeader>
            <DialogTitle>{pendingHeaderRetentionAction?.action === 'delete'
              ? t('sessions.sidebar.dialogs.deleteSession.title')
              : t('sessions.sidebar.dialogs.archiveSession.title')}</DialogTitle>
            <DialogDescription>{pendingHeaderRetentionAction?.action === 'delete'
              ? t('sessions.sidebar.dialogs.deleteSession.single', { sessionTitle: currentSessionTitle })
              : t('sessions.sidebar.dialogs.archiveSession.single', { sessionTitle: currentSessionTitle })}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setPendingHeaderRetentionAction(null)}>
              {t('sessions.sidebar.dialogs.cancel')}
            </Button>
            <Button variant="destructive" size="sm" onClick={() => void confirmHeaderRetentionAction()}>
              {pendingHeaderRetentionAction?.action === 'delete'
                ? t('sessions.sidebar.bulkActions.delete')
                : t('sessions.sidebar.bulkActions.archive')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
