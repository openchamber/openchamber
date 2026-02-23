import React from 'react';
import { RiRestartLine } from '@remixicon/react';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useDeviceInfo } from '@/lib/device';
import { isVSCodeRuntime, isWebRuntime } from '@/lib/desktop';
import { AboutSettings } from './AboutSettings';
import { reloadOpenCodeConfiguration } from '@/stores/useAgentsStore';
import { cn } from '@/lib/utils';

export type OpenChamberSection = 'visual' | 'chat' | 'shortcuts' | 'sessions' | 'git' | 'github' | 'notifications' | 'voice';

interface OpenChamberSidebarProps {
  selectedSection: OpenChamberSection;
  onSelectSection: (section: OpenChamberSection) => void;
}

interface SectionGroup {
  id: OpenChamberSection;
  label: string;
  items: string[];
  badge?: string;
  webOnly?: boolean;
  hideInVSCode?: boolean;
}

const OPENCHAMBER_SECTION_GROUPS: SectionGroup[] = [
  {
    id: 'visual',
    label: 'Visual',
    items: ['Theme', 'Font', 'Spacing'],
  },
  {
    id: 'chat',
    label: 'Chat',
    items: ['Tools', 'Diff', 'Reasoning'],
  },
  {
    id: 'shortcuts',
    label: 'Shortcuts',
    items: ['Keyboard', 'Overrides'],
  },
  {
    id: 'sessions',
    label: 'Sessions',
    items: ['Defaults', 'Utility Model', 'Retention'],
  },
  {
    id: 'git',
    label: 'Git',
    items: ['Commit Messages', 'Worktree'],
    hideInVSCode: true,
  },
  {
    id: 'github',
    label: 'GitHub',
    items: ['Connect', 'PRs', 'Issues'],
    hideInVSCode: true,
  },
  {
    id: 'notifications',
    label: 'Notifications',
    items: ['Native'],
  },
  {
    id: 'voice',
    label: 'Voice',
    items: ['Language', 'Continuous Mode'],
    badge: 'experimental',
    hideInVSCode: true,
  },
];

export const OpenChamberSidebar: React.FC<OpenChamberSidebarProps> = ({
  selectedSection,
  onSelectSection,
}) => {
  const { isMobile } = useDeviceInfo();
  const showAbout = isMobile && isWebRuntime();
  const [isReloadingConfig, setIsReloadingConfig] = React.useState(false);

  const isVSCode = React.useMemo(() => isVSCodeRuntime(), []);
  const isWeb = React.useMemo(() => isWebRuntime(), []);
  const showReload = !isVSCode;

  const handleReloadConfiguration = React.useCallback(async () => {
    setIsReloadingConfig(true);
    try {
      await reloadOpenCodeConfiguration({ message: 'Restarting OpenCode…', mode: 'projects', scopes: ['all'] });
    } finally {
      setIsReloadingConfig(false);
    }
  }, []);

  const visibleSections = React.useMemo(() => {
    return OPENCHAMBER_SECTION_GROUPS.filter((group) => {
      if (group.webOnly && !isWeb) return false;
      if (group.hideInVSCode && isVSCode) return false;
      return true;
    });
  }, [isWeb, isVSCode]);

  // Desktop app: transparent for blur effect
  // VS Code: bg-background (same as page content)
  // Web/mobile: bg-sidebar
  const bgClass = isVSCode ? 'bg-background' : 'bg-sidebar';

  return (
    <div className={cn('grid h-full min-h-0 grid-rows-[minmax(0,1fr)_auto]', bgClass)}>
      <div className="min-h-0">
        <ScrollableOverlay outerClassName="h-full" className="space-y-1 px-3 py-2 overflow-x-hidden">
          {visibleSections.map((group) => {
            const isSelected = selectedSection === group.id;
            return (
              <div
                key={group.id}
                className={cn(
                  'group relative rounded-md px-1.5 py-1 transition-all duration-200',
                  isSelected ? 'bg-interactive-selection' : 'hover:bg-interactive-hover'
                )}
              >
                <button
                  onClick={() => onSelectSection(group.id)}
                  className="w-full text-left flex flex-col gap-0 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                >
                  <div className="flex items-center gap-2">
                    <span className="typography-ui-label font-normal text-foreground">
                      {group.label}
                    </span>
                    {group.badge && (
                      <span className="text-[10px] leading-none uppercase font-bold tracking-tight bg-[var(--status-warning-background)] text-[var(--status-warning)] border border-[var(--status-warning-border)] px-1.5 py-0.5 rounded">
                        {group.badge}
                      </span>
                    )}
                  </div>
                  <div className="typography-micro text-muted-foreground/60 leading-tight">
                    {group.items.join(' · ')}
                  </div>
                </button>
              </div>
            );
          })}
        </ScrollableOverlay>
      </div>

      {(showReload || showAbout) && (
        <div className={cn(
          'border-t border-border bg-sidebar',
          showAbout ? 'px-3 py-3 space-y-3' : 'flex-shrink-0 h-12 px-2'
        )}>
          {showAbout ? (
            <>
              {showReload && (
                <Tooltip delayDuration={300}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className={cn(
                        'flex h-8 w-full items-center gap-2 rounded-md px-2',
                        'text-sm font-semibold text-sidebar-foreground/90',
                        'hover:text-sidebar-foreground hover:bg-interactive-hover',
                        'transition-all duration-200',
                        'disabled:pointer-events-none disabled:opacity-50'
                      )}
                      onClick={() => void handleReloadConfiguration()}
                      disabled={isReloadingConfig}
                    >
                      <RiRestartLine className="h-4 w-4" />
                      {isReloadingConfig ? 'Reloading OpenCode…' : 'Reload OpenCode'}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>
                    Restart OpenCode and reload its configuration (agents, commands, skills, providers).
                  </TooltipContent>
                </Tooltip>
              )}
              <AboutSettings />
            </>
          ) : (
            <div className="flex h-full items-center justify-between gap-2">
              {showReload && (
                <Tooltip delayDuration={300}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className={cn(
                        'flex h-8 items-center gap-2 rounded-md px-2',
                        'text-sm font-semibold text-sidebar-foreground/90',
                        'hover:text-sidebar-foreground hover:bg-interactive-hover',
                        'transition-all duration-200',
                        'disabled:pointer-events-none disabled:opacity-50'
                      )}
                      onClick={() => void handleReloadConfiguration()}
                      disabled={isReloadingConfig}
                    >
                      <RiRestartLine className="h-4 w-4" />
                      {isReloadingConfig ? 'Reloading OpenCode…' : 'Reload OpenCode'}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>
                    Restart OpenCode and reload its configuration (agents, commands, skills, providers).
                  </TooltipContent>
                </Tooltip>
              )}
              <div />
            </div>
          )}
        </div>
      )}

    </div>
  );
};
