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
import { AnimatedTabs } from '@/components/ui/animated-tabs';

import { RiArrowLeftSLine, RiChat4Line, RiCheckLine, RiCloseLine, RiCommandLine, RiFileTextLine, RiFolder6Line, RiGithubFill, RiLayoutLeftLine, RiLayoutRightLine, RiPlayListAddLine, RiRefreshLine, RiServerLine, RiStackLine, RiTerminalBoxLine, RiTimerLine, type RemixiconComponentType } from '@remixicon/react';
import { DiffIcon } from '@/components/icons/DiffIcon';
import { useUIStore, type MainTab } from '@/stores/useUIStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { useSessionStore } from '@/stores/useSessionStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useQuotaAutoRefresh, useQuotaStore } from '@/stores/useQuotaStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';

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
import { isDesktopShell, isVSCodeRuntime } from '@/lib/desktop';
import { desktopHostsGet, locationMatchesHost, redactSensitiveUrl } from '@/lib/desktopHosts';


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

const joinPath = (base: string, segment: string): string => {
  const normalizedBase = normalize(base);
  const cleanSegment = segment.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  if (!normalizedBase || normalizedBase === '/') {
    return `/${cleanSegment}`;
  }
  return `${normalizedBase}/${cleanSegment}`;
};

const buildRepoPlansDirectory = (directory: string): string => {
  return joinPath(joinPath(directory, '.opencode'), 'plans');
};

const buildHomePlansDirectory = (): string => {
  return '~/.opencode/plans';
};

const resolveTilde = (path: string, homeDir: string | null): string => {
  const trimmed = path.trim();
  if (!trimmed.startsWith('~')) return trimmed;
  if (trimmed === '~') return homeDir || trimmed;
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return homeDir ? `${homeDir}${trimmed.slice(1)}` : trimmed;
  }
  return trimmed;
};

