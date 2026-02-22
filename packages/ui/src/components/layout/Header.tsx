import React, { useEffect } from 'react';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { toast } from '@/components/ui';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { AnimatedTabs } from '@/components/ui/animated-tabs';

import { RiArrowLeftSLine, RiChat4Line, RiCheckLine, RiCloseLine, RiFileTextLine, RiFolder6Line, RiFolderAddLine, RiGitBranchLine, RiGithubFill, RiLayoutLeftLine, RiLayoutRightLine, RiMore2Fill, RiPencilLine, RiPlayListAddLine, RiRefreshLine, RiServerLine, RiSettings3Line, RiStackLine, RiTerminalBoxLine, RiTimerLine, type RemixiconComponentType } from '@remixicon/react';
import { DiffIcon } from '@/components/icons/DiffIcon';
import { useUIStore, type MainTab } from '@/stores/useUIStore';
import { useUpdateStore } from '@/stores/useUpdateStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { useSessionStore } from '@/stores/useSessionStore';
import { useQuotaAutoRefresh, useQuotaStore } from '@/stores/useQuotaStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useGitHubAuthStore } from '@/stores/useGitHubAuthStore';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { ContextUsageDisplay } from '@/components/ui/ContextUsageDisplay';
import { useDeviceInfo } from '@/lib/device';
import { cn, hasModifier, formatDirectoryName } from '@/lib/utils';
import { useDiffFileCount } from '@/components/views/DiffView';
import { McpDropdown, McpDropdownContent } from '@/components/mcp/McpDropdown';
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
import { isDesktopLocalOriginActive, isDesktopShell, isTauriShell, isVSCodeRuntime } from '@/lib/desktop';
import { sessionEvents } from '@/lib/sessionEvents';
import { desktopHostsGet, locationMatchesHost, redactSensitiveUrl } from '@/lib/desktopHosts';
import { ProjectEditDialog } from '@/components/layout/ProjectEditDialog';
import { GridLoader } from '@/components/ui/grid-loader';
import { PROJECT_ICON_MAP, PROJECT_COLOR_MAP } from '@/lib/projectMeta';

const ATTENTION_DIAMOND_INDICES = new Set([1, 3, 4, 5, 7]);

const getAttentionDiamondDelay = (index: number): string => {
  return index === 4 ? '0ms' : '130ms';
};

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

