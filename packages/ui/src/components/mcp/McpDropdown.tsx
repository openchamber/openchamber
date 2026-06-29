import React from 'react';
import type { McpStatus } from '@opencode-ai/sdk/v2';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { Switch } from '@/components/ui/switch';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { cn } from '@/lib/utils';
import { useDeviceInfo } from '@/lib/device';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useMcpConfigStore } from '@/stores/useMcpConfigStore';
import { computeMcpHealth, useMcpStore } from '@/stores/useMcpStore';
import { McpIcon } from '@/components/icons/McpIcon';
import { Icon } from "@/components/icon/Icon";
import { useI18n } from '@/lib/i18n';


/**
 * DeferredMount delays rendering children by `delayMs` milliseconds.
 * This decouples the tab switch animation from heavy component mounts,
 * ensuring the user sees the tab switch UI before the expensive render blocks.
 */
export function DeferredMount({ children, delayMs = 200 }: { children: React.ReactNode; delayMs?: number }) {
  const [ready, setReady] = React.useState(false);
  React.useEffect(() => {
    const id = setTimeout(() => setReady(true), delayMs);
    return () => clearTimeout(id);
  }, [delayMs]);
  if (!ready) return null;
  return <>{children}</>;
}

const statusTooltip = (
  status: McpStatus | undefined,
  t: (key: 'mcpDropdown.status.unknown' | 'mcpDropdown.status.connected' | 'mcpDropdown.status.failed' | 'mcpDropdown.status.unknownError' | 'mcpDropdown.status.needsAuth' | 'mcpDropdown.status.needsRegistration', params?: { error?: string }) => string
): string => {
  if (!status) return t('mcpDropdown.status.unknown');
  switch (status.status) {
    case 'connected':
      return t('mcpDropdown.status.connected');
    case 'failed':
      return t('mcpDropdown.status.failed', { error: (status as { error?: string }).error || t('mcpDropdown.status.unknownError') });
    case 'needs_auth':
      return t('mcpDropdown.status.needsAuth');
    case 'needs_client_registration':
      return t('mcpDropdown.status.needsRegistration', { error: (status as { error?: string }).error || '' });
    default:
      return status.status;
  }
};

const statusTone = (status: McpStatus | undefined): 'default' | 'success' | 'warning' | 'error' => {
  switch (status?.status) {
    case 'connected':
      return 'success';
    case 'failed':
      return 'error';
    case 'needs_auth':
    case 'needs_client_registration':
      return 'warning';
    default:
      return 'default';
  }
};

interface McpDropdownProps {
  headerIconButtonClass: string;
}

interface McpDropdownContentProps {
  active: boolean;
  className?: string;
  headerAction?: React.ReactNode;
  listClassName?: string;
  hideHeader?: boolean;
  mobileListDensity?: boolean;
}