interface TabConfig {
  id: MainTab;
  label: string;
  icon: RemixiconComponentType | 'diff';
  badge?: number;
  showDot?: boolean;
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
  const setSessionSwitcherOpen = useUIStore((state) => state.setSessionSwitcherOpen);
  const toggleSidebar = useUIStore((state) => state.toggleSidebar);
  const toggleBottomTerminal = useUIStore((state) => state.toggleBottomTerminal);
  const toggleRightSidebar = useUIStore((state) => state.toggleRightSidebar);
  const openContextOverview = useUIStore((state) => state.openContextOverview);
  const openContextPlan = useUIStore((state) => state.openContextPlan);
  const closeContextPanel = useUIStore((state) => state.closeContextPanel);
  const contextPanelByDirectory = useUIStore((state) => state.contextPanelByDirectory);
  const activeMainTab = useUIStore((state) => state.activeMainTab);
  const setActiveMainTab = useUIStore((state) => state.setActiveMainTab);
  const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);

  const { getCurrentModel } = useConfigStore();
  const runtimeApis = useRuntimeAPIs();

  const getContextUsage = useSessionStore((state) => state.getContextUsage);
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const currentSessionMessages = useSessionStore((state) => {
    if (!currentSessionId) {
      return undefined;
    }
    return state.messages.get(currentSessionId);
  });
  const sessions = useSessionStore((state) => state.sessions);
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
  const homeDirectory = useDirectoryStore((state) => state.homeDirectory);

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
  const isContextUsageResolvedForSession = !currentSessionId || currentSessionMessages !== undefined;

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
  const githubAvatarUrl = githubAuthStatus?.connected ? githubAuthStatus.user?.avatarUrl : null;
  const githubLogin = githubAuthStatus?.connected ? githubAuthStatus.user?.login : null;
  const githubAccounts = githubAuthStatus?.accounts ?? [];
  const [isSwitchingGitHubAccount, setIsSwitchingGitHubAccount] = React.useState(false);
  const [isMobileRateLimitsOpen, setIsMobileRateLimitsOpen] = React.useState(false);
  const [isDesktopServicesOpen, setIsDesktopServicesOpen] = React.useState(false);
  const [isUsageRefreshSpinning, setIsUsageRefreshSpinning] = React.useState(false);
  const [currentInstanceLabel, setCurrentInstanceLabel] = React.useState('Local');
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

  const currentSession = React.useMemo(() => {
    if (!currentSessionId) return null;
    return sessions.find((s) => s.id === currentSessionId) ?? null;
  }, [currentSessionId, sessions]);

  const worktreePath = useSessionStore((state) => {
    if (!currentSessionId) return '';
    return state.worktreeMetadata.get(currentSessionId)?.path ?? '';
  });

  const worktreeDirectory = React.useMemo(() => {
    return normalize(worktreePath || '');
  }, [worktreePath]);

  const sessionDirectory = React.useMemo(() => {
    const raw = typeof currentSession?.directory === 'string' ? currentSession.directory : '';
    return normalize(raw || '');
  }, [currentSession?.directory]);

  const draftDirectory = useSessionStore((state) => {
    if (!state.newSessionDraft?.open) {
      return '';
    }
    return normalize(state.newSessionDraft.directoryOverride ?? '');
  });

  const openDirectory = React.useMemo(() => {
    return worktreeDirectory || sessionDirectory || draftDirectory;
  }, [draftDirectory, sessionDirectory, worktreeDirectory]);

  const actionDirectory = React.useMemo(() => {
    return normalize(openDirectory || activeProject?.path || '');
  }, [activeProject?.path, openDirectory]);

  const activeProjectRef = React.useMemo(() => {
    if (!activeProject) {
      return null;
    }
    return { id: activeProject.id, path: activeProject.path };
  }, [activeProject]);


  const [planTabAvailable, setPlanTabAvailable] = React.useState(false);
  const showPlanTab = planTabAvailable;
  const lastPlanSessionKeyRef = React.useRef<string>('');

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

  React.useEffect(() => {
    let cancelled = false;

    const checkExists = async (directory: string, fileName: string): Promise<boolean> => {
      if (!directory || !fileName) return false;
      if (!runtimeApis.files?.listDirectory) return false;

      try {
        const listing = await runtimeApis.files.listDirectory(directory);
        const entries = Array.isArray(listing?.entries) ? listing.entries : [];
        return entries.some((entry) => entry?.name === fileName && !entry?.isDirectory);
      } catch {
        return false;
      }
    };

    const runOnce = async () => {
      if (cancelled) return;

      if (!currentSession?.slug || !currentSession?.time?.created || !sessionDirectory) {
        setPlanTabAvailable(false);
        if (useUIStore.getState().activeMainTab === 'plan') {
          useUIStore.getState().setActiveMainTab('chat');
        }
        return;
      }

      const fileName = `${currentSession.time.created}-${currentSession.slug}.md`;
      const repoDir = buildRepoPlansDirectory(sessionDirectory);
      const homeDir = resolveTilde(buildHomePlansDirectory(), homeDirectory || null);

      const [repoExists, homeExists] = await Promise.all([
        checkExists(repoDir, fileName),
        checkExists(homeDir, fileName),
      ]);

      if (cancelled) return;

      const available = repoExists || homeExists;
      setPlanTabAvailable(available);
      if (!available && useUIStore.getState().activeMainTab === 'plan') {
        useUIStore.getState().setActiveMainTab('chat');
      }
    };

    const sessionKey = `${currentSessionId || 'none'}:${sessionDirectory || 'none'}:${currentSession?.time?.created || 0}:${currentSession?.slug || 'none'}`;
    if (lastPlanSessionKeyRef.current !== sessionKey) {
      lastPlanSessionKeyRef.current = sessionKey;
      setPlanTabAvailable(false);
    }
    void runOnce();

    const interval = window.setInterval(() => {
      void runOnce();
    }, 3000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [
    sessionDirectory,
    currentSession?.slug,
    currentSession?.time?.created,
    currentSessionId,
    homeDirectory,
    runtimeApis.files,
  ]);

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

  const handleOpenContextPanel = React.useCallback(() => {
    const directory = normalize(openDirectory || '');
    if (!directory) {
      return;
    }

    const panelState = contextPanelByDirectory[directory];
    if (panelState?.isOpen && panelState.mode === 'context') {
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
    return Boolean(panelState?.isOpen && panelState.mode === 'context');
  }, [contextPanelByDirectory, openDirectory]);

  const handleOpenContextPlan = React.useCallback(() => {
    const directory = normalize(openDirectory || '');
    if (!directory) {
      return;
    }

    const panelState = contextPanelByDirectory[directory];
    if (panelState?.isOpen && panelState.mode === 'plan') {
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
    return Boolean(panelState?.isOpen && panelState.mode === 'plan');
  }, [contextPanelByDirectory, openDirectory]);

  const desktopHeaderIconButtonClass = 'app-region-no-drag inline-flex h-8 w-8 items-center justify-center gap-2 rounded-md typography-ui-label font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:pointer-events-none disabled:opacity-50 hover:bg-interactive-hover transition-colors';
  const mobileHeaderIconButtonClass = 'app-region-no-drag inline-flex h-9 w-9 items-center justify-center gap-2 p-2 rounded-md typography-ui-label font-medium text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:pointer-events-none disabled:opacity-50 hover:text-foreground hover:bg-interactive-hover transition-colors';

  const desktopPaddingClass = React.useMemo(() => {
    if (isDesktopApp && isMacPlatform) {
      // Always reserve space for Mac traffic lights since header is always on top
      return 'pl-[5.5rem]';
    }
    return 'pl-3';
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

    const observer = new ResizeObserver(() => {
      updateHeaderHeight();
    });

    observer.observe(node);
    window.addEventListener('resize', updateHeaderHeight);
    window.addEventListener('orientationchange', updateHeaderHeight);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updateHeaderHeight);
      window.removeEventListener('orientationchange', updateHeaderHeight);
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
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const window = getCurrentWindow();
        await window.startDragging();
      } catch (error) {
        console.error('Failed to start window dragging:', error);
      }
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

  const quotaDisplayTabs = React.useMemo(() => {
    return [
      { value: 'usage' as const, label: 'Used' },
      { value: 'remaining' as const, label: 'Remaining' },
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

  const renderDesktop = () => (
    <div
      onMouseDown={handleDragStart}
      className={cn(
        'app-region-drag relative flex h-12 select-none items-center',
        desktopPaddingClass,
        macosHeaderSizeClass
      )}
      role="tablist"
      aria-label="Main navigation"
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={handleOpenSessionSwitcher}
            aria-label="Open sessions"
            className={`${desktopHeaderIconButtonClass} mr-2 shrink-0`}
          >
            <RiLayoutLeftLine className="h-[18px] w-[18px]" />
          </button>
        </TooltipTrigger>
        <TooltipContent>
          <p>Open sessions ({shortcutLabel('toggle_sidebar')})</p>
        </TooltipContent>
      </Tooltip>

      {activeProjectLabel && (
        <div className="mr-3 min-w-0 max-w-[16rem] truncate typography-ui-label font-medium text-foreground">
          {activeProjectLabel}
        </div>
      )}

      {activeProjectRef && actionDirectory && (
        <ProjectActionsButton
          projectRef={activeProjectRef}
          directory={actionDirectory}
          className="mr-1"
        />
      )}

      {tabs.length > 0 && (
        <div className="flex items-center gap-1 rounded-lg bg-[var(--surface-muted)]/50 p-1">
          {tabs.map((tab) => renderTab(tab))}
        </div>
      )}

      <div className="flex-1" />

      <div className="flex items-center gap-1 pr-3 shrink-0">
        {showDesktopHeaderContextUsage && stableDesktopContextUsage && (
          <ContextUsageDisplay
            totalTokens={stableDesktopContextUsage.totalTokens}
            percentage={stableDesktopContextUsage.percentage}
            contextLimit={stableDesktopContextUsage.contextLimit}
            outputLimit={stableDesktopContextUsage.outputLimit ?? 0}
            size="compact"
            hideIcon
            showPercentIcon
            onClick={handleOpenContextPanel}
            pressed={isContextPanelActive}
            className="mr-3.5"
            valueClassName="typography-ui-label font-medium leading-none text-foreground"
            percentIconClassName="h-5 w-5"
          />
        )}
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
        <OpenInAppButton directory={openDirectory} className="mr-1" />
        <DropdownMenu
            open={isDesktopServicesOpen}
            onOpenChange={(open) => {
              setIsDesktopServicesOpen(open);
              if (open) {
                void refreshCurrentInstanceLabel();
                if (desktopServicesTab === 'usage' && quotaResults.length === 0) {
                  fetchAllQuotas();
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
                      desktopHeaderIconButtonClass,
                      isDesktopApp
                        ? 'w-auto max-w-[14rem] justify-start gap-1.5 px-2.5'
                        : 'h-8 w-8'
                    )}
                  >
                    <RiStackLine className="h-[18px] w-[18px]" />
                    {isDesktopApp && <span className="truncate typography-ui-label font-medium text-foreground">{currentInstanceLabel}</span>}
                  </button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent>
                <p>
                  {isDesktopApp
                    ? `Current instance: ${currentInstanceLabel}`
                    : 'Services'} ({shortcutLabel('toggle_services_menu')}; next tab {shortcutLabel('cycle_services_tab')})
                </p>
              </TooltipContent>
            </Tooltip>
            <DropdownMenuContent
              align="end"
              className="w-[min(30rem,calc(100vw-2rem))] max-h-[75vh] overflow-y-auto bg-[var(--surface-elevated)] p-0"
            >
              <div className="sticky top-0 z-20 border-b border-[var(--interactive-border)] bg-[var(--surface-elevated)] p-2">
                <AnimatedTabs<'instance' | 'usage' | 'mcp'>
                  value={desktopServicesTab}
                  onValueChange={(value) => {
                    setDesktopServicesTab(value);
                    if (value === 'usage' && quotaResults.length === 0) {
                      fetchAllQuotas();
                    }
                  }}
                  tabs={servicesTabs}
                  className="rounded-md"
                />
              </div>

              {isDesktopApp && desktopServicesTab === 'instance' && (
                <DesktopHostSwitcherDialog
                  embedded
                  open={isDesktopServicesOpen && desktopServicesTab === 'instance'}
                  onOpenChange={() => {}}
                  onHostSwitched={() => setIsDesktopServicesOpen(false)}
                />
              )}

              {desktopServicesTab === 'mcp' && (
                <McpDropdownContent active={isDesktopServicesOpen && desktopServicesTab === 'mcp'} />
              )}

              {desktopServicesTab === 'usage' && (
                <div className="overflow-x-hidden">
                  <div className="bg-[var(--surface-elevated)] border-b border-[var(--interactive-border)]">
                    <DropdownMenuLabel className="flex items-center justify-between gap-3 py-2.5">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="typography-ui-header font-semibold text-foreground">Rate limits</span>
                        <span className="truncate typography-ui-label text-muted-foreground">
                          Last updated {formatTime(quotaLastUpdated)}
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <AnimatedTabs<'usage' | 'remaining'>
                          value={quotaDisplayMode}
                          onValueChange={handleDisplayModeChange}
                          tabs={quotaDisplayTabs}
                          size="sm"
                          className="w-[10.5rem]"
                        />
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
                    </DropdownMenuLabel>
                  </div>
                  {!hasRateLimits && (
                    <DropdownMenuItem
                      className="cursor-default hover:bg-transparent focus:bg-transparent data-[highlighted]:bg-transparent"
                      onSelect={(event) => event.preventDefault()}
                    >
                      <span className="typography-ui-label text-muted-foreground">No rate limits available.</span>
                    </DropdownMenuItem>
                  )}
                  {rateLimitGroups.map((group, index) => {
                    const providerExpandedFamilies = expandedFamilies[group.providerId] ?? [];

                    return (
                      <React.Fragment key={group.providerId}>
                        <DropdownMenuLabel className="flex items-center gap-2 border-b border-[var(--interactive-border)] bg-[var(--surface-elevated)] typography-ui-label text-foreground">
                          <ProviderLogo providerId={group.providerId} className="h-4 w-4" />
                          {group.providerName}
                        </DropdownMenuLabel>

                        {group.entries.length === 0 && (!group.modelFamilies || group.modelFamilies.length === 0) ? (
                          <DropdownMenuItem
                            key={`${group.providerId}-empty`}
                            className="cursor-default hover:bg-transparent focus:bg-transparent data-[highlighted]:bg-transparent"
                            onSelect={(event) => event.preventDefault()}
                          >
                            <span className="typography-ui-label text-muted-foreground">
                              {group.error ?? 'No rate limits reported.'}
                            </span>
                          </DropdownMenuItem>
                        ) : (
                          <>
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
                              <DropdownMenuItem
                                key={`${group.providerId}-${label}`}
                                className="cursor-default items-start hover:bg-transparent focus:bg-transparent data-[highlighted]:bg-transparent"
                                onSelect={(event) => event.preventDefault()}
                              >
                                <span className="flex min-w-0 flex-1 flex-col gap-2">
                                        <span className="flex min-w-0 items-center justify-between gap-3">
                                          <span className="min-w-0 flex items-center gap-2">
                                            <span className="truncate typography-ui-label text-foreground">{formatWindowLabel(label)}</span>
                                            {(window.resetAfterFormatted ?? window.resetAtFormatted) ? (
                                              <span className="truncate typography-ui-label text-muted-foreground">
                                                {window.resetAfterFormatted ?? window.resetAtFormatted}
                                              </span>
                                            ) : null}
                                          </span>
                                          <span className="typography-ui-label text-foreground tabular-nums">
                                            {formatPercent(displayPercent) === '-' ? '' : formatPercent(displayPercent)}
                                          </span>
                                        </span>
                                        <UsageProgressBar
                                          percent={displayPercent}
                                          tonePercent={window.usedPercent}
                                          className="h-1.5"
                                          expectedMarkerPercent={expectedMarker}
                                        />
                                        {paceInfo && (
                                          <div className="mb-1">
                                            <PaceIndicator paceInfo={paceInfo} compact />
                                          </div>
                                        )}
                                </span>
                              </DropdownMenuItem>
                            );
                            })}

                            {group.modelFamilies && group.modelFamilies.length > 0 && (
                              <div className="px-2 py-1">
                                {group.modelFamilies.map((family) => {
                                  const isExpanded = providerExpandedFamilies.includes(family.familyId ?? 'other');

                                  return (
                                    <Collapsible
                                      key={family.familyId ?? 'other'}
                                      open={isExpanded}
                                      onOpenChange={() => toggleFamilyExpanded(group.providerId, family.familyId ?? 'other')}
                                    >
                                      <CollapsibleTrigger className="flex w-full items-center justify-between py-1.5 text-left">
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
                                        <div className="space-y-1 pl-2">
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
                                            <div
                                              key={`${group.providerId}-${modelName}`}
                                              className="py-1.5"
                                            >
                                              <div className="flex min-w-0 flex-col gap-1.5">
                                                <span className="flex min-w-0 items-center justify-between gap-3">
                                                  <span className="truncate typography-micro text-muted-foreground">{getDisplayModelName(modelName)}</span>
                                                  <span className="typography-ui-label text-foreground tabular-nums">
                                                    {formatPercent(displayPercent) === '-' ? '' : formatPercent(displayPercent)}
                                                  </span>
                                                </span>
                                                <UsageProgressBar
                                                  percent={displayPercent}
                                                  tonePercent={window.usedPercent}
                                                  className="h-1.5"
                                                  expectedMarkerPercent={expectedMarker}
                                                />
                                                {paceInfo && (
                                                  <div className="mb-1">
                                                    <PaceIndicator paceInfo={paceInfo} compact />
                                                  </div>
                                                )}
                                              </div>
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
                          </>
                        )}
                        {index < rateLimitGroups.length - 1 && <DropdownMenuSeparator />}
                      </React.Fragment>
                    );
                  })}
                </div>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        <Tooltip delayDuration={500}>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={toggleBottomTerminal}
              aria-label="Toggle terminal panel"
              className={desktopHeaderIconButtonClass}
            >
              <RiTerminalBoxLine className="h-[18px] w-[18px]" />
            </button>
          </TooltipTrigger>
          <TooltipContent>
            <p>Terminal panel ({shortcutLabel('toggle_terminal')})</p>
          </TooltipContent>
        </Tooltip>

        <Tooltip delayDuration={500}>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={toggleRightSidebar}
              aria-label="Toggle right sidebar"
              className={desktopHeaderIconButtonClass}
            >
              <RiLayoutRightLine className="h-[18px] w-[18px]" />
            </button>
          </TooltipTrigger>
          <TooltipContent>
            <p>Right sidebar ({shortcutLabel('toggle_right_sidebar')})</p>
          </TooltipContent>
        </Tooltip>

        {githubAuthStatus?.connected && !isMobile ? (
          githubAccounts.length > 1 ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className={cn(
                    desktopHeaderIconButtonClass,
                    'h-7 w-7 p-0 overflow-hidden rounded-full border border-border/60 bg-muted/80'
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
                        <span className="typography-ui-label text-foreground truncate">
                          {accountUser?.name?.trim() || accountUser?.login || 'GitHub'}
                        </span>
                        {accountUser?.login ? (
                          <span className="typography-micro text-muted-foreground truncate font-mono">
                            {accountUser.login}
                          </span>
                        ) : null}
                      </span>
                      {isCurrent ? (
                        <RiCheckLine className="h-4 w-4 text-primary" />
                      ) : null}
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
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
          )
        ) : null}
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
            {activeProjectRef && actionDirectory && (
              <ProjectActionsButton
                projectRef={activeProjectRef}
                directory={actionDirectory}
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
                  <div className="sticky top-0 z-20 border-b border-[var(--interactive-border)] bg-[var(--surface-elevated)] p-2">
                    <div className="flex items-center justify-between gap-2 px-3 py-3">
                      <AnimatedTabs<'usage' | 'mcp'>
                        value={mobileServicesTab}
                        onValueChange={(value) => {
                          setMobileServicesTab(value);
                          if (value === 'usage' && quotaResults.length === 0) {
                            fetchAllQuotas();
                          }
                        }}
                        tabs={[
                          { value: 'usage', label: 'Usage', icon: RiTimerLine },
                          { value: 'mcp', label: 'MCP', icon: RiCommandLine },
                        ]}
                        className="rounded-md"
                      />
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
                      <div className="bg-[var(--surface-elevated)] border-b border-[var(--interactive-border)]">
                        <div className="flex items-center justify-between gap-3 px-3 py-2.5">
                          <div className="flex flex-col min-w-0">
                            <span className="typography-ui-header font-semibold text-foreground">Rate limits</span>
                            <span className="truncate typography-ui-label text-muted-foreground">
                              Last updated {formatTime(quotaLastUpdated)}
                            </span>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            {/* Light-weight text toggle for Used/Remaining */}
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
                        <DropdownMenuItem
                          className="cursor-default hover:bg-transparent focus:bg-transparent data-[highlighted]:bg-transparent"
                          onSelect={(event) => event.preventDefault()}
                        >
                          <span className="typography-ui-label text-muted-foreground">No rate limits available.</span>
                        </DropdownMenuItem>
                      )}
                      {rateLimitGroups.map((group) => (
                        <React.Fragment key={group.providerId}>
                          <DropdownMenuLabel className="flex items-center gap-2 border-b border-[var(--interactive-border)] bg-[var(--surface-elevated)] typography-ui-label text-foreground">
                            <ProviderLogo providerId={group.providerId} className="h-4 w-4" />
                            {group.providerName}
                          </DropdownMenuLabel>

                          {group.entries.length === 0 && (!group.modelFamilies || group.modelFamilies.length === 0) ? (
                            <DropdownMenuItem
                              key={`${group.providerId}-empty`}
                              className="cursor-default hover:bg-transparent focus:bg-transparent data-[highlighted]:bg-transparent"
                              onSelect={(event) => event.preventDefault()}
                            >
                              <span className="typography-ui-label text-muted-foreground">
                                {group.error ?? 'No rate limits reported.'}
                              </span>
                            </DropdownMenuItem>
                          ) : (
                            <>
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
                                  <DropdownMenuItem
                                    key={`${group.providerId}-${label}`}
                                    className="cursor-default items-start hover:bg-transparent focus:bg-transparent data-[highlighted]:bg-transparent"
                                    onSelect={(event) => event.preventDefault()}
                                  >
                                    <span className="flex min-w-0 flex-1 flex-col gap-2">
                                      <span className="flex min-w-0 items-center justify-between gap-3">
                                        <span className="min-w-0 flex items-center gap-2">
                                          <span className="truncate typography-ui-label text-foreground">{formatWindowLabel(label)}</span>
                                          {(window.resetAfterFormatted ?? window.resetAtFormatted) ? (
                                            <span className="truncate typography-ui-label text-muted-foreground">
                                              {window.resetAfterFormatted ?? window.resetAtFormatted}
                                            </span>
                                          ) : null}
                                        </span>
                                        <span className="typography-ui-label text-foreground tabular-nums">
                                          {formatPercent(displayPercent) === '-' ? '' : formatPercent(displayPercent)}
                                        </span>
                                      </span>
                                      <UsageProgressBar
                                        percent={displayPercent}
                                        tonePercent={window.usedPercent}
                                        className="h-1.5"
                                        expectedMarkerPercent={expectedMarker}
                                      />
                                      {paceInfo && (
                                        <div className="mb-1">
                                          <PaceIndicator paceInfo={paceInfo} compact />
                                        </div>
                                      )}
                                    </span>
                                  </DropdownMenuItem>
                                );
                              })}

                              {group.modelFamilies && group.modelFamilies.length > 0 && (
                                <div className="px-2 py-1">
                                  {group.modelFamilies.map((family) => {
                                    const providerExpandedFamilies = expandedFamilies[group.providerId] ?? [];
                                    const isExpanded = providerExpandedFamilies.includes(family.familyId ?? 'other');

                                    return (
                                      <Collapsible
                                        key={family.familyId ?? 'other'}
                                        open={isExpanded}
                                        onOpenChange={() => toggleFamilyExpanded(group.providerId, family.familyId ?? 'other')}
                                      >
                                        <CollapsibleTrigger className="flex w-full items-center justify-between py-1.5 text-left">
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
                                          <div className="space-y-1 pl-2">
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
                                                <div
                                                  key={`${group.providerId}-${modelName}`}
                                                  className="py-1.5"
                                                >
                                                  <div className="flex min-w-0 flex-col gap-1.5">
                                                    <span className="flex min-w-0 items-center justify-between gap-3">
                                                      <span className="truncate typography-micro text-muted-foreground">{getDisplayModelName(modelName)}</span>
                                                      <span className="typography-ui-label text-foreground tabular-nums">
                                                        {formatPercent(displayPercent) === '-' ? '' : formatPercent(displayPercent)}
                                                      </span>
                                                    </span>
                                                    <UsageProgressBar
                                                      percent={displayPercent}
                                                      tonePercent={window.usedPercent}
                                                      className="h-1.5"
                                                      expectedMarkerPercent={expectedMarker}
                                                    />
                                                    {paceInfo && (
                                                      <div className="mb-1">
                                                        <PaceIndicator paceInfo={paceInfo} compact />
                                                      </div>
                                                    )}
                                                  </div>
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
                            </>
                          )}
                        </React.Fragment>
                      ))}
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
    isDesktopApp ? 'bg-background' : 'bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80'
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
