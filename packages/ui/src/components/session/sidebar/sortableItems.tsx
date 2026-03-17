import React from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import {
  RiAddLine,
  RiCheckLine,
  RiCloseLine,
  RiGitBranchLine,
  RiMore2Line,
  RiPencilAiLine,
} from '@remixicon/react';
import { ArrowsMerge } from '@/components/icons/ArrowsMerge';
import { cn } from '@/lib/utils';

export interface SortableProjectItemProps {
  id: string;
  projectLabel: string;
  projectDescription: string;
  isCollapsed: boolean;
  isActiveProject: boolean;
  isRepo: boolean;
  isHovered: boolean;
  isDesktopShell: boolean;
  isStuck: boolean;
  hideDirectoryControls: boolean;
  mobileVariant: boolean;
  onToggle: () => void;
  onHoverChange: (hovered: boolean) => void;
  onNewSession: () => void;
  onNewWorktreeSession?: () => void;
  onOpenMultiRunLauncher: () => void;
  onRenameStart: () => void;
  onRenameSave: () => void;
  onRenameCancel: () => void;
  onRenameValueChange: (value: string) => void;
  renameValue: string;
  isRenaming: boolean;
  onClose: () => void;
  sentinelRef: (el: HTMLDivElement | null) => void;
  children?: React.ReactNode;
  settingsAutoCreateWorktree: boolean;
  showCreateButtons?: boolean;
  hideHeader?: boolean;
}

