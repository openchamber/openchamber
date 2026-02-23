import React from 'react';
import { Button } from '@/components/ui/button';
import { ButtonLarge } from '@/components/ui/button-large';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { RiAddLine, RiDeleteBinLine, RiMore2Line, RiPlugLine, RiServerLine } from '@remixicon/react';
import { useMcpConfigStore, type McpDraft, type McpServerConfig } from '@/stores/useMcpConfigStore';
import { useMcpStore } from '@/stores/useMcpStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { isVSCodeRuntime } from '@/lib/desktop';
import { cn } from '@/lib/utils';
import { toast } from '@/components/ui';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
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
    success: 'bg-green-500',
    error: 'bg-destructive',
    warning: 'bg-yellow-500',
    idle: 'bg-muted-foreground/40',
  };
  return (
    <span className={cn('inline-block h-2 w-2 rounded-full flex-shrink-0', classes[tone])} />
  );
};

export const McpSidebar: React.FC<McpSidebarProps> = ({ onItemSelect }) => {
  const isVSCode = React.useMemo(() => isVSCodeRuntime(), []);
  const bgClass = isVSCode ? 'bg-background' : 'bg-sidebar';

  const { mcpServers, selectedMcpName, setSelectedMcp, setMcpDraft, loadMcpConfigs, deleteMcp } =
    useMcpConfigStore();

  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const mcpStatus = useMcpStore((state) => state.getStatusForDirectory(currentDirectory ?? null));

  const [deleteTarget, setDeleteTarget] = React.useState<McpServerConfig | null>(null);
  const [isDeleting, setIsDeleting] = React.useState(false);

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
      {/* Header */}
      <div className="border-b px-3 py-3">
        <div className="flex items-center justify-between gap-2">
          <span className="typography-meta text-muted-foreground">
            {mcpServers.length} server{mcpServers.length !== 1 ? 's' : ''}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 -my-1 text-muted-foreground"
            onClick={handleCreateNew}
            title="Add MCP server"
          >
            <RiAddLine className="size-4" />
          </Button>
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
          mcpServers.map((server) => {
            const runtimeStatus = mcpStatus[server.name];
            const tone = statusToneFromMcp(runtimeStatus?.status);
            const isSelected = selectedMcpName === server.name;

            return (
              <div
                key={server.name}
                className={cn(
                  'group relative flex items-center rounded-md px-1.5 py-1 transition-all duration-200',
                  isSelected ? 'bg-interactive-selection' : 'hover:bg-interactive-hover',
                )}
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
                    <span className="typography-ui-label font-normal truncate text-foreground">
                      {server.name}
                    </span>
                    <span className="typography-micro text-muted-foreground bg-muted px-1 rounded flex-shrink-0 leading-none pb-px border border-border/50">
                      {server.type}
                    </span>
                    {!server.enabled && (
                      <span className="typography-micro text-muted-foreground/60 flex-shrink-0">
                        off
                      </span>
                    )}
                  </div>
                  <div className="typography-micro text-muted-foreground/60 truncate leading-tight pl-4">
                    {server.type === 'local'
                      ? (server as { command?: string[] }).command?.join(' ') ?? ''
                      : (server as { url?: string }).url ?? ''}
                  </div>
                </button>

                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-6 w-6 flex-shrink-0 -mr-1 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100"
                    >
                      <RiMore2Line className="h-3.5 w-3.5" />
                    </Button>
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
          })
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
            <Button
              variant="ghost"
              onClick={() => setDeleteTarget(null)}
              disabled={isDeleting}
              className="text-foreground hover:bg-interactive-hover hover:text-foreground"
            >
              Cancel
            </Button>
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
export { RiServerLine as McpIcon };
