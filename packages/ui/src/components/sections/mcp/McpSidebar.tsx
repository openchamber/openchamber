import React from 'react';
import { ButtonSmall } from '@/components/ui/button-small';
import { ButtonLarge } from '@/components/ui/button-large';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { RiAddLine, RiDeleteBinLine, RiMore2Line, RiPlugLine } from '@remixicon/react';
import { useMcpConfigStore, type McpDraft, type McpServerConfig } from '@/stores/useMcpConfigStore';
import { useMcpStore } from '@/stores/useMcpStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { isMobileDeviceViaCSS } from '@/lib/device';
import { cn } from '@/lib/utils';
import { toast } from '@/components/ui';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { SettingsProjectSelector } from '@/components/sections/shared/SettingsProjectSelector';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface McpSidebarProps {
  onItemSelect?: () => void;
}

// ---- Status dot ----
type StatusTone = 'success' | 'error' | 'warning' | 'idle';

const statusToneFromMcp = (status: string | undefined): StatusTone => {
  switch (status) {
    case 'connected': return 'success';
    case 'failed': return 'error';
    case 'needs_auth':
    case 'needs_client_registration': return 'warning';
    default: return 'idle';
  }
};

const StatusDot: React.FC<{ tone: StatusTone; enabled: boolean }> = ({ tone, enabled }) => {
  if (!enabled) {
    return (
      <span className="inline-block h-2 w-2 rounded-full bg-muted-foreground/30 flex-shrink-0" />
    );
  }
  const classes: Record<StatusTone, string> = {
    success: 'bg-[var(--status-success)]',
    error: 'bg-[var(--status-error)]',
    warning: 'bg-[var(--status-warning)]',
    idle: 'bg-muted-foreground/40',
  };
  return (
    <span className={cn('inline-block h-2 w-2 rounded-full flex-shrink-0', classes[tone])} />
  );
};

