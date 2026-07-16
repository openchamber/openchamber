import React from 'react';
import { cn, getModifierLabel } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useAgentsStore } from '@/stores/useAgentsStore';
import { useCommandsStore } from '@/stores/useCommandsStore';
import { useMcpConfigStore } from '@/stores/useMcpConfigStore';
import { useSnippetsStore } from '@/stores/useSnippetsStore';
import { useSkillsStore } from '@/stores/useSkillsStore';
import { useSkillsCatalogStore } from '@/stores/useSkillsCatalogStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { AgentsSidebar } from '@/components/sections/agents/AgentsSidebar';
import { AgentsPage } from '@/components/sections/agents/AgentsPage';
import { BehaviorPage } from '@/components/sections/behavior/BehaviorPage';
import { CommandsSidebar } from '@/components/sections/commands/CommandsSidebar';
import { CommandsPage } from '@/components/sections/commands/CommandsPage';
import { McpSidebar } from '@/components/sections/mcp/McpSidebar';
import { McpPage } from '@/components/sections/mcp/McpPage';
import { PluginsSidebar, PluginsPage } from '@/components/sections/plugins';
import { usePluginsStore } from '@/stores/usePluginsStore';
import { SkillsSidebar } from '@/components/sections/skills/SkillsSidebar';
import { SkillsPage } from '@/components/sections/skills/SkillsPage';
import { ProjectsSidebar } from '@/components/sections/projects/ProjectsSidebar';
import { ProjectsPage } from '@/components/sections/projects/ProjectsPage';
import { RemoteInstancesPage } from '@/components/sections/remote-instances/RemoteInstancesPage';
import { ProvidersSidebar } from '@/components/sections/providers/ProvidersSidebar';
import { ProvidersPage } from '@/components/sections/providers/ProvidersPage';
import { UsageSidebar } from '@/components/sections/usage/UsageSidebar';
import { UsagePage } from '@/components/sections/usage/UsagePage';
import { MagicPromptsSidebar } from '@/components/sections/magic-prompts/MagicPromptsSidebar';
import { MagicPromptsPage } from '@/components/sections/magic-prompts/MagicPromptsPage';
import { SnippetsSidebar } from '@/components/sections/snippets/SnippetsSidebar';
import { SnippetsPage } from '@/components/sections/snippets/SnippetsPage';
import { GitPage } from '@/components/sections/git-identities/GitPage';
import type { OpenChamberSection } from '@/components/sections/openchamber/types';
import { OpenChamberPage } from '@/components/sections/openchamber/OpenChamberPage';
import { AboutSettings } from '@/components/sections/openchamber/AboutSettings';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import {
  SETTINGS_DESCRIPTION_CLASS,
  SETTINGS_PAGE_TITLE_CLASS,
  SETTINGS_SECTION_TITLE_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { useDeviceInfo } from '@/lib/device';
import { isDesktopLocalOriginActive, isDesktopShell, isVSCodeRuntime, isWebRuntime } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import { Icon } from "@/components/icon/Icon";
import type { IconName } from "@/components/icon/icons";
import { McpIcon } from '@/components/icons/McpIcon';
import { reloadOpenCodeConfiguration } from '@/stores/useAgentsStore';
import {
  SETTINGS_PAGE_METADATA,
  getSettingsPageMeta,
  resolveSettingsSlug,
  type SettingsPageSlug,
  type SettingsRuntimeContext,
  type SettingsPageMeta,
} from '@/lib/settings/metadata';
import { buildSettingsSearchResults, type SettingsSearchResult } from '@/lib/settings/search';

// UI Kit: fixed settings navigation width
const SETTINGS_NAV_WIDTH = 260;
const SETTINGS_SPLIT_SIDEBAR_WIDTH = 280;
const SETTINGS_DETAIL_HISTORY_KEY = '__openchamberSettingsDetail';

type MobileStage = 'nav' | 'page-sidebar' | 'page-content';
type SettingsDetailHistoryEntry = {
  page: SettingsPageSlug;
  stage: 'page-content';
};

interface SettingsViewProps {
  onClose?: () => void;
  /** Force mobile layout regardless of device detection */
  forceMobile?: boolean;
  /** Rendered inside a window/dialog (skip traffic light padding) */
  isWindowed?: boolean;
  /** Restrict top-level settings navigation to a specific product surface. */
  visiblePageSlugs?: SettingsPageSlug[];
  initialMobileStage?: MobileStage;
}

const pageOrder: SettingsPageSlug[] = [
  // Interface
  'appearance',
  'chat',
  'notifications',
  'sessions',
  'shortcuts',
  'voice',
  'about',
  // Workspace & remote
  'projects',
  'remote-instances',
  'tunnel',
  'git',
  // OpenCode
  'providers',
  'usage',
  'agents',
  'behavior',
  'commands',
  'mcp',
  'plugins',
  // Content
  'magic-prompts',
  'snippets',
  'skills.installed',
  'skills.catalog',
];

const NAV_GROUP_ORDER = ['general', 'projects', 'opencode', 'content'] as const;

const SNIPPETS_SETTINGS_ICON = { icon: 'chat-thread' } as const;
const ADD_PROVIDER_SETTINGS_ID = '__add_provider__';

function buildRuntimeContext(isDesktop: boolean, isMobile: boolean): SettingsRuntimeContext {
  const isVSCode = isVSCodeRuntime();
  const isWeb = !isDesktop && isWebRuntime();
  return { isVSCode, isWeb, isDesktop, isMobile };
}

function isPageAvailable(page: SettingsPageMeta, ctx: SettingsRuntimeContext): boolean {
  if (!page.isAvailable) {
    return true;
  }
  return page.isAvailable(ctx);
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nextUniqueName(baseName: string, existingNames: Iterable<string>): string {
  const existing = new Set(existingNames);
  let name = baseName;
  let counter = 1;
  while (existing.has(name)) {
    name = `${baseName}-${counter}`;
    counter += 1;
  }
  return name;
}

function getSettingsDetailHistoryEntry(state: unknown): SettingsDetailHistoryEntry | null {
  if (!isObjectRecord(state)) {
    return null;
  }

  const detail = state[SETTINGS_DETAIL_HISTORY_KEY];
  if (!isObjectRecord(detail)) {
    return null;
  }

  const page = detail.page;
  const stage = detail.stage;
  if (typeof page !== 'string' || stage !== 'page-content') {
    return null;
  }

  const resolvedPage = resolveSettingsSlug(page);
  return { page: resolvedPage, stage };
}

function getCurrentHistoryState(): Record<string, unknown> {
  if (typeof window === 'undefined' || !isObjectRecord(window.history.state)) {
    return {};
  }
  return window.history.state;
}

// eslint-disable-next-line react-refresh/only-export-components
export function getSettingsNavIcon(slug: SettingsPageSlug): IconName | null {
  switch (slug) {
    case 'projects':
      return 'folders';
    case 'remote-instances':
      return 'computer';
    case 'appearance':
      return 'palette';
    case 'chat':
      return 'chat-ai-3';
    case 'magic-prompts':
      return 'ai-generate-2';
    case 'snippets':
      return SNIPPETS_SETTINGS_ICON.icon;
    case 'notifications':
      return 'notification-3';
    case 'shortcuts':
      return 'command';
    case 'sessions':
      return 'chat-history';

    case 'providers':
      return 'cloud';
    case 'agents':
      return 'ai-agent';
    case 'behavior':
      return 'brain';
    case 'commands':
      return 'slash-commands-2';
    case 'mcp':
      return null;
    case 'plugins':
      return 'plug-2';

    case 'skills.installed':
      return 'book-open';
    case 'skills.catalog':
      return 'book';

    case 'git':
      return 'git-branch';

    case 'usage':
      return 'bar-chart-2';
    case 'voice':
      return 'mic';
    case 'tunnel':
      return 'share-2';
    case 'about':
      return 'information';
    case 'home':
      return null;
    default:
      return 'robot-2';
  }
}

const SettingsHome: React.FC<{ onOpen: (slug: SettingsPageSlug) => void }> = ({ onOpen }) => {
  const { t } = useI18n();
  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto w-full max-w-[840px] px-6 py-6 sm:px-12 sm:py-8 space-y-6">
        <div className="space-y-1">
          <h1 className={SETTINGS_PAGE_TITLE_CLASS}>{t('settings.view.home.title')}</h1>
          <p className={SETTINGS_DESCRIPTION_CLASS}>{t('settings.view.home.description')}</p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => onOpen('providers')}
            className={cn(
              'rounded-lg border border-border bg-[var(--surface-elevated)] p-4 text-left',
              'hover:bg-[var(--interactive-hover)] transition-colors'
            )}
          >
            <div className="typography-ui-label text-foreground">{t('settings.view.home.cards.providers.title')}</div>
            <div className="typography-micro text-muted-foreground/70">{t('settings.view.home.cards.providers.description')}</div>
          </button>

          <button
            type="button"
            onClick={() => onOpen('agents')}
            className={cn(
              'rounded-lg border border-border bg-[var(--surface-elevated)] p-4 text-left',
              'hover:bg-[var(--interactive-hover)] transition-colors'
            )}
          >
            <div className="typography-ui-label text-foreground">{t('settings.view.home.cards.agents.title')}</div>
            <div className="typography-micro text-muted-foreground/70">{t('settings.view.home.cards.agents.description')}</div>
          </button>

          <button
            type="button"
            onClick={() => onOpen('skills.catalog')}
            className={cn(
              'rounded-lg border border-border bg-[var(--surface-elevated)] p-4 text-left',
              'hover:bg-[var(--interactive-hover)] transition-colors'
            )}
          >
            <div className="typography-ui-label text-foreground">{t('settings.view.home.cards.skillsCatalog.title')}</div>
            <div className="typography-micro text-muted-foreground/70">{t('settings.view.home.cards.skillsCatalog.description')}</div>
          </button>

          <button
            type="button"
            onClick={() => onOpen('mcp')}
            className={cn(
              'rounded-lg border border-border bg-[var(--surface-elevated)] p-4 text-left',
              'hover:bg-[var(--interactive-hover)] transition-colors'
            )}
          >
            <div className="typography-ui-label text-foreground">{t('settings.view.home.cards.mcp.title')}</div>
            <div className="typography-micro text-muted-foreground/70">{t('settings.view.home.cards.mcp.description')}</div>
          </button>

          <button
            type="button"
            onClick={() => onOpen('usage')}
            className={cn(
              'rounded-lg border border-border bg-[var(--surface-elevated)] p-4 text-left',
              'hover:bg-[var(--interactive-hover)] transition-colors'
            )}
          >
            <div className="typography-ui-label text-foreground">{t('settings.view.home.cards.usage.title')}</div>
            <div className="typography-micro text-muted-foreground/70">{t('settings.view.home.cards.usage.description')}</div>
          </button>
        </div>
      </div>
    </div>
  );
};

