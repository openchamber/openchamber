import React from 'react';
import { cn, getModifierLabel } from '@/lib/utils';
import { SIDEBAR_SECTIONS } from '@/constants/sidebar';
import type { SidebarSection } from '@/constants/sidebar';
import { useUIStore } from '@/stores/useUIStore';
import { RiArrowDownSLine, RiArrowLeftSLine, RiCloseLine, RiFolderLine } from '@remixicon/react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useAgentsStore } from '@/stores/useAgentsStore';
import { useCommandsStore } from '@/stores/useCommandsStore';
import { useSkillsStore } from '@/stores/useSkillsStore';
import { useSkillsCatalogStore } from '@/stores/useSkillsCatalogStore';
import { useMcpConfigStore } from '@/stores/useMcpConfigStore';
import { AgentsSidebar } from '@/components/sections/agents/AgentsSidebar';
import { AgentsPage } from '@/components/sections/agents/AgentsPage';
import { CommandsSidebar } from '@/components/sections/commands/CommandsSidebar';
import { CommandsPage } from '@/components/sections/commands/CommandsPage';
import { SkillsSidebar } from '@/components/sections/skills/SkillsSidebar';
import { SkillsPage } from '@/components/sections/skills/SkillsPage';
import { McpSidebar } from '@/components/sections/mcp/McpSidebar';
import { McpPage } from '@/components/sections/mcp/McpPage';
import { ProvidersSidebar } from '@/components/sections/providers/ProvidersSidebar';
import { ProvidersPage } from '@/components/sections/providers/ProvidersPage';
import { UsageSidebar } from '@/components/sections/usage/UsageSidebar';
import { UsagePage } from '@/components/sections/usage/UsagePage';
import { GitIdentitiesSidebar } from '@/components/sections/git-identities/GitIdentitiesSidebar';
import { GitIdentitiesPage } from '@/components/sections/git-identities/GitIdentitiesPage';
import { OpenChamberPage } from '@/components/sections/openchamber/OpenChamberPage';
import { OpenChamberSidebar, type OpenChamberSection } from '@/components/sections/openchamber/OpenChamberSidebar';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { useDeviceInfo } from '@/lib/device';
import { isVSCodeRuntime } from '@/lib/desktop';

const getSettingsSections = (isVSCode: boolean) => {
  let filtered = SIDEBAR_SECTIONS.filter(section => section.id !== 'sessions');
  // Hide Git Identities tab for VS Code
  if (isVSCode) {
    filtered = filtered.filter(section => section.id !== 'git-identities');
  }
  const settingsSection = filtered.find(s => s.id === 'settings');
  const otherSections = filtered.filter(s => s.id !== 'settings');
  return settingsSection ? [settingsSection, ...otherSections] : filtered;
};

// Same constraints as main sidebar
const SETTINGS_SIDEBAR_MIN_WIDTH = 200;
const SETTINGS_SIDEBAR_MAX_WIDTH = 500;
const SETTINGS_SIDEBAR_DEFAULT_WIDTH = 264;

// Width threshold for hiding tab labels (show icons only)
const TAB_LABELS_MIN_WIDTH = 1024;

interface SettingsViewProps {
  onClose?: () => void;
  /** Force mobile layout regardless of device detection */
  forceMobile?: boolean;
  /** Rendered inside a window/dialog (skip traffic light padding) */
  isWindowed?: boolean;
}