export const McpDropdownContent = React.memo<McpDropdownContentProps>(function McpDropdownContent({ active, className, headerAction, listClassName, hideHeader = false, mobileListDensity = false }) {
  'use no memo'; // React Compiler: skip automatic memoization for this hot component

  const { t } = useI18n();
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const directory = currentDirectory ?? null;
  const status = useMcpStore((state) => state.getStatusForDirectory(directory));
  const refresh = useMcpStore((state) => state.refresh);
  const connect = useMcpStore((state) => state.connect);
  const disconnect = useMcpStore((state) => state.disconnect);
  const mcpServers = useMcpConfigStore((state) => state.mcpServers);
  const loadMcpConfigs = useMcpConfigStore((state) => state.loadMcpConfigs);
  const updateMcp = useMcpConfigStore((state) => state.updateMcp);
  const [isSpinning, setIsSpinning] = React.useState(false);
  const [busyName, setBusyName] = React.useState<string | null>(null);

  // Only refresh on first active render
  React.useEffect(() => {
    if (!active) return;
    void refresh({ directory, silent: true });
    void loadMcpConfigs({ force: true, timeoutMs: 3_000 });
  }, [active, refresh, directory, loadMcpConfigs]);

  // Cap the visible server list to prevent rendering thousands of Tooltip+Switch
  // components when the status map contains excessive entries (which causes
  // browser freeze from 200k+ DOM nodes). Show a truncated indicator.
  const MAX_VISIBLE_SERVERS = 100;
  const { visibleNames, totalCount, filteredCount } = React.useMemo(() => {
    // Collect all unique server names from both sources
    const allNames = new Set<string>();
    for (const server of mcpServers) {
      if (server?.name) allNames.add(server.name);
    }
    for (const key of Object.keys(status)) {
      allNames.add(key);
    }

    const sorted = Array.from(allNames).sort((a, b) => a.localeCompare(b));

    // Collect config server names (real configured MCP servers)
    const configNames = new Set<string>();
    for (const server of mcpServers) {
      if (server?.name) configNames.add(server.name);
    }

    // Prioritize: config servers (real) always included;
    // fill remaining slots from status keys up to MAX_VISIBLE_SERVERS.
    // This prevents 28K+ numeric status entries drowning out real servers.
    if (sorted.length <= MAX_VISIBLE_SERVERS) {
      return { visibleNames: sorted, totalCount: sorted.length };
    }

    const prioritized = new Set<string>();
    // 1. All config server names first (real MCP servers)
    for (const name of sorted) {
      if (configNames.has(name)) {
        prioritized.add(name);
      }
    }
    // 2. Fill remaining slots from sorted status keys, skipping purely numeric
    //    names that are noise (OpenCode internal entries, not real MCP servers).
    for (const name of sorted) {
      if (prioritized.size >= MAX_VISIBLE_SERVERS) break;
      if (prioritized.has(name)) continue;
      // Skip names that are purely numeric (noise from OpenCode status map)
      if (/^\d+$/.test(name)) continue;
      prioritized.add(name);
    }

    return {
      visibleNames: Array.from(prioritized),
      totalCount: sorted.length,
      filteredCount: sorted.length - Array.from(prioritized).length,
    };
  }, [mcpServers, status]);

  // Config lookup: server name → config entry (for enabled/disabled fallback)
  const configByName = React.useMemo(() => {
    const map = new Map<string, { name: string; enabled: boolean }>();
    for (const server of mcpServers) {
      if (server?.name) map.set(server.name, { name: server.name, enabled: server.enabled });
    }
    return map;
  }, [mcpServers]);

  const handleRefresh = React.useCallback((e?: React.MouseEvent) => {
    e?.preventDefault();
    if (isSpinning) return;
    setIsSpinning(true);
    const minSpinPromise = new Promise(resolve => setTimeout(resolve, 500));
    Promise.all([refresh({ directory }), minSpinPromise]).finally(() => {
      setIsSpinning(false);
    });
  }, [isSpinning, refresh, directory]);
  return (
    <div className={cn('w-full', className)}>
      {!hideHeader ? <div className="border-b border-[var(--interactive-border)]">
        <div className="flex items-center justify-between gap-3 px-4 py-2.5">
          <div className="min-w-0 flex items-baseline gap-2">
            <div className="typography-ui-header font-semibold text-foreground">{t('mcpDropdown.title')}</div>
            {directory && (
              <div className="truncate typography-micro text-muted-foreground">
                {directory.split('/').pop() || directory}
              </div>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {headerAction}
            <button
              type="button"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              disabled={isSpinning}
              onClick={handleRefresh}
              aria-label={t('mcpDropdown.actions.refreshAria')}
            >
              <Icon name="refresh" className={cn('h-4 w-4', isSpinning && 'animate-spin')} />
            </button>
          </div>
        </div>
      </div> : null}

      <div className={cn('max-h-64 overflow-y-auto py-2', mobileListDensity && 'space-y-1 py-3', listClassName)}>
        {visibleNames.map((serverName) => {
          const serverStatus = status[serverName];
          const configEntry = configByName.get(serverName);
          const tone = serverStatus ? statusTone(serverStatus) : configEntry?.enabled ? 'success' : 'default';
          const isConnected = configEntry ? configEntry.enabled : serverStatus?.status === 'connected';
          const isBusy = busyName === serverName;
          const tooltip = serverStatus
            ? statusTooltip(serverStatus, t)
            : configEntry?.enabled
              ? t('mcpDropdown.status.configured')
              : t('mcpDropdown.status.notConnected');

          return (
            <div
              key={serverName}
              className={cn(
                'flex items-center justify-between rounded-lg hover:bg-interactive-hover/50',
                mobileListDensity ? 'gap-3 px-4 py-3' : 'gap-2 px-4 py-1.5',
              )}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 min-w-0">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span
                        className={cn(
                          'rounded-full flex-shrink-0',
                          mobileListDensity ? 'h-2.5 w-2.5' : 'h-2 w-2',
                          tone === 'success' && 'bg-status-success',
                          tone === 'error' && 'bg-status-error',
                          tone === 'warning' && 'bg-status-warning',
                          tone === 'default' && 'bg-muted-foreground/40'
                        )}
                        aria-label={tooltip}
                      />
                    </TooltipTrigger>
                    <TooltipContent side="left">
                      <p>{tooltip}</p>
                    </TooltipContent>
                  </Tooltip>
                  <span className={cn('truncate', mobileListDensity ? 'text-[17px] leading-6 font-medium' : 'typography-ui-label')}>
                    {serverName}
                  </span>
                </div>
              </div>

              <Switch
                checked={isConnected}
                disabled={isBusy}
                className="data-[checked]:bg-status-info"
                onCheckedChange={async (checked) => {
                  setBusyName(serverName);
                  try {
                    if (configEntry) {
                      // Config-managed server: toggle via config PATCH
                      await updateMcp(serverName, { enabled: checked });
                      await loadMcpConfigs({ force: true });
                    } else if (checked) {
                      await connect(serverName, directory);
                    } else {
                      await disconnect(serverName, directory);
                    }
                  } catch {
                    // Toggle failed — refresh to restore actual state
                    await loadMcpConfigs({ force: true }).catch(() => {});
                    await refresh({ directory, silent: true }).catch(() => {});
                  } finally {
                    setBusyName(null);
                  }
                }}
              />
            </div>
          );
        })}

        {visibleNames.length === 0 && (
          <div className="px-4 py-5 typography-ui-label text-muted-foreground text-center">
            {t('mcpDropdown.empty.configureInConfig')}
          </div>
        )}

        {filteredCount > 0 && (
          <div className="px-4 py-2 typography-caption text-muted-foreground text-center border-t border-border/50">
            Showing {visibleNames.length} of {totalCount} servers
          </div>
        )}
      </div>
    </div>
  );
});

export const McpDropdown: React.FC<McpDropdownProps> = ({ headerIconButtonClass }) => {
  const { t } = useI18n();
  const [open, setOpen] = React.useState(false);
  const [tooltipOpen, setTooltipOpen] = React.useState(false);
  const blockTooltipRef = React.useRef(false);
  const { isMobile } = useDeviceInfo();
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const directory = currentDirectory ?? null;

  const status = useMcpStore((state) => state.getStatusForDirectory(directory));
  const refresh = useMcpStore((state) => state.refresh);
  const connect = useMcpStore((state) => state.connect);
  const disconnect = useMcpStore((state) => state.disconnect);
  const mcpServers = useMcpConfigStore((state) => state.mcpServers);
  const loadMcpConfigs = useMcpConfigStore((state) => state.loadMcpConfigs);
  const updateMcp = useMcpConfigStore((state) => state.updateMcp);

  const handleDropdownOpenChange = React.useCallback((isOpen: boolean) => {
    if (!isOpen) {
      blockTooltipRef.current = true;
      setTooltipOpen(false);
      setTimeout(() => {
        blockTooltipRef.current = false;
      }, 200);
    }
    setOpen(isOpen);
  }, []);

  const handleTooltipOpenChange = React.useCallback((isOpen: boolean) => {
    if (blockTooltipRef.current) return;
    setTooltipOpen(isOpen);
  }, []);

  const [isSpinning, setIsSpinning] = React.useState(false);

  const [busyName, setBusyName] = React.useState<string | null>(null);

  // Load data on mount (cached) so header icon shows status immediately.
  // Dropdown re-fetch happens separately in McpDropdownContent.
  React.useEffect(() => {
    void refresh({ directory, silent: true });
    void loadMcpConfigs();
  }, [refresh, directory, loadMcpConfigs]);

  // Refresh when dropdown opens (force = bypass in-flight dedup)
  React.useEffect(() => {
    if (!open) return;
    void refresh({ directory, silent: true });
    void loadMcpConfigs({ force: true, timeoutMs: 3_000 });
  }, [open, refresh, directory, loadMcpConfigs]);

  const health = React.useMemo(() => computeMcpHealth(status), [status]);

  const sortedNames = React.useMemo(() => {
    const names = new Set<string>(Object.keys(status));
    for (const server of mcpServers) {
      if (server?.name) {
        names.add(server.name);
      }
    }
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [mcpServers, status]);

  const handleRefresh = React.useCallback((e?: React.MouseEvent) => {
    e?.preventDefault();
    if (isSpinning) return;
    setIsSpinning(true);
    const minSpinPromise = new Promise(resolve => setTimeout(resolve, 500));
    Promise.all([refresh({ directory }), minSpinPromise]).finally(() => {
      setIsSpinning(false);
    });
  }, [isSpinning, refresh, directory]);

  // Config lookup for the header dropdown icon
  const configByName = React.useMemo(() => {
    const map = new Map<string, { name: string; enabled: boolean }>();
    for (const server of mcpServers) {
      if (server?.name) map.set(server.name, { name: server.name, enabled: server.enabled });
    }
    return map;
  }, [mcpServers]);

  const renderServerList = () => (
    <>
      {sortedNames.map((serverName) => {
        const serverStatus = status[serverName];
        const configEntry = configByName.get(serverName);
        const tone = serverStatus ? statusTone(serverStatus) : configEntry?.enabled ? 'success' : 'default';
        const isConnected = configEntry ? configEntry.enabled : serverStatus?.status === 'connected';
        const isBusy = busyName === serverName;
        const tooltip = serverStatus
          ? statusTooltip(serverStatus, t)
          : configEntry?.enabled
            ? t('mcpDropdown.status.configured', 'Configured')
            : t('mcpDropdown.status.notConnected', 'Not connected');

        return (
          <div
            key={serverName}
            className="flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg hover:bg-interactive-hover/50"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 min-w-0">
                {isMobile ? (
                  <span
                    className={cn(
                      'h-2 w-2 rounded-full flex-shrink-0',
                      tone === 'success' && 'bg-status-success',
                      tone === 'error' && 'bg-status-error',
                      tone === 'warning' && 'bg-status-warning',
                      tone === 'default' && 'bg-muted-foreground/40'
                    )}
                    aria-label={tooltip}
                  />
                ) : (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span
                        className={cn(
                          'h-2 w-2 rounded-full flex-shrink-0',
                          tone === 'success' && 'bg-status-success',
                          tone === 'error' && 'bg-status-error',
                          tone === 'warning' && 'bg-status-warning',
                          tone === 'default' && 'bg-muted-foreground/40'
                        )}
                        aria-label={tooltip}
                      />
                    </TooltipTrigger>
                    <TooltipContent side="left">
                      <p>{tooltip}</p>
                    </TooltipContent>
                  </Tooltip>
                )}
                <span className="typography-ui-label truncate">{serverName}</span>
              </div>
            </div>

            <Switch
              checked={isConnected}
              disabled={isBusy}
              className="data-[checked]:bg-status-info"
              onCheckedChange={async (checked) => {
                setBusyName(serverName);
                try {
                  if (configEntry) {
                    await updateMcp(serverName, { enabled: checked });
                    await loadMcpConfigs({ force: true });
                  } else if (checked) {
                    await connect(serverName, directory);
                  } else {
                    await disconnect(serverName, directory);
                  }
                } catch {
                  await loadMcpConfigs({ force: true }).catch(() => {});
                  await refresh({ directory, silent: true }).catch(() => {});
                } finally {
                  setBusyName(null);
                }
              }}
            />
          </div>
        );
      })}

      {sortedNames.length === 0 && (
        <div className="px-2 py-3 typography-ui-label text-muted-foreground text-center">
          {t('mcpDropdown.empty.configureInConfig')}
        </div>
      )}
    </>
  );

  const triggerButton = (
    <button
      type="button"
      aria-label={t('mcpDropdown.actions.openAria')}
      className={cn(headerIconButtonClass, 'relative')}
      onClick={isMobile ? () => setOpen(true) : undefined}
    >
      <McpIcon className="h-[1.0625rem] w-[1.0625rem]" />
      {health.total > 0 && (
        <span
          className={cn(
            'absolute top-1.5 right-1.5 h-1.5 w-1.5 rounded-full',
            health.hasFailed
              ? 'bg-status-error'
              : health.hasAuthRequired
                ? 'bg-status-warning'
                : health.connected > 0
                  ? 'bg-status-success'
                  : 'bg-muted-foreground/40'
          )}
          aria-label={t('mcpDropdown.statusAria')}
        />
      )}
    </button>
  );

  // Mobile: use MobileOverlayPanel
  if (isMobile) {
    return (
      <>
        {triggerButton}
        <MobileOverlayPanel
          open={open}
          title={t('mcpDropdown.title')}
          onClose={() => setOpen(false)}
          renderHeader={(closeButton) => (
            <div className="flex items-center justify-between px-3 py-2 border-b border-border/40">
              <h2 className="typography-ui-label font-semibold text-foreground">{t('mcpDropdown.title')}</h2>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-interactive-hover transition-colors"
                  disabled={isSpinning}
                  onClick={handleRefresh}
                  aria-label={t('mcpDropdown.actions.refreshAria')}
                >
                  <Icon name="refresh" className={cn('h-4 w-4', isSpinning && 'animate-spin')} />
                </button>
                {closeButton}
              </div>
            </div>
          )}
        >
          <div className="py-1">
            {renderServerList()}
          </div>
          {directory && (
            <div className="px-2 py-1 border-t border-border/40 mt-1">
              <span className="typography-meta text-muted-foreground truncate block">
                {directory.split('/').pop() || directory}
              </span>
            </div>
          )}
        </MobileOverlayPanel>
      </>
    );
  }

  // Desktop: use DropdownMenu
  return (
    <DropdownMenu open={open} onOpenChange={handleDropdownOpenChange}>
      <Tooltip open={open ? false : tooltipOpen} onOpenChange={handleTooltipOpenChange}>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            {triggerButton}
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>
          <p>{t('mcpDropdown.title')}</p>
        </TooltipContent>
      </Tooltip>

      <DropdownMenuContent align="end" className="w-72">
        <McpDropdownContent active={open} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