export const Header: React.FC = () => {
  const setSessionSwitcherOpen = useUIStore((state) => state.setSessionSwitcherOpen);
  const toggleSidebar = useUIStore((state) => state.toggleSidebar);
  const toggleBottomTerminal = useUIStore((state) => state.toggleBottomTerminal);
  const toggleRightSidebar = useUIStore((state) => state.toggleRightSidebar);
  const openContextOverview = useUIStore((state) => state.openContextOverview);
  const openContextPlan = useUIStore((state) => state.openContextPlan);
  const closeContextPanel = useUIStore((state) => state.closeContextPanel);
  const contextPanelByDirectory = useUIStore((state) => state.contextPanelByDirectory);
  const setSettingsDialogOpen = useUIStore((state) => state.setSettingsDialogOpen);
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
  const sessionsByDirectory = useSessionStore((state) => state.sessionsByDirectory);
  const getSessionsByDirectory = useSessionStore((state) => state.getSessionsByDirectory);
  const availableWorktreesByProject = useSessionStore((state) => state.availableWorktreesByProject);
  const sessionStatus = useSessionStore((state) => state.sessionStatus);
  const sessionAttentionStates = useSessionStore((state) => state.sessionAttentionStates);
  const quotaResults = useQuotaStore((state) => state.results);
  const fetchAllQuotas = useQuotaStore((state) => state.fetchAllQuotas);
  const isQuotaLoading = useQuotaStore((state) => state.isLoading);
  const quotaLastUpdated = useQuotaStore((state) => state.lastUpdated);
  const quotaDisplayMode = useQuotaStore((state) => state.displayMode);
  const dropdownProviderIds = useQuotaStore((state) => state.dropdownProviderIds);
  const loadQuotaSettings = useQuotaStore((state) => state.loadSettings);
  const setQuotaDisplayMode = useQuotaStore((state) => state.setDisplayMode);
  const homeDirectory = useDirectoryStore((state) => state.homeDirectory);
  const projects = useProjectsStore((state) => state.projects);
  const activeProjectId = useProjectsStore((state) => state.activeProjectId);
  const setActiveProject = useProjectsStore((state) => state.setActiveProject);
  const reorderProjects = useProjectsStore((state) => state.reorderProjects);
  const addProject = useProjectsStore((state) => state.addProject);
  const removeProject = useProjectsStore((state) => state.removeProject);

  const { isMobile } = useDeviceInfo();
  const diffFileCount = useDiffFileCount();
  const updateAvailable = useUpdateStore((state) => state.available);
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
  useEffect(() => {
    if (!isDesktopApp && desktopServicesTab === 'instance') {
      setDesktopServicesTab('usage');
    }
  }, [desktopServicesTab, isDesktopApp]);

  // --- Project tabs state (desktop, non-vscode only) ---
  const isVSCode = React.useMemo(() => isVSCodeRuntime(), []);
  const showProjectTabs = !isMobile && !isVSCode && projects.length > 0;
  const showDesktopHeaderContextUsage = !isVSCode && activeMainTab === 'chat' && !!stableDesktopContextUsage && stableDesktopContextUsage.totalTokens > 0;
  const tauriIpcAvailable = React.useMemo(() => isTauriShell(), []);

  const [editingProject, setEditingProject] = React.useState<{ id: string; name: string; path: string; icon?: string | null; color?: string | null } | null>(null);
  const [projectTabMenuOpen, setProjectTabMenuOpen] = React.useState<string | null>(null);
  const projectTabsScrollRef = React.useRef<HTMLDivElement>(null);
  const projectTabsContainerRef = React.useRef<HTMLDivElement>(null);
  const projectTabIndicatorRef = React.useRef<HTMLDivElement>(null);
  const projectTabRefs = React.useRef<Map<string, HTMLElement>>(new Map());
  const [projectTabsReady, setProjectTabsReady] = React.useState(false);
  const [projectTabsOverflow, setProjectTabsOverflow] = React.useState<{ left: boolean; right: boolean }>({ left: false, right: false });

  // --- Pointer-based drag reorder state ---
  const dragStateRef = React.useRef<{
    projectId: string;
    startX: number;
    startY: number;
    pointerId: number;
    active: boolean;
    overlay: HTMLDivElement | null;
    sourceRect: DOMRect | null;
    // Immutable after drag activation — never re-read from DOM
    tabWidths: Map<string, number>;
    layoutOriginX: number; // left edge of first tab
    gap: number;
    // Mutable virtual layout
    virtualRects: Array<{ id: string; left: number; right: number; centerX: number; width: number }>;
    currentOrder: string[];
    originalOrder: string[];
    scrollInterval: ReturnType<typeof setInterval> | null;
    lastClientX: number;
  } | null>(null);
  const [draggingProjectId, setDraggingProjectId] = React.useState<string | null>(null);
  const [dragCurrentOrder, setDragCurrentOrder] = React.useState<string[] | null>(null);

  /** Lay out tabs left-to-right using fixed widths. Pure computation, no DOM reads. */
  const computeVirtualRects = React.useCallback(
    (order: string[], widths: Map<string, number>, originX: number, gap: number) => {
      let x = originX;
      return order.map((id) => {
        const w = widths.get(id) ?? 0;
        const rect = { id, left: x, right: x + w, centerX: x + w / 2, width: w };
        x += w + gap;
        return rect;
      });
    },
    []
  );

  const formatProjectTabLabel = React.useCallback((project: { label?: string; path: string }): string => {
    return project.label?.trim()
      || formatDirectoryName(project.path, homeDirectory)
      || project.path;
  }, [homeDirectory]);

  const updateProjectTabsOverflow = React.useCallback(() => {
    const el = projectTabsScrollRef.current;
    if (!el) return;
    const next = {
      left: el.scrollLeft > 2,
      right: el.scrollLeft + el.clientWidth < el.scrollWidth - 2,
    };
    setProjectTabsOverflow((prev) => {
      if (prev.left === next.left && prev.right === next.right) {
        return prev;
      }
      return next;
    });
  }, []);

  const updateProjectTabIndicator = React.useCallback(() => {
    const container = projectTabsContainerRef.current;
    const indicator = projectTabIndicatorRef.current;
    if (!container || !indicator || !activeProjectId) return;
    // Hide indicator when the active tab itself is being dragged
    if (draggingProjectId === activeProjectId) {
      indicator.style.opacity = '0';
      return;
    }
    const activeTab = projectTabRefs.current.get(activeProjectId);
    if (!activeTab) {
      indicator.style.opacity = '0';
      return;
    }
    const containerRect = container.getBoundingClientRect();
    const tabRect = activeTab.getBoundingClientRect();
    const indicatorX = Math.round(tabRect.left - containerRect.left);
    const indicatorWidth = Math.round(tabRect.width);
    indicator.style.transform = `translateX(${indicatorX}px)`;
    indicator.style.width = `${indicatorWidth}px`;
    indicator.style.opacity = '1';
  }, [activeProjectId, draggingProjectId]);

  // Track metadata that affects tab width (label, icon) to re-measure indicator
  const projectTabMeta = React.useMemo(
    () => projects.map((p) => `${p.id}:${p.label ?? ''}:${p.icon ?? ''}`).join('|'),
    [projects]
  );

  const projectTabSessionIndicators = React.useMemo(() => {
    const result = new Map<string, { hasStreaming: boolean; hasNeedsAttention: boolean }>();
    if (!showProjectTabs || projects.length === 0) {
      return result;
    }

    for (const project of projects) {
      const projectRoot = normalize(project.path);
      if (!projectRoot) {
        result.set(project.id, { hasStreaming: false, hasNeedsAttention: false });
        continue;
      }

      const dirs: string[] = [projectRoot];
      const worktrees = availableWorktreesByProject.get(projectRoot) ?? [];
      for (const meta of worktrees) {
        const p = (meta && typeof meta === 'object' && 'path' in meta) ? (meta as { path?: unknown }).path : null;
        if (typeof p === 'string' && p.trim()) {
          const normalized = normalize(p);
          if (normalized && normalized !== projectRoot) {
            dirs.push(normalized);
          }
        }
      }

      const seen = new Set<string>();
      let hasStreaming = false;
      let hasNeedsAttention = false;

      for (const dir of dirs) {
        const list = sessionsByDirectory.get(dir) ?? getSessionsByDirectory(dir);
        for (const session of list) {
          if (!session?.id || seen.has(session.id)) {
            continue;
          }
          seen.add(session.id);

          const statusType = sessionStatus?.get(session.id)?.type ?? 'idle';
          if (statusType === 'busy' || statusType === 'retry') {
            hasStreaming = true;
          }

          const isCurrentVisibleSession = session.id === currentSessionId && project.id === activeProjectId;
          if (!isCurrentVisibleSession && sessionAttentionStates.get(session.id)?.needsAttention === true) {
            hasNeedsAttention = true;
          }

          if (hasStreaming && hasNeedsAttention) {
            break;
          }
        }
        if (hasStreaming && hasNeedsAttention) {
          break;
        }
      }

      result.set(project.id, { hasStreaming, hasNeedsAttention });
    }

    return result;
  }, [activeProjectId, availableWorktreesByProject, currentSessionId, getSessionsByDirectory, projects, sessionAttentionStates, sessionStatus, sessionsByDirectory, showProjectTabs]);

  React.useLayoutEffect(() => {
    if (!showProjectTabs) return;
    updateProjectTabIndicator();
    if (!projectTabsReady) {
      setProjectTabsReady(true);
    }
  }, [showProjectTabs, updateProjectTabIndicator, projectTabsReady, activeProjectId, projectTabMeta]);

  React.useEffect(() => {
    if (!showProjectTabs) return;
    const ro = new ResizeObserver(() => updateProjectTabIndicator());
    const container = projectTabsContainerRef.current;
    if (container) ro.observe(container);
    // Also observe the active tab element for size changes
    if (activeProjectId) {
      const activeTab = projectTabRefs.current.get(activeProjectId);
      if (activeTab) ro.observe(activeTab);
    }
    return () => ro.disconnect();
  }, [showProjectTabs, updateProjectTabIndicator, activeProjectId]);

  React.useEffect(() => {
    const el = projectTabsScrollRef.current;
    if (!el || !showProjectTabs) return;
    updateProjectTabsOverflow();
    el.addEventListener('scroll', updateProjectTabsOverflow, { passive: true });
    const ro = new ResizeObserver(updateProjectTabsOverflow);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', updateProjectTabsOverflow);
      ro.disconnect();
    };
  }, [showProjectTabs, updateProjectTabsOverflow, projects.length]);

  const handleAddProject = React.useCallback(() => {
    if (!tauriIpcAvailable || !isDesktopLocalOriginActive()) {
      sessionEvents.requestDirectoryDialog();
      return;
    }
    import('@/lib/desktop')
      .then(({ requestDirectoryAccess }) => requestDirectoryAccess(''))
      .then((result) => {
        if (result.success && result.path) {
          const added = addProject(result.path, { id: result.projectId });
          if (!added) {
            toast.error('Failed to add project', {
              description: 'Please select a valid directory.',
            });
          }
        } else if (result.error && result.error !== 'Directory selection cancelled') {
          toast.error('Failed to select directory', {
            description: result.error,
          });
        }
      })
      .catch((error) => {
        console.error('Failed to select directory:', error);
        toast.error('Failed to select directory');
      });
  }, [addProject, tauriIpcAvailable]);

  const updateProjectMeta = useProjectsStore((state) => state.updateProjectMeta);

  const handleOpenProjectEdit = React.useCallback((projectId: string) => {
    const project = projects.find((p) => p.id === projectId);
    if (!project) return;
    setEditingProject({
      id: project.id,
      name: formatProjectTabLabel(project),
      path: project.path,
      icon: project.icon,
      color: project.color,
    });
    setProjectTabMenuOpen(null);
  }, [projects, formatProjectTabLabel]);

  const handleSaveProjectEdit = React.useCallback((data: { label: string; icon: string | null; color: string | null }) => {
    if (!editingProject) return;
    updateProjectMeta(editingProject.id, data);
    setEditingProject(null);
  }, [editingProject, updateProjectMeta]);

  const handleCloseProject = React.useCallback((projectId: string) => {
    removeProject(projectId);
    setProjectTabMenuOpen(null);
  }, [removeProject]);

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

  const handleOpenSettings = React.useCallback(() => {
    if (isMobile) {
      blurActiveElement();
    }
    setSessionSwitcherOpen(false);
    setSettingsDialogOpen(true);
  }, [blurActiveElement, isMobile, setSessionSwitcherOpen, setSettingsDialogOpen]);

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

  const headerIconButtonClass = 'app-region-no-drag inline-flex h-9 w-9 items-center justify-center gap-2 p-2 rounded-md typography-ui-label font-medium text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:pointer-events-none disabled:opacity-50 hover:text-foreground hover:bg-interactive-hover transition-colors';

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
    const base: TabConfig[] = [
      { id: 'chat', label: 'Chat', icon: RiChat4Line },
    ];

    if (showPlanTab) {
      base.push({ id: 'plan', label: 'Plan', icon: RiFileTextLine });
    }

    if (isMobile) {
      base.push(
        {
          id: 'diff',
          label: 'Diff',
          icon: 'diff',
        },
        { id: 'files', label: 'Files', icon: RiFolder6Line },
        {
          id: 'terminal',
          label: 'Terminal',
          icon: RiTerminalBoxLine,
        },
        {
          id: 'git',
          label: 'Git',
          icon: RiGitBranchLine,
          showDot: diffFileCount > 0,
        },
      );
    }

    return base;
  }, [diffFileCount, isMobile, showPlanTab]);

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
        if (showProjectTabs) {
          if (num >= 1 && num <= projects.length) {
            e.preventDefault();
            const targetProject = projects[num - 1];
            if (targetProject && targetProject.id !== activeProjectId) {
              setActiveProject(targetProject.id);
            }
          }
          return;
        }

        if (num >= 1 && num <= tabs.length) {
          e.preventDefault();
          setActiveMainTab(tabs[num - 1].id);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [tabs, setActiveMainTab, showProjectTabs, projects, activeProjectId, setActiveProject]);

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
              ? 'app-region-no-drag bg-interactive-selection text-interactive-selection-foreground shadow-sm'
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

  // --- Pointer-based drag reorder handlers ---
  const DRAG_DEAD_ZONE = 5;

  const cleanupDrag = React.useCallback(() => {
    const ds = dragStateRef.current;
    if (!ds) return;
    if (ds.overlay && ds.overlay.parentNode) {
      ds.overlay.parentNode.removeChild(ds.overlay);
    }
    if (ds.scrollInterval) {
      clearInterval(ds.scrollInterval);
    }
    dragStateRef.current = null;
    setDraggingProjectId(null);
    setDragCurrentOrder(null);
  }, []);

  // Cleanup overlay on unmount + Escape to cancel drag
  React.useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && dragStateRef.current) {
        // Reset order to original (don't commit)
        cleanupDrag();
      }
    };
    window.addEventListener('keydown', handleEscape);
    return () => {
      window.removeEventListener('keydown', handleEscape);
      const ds = dragStateRef.current;
      if (ds?.overlay?.parentNode) {
        ds.overlay.parentNode.removeChild(ds.overlay);
      }
      if (ds?.scrollInterval) {
        clearInterval(ds.scrollInterval);
      }
      dragStateRef.current = null;
    };
  }, [cleanupDrag]);

  const commitDragOrder = React.useCallback(() => {
    const ds = dragStateRef.current;
    if (!ds) return;
    const { originalOrder, currentOrder } = ds;
    // Find the dragged project's positions in original vs current order
    if (JSON.stringify(originalOrder) !== JSON.stringify(currentOrder)) {
      const fromIndex = originalOrder.indexOf(ds.projectId);
      const toIndex = currentOrder.indexOf(ds.projectId);
      if (fromIndex !== -1 && toIndex !== -1 && fromIndex !== toIndex) {
        reorderProjects(fromIndex, toIndex);
      }
    }
  }, [reorderProjects]);

  const handleProjectTabPointerDown = React.useCallback((e: React.PointerEvent<HTMLDivElement>, projectId: string) => {
    // Don't start drag from buttons (dropdown trigger, etc.)
    const target = e.target as HTMLElement;
    if (target.closest('button')) return;
    // Only primary button
    if (e.button !== 0) return;
    // Don't start if a menu is open
    if (projectTabMenuOpen) return;

    const tabEl = projectTabRefs.current.get(projectId);
    if (!tabEl) return;

    const currentProjectIds = projects.map((p) => p.id);

    dragStateRef.current = {
      projectId,
      startX: e.clientX,
      startY: e.clientY,
      pointerId: e.pointerId,
      active: false,
      overlay: null,
      sourceRect: null,
      tabWidths: new Map(),
      layoutOriginX: 0,
      gap: 2,
      virtualRects: [],
      currentOrder: [...currentProjectIds],
      originalOrder: [...currentProjectIds],
      scrollInterval: null,
      lastClientX: e.clientX,
    };

    tabEl.setPointerCapture(e.pointerId);
  }, [projectTabMenuOpen, projects]);

  const handleProjectTabPointerMove = React.useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const ds = dragStateRef.current;
    if (!ds) return;

    const dx = e.clientX - ds.startX;
    const dy = e.clientY - ds.startY;

    if (!ds.active) {
      // Check dead zone
      if (Math.abs(dx) < DRAG_DEAD_ZONE && Math.abs(dy) < DRAG_DEAD_ZONE) return;

      // Activate drag
      ds.active = true;
      setDraggingProjectId(ds.projectId);

      const sourceEl = projectTabRefs.current.get(ds.projectId);
      if (!sourceEl) { cleanupDrag(); return; }

      ds.sourceRect = sourceEl.getBoundingClientRect();

      // Snapshot widths once — these never change for the duration of the drag
      const widths = new Map<string, number>();
      for (const id of ds.currentOrder) {
        const el = projectTabRefs.current.get(id);
        if (el) widths.set(id, el.getBoundingClientRect().width);
      }
      ds.tabWidths = widths;

      // Compute layout origin and gap from DOM (one-time read)
      const firstEl = projectTabRefs.current.get(ds.currentOrder[0]);
      ds.layoutOriginX = firstEl ? firstEl.getBoundingClientRect().left : ds.sourceRect.left;
      if (ds.currentOrder.length >= 2) {
        const a = projectTabRefs.current.get(ds.currentOrder[0]);
        const b = projectTabRefs.current.get(ds.currentOrder[1]);
        if (a && b) {
          ds.gap = Math.max(0, b.getBoundingClientRect().left - a.getBoundingClientRect().right);
        }
      }

      // Build initial virtual rects
      ds.virtualRects = computeVirtualRects(ds.currentOrder, ds.tabWidths, ds.layoutOriginX, ds.gap);

      // Create overlay clone
      const overlay = document.createElement('div');
      overlay.style.position = 'fixed';
      overlay.style.zIndex = '99999';
      overlay.style.pointerEvents = 'none';
      overlay.style.width = `${ds.sourceRect.width}px`;
      overlay.style.height = `${ds.sourceRect.height}px`;
      overlay.style.left = `${ds.sourceRect.left}px`;
      overlay.style.top = `${ds.sourceRect.top}px`;
      overlay.style.transition = 'box-shadow 150ms ease';
      overlay.style.boxShadow = '0 4px 16px rgba(0,0,0,0.18), 0 1px 4px rgba(0,0,0,0.10)';
      overlay.style.willChange = 'transform';
      overlay.style.cursor = 'grabbing';

      // Clone visual content
      overlay.innerHTML = sourceEl.innerHTML;
      // Copy computed styles for visual fidelity
      const computed = getComputedStyle(sourceEl);
      overlay.style.borderRadius = computed.borderRadius;
      overlay.style.display = computed.display;
      overlay.style.alignItems = computed.alignItems;
      overlay.style.gap = computed.gap;
      overlay.style.padding = computed.padding;
      overlay.style.fontSize = computed.fontSize;
      overlay.style.fontWeight = computed.fontWeight;
      overlay.style.fontFamily = computed.fontFamily;
      overlay.style.color = computed.color;
      overlay.style.backgroundColor = 'var(--surface-elevated)';
      overlay.style.border = '1px solid var(--interactive-border)';
      overlay.style.boxSizing = 'border-box';
      overlay.style.whiteSpace = 'nowrap';
      overlay.style.opacity = '1';
      const isDraggedActive = ds.projectId === activeProjectId;
      if (isDraggedActive) {
        overlay.style.outline = '1px solid var(--interactive-border)';
        overlay.style.outlineOffset = '-1px';
      } else {
        overlay.style.outline = 'none';
        overlay.style.outlineOffset = '0';
      }

      document.body.appendChild(overlay);
      ds.overlay = overlay;

      // Set current order in state for rendering
      setDragCurrentOrder([...ds.currentOrder]);

      // Auto-scroll setup
      const scrollEl = projectTabsScrollRef.current;
      if (scrollEl) {
        ds.scrollInterval = setInterval(() => {
          const state = dragStateRef.current;
          if (!state) return;
          const scrollRect = scrollEl.getBoundingClientRect();
          const edgeZone = 40;
          if (state.lastClientX < scrollRect.left + edgeZone && scrollEl.scrollLeft > 0) {
            scrollEl.scrollLeft -= 4;
          } else if (state.lastClientX > scrollRect.right - edgeZone && scrollEl.scrollLeft + scrollEl.clientWidth < scrollEl.scrollWidth) {
            scrollEl.scrollLeft += 4;
          }
        }, 16);
      }
    }

    // Track cursor position for auto-scroll
    ds.lastClientX = e.clientX;

    // Move overlay — clamped to the visible tabs container
    if (ds.overlay && ds.sourceRect) {
      let offsetX = e.clientX - ds.startX;
      const scrollEl = projectTabsScrollRef.current;
      if (scrollEl) {
        const bounds = scrollEl.getBoundingClientRect();
        const overlayLeft = ds.sourceRect.left + offsetX;
        const clampedLeft = Math.max(bounds.left, Math.min(overlayLeft, bounds.right - ds.sourceRect.width));
        offsetX = clampedLeft - ds.sourceRect.left;
      }
      ds.overlay.style.transform = `translate(${offsetX}px, 0px) scale(1.03)`;
    }

    // Determine new order via virtual rects (no DOM reads — fully deterministic)
    if (ds.virtualRects.length > 0) {
      const cursorX = e.clientX;
      const draggedIdx = ds.currentOrder.indexOf(ds.projectId);
      if (draggedIdx === -1) return;

      // Hysteresis: require cursor to pass center ± margin to prevent borderline oscillation
      const HYSTERESIS = 6;
      let targetIdx = draggedIdx;
      for (let i = 0; i < ds.virtualRects.length; i++) {
        if (ds.currentOrder[i] === ds.projectId) continue;
        const rect = ds.virtualRects[i];
        if (i < draggedIdx && cursorX < rect.centerX - HYSTERESIS) {
          targetIdx = i;
          break;
        }
        if (i > draggedIdx && cursorX > rect.centerX + HYSTERESIS) {
          targetIdx = i;
        }
      }

      if (targetIdx !== draggedIdx) {
        const newOrder = [...ds.currentOrder];
        const [moved] = newOrder.splice(draggedIdx, 1);
        newOrder.splice(targetIdx, 0, moved);
        ds.currentOrder = newOrder;

        // Recompute virtual rects from fixed widths — deterministic, no DOM
        ds.virtualRects = computeVirtualRects(newOrder, ds.tabWidths, ds.layoutOriginX, ds.gap);

        setDragCurrentOrder([...newOrder]);
      }
    }
  }, [activeProjectId, cleanupDrag, computeVirtualRects]);

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const handleProjectTabPointerUp = React.useCallback((_e: React.PointerEvent<HTMLDivElement>) => {
    const ds = dragStateRef.current;
    if (!ds) return;

    const tabEl = projectTabRefs.current.get(ds.projectId);
    if (tabEl) {
      try { tabEl.releasePointerCapture(ds.pointerId); } catch { /* ignore */ }
    }

    if (ds.active) {
      commitDragOrder();
    } else {
      // It was a click, not a drag — activate the project
      if (ds.projectId !== activeProjectId) {
        setActiveProject(ds.projectId);
      }
    }

    cleanupDrag();
  }, [activeProjectId, cleanupDrag, commitDragOrder, setActiveProject]);

  const handleProjectTabPointerCancel = React.useCallback(() => {
    cleanupDrag();
  }, [cleanupDrag]);

  // Determine the display order of projects (reordered during drag, normal otherwise)
  const displayProjects = React.useMemo(() => {
    if (!dragCurrentOrder) return projects;
    // Map the order of IDs to actual project objects
    const projectMap = new Map(projects.map((p) => [p.id, p]));
    return dragCurrentOrder.map((id) => projectMap.get(id)).filter(Boolean) as typeof projects;
  }, [dragCurrentOrder, projects]);

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
            className={`${headerIconButtonClass} mr-2 shrink-0`}
          >
            <RiLayoutLeftLine className="h-5 w-5" />
          </button>
        </TooltipTrigger>
        <TooltipContent>
          <p>Open sessions ({shortcutLabel('toggle_sidebar')})</p>
        </TooltipContent>
      </Tooltip>

      {/* Project tabs */}
      {showProjectTabs && (
        <div className="ml-6 mr-3 flex min-w-0 flex-1 items-center">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={handleAddProject}
                className={`${headerIconButtonClass} mr-1 shrink-0`}
                aria-label="Add project"
              >
                <RiFolderAddLine className="h-5 w-5" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Add project</TooltipContent>
          </Tooltip>
          <div className="app-region-no-drag relative min-w-0 w-fit max-w-full">
            {/* Left fade */}
            {projectTabsOverflow.left && (
              <div className="pointer-events-none absolute left-0 top-0 bottom-0 w-6 z-20 bg-gradient-to-r from-[var(--surface-background)] to-transparent rounded-l-lg" />
            )}
            {/* Right fade */}
            {projectTabsOverflow.right && (
              <div className="pointer-events-none absolute right-0 top-0 bottom-0 w-6 z-20 bg-gradient-to-l from-[var(--surface-background)] to-transparent rounded-r-lg" />
            )}
            <div
              ref={projectTabsScrollRef}
              className="max-w-full overflow-x-auto scrollbar-none"
              style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
            >
              <div
                ref={projectTabsContainerRef}
                className="relative inline-flex items-center h-9 gap-0.5 rounded-lg bg-[var(--surface-muted)]/50 py-0.5 px-px"
              >
                {/* Sliding indicator */}
                <div
                  ref={projectTabIndicatorRef}
                  className={cn(
                    'absolute top-0.5 bottom-0.5 rounded-lg border border-[var(--interactive-border)] bg-[var(--surface-elevated)] shadow-sm'
                  )}
                  style={{ width: 0, transform: 'translateX(0)', opacity: 0 }}
                />
              {displayProjects.map((project) => {
                const isActive = project.id === activeProjectId;
                const isDragged = draggingProjectId === project.id;
                const sessionIndicator = projectTabSessionIndicators.get(project.id);
                const showProjectStreaming = sessionIndicator?.hasStreaming === true;
                const showProjectUnread = !showProjectStreaming
                  && project.id !== activeProjectId
                  && sessionIndicator?.hasNeedsAttention === true;
                const ProjectIcon = project.icon ? PROJECT_ICON_MAP[project.icon] : null;
                const projectColorVar = project.color ? (PROJECT_COLOR_MAP[project.color] ?? null) : null;

                 const statusMarker = showProjectStreaming
                   ? (
                     <GridLoader size="xs" className="text-primary" />
                   )
                   : showProjectUnread
                     ? (
                      <span
                        className="grid grid-cols-3 place-items-center gap-[1px] text-[var(--status-info)]"
                        style={{ width: '11px', height: '11px' }}
                        aria-label="Unread updates"
                        title="Unread updates"
                      >
                        {Array.from({ length: 9 }, (_, i) => (
                          ATTENTION_DIAMOND_INDICES.has(i) ? (
                            <span
                              key={i}
                              className="shrink-0 h-[3px] w-[3px] rounded-full bg-current animate-attention-diamond-pulse"
                              style={{ animationDelay: getAttentionDiamondDelay(i) }}
                            />
                          ) : (
                            <span key={i} className="shrink-0 h-[3px] w-[3px]" />
                          )
                        ))}
                      </span>
                    )
                    : null;

                return (
                  <div
                    key={project.id}
                    ref={(el) => {
                      if (el) { projectTabRefs.current.set(project.id, el); }
                      else { projectTabRefs.current.delete(project.id); }
                    }}
                    role="tab"
                    tabIndex={0}
                    aria-selected={isActive}
                    onPointerDown={(e) => handleProjectTabPointerDown(e, project.id)}
                    onPointerMove={handleProjectTabPointerMove}
                    onPointerUp={handleProjectTabPointerUp}
                    onPointerCancel={handleProjectTabPointerCancel}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setProjectTabMenuOpen(project.id);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        if (project.id !== activeProjectId) {
                          setActiveProject(project.id);
                        }
                      }
                    }}
                    className={cn(
                      'relative z-10 flex h-8 shrink-0 items-center gap-1 rounded-lg pr-1 text-[0.9375rem] font-medium whitespace-nowrap group',
                      isDragged
                        ? 'opacity-30 scale-[0.97]'
                        : 'cursor-pointer',
                      statusMarker ? 'pl-[9px]' : 'pl-[7px]',
                      isActive
                        ? 'text-foreground'
                        : 'text-muted-foreground hover:text-foreground',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)] focus-visible:ring-offset-1 focus-visible:ring-offset-background'
                    )}
                    style={{ touchAction: 'none' }}
                    title={project.path}
                  >
                     <span
                       className="relative flex h-3.5 items-center justify-center overflow-visible"
                        style={{ width: statusMarker ? '13px' : '0px' }}
                     >
                       {statusMarker && (
                         <span className="absolute left-0 flex items-center justify-center">
                           {statusMarker}
                         </span>
                       )}
                     </span>
                    {ProjectIcon && (
                      <ProjectIcon
                        className="h-4 w-4 shrink-0"
                        style={projectColorVar ? { color: projectColorVar } : undefined}
                      />
                    )}
                    <span>{formatProjectTabLabel(project)}</span>
                    <DropdownMenu
                      open={projectTabMenuOpen === project.id}
                      onOpenChange={(open) => setProjectTabMenuOpen(open ? project.id : null)}
                    >
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          className={cn(
                            '-ml-0.5 inline-flex h-3.5 w-3.5 items-center justify-center rounded-sm',
                            'text-muted-foreground hover:text-foreground',
                            isActive || projectTabMenuOpen === project.id
                              ? 'opacity-60 hover:opacity-100'
                              : 'opacity-0 group-hover:opacity-60 hover:!opacity-100'
                          )}
                          aria-label="Project options"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <RiMore2Fill className="h-3.5 w-3.5" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start" className="min-w-[160px]">
                        <DropdownMenuItem
                          onClick={() => handleOpenProjectEdit(project.id)}
                          className="gap-2"
                        >
                          <RiPencilLine className="h-4 w-4" />
                          Edit project
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => handleCloseProject(project.id)}
                          className="text-destructive focus:text-destructive gap-2"
                        >
                          <RiCloseLine className="h-4 w-4" />
                          Close project
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                );
              })}
              </div>
            </div>
          </div>
        </div>
      )}

      {!showProjectTabs && (
        <div className="flex items-center gap-1 rounded-lg bg-[var(--surface-muted)]/50 p-1">
          {tabs.map((tab) => renderTab(tab))}
        </div>
      )}

      {!showProjectTabs && <div className="flex-1" />}

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
                className={cn(headerIconButtonClass, isContextPlanActive && 'bg-[var(--interactive-hover)] text-foreground')}
              >
                <RiFileTextLine className="h-5 w-5" />
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
                      headerIconButtonClass,
                      isDesktopApp
                        ? 'w-auto max-w-[14rem] justify-start gap-1.5 px-2.5'
                        : 'h-9 w-9'
                    )}
                  >
                    <RiStackLine className="h-5 w-5" />
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
              className={headerIconButtonClass}
            >
              <RiTerminalBoxLine className="h-5 w-5" />
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
              className={headerIconButtonClass}
            >
              <RiLayoutRightLine className="h-5 w-5" />
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
                    headerIconButtonClass,
                    'h-8 w-8 p-0 overflow-hidden rounded-full border border-border/60 bg-muted/80'
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
                    <RiGithubFill className="h-4 w-4 text-muted-foreground" />
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
              className="app-region-no-drag flex h-8 w-8 items-center justify-center overflow-hidden rounded-full border border-border/60 bg-muted/80"
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
                <RiGithubFill className="h-4 w-4 text-muted-foreground" />
              )}
            </div>
          )
        ) : null}
      </div>
    </div>
  );

  const renderMobile = () => (
    <div className="app-region-drag relative flex items-center justify-between gap-2 px-3 py-2 select-none">
      <div className="flex items-center gap-2 shrink-0">
        {/* Show back button when sessions sidebar is open, otherwise show sessions toggle */}
        {isSessionSwitcherOpen ? (
          <button
            onClick={() => setSessionSwitcherOpen(false)}
            className="app-region-no-drag h-9 w-9 p-2 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-md active:bg-interactive-active"
            aria-label="Back"
          >
            <RiArrowLeftSLine className="h-5 w-5" />
          </button>
        ) : (
          <button
            onClick={handleOpenSessionSwitcher}
            className="app-region-no-drag h-9 w-9 p-2 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-md active:bg-interactive-active"
            aria-label="Open sessions"
          >
            <RiPlayListAddLine className="h-5 w-5" />
          </button>
        )}
        {!isSessionSwitcherOpen && contextUsage && contextUsage.totalTokens > 0 && activeMainTab === 'chat' && (
          <ContextUsageDisplay
            totalTokens={contextUsage.totalTokens}
            percentage={contextUsage.percentage}
            contextLimit={contextUsage.contextLimit}
            outputLimit={contextUsage.outputLimit ?? 0}
            size="compact"
            isMobile={true}
          />
        )}
        {isSessionSwitcherOpen && (
          <span className="typography-ui-label font-semibold text-foreground">Sessions</span>
        )}
      </div>

      {/* Hide tabs and right-side buttons when sessions sidebar is open */}
      {!isSessionSwitcherOpen && (
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
                          headerIconButtonClass,
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

            <McpDropdown headerIconButtonClass={headerIconButtonClass} />

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
                      aria-label="View rate limits"
                      className={headerIconButtonClass}
                      disabled={isQuotaLoading}
                    >
                      <RiTimerLine className="h-5 w-5" />
                    </button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent>
                  <p>Rate limits</p>
                </TooltipContent>
              </Tooltip>
              <DropdownMenuContent
                align="end"
                sideOffset={0}
                className="h-dvh w-[100vw] max-h-none rounded-none border-0 p-0 overflow-hidden"
              >
                <div className="flex h-full flex-col bg-[var(--surface-elevated)]">
                  <div className="sticky top-0 z-20 border-b border-[var(--interactive-border)] bg-[var(--surface-elevated)]">
                    <div className="flex items-center justify-between gap-2 px-3 py-3">
                      <span className="typography-ui-header font-semibold text-foreground">Rate limits</span>
                      <div className="flex items-center gap-2">
                        <div className="flex items-center rounded-md border border-[var(--interactive-border)] p-0.5">
                          <button
                            type="button"
                            className={cn(
                              'px-1.5 py-0.5 rounded-sm typography-micro text-[9px] transition-colors',
                              quotaDisplayMode === 'usage'
                                ? 'bg-interactive-selection text-interactive-selection-foreground'
                                : 'text-muted-foreground hover:text-foreground'
                            )}
                            onClick={() => handleDisplayModeChange('usage')}
                            aria-label="Show used quota"
                          >
                            Used
                          </button>
                          <button
                            type="button"
                            className={cn(
                              'px-1.5 py-0.5 rounded-sm typography-micro text-[9px] transition-colors',
                              quotaDisplayMode === 'remaining'
                                ? 'bg-interactive-selection text-interactive-selection-foreground'
                                : 'text-muted-foreground hover:text-foreground'
                            )}
                            onClick={() => handleDisplayModeChange('remaining')}
                            aria-label="Show remaining quota"
                          >
                            Remaining
                          </button>
                        </div>
                        <button
                          type="button"
                          className={cn(
                            'inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors',
                            'hover:text-foreground hover:bg-interactive-hover',
                            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary'
                          )}
                          onClick={() => fetchAllQuotas()}
                          disabled={isQuotaLoading}
                          aria-label="Refresh rate limits"
                        >
                          <RiRefreshLine className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setIsMobileRateLimitsOpen(false)}
                          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-interactive-hover"
                          aria-label="Close rate limits"
                        >
                          <RiCloseLine className="h-5 w-5" />
                        </button>
                      </div>
                    </div>
                    <div className="px-3 pb-3 text-right typography-micro text-muted-foreground text-[8px]">
                      Last updated {formatTime(quotaLastUpdated)}
                    </div>
                  </div>
                  <div className="flex-1 overflow-y-auto overflow-x-hidden pb-[calc(4rem+env(safe-area-inset-bottom))]">
                    {!hasRateLimits && (
                      <div className="px-3 py-4 typography-ui-label text-muted-foreground">
                        No rate limits available.
                      </div>
                    )}
                    {rateLimitGroups.map((group) => (
                      <React.Fragment key={group.providerId}>
                        <div className="flex items-center gap-2 bg-[var(--surface-elevated)] px-3 py-2">
                          <ProviderLogo providerId={group.providerId} className="h-4 w-4" />
                          <span className="typography-ui-label text-foreground">{group.providerName}</span>
                        </div>
                        {group.entries.length === 0 && (!group.modelFamilies || group.modelFamilies.length === 0) && (
                          <div className="px-3 py-2 typography-ui-label text-muted-foreground">
                            {group.error ?? 'No rate limits reported.'}
                          </div>
                        )}
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
                            <div key={`${group.providerId}-${label}`} className="px-3 py-2">
                              <div className="flex items-center justify-between gap-3">
                                <span className="truncate typography-micro text-muted-foreground">
                                  {formatWindowLabel(label)}
                                </span>
                                <span className="typography-ui-label text-foreground tabular-nums">
                                  {formatPercent(displayPercent)}
                                </span>
                              </div>
                              <UsageProgressBar
                                percent={displayPercent}
                                tonePercent={window.usedPercent}
                                className="mt-2 h-1"
                                expectedMarkerPercent={expectedMarker}
                              />
                              {paceInfo && (
                                <div className="mt-1.5">
                                  <PaceIndicator paceInfo={paceInfo} compact />
                                </div>
                              )}
                              <div className="mt-1 typography-micro text-muted-foreground text-[10px]">
                                {window.resetAfterFormatted ?? window.resetAtFormatted ?? ''}
                              </div>
                            </div>
                          );
                        })}
                        {/* Model families with collapsible sections */}
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
                                  <CollapsibleTrigger className="flex w-full items-center justify-between py-2 text-left">
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
                                    <div className="space-y-2 pl-2">
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
                                          <div key={`${group.providerId}-${modelName}`} className="py-1.5">
                                            <div className="flex items-center justify-between gap-3">
                                              <span className="truncate typography-micro text-muted-foreground">
                                                {getDisplayModelName(modelName)}
                                              </span>
                                              <span className="typography-ui-label text-foreground tabular-nums">
                                                {formatPercent(displayPercent) === '-' ? '' : formatPercent(displayPercent)}
                                              </span>
                                            </div>
                                            <UsageProgressBar
                                              percent={displayPercent}
                                              tonePercent={window.usedPercent}
                                              className="mt-1.5 h-1"
                                              expectedMarkerPercent={expectedMarker}
                                            />
                                            {paceInfo && (
                                              <div className="mt-1">
                                                <PaceIndicator paceInfo={paceInfo} compact />
                                              </div>
                                            )}
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
                      </React.Fragment>
                    ))}
                  </div>
                </div>
              </DropdownMenuContent>
            </DropdownMenu>

            <Tooltip delayDuration={500}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={handleOpenSettings}
                  aria-label="Open settings"
                  className={cn(headerIconButtonClass, 'relative')}
                >
                  <RiSettings3Line className="h-5 w-5" />
                  {updateAvailable && (
                    <span
                      className="absolute top-1.5 right-1.5 h-2 w-2 rounded-full bg-primary"
                      aria-label="Update available"
                    />
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent>
                <p>{updateAvailable ? `Settings (Update available) (${shortcutLabel('open_settings')})` : `Settings (${shortcutLabel('open_settings')})`}</p>
              </TooltipContent>
            </Tooltip>
            </div>
          </div>
        </div>
      )}
    </div>
  );

  const headerClassName = cn(
    'header-safe-area border-b border-border/50 relative z-10',
    isDesktopApp ? 'bg-background' : 'bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80'
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
      {editingProject && (
        <ProjectEditDialog
          open={Boolean(editingProject)}
          onOpenChange={(open) => { if (!open) setEditingProject(null); }}
          projectName={editingProject.name}
          projectPath={editingProject.path}
          initialIcon={editingProject.icon}
          initialColor={editingProject.color}
          onSave={handleSaveProjectEdit}
        />
      )}
    </>
  );
};
