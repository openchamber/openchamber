import React, { useEffect, useState } from 'react';
import { useWorkspaceStore, type Workspace } from '@/stores/team/workspace';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { RiGroupLine, RiArrowDownSLine } from '@remixicon/react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';

export const WorkspaceSwitcher: React.FC = () => {
  const { teams } = useRuntimeAPIs();
  const { workspaces, activeWorkspaceId, setWorkspaces, setActiveWorkspace } = useWorkspaceStore();
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    if (!teams) return;
    teams.workspacesList()
      .then((res) => {
        if (res.ok && res.data) {
          setWorkspaces(res.data.workspaces as unknown as Workspace[]);
          if (!activeWorkspaceId && res.data.workspaces.length > 0) {
            setActiveWorkspace((res.data.workspaces[0] as unknown as Workspace).id);
          }
        }
      })
      .catch(() => {});
  }, [teams, setWorkspaces, activeWorkspaceId, setActiveWorkspace]);

  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId);

  if (workspaces.length === 0) {
    return null;
  }

  return (
    <DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="h-8 gap-1 px-2 text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]">
          <RiGroupLine className="size-4" />
          <span className="typography-micro hidden md:inline">{activeWorkspace?.display_name || 'Workspaces'}</span>
          <RiArrowDownSLine className="size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <div className="px-2 py-1.5 typography-micro text-[hsl(var(--muted-foreground))]">Switch Workspace</div>
        <DropdownMenuSeparator />
        {workspaces.map((w) => (
          <DropdownMenuItem
            key={w.id}
            onSelect={() => setActiveWorkspace(w.id)}
            className="flex items-center justify-between"
          >
            <span className="truncate">{w.display_name}</span>
            {w.id === activeWorkspaceId && <span className="text-[hsl(var(--status-success))] text-xs">✓</span>}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