export const McpSidebar: React.FC<McpSidebarProps> = ({ onItemSelect }) => {
  const bgClass = 'bg-background';

  const { mcpServers, selectedMcpName, setSelectedMcp, setMcpDraft, loadMcpConfigs, deleteMcp } =
    useMcpConfigStore();

  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const mcpStatus = useMcpStore((state) => state.getStatusForDirectory(currentDirectory ?? null));

  const [deleteTarget, setDeleteTarget] = React.useState<McpServerConfig | null>(null);
  const [isDeleting, setIsDeleting] = React.useState(false);
  const [openMenuMcp, setOpenMenuMcp] = React.useState<string | null>(null);

  const projectServers = React.useMemo(
    () => mcpServers.filter((server) => server.scope === 'project'),
    [mcpServers]
  );
  const userServers = React.useMemo(
    () => mcpServers.filter((server) => server.scope !== 'project'),
    [mcpServers]
  );

  React.useEffect(() => {
    void loadMcpConfigs();
  }, [loadMcpConfigs]);

  const handleCreateNew = () => {
    const baseName = 'new-mcp-server';
    let newName = baseName;
    let counter = 1;
    while (mcpServers.some((s) => s.name === newName)) {
      newName = `${baseName}-${counter}`;
      counter++;
    }

    const draft: McpDraft = {
      name: newName,
      scope: 'user',
      type: 'local',
      command: [],
      url: '',
      environment: [],
      enabled: true,
    };
    setMcpDraft(draft);
    setSelectedMcp(newName);
    onItemSelect?.();
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setIsDeleting(true);
    const success = await deleteMcp(deleteTarget.name);
    if (success) {
      toast.success(`MCP server "${deleteTarget.name}" deleted`);
    } else {
      toast.error('Failed to delete MCP server');
    }
    setDeleteTarget(null);
    setIsDeleting(false);
  };

  return (
    <div className={cn('flex h-full flex-col', bgClass)}>
      <div className="border-b px-3 pt-4 pb-3">
        <h2 className="text-base font-semibold text-foreground mb-3">MCP Servers</h2>
        <SettingsProjectSelector className="mb-3" />
        <div className="flex items-center justify-between gap-2">
          <span className="typography-meta text-muted-foreground">
            Total {mcpServers.length}
          </span>
          <ButtonSmall
            variant="ghost"
            className="h-7 w-7 px-0 -my-1 text-muted-foreground"
            onClick={handleCreateNew}
            title="Add MCP server"
          >
            <RiAddLine className="h-3.5 w-3.5" />
          </ButtonSmall>
        </div>
      </div>

      {/* List */}
      <ScrollableOverlay outerClassName="flex-1 min-h-0" className="space-y-1 px-3 py-2 overflow-x-hidden">
        {mcpServers.length === 0 ? (
          <div className="py-12 px-4 text-center text-muted-foreground">
            <RiPlugLine className="mx-auto mb-3 h-10 w-10 opacity-50" />
            <p className="typography-ui-label font-medium">No MCP servers configured</p>
            <p className="typography-meta mt-1 opacity-75">Use the + button above to add one</p>
          </div>
        ) : (
          <>
            {projectServers.length > 0 && (
              <>
                <div className="px-2 pb-1.5 pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Project Servers
                </div>
                {projectServers.map((server) => {
                  const runtimeStatus = mcpStatus[server.name];
                  const tone = statusToneFromMcp(runtimeStatus?.status);
                  const isSelected = selectedMcpName === server.name;
                  const isMobile = isMobileDeviceViaCSS();

                  return (
                    <div
                      key={server.name}
                      className={cn(
                        'group relative flex items-center rounded-md px-1.5 py-1 transition-all duration-200 select-none',
                        isSelected ? 'bg-interactive-selection' : 'hover:bg-interactive-hover',
                      )}
                      onContextMenu={!isMobile ? (e) => {
                        e.preventDefault();
                        setOpenMenuMcp(server.name);
                      } : undefined}
                    >
                      <button
                        onClick={() => {
                          setSelectedMcp(server.name);
                          setMcpDraft(null);
                          onItemSelect?.();
                        }}
                        className="flex min-w-0 flex-1 flex-col gap-0 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                      >
                        <div className="flex items-center gap-2">
                          <StatusDot tone={tone} enabled={server.enabled} />
                          <span className="typography-ui-label font-normal truncate text-foreground">{server.name}</span>
                          <span className="typography-micro text-muted-foreground bg-muted px-1 rounded flex-shrink-0 leading-none pb-px border border-border/50">
                            {server.type}
                          </span>
                        </div>
                        <div className="typography-micro text-muted-foreground/60 truncate leading-tight pl-4">
                          {server.type === 'local'
                            ? (server as { command?: string[] }).command?.join(' ') ?? ''
                            : (server as { url?: string }).url ?? ''}
                        </div>
                      </button>

                      <DropdownMenu open={openMenuMcp === server.name} onOpenChange={(open) => setOpenMenuMcp(open ? server.name : null)}>
                        <DropdownMenuTrigger asChild>
                          <ButtonSmall variant="ghost" className="h-6 w-6 px-0 flex-shrink-0 -mr-1 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100">
                            <RiMore2Line className="h-3.5 w-3.5" />
                          </ButtonSmall>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-fit min-w-20">
                          <DropdownMenuItem
                            onClick={(e) => {
                              e.stopPropagation();
                              setDeleteTarget(server);
                            }}
                            className="text-destructive focus:text-destructive"
                          >
                            <RiDeleteBinLine className="h-4 w-4 mr-px" />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  );
                })}
              </>
            )}

            {userServers.length > 0 && (
              <>
                <div className="px-2 pb-1.5 pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  User Servers
                </div>
                {userServers.map((server) => {
                  const runtimeStatus = mcpStatus[server.name];
                  const tone = statusToneFromMcp(runtimeStatus?.status);
                  const isSelected = selectedMcpName === server.name;
                  const isMobile = isMobileDeviceViaCSS();

                  return (
                    <div
                      key={server.name}
                      className={cn(
                        'group relative flex items-center rounded-md px-1.5 py-1 transition-all duration-200 select-none',
                        isSelected ? 'bg-interactive-selection' : 'hover:bg-interactive-hover',
                      )}
                      onContextMenu={!isMobile ? (e) => {
                        e.preventDefault();
                        setOpenMenuMcp(server.name);
                      } : undefined}
                    >
                      <button
                        onClick={() => {
                          setSelectedMcp(server.name);
                          setMcpDraft(null);
                          onItemSelect?.();
                        }}
                        className="flex min-w-0 flex-1 flex-col gap-0 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                      >
                        <div className="flex items-center gap-2">
                          <StatusDot tone={tone} enabled={server.enabled} />
                          <span className="typography-ui-label font-normal truncate text-foreground">{server.name}</span>
                          <span className="typography-micro text-muted-foreground bg-muted px-1 rounded flex-shrink-0 leading-none pb-px border border-border/50">
                            {server.type}
                          </span>
                        </div>
                        <div className="typography-micro text-muted-foreground/60 truncate leading-tight pl-4">
                          {server.type === 'local'
                            ? (server as { command?: string[] }).command?.join(' ') ?? ''
                            : (server as { url?: string }).url ?? ''}
                        </div>
                      </button>

                      <DropdownMenu open={openMenuMcp === server.name} onOpenChange={(open) => setOpenMenuMcp(open ? server.name : null)}>
                        <DropdownMenuTrigger asChild>
                          <ButtonSmall variant="ghost" className="h-6 w-6 px-0 flex-shrink-0 -mr-1 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100">
                            <RiMore2Line className="h-3.5 w-3.5" />
                          </ButtonSmall>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-fit min-w-20">
                          <DropdownMenuItem
                            onClick={(e) => {
                              e.stopPropagation();
                              setDeleteTarget(server);
                            }}
                            className="text-destructive focus:text-destructive"
                          >
                            <RiDeleteBinLine className="h-4 w-4 mr-px" />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  );
                })}
              </>
            )}
          </>
        )}
      </ScrollableOverlay>

      {/* Delete confirm dialog */}
      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => { if (!open && !isDeleting) setDeleteTarget(null); }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete MCP Server</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete "{deleteTarget?.name}"? This will remove it from{' '}
              <code className="text-foreground">opencode.json</code>.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <ButtonLarge
              variant="ghost"
              onClick={() => setDeleteTarget(null)}
              disabled={isDeleting}
            >
              Cancel
            </ButtonLarge>
            <ButtonLarge onClick={handleDelete} disabled={isDeleting}>
              {isDeleting ? 'Deleting…' : 'Delete'}
            </ButtonLarge>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

// Re-export for easy sidebar icon usage
export { McpIcon } from '@/components/icons/McpIcon';