export const SettingsView: React.FC<SettingsViewProps> = ({ onClose, forceMobile, isWindowed, visiblePageSlugs, initialMobileStage = 'nav' }) => {
  const { t } = useI18n();
  const deviceInfo = useDeviceInfo();
  const isMobile = forceMobile ?? deviceInfo.isMobile;

  const settingsPageRaw = useUIStore((state) => state.settingsPage);
  const isSettingsDialogOpen = useUIStore((state) => state.isSettingsDialogOpen);
  const setSettingsPage = useUIStore((state) => state.setSettingsPage);
  const settingsSlug = resolveSettingsSlug(settingsPageRaw);

  const [mobileStage, setMobileStage] = React.useState<MobileStage>(initialMobileStage);
  const autoNavSlugRef = React.useRef<string | null>(null);

  const [settingsSearchQuery, setSettingsSearchQuery] = React.useState('');
  const [pendingSearchItemId, setPendingSearchItemId] = React.useState<string | null>(null);
  const [activeSearchResultIndex, setActiveSearchResultIndex] = React.useState(0);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const searchResultRefs = React.useRef<(HTMLButtonElement | null)[]>([]);
  const activeSearchResultIndexRef = React.useRef(0);
  const keyboardSearchNavigationRef = React.useRef(false);

  const isDesktopApp = React.useMemo(() => {
    return isDesktopShell();
  }, []);
  const isDesktopLocalOrigin = React.useMemo(() => {
    return isDesktopShell() && isDesktopLocalOriginActive();
  }, []);
  const isMac = React.useMemo(() => {
    return isDesktopShell() && typeof window !== 'undefined'
      && (window as unknown as { __OPENCHAMBER_PLATFORM__?: string }).__OPENCHAMBER_PLATFORM__ === 'darwin';
  }, []);
  const isWindows = React.useMemo(() => {
    return isDesktopShell() && typeof window !== 'undefined'
      && (window as unknown as { __OPENCHAMBER_PLATFORM__?: string }).__OPENCHAMBER_PLATFORM__ === 'win32';
  }, []);

  // keep platform check available for future window chrome tweaks

  const runtimeCtx = React.useMemo(() => buildRuntimeContext(isDesktopApp, isMobile), [isDesktopApp, isMobile]);

  const visiblePages = React.useMemo(() => {
    const allowedPages = visiblePageSlugs ? new Set<SettingsPageSlug>(visiblePageSlugs) : null;
    return SETTINGS_PAGE_METADATA
      .filter((page) => page.slug !== 'home')
      .filter((page) => !allowedPages || allowedPages.has(page.slug))
      .filter((page) => isPageAvailable(page, runtimeCtx))
      .filter((page) => !(runtimeCtx.isVSCode && page.slug === 'projects'))
      .filter((page) => !(isMobile && page.slug === 'shortcuts'));
  }, [runtimeCtx, isMobile, visiblePageSlugs]);

  const sortedFilteredPages = React.useMemo(() => {
    const rank = new Map<SettingsPageSlug, number>(pageOrder.map((s, i) => [s, i]));
    return visiblePages
      .slice()
      .sort((a, b) => (rank.get(a.slug) ?? 999) - (rank.get(b.slug) ?? 999));
  }, [visiblePages]);

  const activeProjectId = useProjectsStore((state) => state.activeProjectId);

  // Load stores when project changes or when a page becomes active.
  React.useEffect(() => {
    if (!isSettingsDialogOpen && !runtimeCtx.isVSCode && !isWindowed) {
      return;
    }

    if (settingsSlug === 'agents') {
      void useAgentsStore.getState().loadAgents();
      return;
    }
    if (settingsSlug === 'commands') {
      void useCommandsStore.getState().loadCommands();
      return;
    }
    if (settingsSlug === 'mcp') {
      void useMcpConfigStore.getState().loadMcpConfigs();
      return;
    }
    if (settingsSlug === 'plugins') {
      void usePluginsStore.getState().loadPlugins();
      return;
    }
    if (settingsSlug === 'skills.installed' || settingsSlug === 'skills.catalog') {
      void useSkillsStore.getState().loadSkills();
      void useSkillsCatalogStore.getState().loadCatalog();
    }
    if (settingsSlug === 'snippets') {
      void useSnippetsStore.getState().loadSnippets();
    }
  }, [activeProjectId, isSettingsDialogOpen, isWindowed, runtimeCtx.isVSCode, settingsSlug]);

  const openPage = React.useCallback((slug: SettingsPageSlug) => {
    setSettingsPage(slug);
    autoNavSlugRef.current = slug;
    if (!isMobile) {
      return;
    }
    const def = getSettingsPageMeta(slug);
    if (!def || def.slug === 'home') {
      setMobileStage('nav');
      return;
    }
    setMobileStage(def.kind === 'split' ? 'page-sidebar' : 'page-content');
  }, [isMobile, setSettingsPage]);

  const activePageMeta = React.useMemo(() => {
    return getSettingsPageMeta(settingsSlug);
  }, [settingsSlug]);

  // Nav is always open (collapsed state removed)

  const openChamberSectionBySlug: Partial<Record<SettingsPageSlug, OpenChamberSection>> = React.useMemo(() => ({
    appearance: 'visual',
    chat: 'chat',
    shortcuts: 'shortcuts',
    sessions: 'sessions',
    notifications: 'notifications',
    voice: 'voice',
    tunnel: 'tunnel',
  }), []);

  const getPageTitle = React.useCallback((slug: SettingsPageSlug): string => {
    switch (slug) {
      case 'projects':
        return t('settings.page.projects.title');
      case 'remote-instances':
        return t('settings.page.remoteInstances.title');
      case 'providers':
        return t('settings.page.providers.title');
      case 'usage':
        return t('settings.page.usage.title');
      case 'agents':
        return t('settings.page.agents.title');
      case 'behavior':
        return t('settings.page.behavior.title');
      case 'commands':
        return t('settings.page.commands.title');
      case 'mcp':
        return t('settings.page.mcp.title');
      case 'plugins':
        return t('settings.page.plugins.title');
      case 'skills.installed':
        return t('settings.page.skills.title');
      case 'skills.catalog':
        return t('settings.page.skillsCatalog.title');
      case 'git':
        return t('settings.page.git.title');
      case 'appearance':
        return t('settings.page.appearance.title');
      case 'chat':
        return t('settings.page.chat.title');
      case 'shortcuts':
        return t('settings.page.shortcuts.title');
      case 'sessions':
        return t('settings.page.sessions.title');
      case 'magic-prompts':
        return t('settings.page.magicPrompts.title');
      case 'snippets':
        return t('settings.page.snippets.title');
      case 'notifications':
        return t('settings.page.notifications.title');
      case 'voice':
        return t('settings.page.voice.title');
      case 'tunnel':
        return t('settings.page.tunnel.title');
      case 'about':
        return t('settings.page.about.title');
      case 'home':
      default:
        return t('settings.view.home.title');
    }
  }, [t]);

  const settingsSearchResults = React.useMemo(() => {
    return buildSettingsSearchResults({
      query: settingsSearchQuery,
      runtimeCtx: { ...runtimeCtx, isDesktopLocalOrigin, isMac, isWindows },
      visiblePageSlugs,
      t,
      getPageTitle,
    });
  }, [getPageTitle, isDesktopLocalOrigin, isMac, isWindows, runtimeCtx, settingsSearchQuery, t, visiblePageSlugs]);

  const prepareSettingsSearchTarget = React.useCallback((result: SettingsSearchResult): string => {
    if (result.id.startsWith('agents.')) {
      const store = useAgentsStore.getState();
      const name = nextUniqueName('new-agent', store.agents.map((agent) => agent.name));
      store.setAgentDraft({ name, scope: 'user' });
      store.setSelectedAgent(name);
      return result.id === 'agents.create' ? 'agents.name' : result.id;
    }

    if (result.id.startsWith('commands.')) {
      const store = useCommandsStore.getState();
      const name = nextUniqueName('new-command', store.commands.map((command) => command.name));
      store.setCommandDraft({ name, scope: 'user' });
      store.setSelectedCommand(name);
      return result.id === 'commands.create' ? 'commands.name' : result.id;
    }

    if (result.id.startsWith('mcp.')) {
      const store = useMcpConfigStore.getState();
      const name = nextUniqueName('new-mcp-server', store.mcpServers.map((server) => server.name));
      store.setMcpDraft({
        name,
        scope: 'user',
        type: 'local',
        command: [],
        url: '',
        environment: [],
        headers: [],
        oauthEnabled: true,
        oauthClientId: '',
        oauthClientSecret: '',
        oauthScope: '',
        oauthRedirectUri: '',
        timeout: '',
        enabled: true,
      });
      store.setSelectedMcp(name);
      return result.id === 'mcp.create' ? 'mcp.server' : result.id;
    }

    if (result.id.startsWith('snippets.')) {
      const store = useSnippetsStore.getState();
      const name = nextUniqueName('new-snippet', store.snippets.map((snippet) => snippet.name));
      store.setSnippetDraft({ name, scope: 'global' });
      store.setSelectedSnippet(name);
      return result.id === 'snippets.create' ? 'snippets.content' : result.id;
    }

    if (result.id.startsWith('skills.')) {
      const store = useSkillsStore.getState();
      const name = nextUniqueName('new-skill', store.skills.map((skill) => skill.name));
      store.setSkillDraft({ name, scope: 'user', source: 'opencode', description: '', instructions: '' });
      store.setSelectedSkill(name);
      return result.id === 'skills.create' ? 'skills.basic-information' : result.id;
    }

    if (result.id === 'providers.connect') {
      useConfigStore.getState().setSelectedProvider(ADD_PROVIDER_SETTINGS_ID);
    }

    if (result.id === 'plugins.create') {
      return 'plugins.spec';
    }

    return result.id;
  }, []);

  const groupedSettingsSearchResults = React.useMemo(() => {
    const groups: Array<{ page: SettingsPageSlug; pageTitle: string; results: SettingsSearchResult[] }> = [];
    const groupByPage = new Map<SettingsPageSlug, { page: SettingsPageSlug; pageTitle: string; results: SettingsSearchResult[] }>();
    for (const result of settingsSearchResults) {
      let group = groupByPage.get(result.page);
      if (!group) {
        group = { page: result.page, pageTitle: result.pageTitle, results: [] };
        groupByPage.set(result.page, group);
        groups.push(group);
      }
      group.results.push(result);
    }
    return groups;
  }, [settingsSearchResults]);

  React.useEffect(() => {
    setActiveSearchResultIndex(0);
    activeSearchResultIndexRef.current = 0;
    keyboardSearchNavigationRef.current = false;
  }, [settingsSearchQuery]);

  React.useEffect(() => {
    activeSearchResultIndexRef.current = activeSearchResultIndex;
  }, [activeSearchResultIndex]);

  React.useEffect(() => {
    searchResultRefs.current[activeSearchResultIndex]?.scrollIntoView({ block: 'nearest' });
  }, [activeSearchResultIndex]);

  React.useEffect(() => {
    if (activeSearchResultIndex >= settingsSearchResults.length) {
      setActiveSearchResultIndex(Math.max(0, settingsSearchResults.length - 1));
    }
    searchResultRefs.current.length = settingsSearchResults.length;
  }, [activeSearchResultIndex, settingsSearchResults.length]);

  const openSearchResult = React.useCallback((result: SettingsSearchResult) => {
    const targetId = prepareSettingsSearchTarget(result);
    setPendingSearchItemId(targetId);
    openPage(result.page);
    if (isMobile) {
      setMobileStage('page-content');
    }
    if (result.id === 'plugins.create' && typeof window !== 'undefined') {
      window.setTimeout(() => {
        window.dispatchEvent(new CustomEvent('openchamber:settings-open-plugin-add'));
      }, 50);
    }
  }, [isMobile, openPage, prepareSettingsSearchTarget]);

  const handleSettingsSearchKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    if (!settingsSearchQuery.trim()) {
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      setSettingsSearchQuery('');
      return;
    }

    if (settingsSearchResults.length === 0) {
      return;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      keyboardSearchNavigationRef.current = true;
      setActiveSearchResultIndex((current) => (current + 1) % settingsSearchResults.length);
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      keyboardSearchNavigationRef.current = true;
      setActiveSearchResultIndex((current) => (current - 1 + settingsSearchResults.length) % settingsSearchResults.length);
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      const safeIndex = ((activeSearchResultIndexRef.current % settingsSearchResults.length) + settingsSearchResults.length) % settingsSearchResults.length;
      const result = settingsSearchResults[safeIndex] ?? settingsSearchResults[0];
      if (result) {
        openSearchResult(result);
      }
    }
  }, [openSearchResult, settingsSearchQuery, settingsSearchResults]);

  React.useEffect(() => {
    const targetId = pendingSearchItemId;
    if (!targetId) {
      return;
    }

    let cancelled = false;
    const frame = window.requestAnimationFrame(() => {
      if (cancelled) {
        return;
      }
      const escapedId = typeof CSS !== 'undefined' && CSS.escape
        ? CSS.escape(targetId)
        : targetId.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
      const target = containerRef.current?.querySelector<HTMLElement>(`[data-settings-item="${escapedId}"]`);
      if (!target) {
        return;
      }
      setPendingSearchItemId(null);
      target.scrollIntoView({ block: 'center', behavior: 'smooth' });
      target.setAttribute('data-settings-search-highlight', 'true');
      window.setTimeout(() => {
        target.removeAttribute('data-settings-search-highlight');
      }, 1600);
    });

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
    };
  }, [pendingSearchItemId, settingsSlug]);

  const renderUnavailable = React.useCallback(() => {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <div className="max-w-md text-center">
          <div className={SETTINGS_SECTION_TITLE_CLASS}>{t('settings.view.unavailable.title')}</div>
          <p className="typography-ui text-muted-foreground mt-1">{t('settings.view.unavailable.description')}</p>
        </div>
      </div>
    );
  }, [t]);

  const renderPageSidebar = React.useCallback((slug: SettingsPageSlug, opts: { onItemSelect?: () => void }) => {
    switch (slug) {
      case 'projects':
        return <ProjectsSidebar onItemSelect={opts.onItemSelect} />;
      case 'agents':
        return <AgentsSidebar onItemSelect={opts.onItemSelect} />;
      case 'commands':
        return <CommandsSidebar onItemSelect={opts.onItemSelect} />;
      case 'mcp':
        return <McpSidebar onItemSelect={opts.onItemSelect} />;
      case 'plugins':
        return <PluginsSidebar onItemSelect={opts.onItemSelect} />;
      case 'skills.installed':
        return <SkillsSidebar onItemSelect={opts.onItemSelect} />;
      case 'providers':
        return <ProvidersSidebar onItemSelect={opts.onItemSelect} />;
      case 'usage':
        return <UsageSidebar onItemSelect={opts.onItemSelect} />;
      case 'magic-prompts':
        return <MagicPromptsSidebar onItemSelect={opts.onItemSelect} />;
      case 'snippets':
        return <SnippetsSidebar onItemSelect={opts.onItemSelect} />;
      default:
        return null;
    }
  }, []);

  const renderPageContent = React.useCallback((slug: SettingsPageSlug) => {
    const meta = getSettingsPageMeta(slug);
    if (meta && !isPageAvailable(meta, runtimeCtx)) {
      return renderUnavailable();
    }

    switch (slug) {
      case 'home':
        return <SettingsHome onOpen={openPage} />;
      case 'projects':
        return <ProjectsPage />;
      case 'remote-instances':
        return <RemoteInstancesPage />;
      case 'agents':
        return <AgentsPage />;
      case 'behavior':
        return <BehaviorPage />;
      case 'commands':
        return <CommandsPage />;
      case 'mcp':
        return <McpPage />;
      case 'plugins':
        return <PluginsPage />;
      case 'skills.installed':
        return <SkillsPage view="installed" />;
      case 'skills.catalog':
        return <SkillsPage view="catalog" />;
      case 'providers':
        return <ProvidersPage />;
      case 'usage':
        return <UsagePage />;
      case 'about':
        return (
          <SettingsPageLayout title={t('settings.page.about.title')} showSaveStatus={false}>
            <AboutSettings />
          </SettingsPageLayout>
        );
      case 'magic-prompts':
        return <MagicPromptsPage />;
      case 'snippets':
        return <SnippetsPage />;
      case 'git':
        return <GitPage />;
      case 'appearance':
      case 'chat':
      case 'shortcuts':
      case 'sessions':
      case 'notifications':
      case 'voice':
      case 'tunnel': {
        const section = openChamberSectionBySlug[slug] ?? 'visual';
        return <OpenChamberPage section={section} />;
      }
      default:
        return <SettingsHome onOpen={openPage} />;
    }
  }, [openChamberSectionBySlug, openPage, renderUnavailable, runtimeCtx, t]);

  // Mobile: if opened via deep-link / palette to a non-home page, jump into it once.
  React.useEffect(() => {
    if (!isMobile) {
      return;
    }
    if (mobileStage !== 'nav') {
      return;
    }
    if (settingsSlug === 'home') {
      return;
    }
    if (autoNavSlugRef.current === settingsSlug) {
      return;
    }
    const def = getSettingsPageMeta(settingsSlug);
    if (!def || def.slug === 'home') {
      return;
    }
    autoNavSlugRef.current = settingsSlug;
    setMobileStage(def.kind === 'split' ? 'page-sidebar' : 'page-content');
  }, [isMobile, mobileStage, settingsSlug]);

  const showBackButton = isMobile && mobileStage !== 'nav';
  const backButtonTargetsPageSidebar = isMobile && mobileStage === 'page-content' && settingsSlug === 'skills.installed';
  const showOpenPageSidebarButton = mobileStage === 'page-content'
    && activePageMeta?.kind === 'split'
    && !backButtonTargetsPageSidebar;
  const mobileBackButtonLabel = backButtonTargetsPageSidebar
    ? t('settings.view.actions.back')
    : showBackButton
      ? t('settings.view.actions.backToSettings')
      : t('settings.view.actions.closeSettings');
  const shortcutKey = getModifierLabel();

  const pushMobileSplitDetailHistory = React.useCallback((slug: SettingsPageSlug) => {
    if (typeof window === 'undefined' || runtimeCtx.isVSCode) {
      return;
    }

    const currentDetail = getSettingsDetailHistoryEntry(window.history.state);
    if (currentDetail?.page === slug && currentDetail.stage === 'page-content') {
      return;
    }

    window.history.pushState(
      {
        ...getCurrentHistoryState(),
        [SETTINGS_DETAIL_HISTORY_KEY]: { page: slug, stage: 'page-content' },
      },
      '',
      window.location.href,
    );
  }, [runtimeCtx.isVSCode]);

  const handleMobilePageSidebarItemSelect = React.useCallback(() => {
    setMobileStage('page-content');
    if (settingsSlug === 'skills.installed') {
      pushMobileSplitDetailHistory(settingsSlug);
    }
  }, [pushMobileSplitDetailHistory, settingsSlug]);

  const handleBack = React.useCallback(() => {
    if (backButtonTargetsPageSidebar) {
      const currentDetail = typeof window !== 'undefined'
        ? getSettingsDetailHistoryEntry(window.history.state)
        : null;
      if (currentDetail?.page === settingsSlug && !runtimeCtx.isVSCode) {
        window.history.back();
        return;
      }
      setMobileStage('page-sidebar');
      return;
    }

    setMobileStage('nav');
  }, [backButtonTargetsPageSidebar, runtimeCtx.isVSCode, settingsSlug]);

  React.useEffect(() => {
    if (!isMobile || runtimeCtx.isVSCode) {
      return;
    }

    const handlePopState = (event: PopStateEvent) => {
      if (settingsSlug !== 'skills.installed') {
        return;
      }

      const detail = getSettingsDetailHistoryEntry(event.state);
      if (detail?.page === 'skills.installed') {
        setMobileStage('page-content');
        return;
      }

      setMobileStage((stage) => stage === 'page-content' ? 'page-sidebar' : stage);
    };

    window.addEventListener('popstate', handlePopState);
    return () => {
      window.removeEventListener('popstate', handlePopState);
    };
  }, [isMobile, runtimeCtx.isVSCode, settingsSlug]);

  const handleOpenPageSidebar = React.useCallback(() => {
    setMobileStage('page-sidebar');
  }, []);

  const renderSettingsNav = () => {
    const hasSearchQuery = settingsSearchQuery.trim().length > 0;

    return (
      <div className="flex h-full flex-col overflow-hidden">
        <div className="px-2 pt-3">
          <div className="flex h-10 items-center gap-1.5 rounded-md border border-border bg-background/70 px-2 text-muted-foreground focus-within:ring-2 focus-within:ring-primary/40 sm:h-8">
            <Icon name="search" className="h-4 w-4 shrink-0" />
            <input
              value={settingsSearchQuery}
              onChange={(event) => setSettingsSearchQuery(event.target.value)}
              onKeyDown={handleSettingsSearchKeyDown}
              placeholder={t('settings.view.search.placeholder')}
              aria-label={t('settings.view.search.aria')}
              className="typography-ui min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground/70"
            />
            {hasSearchQuery && (
              <button
                type="button"
                onClick={() => setSettingsSearchQuery('')}
                aria-label={t('settings.view.search.clear')}
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-interactive-hover hover:text-foreground sm:h-5 sm:w-5"
              >
                <Icon name="close" className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* Scrollable nav items */}
        <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
          <div className="flex flex-col gap-0.5 pt-4 pb-2 px-2">
            {hasSearchQuery ? (
              settingsSearchResults.length > 0 ? (() => {
                let resultIndex = 0;
                return groupedSettingsSearchResults.map((group) => (
                  <div key={group.page} className="space-y-0.5">
                    <div className="px-2 pb-0.5 pt-2 typography-micro font-medium text-muted-foreground/70">
                      {group.pageTitle}
                    </div>
                    {group.results.map((result) => {
                      const currentIndex = resultIndex;
                      resultIndex += 1;
                      const active = currentIndex === activeSearchResultIndex;
                      const hasDescription = Boolean(result.description);
                      return (
                        <button
                          key={result.id}
                          type="button"
                          ref={(element) => {
                            searchResultRefs.current[currentIndex] = element;
                          }}
                          onMouseMove={() => {
                            keyboardSearchNavigationRef.current = false;
                            setActiveSearchResultIndex(currentIndex);
                          }}
                          onClick={() => openSearchResult(result)}
                          className={cn(
                            'flex w-full flex-col rounded-md px-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
                            hasDescription ? 'min-h-11 py-1.5' : 'py-2',
                            active ? 'bg-interactive-selection' : 'hover:bg-interactive-hover'
                          )}
                        >
                          <span className="typography-ui-label text-foreground truncate">{result.title}</span>
                          {hasDescription && (
                            <span className="typography-micro text-muted-foreground/70 line-clamp-2">{result.description}</span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                ));
              })() : (
                <div className="px-2 py-6 text-center typography-ui text-muted-foreground">
                  {t('settings.view.search.noResults')}
                </div>
              )
            ) : (() => {
              const pagesByGroup = new Map<string, typeof sortedFilteredPages>();
              for (const page of sortedFilteredPages) {
                const group = page.group;
                const existing = pagesByGroup.get(group);
                if (existing) {
                  existing.push(page);
                } else {
                  pagesByGroup.set(group, [page]);
                }
              }

              const visibleGroups = NAV_GROUP_ORDER
                .map((group) => ({ group, pages: pagesByGroup.get(group) ?? [] }))
                .filter((entry) => entry.pages.length > 0);

              return visibleGroups.map(({ group, pages }, groupIndex) => (
                <div key={group} className="space-y-0.5">
                  <div
                    className={cn(
                      'px-2 pb-0.5 typography-micro font-medium text-muted-foreground/70',
                      groupIndex === 0 ? 'pt-1' : 'pt-3',
                    )}
                  >
                    {t(`settings.view.nav.group.${group}`)}
                  </div>
                  {pages.map((page) => {
                    const selected = settingsSlug === page.slug;
                    const iconName = getSettingsNavIcon(page.slug);
                    if (!iconName && page.slug !== 'mcp') return null;

                    return (
                      <Tooltip key={page.slug}>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            onClick={() => openPage(page.slug)}
                            aria-current={selected ? 'page' : undefined}
                            className={cn(
                              'flex h-8 items-center gap-2 rounded-md px-2 overflow-hidden',
                              selected
                                ? 'bg-interactive-selection text-foreground'
                                : 'text-foreground hover:bg-interactive-hover'
                            )}
                          >
                            {page.slug === 'mcp'
                              ? <McpIcon className="h-4 w-4 shrink-0" />
                              : <Icon name={iconName!} className="h-4 w-4 shrink-0" />}
                            <span className="flex items-center gap-1.5 whitespace-nowrap overflow-hidden transition-opacity duration-150 opacity-100">
                              <span className="typography-ui-label font-normal truncate">{getPageTitle(page.slug)}</span>
                              {page.slug === 'tunnel' && (
                                <span className="shrink-0 typography-micro px-1 rounded leading-none pb-px text-[var(--status-warning)] bg-[var(--status-warning)]/10">
                                  {t('settings.view.badge.beta')}
                                </span>
                              )}
                            </span>
                          </button>
                        </TooltipTrigger>
                      </Tooltip>
                    );
                  })}
                </div>
              ));
            })()}
          </div>
        </div>

        {/* Footer */}
        <div className="overflow-hidden transition-opacity duration-150 opacity-100">
          <div className="border-t border-border bg-sidebar px-2 py-1 space-y-0.5">
            {!runtimeCtx.isVSCode && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className={cn(
                      'flex h-7 w-full items-center gap-2 rounded-md px-2 overflow-hidden whitespace-nowrap',
                      'text-sm font-semibold text-sidebar-foreground/90',
                      'hover:text-sidebar-foreground hover:bg-interactive-hover',
                    )}
                    onClick={() => void reloadOpenCodeConfiguration({ message: 'Restarting OpenCode…', mode: 'projects', scopes: ['all'] }).catch(() => undefined)}
                  >
                    <Icon name="restart" className="h-4 w-4 shrink-0" />
                    <span>{t('settings.view.actions.reloadOpenCode')}</span>
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  {t('settings.view.actions.reloadOpenCodeTooltip')}
                </TooltipContent>
              </Tooltip>
            )}

          </div>
        </div>
      </div>
    );
  };

  const renderMobileStage = () => {
    if (mobileStage === 'nav') {
      return (
        <div className={cn('flex-1 min-h-0 overflow-hidden', runtimeCtx.isVSCode ? 'bg-background' : 'bg-sidebar')}>
          <div className="flex h-full min-h-0 flex-col">
            <ErrorBoundary>{renderSettingsNav()}</ErrorBoundary>
          </div>
        </div>
      );
    }

    if (!activePageMeta) {
      return <div className="flex-1 bg-background" />;
    }

    if (mobileStage === 'page-sidebar') {
      if (activePageMeta.kind !== 'split') {
        // No sidebar available; fall back to direct content.
        const fallback = renderPageContent(settingsSlug);
        return (
          <div className="flex-1 min-h-0 overflow-hidden bg-background">
            <ErrorBoundary>{fallback}</ErrorBoundary>
          </div>
        );
      }
      return (
        <div className={cn('flex-1 min-h-0 overflow-hidden', runtimeCtx.isVSCode ? 'bg-background' : 'bg-sidebar')}>
          <ErrorBoundary>
            {renderPageSidebar(settingsSlug, { onItemSelect: handleMobilePageSidebarItemSelect })}
          </ErrorBoundary>
        </div>
      );
    }

    // page-content
    const content = renderPageContent(settingsSlug);

    return (
      <div className="flex-1 min-h-0 overflow-hidden bg-background">
        <ErrorBoundary>{content}</ErrorBoundary>
      </div>
    );
  };

  const renderDesktopContent = () => {
    if (!activePageMeta || settingsSlug === 'home') {
      return <SettingsHome onOpen={openPage} />;
    }

    if (activePageMeta.kind === 'split') {
      return (
        <div className="flex h-full min-h-0 overflow-hidden">
          <div className={cn('border-r', runtimeCtx.isVSCode ? 'bg-background' : 'bg-sidebar')} style={{ width: SETTINGS_SPLIT_SIDEBAR_WIDTH, minWidth: SETTINGS_SPLIT_SIDEBAR_WIDTH, borderColor: 'var(--interactive-border)' }}>
            <ErrorBoundary>{renderPageSidebar(settingsSlug, {})}</ErrorBoundary>
          </div>
          <div className="flex-1 min-h-0 overflow-hidden bg-background">
            <ErrorBoundary>{renderPageContent(settingsSlug)}</ErrorBoundary>
          </div>
        </div>
      );
    }

    return (
      <div className="h-full min-h-0 overflow-hidden bg-background">
        <ErrorBoundary>{renderPageContent(settingsSlug)}</ErrorBoundary>
      </div>
    );
  };

  return (
    <div ref={containerRef} data-settings-view="true" className={cn('relative flex h-full min-h-0 flex-col overflow-hidden bg-background')}>
      {isMobile ? (
        <div
          className={cn(
            'flex h-[var(--oc-header-height,56px)] shrink-0 items-center gap-2 border-b px-3',
            'bg-background'
          )}
          style={{ borderColor: 'var(--interactive-border)' }}
        >
          {(showBackButton || onClose) ? (
            <button
              type="button"
              onClick={showBackButton ? handleBack : onClose}
              aria-label={mobileBackButtonLabel}
              className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg p-2 text-muted-foreground hover:text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <Icon name="arrow-left-s" className="h-5 w-5" />
            </button>
          ) : null}

          <div className="min-w-0 flex-1 px-2 typography-ui-label font-medium text-foreground truncate">
            {mobileStage === 'nav'
              ? t('settings.view.home.title')
              : (activePageMeta ? getPageTitle(activePageMeta.slug) : t('settings.view.home.title'))}
          </div>

          {showOpenPageSidebarButton && (
            <button
              type="button"
              onClick={handleOpenPageSidebar}
              aria-label={t('settings.view.actions.openSectionList')}
              className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg p-2 text-muted-foreground hover:text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <Icon name="list-unordered" className="h-5 w-5" />
            </button>
          )}

          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label={t('settings.view.actions.closeSettings')}
              title={t('settings.view.actions.closeSettingsWithShortcut', { shortcut: shortcutKey })}
              className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg p-2 text-muted-foreground hover:text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <Icon name="close" className="h-5 w-5" />
            </button>
          )}
        </div>
      ) : (
        <>
          {showBackButton && (
            <div className={cn('absolute left-3 z-50', isWindowed ? 'top-2' : 'top-3')}>
              <button
                type="button"
                onClick={handleBack}
                aria-label={t('settings.view.actions.back')}
                className="inline-flex h-9 w-9 items-center justify-center rounded-lg p-2 text-muted-foreground hover:text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                <Icon name="arrow-left-s" className="h-5 w-5" />
              </button>
            </div>
          )}

      {onClose && (
        <div className={cn('absolute right-0.5 z-50', isWindowed ? 'top-0.5' : 'top-1')}>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('settings.view.actions.closeSettings')}
            title={t('settings.view.actions.closeSettingsWithShortcut', { shortcut: shortcutKey })}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md p-0.5 text-muted-foreground hover:text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <Icon name="close" className="h-5 w-5" />
          </button>
        </div>
      )}
        </>
      )}

      <div className="flex flex-1 min-h-0 overflow-hidden">
        {isMobile ? (
          renderMobileStage()
        ) : (
          <>
            <div
              className={cn(
                'relative flex h-full min-h-0 flex-col overflow-hidden border-r',
                isDesktopApp
                  ? 'bg-sidebar'
                  : runtimeCtx.isVSCode
                    ? 'bg-background'
                    : 'bg-sidebar',
              )}
              style={{
                width: `${SETTINGS_NAV_WIDTH}px`,
                minWidth: `${SETTINGS_NAV_WIDTH}px`,
                borderColor: 'var(--interactive-border)',
              }}
            >
              <ErrorBoundary>
                {renderSettingsNav()}
              </ErrorBoundary>
            </div>

            <div className="flex-1 overflow-hidden bg-background">
              {renderDesktopContent()}
            </div>
          </>
        )}
      </div>
    </div>
  );
};