export const SettingsView: React.FC<SettingsViewProps> = ({ onClose, forceMobile, isWindowed }) => {
  const deviceInfo = useDeviceInfo();
  const isMobile = forceMobile ?? deviceInfo.isMobile;

  // Sync activeTab with store's sidebarSection for routing support
  const storeSidebarSection = useUIStore((state) => state.sidebarSection);
  const setSidebarSection = useUIStore((state) => state.setSidebarSection);

  // Use store's sidebarSection as the source of truth, but filter to valid settings sections
  const activeTab = React.useMemo<SidebarSection>(() => {
    // If store has a valid settings section (not 'sessions'), use it
    if (storeSidebarSection !== 'sessions') {
      return storeSidebarSection;
    }
    // Default to 'settings' if store has 'sessions'
    return 'settings';
  }, [storeSidebarSection]);

  // Update store when tab changes
  const setActiveTab = React.useCallback((tab: SidebarSection) => {
    setSidebarSection(tab);
  }, [setSidebarSection]);
  const [selectedOpenChamberSection, setSelectedOpenChamberSection] = React.useState<OpenChamberSection>('visual');
  // Mobile drill-down state: show page content instead of sidebar
  const [showMobilePageContent, setShowMobilePageContent] = React.useState(false);
  const [sidebarWidth, setSidebarWidth] = React.useState(() => {
    // Use proportional width like main sidebar (20% of window)
    if (typeof window !== 'undefined') {
      return Math.min(
        SETTINGS_SIDEBAR_MAX_WIDTH,
        Math.max(SETTINGS_SIDEBAR_MIN_WIDTH, Math.floor(window.innerWidth * 0.2))
      );
    }
    return SETTINGS_SIDEBAR_DEFAULT_WIDTH;
  });
  const [hasManuallyResized, setHasManuallyResized] = React.useState(false);
  const [isResizing, setIsResizing] = React.useState(false);
  const [containerWidth, setContainerWidth] = React.useState(0);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const startXRef = React.useRef(0);
  const startWidthRef = React.useRef(sidebarWidth);

  const isTauri = React.useMemo(() => {
    if (typeof window === 'undefined') return false;
    return Boolean((window as unknown as { __TAURI__?: unknown }).__TAURI__);
  }, []);

  const isMacPlatform = React.useMemo(() => {
    if (typeof navigator === 'undefined') return false;
    return /Macintosh|Mac OS X/.test(navigator.userAgent || '');
  }, []);

  const isVSCode = React.useMemo(() => isVSCodeRuntime(), []);

  const settingsSections = React.useMemo(() => getSettingsSections(isVSCode), [isVSCode]);

  const isDesktopApp = isTauri;

  // Track container width for responsive tab labels
  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
      }
    });

    observer.observe(container);
    setContainerWidth(container.clientWidth);

    return () => observer.disconnect();
  }, []);

  const projects = useProjectsStore((state) => state.projects);
  const activeProjectId = useProjectsStore((state) => state.activeProjectId);
  const setActiveProject = useProjectsStore((state) => state.setActiveProject);

  const sortedProjects = React.useMemo(() => {
    return [...projects].sort((a, b) => (a.label || a.path).localeCompare(b.label || b.path));
  }, [projects]);

  const activeProject = React.useMemo(() => {
    if (sortedProjects.length === 0) {
      return null;
    }
    return sortedProjects.find((p) => p.id === activeProjectId) ?? sortedProjects[0];
  }, [activeProjectId, sortedProjects]);

  // Format project label: kebab-case/snake_case → Title Case
  const formatProjectLabel = React.useCallback((label: string): string => {
    return label
      .replace(/[-_]/g, ' ')
      .replace(/\b\w/g, (char) => char.toUpperCase());
  }, []);

  const activeProjectLabel = React.useMemo(() => {
    if (!activeProject) {
      return 'Project';
    }
    const rawLabel = activeProject.label && activeProject.label.trim().length > 0
      ? activeProject.label
      : (activeProject.path.split('/').filter(Boolean).pop() || activeProject.path);
    return formatProjectLabel(rawLabel);
  }, [activeProject, formatProjectLabel]);

  const showProjectSwitcher = sortedProjects.length > 0 && !isVSCode;

  const showTabLabels = containerWidth === 0 || containerWidth >= TAB_LABELS_MIN_WIDTH;

  React.useEffect(() => {
    // Force reload when activeProject changes to ensure scopes update
    if (activeTab === 'agents') {
      // Small delay to allow store state to propagate if needed
      setTimeout(() => void useAgentsStore.getState().loadAgents(), 0);
      return;
    }

    if (activeTab === 'commands') {
      setTimeout(() => void useCommandsStore.getState().loadCommands(), 0);
      return;
    }

    if (activeTab === 'skills') {
      void useSkillsStore.getState().loadSkills();
      void useSkillsCatalogStore.getState().loadCatalog();
    }

    if (activeTab === 'mcp') {
      void useMcpConfigStore.getState().loadMcpConfigs();
    }
  }, [activeProjectId, activeTab]);

  // Update proportional width on window resize (if not manually resized)
  React.useEffect(() => {
    if (typeof window === 'undefined') return;

    const handleResize = () => {
      if (!hasManuallyResized) {
        const proportionalWidth = Math.min(
          SETTINGS_SIDEBAR_MAX_WIDTH,
          Math.max(SETTINGS_SIDEBAR_MIN_WIDTH, Math.floor(window.innerWidth * 0.2))
        );
        setSidebarWidth(proportionalWidth);
      }
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [hasManuallyResized]);

  // Resize handling
  React.useEffect(() => {
    if (!isResizing) return;

    const handlePointerMove = (event: PointerEvent) => {
      const delta = event.clientX - startXRef.current;
      const nextWidth = Math.min(
        SETTINGS_SIDEBAR_MAX_WIDTH,
        Math.max(SETTINGS_SIDEBAR_MIN_WIDTH, startWidthRef.current + delta)
      );
      setSidebarWidth(nextWidth);
      setHasManuallyResized(true);
    };

    const handlePointerUp = () => setIsResizing(false);

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp, { once: true });

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [isResizing]);

  const handlePointerDown = (event: React.PointerEvent) => {
    setIsResizing(true);
    startXRef.current = event.clientX;
    startWidthRef.current = sidebarWidth;
    event.preventDefault();
  };

  // Draggable header for Tauri desktop
  const handleDragStart = React.useCallback(async (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button, a, input, select, textarea')) return;
    if (e.button !== 0) return;

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

  // Active tab can be dragged (like main header)
  const handleActiveTabDragStart = React.useCallback(async (e: React.MouseEvent) => {
    if (e.button !== 0) return;

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

  const handleTabChange = React.useCallback((tab: SidebarSection) => {
    setActiveTab(tab);
    // Reset mobile drill-down state when changing tabs
    setShowMobilePageContent(false);
  }, [setActiveTab]);

  // Handle mobile sidebar item selection (drill-down to page)
  const handleMobileSidebarClick = React.useCallback(() => {
    if (isMobile) {
      setShowMobilePageContent(true);
    }
  }, [isMobile]);

  const renderSidebarContent = () => {
    switch (activeTab) {
      case 'settings':
        return (
          <div className="h-full">
            <OpenChamberSidebar
              selectedSection={selectedOpenChamberSection}
              onSelectSection={(section) => {
                setSelectedOpenChamberSection(section);
                handleMobileSidebarClick();
              }}
            />
          </div>
        );
      case 'agents':
        return <AgentsSidebar onItemSelect={handleMobileSidebarClick} />;
      case 'commands':
        return <CommandsSidebar onItemSelect={handleMobileSidebarClick} />;
      case 'skills':
        return <SkillsSidebar onItemSelect={handleMobileSidebarClick} />;
      case 'mcp':
        return <McpSidebar onItemSelect={handleMobileSidebarClick} />;
      case 'providers':
        return <ProvidersSidebar onItemSelect={handleMobileSidebarClick} />;
      case 'usage':
        return <UsageSidebar onItemSelect={handleMobileSidebarClick} />;
      case 'git-identities':
        return <GitIdentitiesSidebar onItemSelect={handleMobileSidebarClick} />;
      default:
        return null;
    }
  };

  const hasSidebar = true; // All tabs now have sidebars

  const renderPageContent = () => {
    switch (activeTab) {
      case 'agents':
        return <AgentsPage />;
      case 'commands':
        return <CommandsPage />;
      case 'skills':
        return <SkillsPage />;
      case 'mcp':
        return <McpPage />;
      case 'providers':
        return <ProvidersPage />;
      case 'usage':
        return <UsagePage />;
      case 'git-identities':
        return <GitIdentitiesPage />;
      case 'settings':
        return <OpenChamberPage section={selectedOpenChamberSection} />;
      default:
        return null;
    }
  };

  // Keyboard shortcut display based on platform
  const shortcutKey = getModifierLabel();

  // Desktop padding for Mac titlebar area (only when full-screen, not windowed)
  const desktopPaddingClass = React.useMemo(() => {
    if (isWindowed) {
      return 'pl-1.5'; // Balanced padding for windowed mode
    }
    if (isDesktopApp && isMacPlatform) {
      return 'pl-[5.75rem]'; // Space for traffic lights
    }
    return '';
  }, [isDesktopApp, isMacPlatform, isWindowed]);


  return (
    <div ref={containerRef} data-settings-view="true" className={cn('flex h-full flex-col overflow-hidden bg-background')}>
      {/* Header with tabs and close button */}
      <div
        onMouseDown={!isMobile ? handleDragStart : undefined}
        className={cn(
          'flex select-none items-center justify-between border-b',
          isMobile ? 'h-auto px-3 py-2' : 'app-region-drag h-12',
          !isMobile && desktopPaddingClass,
          isDesktopApp ? 'bg-background' : 'bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80'
        )}
        style={{ borderColor: 'var(--interactive-border)' }}
      >
        {/* Mobile: back button when drilling down */}
        {isMobile && showMobilePageContent && (
          <button
            type="button"
            onClick={() => setShowMobilePageContent(false)}
            aria-label="Back"
            className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center p-2 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <RiArrowLeftSLine className="h-5 w-5" />
          </button>
        )}

        {/* Mobile: spacer to push tabs to the right */}
        {isMobile && <div className="flex-1" />}

        <div className={cn('flex items-center', isMobile ? 'gap-1' : 'h-full')}>
          <div className={cn('flex items-center gap-1', !isMobile && 'p-1 bg-background/50 rounded-lg')}>
            {settingsSections.map(({ id, label, icon: Icon }) => {
              const isActive = activeTab === id;
              const PhosphorIcon = Icon as React.ComponentType<{ className?: string; weight?: string }>;

              if (isMobile) {
                // Mobile: icon-only buttons
                return (
                  <Tooltip key={id} delayDuration={500}>
                    <TooltipTrigger asChild>
                      <button
                        onClick={() => handleTabChange(id)}
                        className={cn(
                          'relative flex h-9 w-9 items-center justify-center rounded-md transition-colors',
                          'hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                          isActive ? 'bg-interactive-selection text-interactive-selection-foreground shadow-sm' : 'text-muted-foreground hover:bg-interactive-hover/50'
                        )}
                        aria-pressed={isActive}
                        aria-label={label}
                      >
                        <PhosphorIcon className="h-5 w-5" weight="regular" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>{label}</p>
                    </TooltipContent>
                  </Tooltip>
                );
              }

              // Desktop: pill tabs like main header
              return (
                <button
                  key={id}
                  onClick={() => handleTabChange(id)}
                  onMouseDown={isActive ? handleActiveTabDragStart : undefined}
                  className={cn(
                    'relative flex h-8 items-center gap-2 px-3 rounded-md typography-ui-label font-medium transition-colors',
                    isActive ? 'app-region-drag bg-interactive-selection text-interactive-selection-foreground shadow-sm' : 'app-region-no-drag text-muted-foreground hover:bg-interactive-hover/50 hover:text-foreground',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary'
                  )}
                  aria-pressed={isActive}
                  aria-label={label}
                >
                  <PhosphorIcon className="h-4 w-4" weight="regular" />
                  {showTabLabels && <span>{label}</span>}
                </button>
              );
            })}
          </div>
        </div>

        {(onClose || showProjectSwitcher) && (
          <div className={cn('flex items-center gap-2', isMobile ? '' : 'pr-3')}>
            {showProjectSwitcher && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  {isMobile ? (
                    <button
                      type="button"
                      aria-label="Switch project"
                      title={activeProjectLabel}
                      className="inline-flex h-9 w-9 items-center justify-center p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary border border-[var(--interactive-border)]"
                    >
                      <RiFolderLine className="h-5 w-5" />
                    </button>
                  ) : (
                    <button
                      type="button"
                      aria-label="Switch project"
                      title={activeProjectLabel}
                      className={cn(
                        'flex h-9 max-w-[18rem] items-center gap-1.5 bg-transparent px-2 rounded-lg text-foreground outline-none hover:bg-interactive-hover/50 focus-visible:ring-2 focus-visible:ring-ring border border-[var(--interactive-border)]',
                        !isMobile && 'app-region-no-drag'
                      )}
                    >
                      <span className="min-w-0 flex-1 truncate typography-ui-label font-medium">{activeProjectLabel}</span>
                      <RiArrowDownSLine className="size-4 opacity-50" />
                    </button>
                  )}
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-auto">
                  <DropdownMenuRadioGroup
                    value={activeProject?.id ?? ''}
                    onValueChange={(value) => {
                      if (!value) return;
                      setActiveProject(value);
                    }}
                  >
                    {sortedProjects.map((project) => {
                      const rawLabel = project.label?.trim()
                        ? project.label.trim()
                        : (project.path.split('/').filter(Boolean).pop() || project.path);
                      const label = formatProjectLabel(rawLabel);
                      return (
                        <DropdownMenuRadioItem key={project.id} value={project.id}>
                          <span className="min-w-0 truncate typography-ui">{label}</span>
                        </DropdownMenuRadioItem>
                      );
                    })}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            )}

            {onClose && (
              <Tooltip delayDuration={500}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={onClose}
                    aria-label="Close settings"
                    className={cn(
                      'inline-flex h-9 w-9 items-center justify-center p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                      !isMobile && 'app-region-no-drag'
                    )}
                  >
                    <RiCloseLine className="h-5 w-5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>Close Settings ({shortcutKey}+,)</p>
                </TooltipContent>
              </Tooltip>
            )}
          </div>
        )}
      </div>

      {/* Content area */}
      <div className="flex flex-1 overflow-hidden">
        {/* Mobile: show sidebar OR page content based on drill-down state */}
        {isMobile ? (
          showMobilePageContent ? (
            <div className="flex-1 overflow-hidden bg-background" data-keyboard-avoid="true">
              <ErrorBoundary>{renderPageContent()}</ErrorBoundary>
            </div>
          ) : (
            <div className={cn('flex-1 overflow-hidden', isVSCode ? 'bg-background' : 'bg-sidebar')}>
              <div className="flex h-full min-h-0 flex-col">
                <ErrorBoundary>{renderSidebarContent()}</ErrorBoundary>
              </div>
            </div>
          )
        ) : (
          /* Desktop: show both sidebar and page content side by side */
          <>
            {hasSidebar && (
              <div
                className={cn(
                  'relative flex h-full min-h-0 flex-col overflow-hidden border-r',
                  isDesktopApp
                    ? 'bg-[color:var(--sidebar-overlay-strong)] backdrop-blur supports-[backdrop-filter]:bg-[color:var(--sidebar-overlay-soft)]'
                    : isVSCode
                      ? 'bg-background'
                      : 'bg-sidebar',
                  isResizing ? 'transition-none' : ''
                )}
                style={{
                  width: `${sidebarWidth}px`,
                  minWidth: `${sidebarWidth}px`,
                  borderColor: 'var(--interactive-border)',
                }}
              >
                {/* Resize handle */}
                <div
                  className={cn(
                    'absolute right-0 top-0 z-20 h-full w-[6px] -mr-[3px] cursor-col-resize',
                    isResizing ? 'bg-primary/30' : 'bg-transparent hover:bg-primary/20'
                  )}
                  onPointerDown={handlePointerDown}
                  role="separator"
                  aria-orientation="vertical"
                  aria-label="Resize settings sidebar"
                />
                <div className="flex h-full min-h-0 flex-col">
                  <ErrorBoundary>{renderSidebarContent()}</ErrorBoundary>
                </div>
              </div>
            )}

            <div className="flex-1 overflow-hidden bg-background">
              <ErrorBoundary>{renderPageContent()}</ErrorBoundary>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
