import React from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { RiMore2Line } from '@remixicon/react';
import { cn } from '@/lib/utils';

export interface SettingsSidebarItemAction {
  /** Label shown in dropdown menu */
  label: string;
  /** Icon component to show before label */
  icon?: React.ComponentType<{ className?: string }>;
  /** Callback when action is clicked */
  onClick: () => void;
  /** If true, uses destructive styling (red text) */
  destructive?: boolean;
}

interface SettingsSidebarItemProps {
  /** Primary title text */
  title: React.ReactNode;
  /** Secondary metadata text (shown below title) */
  metadata?: React.ReactNode;
  /** Whether this item is currently selected */
  selected?: boolean;
  /** Callback when item is clicked */
  onSelect: () => void;
  /** Optional icon to show before title */
  icon?: React.ReactNode;
  /** Actions shown in dropdown menu. If empty/undefined, no dropdown is shown. */
  actions?: SettingsSidebarItemAction[];
  /** Additional className for the outer container */
  className?: string;
}

/**
 * Standard list item for settings sidebars.
 * Provides consistent styling for title, metadata, selection state, and optional actions dropdown.
 *
 * @example
 * <SettingsSidebarItem
 *   title={agent.name}
 *   metadata={agent.description}
 *   selected={selectedId === agent.id}
 *   onSelect={() => setSelectedId(agent.id)}
 *   icon={<RiRobotLine className="h-4 w-4" />}
 *   actions={[
 *     { label: 'Duplicate', icon: RiFileCopyLine, onClick: handleDuplicate },
 *     { label: 'Delete', icon: RiDeleteBinLine, onClick: handleDelete, destructive: true },
 *   ]}
 * />
 */
export const SettingsSidebarItem: React.FC<SettingsSidebarItemProps> = ({
  title,
  metadata,
  selected = false,
  onSelect,
  icon,
  actions,
  className,
}) => {
  const hasActions = actions && actions.length > 0;

  return (
    <div
      className={cn(
        'group relative flex items-center rounded-md px-1.5 py-0.5 transition-all duration-200',
        selected
          ? 'bg-interactive-selection'
          : 'hover:bg-interactive-hover',
        className
      )}
    >
      <div className="flex min-w-0 flex-1 items-center">
        <button
          onClick={onSelect}
          className="flex min-w-0 flex-1 flex-col gap-0 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
          tabIndex={0}
        >
          <div className="flex items-center gap-1.5">
            {icon}
            <span className="typography-ui-label font-normal truncate text-foreground">
              {title}
            </span>
          </div>

          {metadata && (
            <div className="typography-micro text-muted-foreground/60 truncate leading-tight">
              {metadata}
            </div>
          )}
        </button>

        {hasActions && (
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
              {actions.map((action, index) => {
                const Icon = action.icon;
                return (
                  <DropdownMenuItem
                    key={index}
                    onClick={(e) => {
                      e.stopPropagation();
                      action.onClick();
                    }}
                    className={cn(
                      action.destructive && 'text-destructive focus:text-destructive'
                    )}
                  >
                    {Icon && <Icon className="h-4 w-4 mr-px" />}
                    {action.label}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </div>
  );
};