export const SortableProjectItem: React.FC<SortableProjectItemProps> = ({
  id,
  projectLabel,
  projectDescription,
  isCollapsed,
  isActiveProject,
  isRepo,
  isHovered,
  isDesktopShell,
  isStuck,
  hideDirectoryControls,
  mobileVariant,
  onToggle,
  onHoverChange,
  onNewSession,
  onNewWorktreeSession,
  onOpenMultiRunLauncher,
  onRenameStart,
  onRenameSave,
  onRenameCancel,
  onRenameValueChange,
  renameValue,
  isRenaming,
  onClose,
  sentinelRef,
  children,
  settingsAutoCreateWorktree,
  showCreateButtons = true,
  hideHeader = false,
}) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  const [isMenuOpen, setIsMenuOpen] = React.useState(false);

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn('relative', isDragging && 'opacity-30')}
    >
      {!hideHeader ? (
        <>
          {isDesktopShell && (
            <div
              ref={sentinelRef}
              data-project-id={id}
              className="absolute top-0 h-px w-full pointer-events-none"
              aria-hidden="true"
            />
          )}

          <div
            className={cn(
              'sticky top-0 z-10 pt-2 pb-1.5 w-full text-left cursor-pointer group/project border-b select-none',
              !isDesktopShell && 'bg-transparent',
            )}
            style={{
              backgroundColor: isDesktopShell
                ? (isStuck ? 'transparent' : 'transparent')
                : undefined,
              borderColor: isHovered
                ? 'var(--color-border-hover)'
                : isCollapsed
                  ? 'color-mix(in srgb, var(--color-border) 35%, transparent)'
                  : 'var(--color-border)',
            }}
            onMouseEnter={() => onHoverChange(true)}
            onMouseLeave={() => onHoverChange(false)}
            onContextMenu={(event) => {
              event.preventDefault();
              if (!isRenaming) {
                setIsMenuOpen(true);
              }
            }}
          >
            <div className="relative flex items-center gap-1 px-1" {...attributes}>
              {isRenaming ? (
                <form
                  className="flex min-w-0 flex-1 items-center gap-2"
                  data-keyboard-avoid="true"
                  onSubmit={(event) => {
                    event.preventDefault();
                    onRenameSave();
                  }}
                >
                  <input
                    value={renameValue}
                    onChange={(event) => onRenameValueChange(event.target.value)}
                    className="flex-1 min-w-0 bg-transparent typography-ui-label outline-none placeholder:text-muted-foreground"
                    autoFocus
                    placeholder="Rename project"
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') {
                        event.stopPropagation();
                        onRenameCancel();
                        return;
                      }
                      if (event.key === ' ' || event.key === 'Enter') {
                        event.stopPropagation();
                      }
                    }}
                  />
                  <button
                    type="submit"
                    className="shrink-0 text-muted-foreground hover:text-foreground"
                  >
                    <RiCheckLine className="size-4" />
                  </button>
                  <button
                    type="button"
                    onClick={onRenameCancel}
                    className="shrink-0 text-muted-foreground hover:text-foreground"
                  >
                    <RiCloseLine className="size-4" />
                  </button>
                </form>
              ) : (
                <Tooltip delayDuration={1500}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={onToggle}
                      {...listeners}
                      className="flex-1 min-w-0 flex items-center gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 rounded-sm cursor-grab active:cursor-grabbing"
                    >
                      <span className={cn(
                        'typography-ui font-semibold truncate',
                        isActiveProject ? 'text-primary' : 'text-foreground group-hover/project:text-foreground',
                      )}>
                        {projectLabel}
                      </span>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="right" sideOffset={8}>
                    {projectDescription}
                  </TooltipContent>
                </Tooltip>
              )}

              {!isRenaming ? (
                <DropdownMenu
                  open={isMenuOpen}
                  onOpenChange={setIsMenuOpen}
                >
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      className={cn(
                        'inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 hover:text-foreground',
                        mobileVariant ? 'opacity-70' : 'opacity-0 group-hover/project:opacity-100',
                      )}
                      aria-label="Project menu"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <RiMore2Line className="h-3.5 w-3.5" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-[180px]">
                    {showCreateButtons && isRepo && !hideDirectoryControls && settingsAutoCreateWorktree && onNewSession && (
                      <DropdownMenuItem onClick={onNewSession}>
                        <RiAddLine className="mr-1.5 h-4 w-4" />
                        New Session
                      </DropdownMenuItem>
                    )}
                    {showCreateButtons && isRepo && !hideDirectoryControls && !settingsAutoCreateWorktree && onNewWorktreeSession && (
                      <DropdownMenuItem onClick={onNewWorktreeSession}>
                        <RiGitBranchLine className="mr-1.5 h-4 w-4" />
                        New Session in Worktree
                      </DropdownMenuItem>
                    )}
                    {showCreateButtons && isRepo && !hideDirectoryControls && (
                      <DropdownMenuItem onClick={onOpenMultiRunLauncher}>
                        <ArrowsMerge className="mr-1.5 h-4 w-4" />
                        New Multi-Run
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem onClick={onRenameStart}>
                      <RiPencilAiLine className="mr-1.5 h-4 w-4" />
                      Rename
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={onClose}
                      className="text-destructive focus:text-destructive"
                    >
                      <RiCloseLine className="mr-1.5 h-4 w-4" />
                      Close Project
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}

              {showCreateButtons && isRepo && !hideDirectoryControls && onNewWorktreeSession && settingsAutoCreateWorktree && !isRenaming && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onNewWorktreeSession();
                      }}
                      className={cn(
                        'inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 hover:text-foreground hover:bg-interactive-hover/50 flex-shrink-0',
                        mobileVariant ? 'opacity-70' : 'opacity-100',
                      )}
                      aria-label="New session in worktree"
                    >
                      <RiGitBranchLine className="h-4 w-4" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" sideOffset={4}>
                    <p>New session in worktree</p>
                  </TooltipContent>
                </Tooltip>
              )}
              {showCreateButtons && (!settingsAutoCreateWorktree || !isRepo) && !isRenaming && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onNewSession();
                      }}
                      className="inline-flex h-6 w-6 items-center justify-center text-muted-foreground hover:text-foreground hover:bg-interactive-hover/50 flex-shrink-0 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                      aria-label="New session"
                    >
                      <RiAddLine className="h-4 w-4" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" sideOffset={4}>
                    <p>New session</p>
                  </TooltipContent>
                </Tooltip>
              )}
            </div>
          </div>
        </>
      ) : null}

      {children}
    </div>
  );
};

const SortableGroupItemBase: React.FC<{
  id: string;
  disabled?: boolean;
  children: React.ReactNode;
}> = ({ id, disabled = false, children }) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled });

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
      }}
      className={cn(
        'space-y-0.5 rounded-md',
        isDragging && 'opacity-50',
      )}
      {...attributes}
      {...listeners}
    >
      {children}
    </div>
  );
};

export const SortableGroupItem = React.memo(SortableGroupItemBase);
