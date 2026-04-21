import React from 'react';
import type { McpStatus } from '@opencode-ai/sdk/v2';
import { RiRefreshLine } from '@remixicon/react';

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
import { computeMcpHealth, useMcpStore } from '@/stores/useMcpStore';
import { McpIcon } from '@/components/icons/McpIcon';

const statusTooltip = (status: McpStatus | undefined): string => {
  if (!status) return 'Unknown';
  switch (status.status) {
    case 'connected':
      return 'Connected';
    case 'failed':
      return `Failed: ${(status as { error?: string }).error || 'Unknown error'}`;
    case 'needs_auth':
      return 'Needs authentication';
    case 'needs_client_registration':
      return `Needs registration: ${(status as { error?: string }).error || ''}`;
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
}

export const McpDropdownContent: React.FC<McpDropdownContentProps> = ({ active, className }) => {
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const directory = currentDirectory ?? null;
  const status = useMcpStore((state) => state.getStatusForDirectory(directory));
  const refresh = useMcpStore((state) => state.refresh);
  const connect = useMcpStore((state) => state.connect);
  const disconnect = useMcpStore((state) => state.disconnect);
  const [isSpinning, setIsSpinning] = React.useState(false);
  const [busyName, setBusyName] = React.useState<string | null>(null);

  React.useEffect(() => {
    void refresh({ directory, silent: true });
  }, [refresh, directory]);

  React.useEffect(() => {
    if (!active) return;
    void refresh({ directory, silent: true });
  }, [active, refresh, directory]);

  const sortedNames = React.useMemo(() => {
    return Object.keys(status).sort((a, b) => a.localeCompare(b));
  }, [status]);

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
      <div className="border-b border-[var(--interactive-border)]">
        <div className="flex items-center justify-between gap-3 px-4 py-2.5">
          <div className="min-w-0 flex items-baseline gap-2">
            <div className="typography-ui-header font-semibold text-foreground">MCP Servers</div>
            {directory && (
              <div className="truncate typography-micro text-muted-foreground">
                {directory.split('/').pop() || directory}
              </div>
            )}
          </div>
          <button
            type="button"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            disabled={isSpinning}
            onClick={handleRefresh}
            aria-label="Refresh"
          >
            <RiRefreshLine className={cn('h-4 w-4', isSpinning && 'animate-spin')} />
          </button>
        </div>
      </div>

      <div className="max-h-64 overflow-y-auto py-2">
        {sortedNames.map((serverName) => {
          const serverStatus = status[serverName];
          const tone = statusTone(serverStatus);
          const isConnected = serverStatus?.status === 'connected';
          const isBusy = busyName === serverName;
          const tooltip = statusTooltip(serverStatus);

          return (
            <div
              key={serverName}
              className="flex items-center justify-between gap-2 px-4 py-1.5 rounded-lg hover:bg-interactive-hover/50"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 min-w-0">
                  <Tooltip delayDuration={300}>
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
                    if (checked) {
                      await connect(serverName, directory);
                    } else {
                      await disconnect(serverName, directory);
                    }
                  } finally {
                    setBusyName(null);
                  }
                }}
              />
            </div>
          );
        })}

        {sortedNames.length === 0 && (
          <div className="px-4 py-5 typography-ui-label text-muted-foreground text-center">
            Configure MCP servers in Opencode config.
          </div>
        )}
      </div>
    </div>
  );
};

export const McpDropdown: React.FC<McpDropdownProps> = ({ headerIconButtonClass }) => {
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

  // Fetch on mount and when directory changes
  React.useEffect(() => {
    void refresh({ directory, silent: true });
  }, [refresh, directory]);

  // Refresh when dropdown opens
  React.useEffect(() => {
    if (!open) return;
    void refresh({ directory, silent: true });
  }, [open, refresh, directory]);

  const health = React.useMemo(() => computeMcpHealth(status), [status]);

  const sortedNames = React.useMemo(() => {
    return Object.keys(status).sort((a, b) => a.localeCompare(b));
  }, [status]);

  const handleRefresh = React.useCallback((e?: React.MouseEvent) => {
    e?.preventDefault();
    if (isSpinning) return;
    setIsSpinning(true);
    const minSpinPromise = new Promise(resolve => setTimeout(resolve, 500));
    Promise.all([refresh({ directory }), minSpinPromise]).finally(() => {
      setIsSpinning(false);
    });
  }, [isSpinning, refresh, directory]);

  const renderServerList = () => (
    <>
      {sortedNames.map((serverName) => {
        const serverStatus = status[serverName];
        const tone = statusTone(serverStatus);
        const isConnected = serverStatus?.status === 'connected';
        const isBusy = busyName === serverName;
        const tooltip = statusTooltip(serverStatus);

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
                  <Tooltip delayDuration={300}>
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
                  if (checked) {
                    await connect(serverName, directory);
                  } else {
                    await disconnect(serverName, directory);
                  }
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
          Configure MCP servers in Opencode config.
        </div>
      )}
    </>
  );

  const triggerButton = (
    <button
      type="button"
      aria-label="MCP servers"
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
          aria-label="MCP status"
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
          title="MCP Servers"
          onClose={() => setOpen(false)}
          renderHeader={(closeButton) => (
            <div className="flex items-center justify-between px-3 py-2 border-b border-border/40">
              <h2 className="typography-ui-label font-semibold text-foreground">MCP Servers</h2>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-interactive-hover transition-colors"
                  disabled={isSpinning}
                  onClick={handleRefresh}
                  aria-label="Refresh"
                >
                  <RiRefreshLine className={cn('h-4 w-4', isSpinning && 'animate-spin')} />
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
      <Tooltip delayDuration={1000} open={open ? false : tooltipOpen} onOpenChange={handleTooltipOpenChange}>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            {triggerButton}
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>
          <p>MCP Servers</p>
        </TooltipContent>
      </Tooltip>

      <DropdownMenuContent align="end" className="w-72">
        <McpDropdownContent active={open} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
