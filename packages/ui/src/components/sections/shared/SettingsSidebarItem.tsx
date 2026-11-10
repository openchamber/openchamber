import React from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu';
import { Icon } from "@/components/icon/Icon";
import type { IconName } from "@/components/icon/icons";
import { cn } from '@/lib/utils';

interface SettingsSidebarItemAction {
  /** Label shown in dropdown menu */
  label: string;
  /** Icon component to show before label */
  icon?: IconName;
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
  /** Actions of the row's right-click menu, and of its ⋯ menu on touch screens. If empty/undefined, the row has no menu. */
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
 *   icon={<'robot' className="h-4 w-4" />}
 *   actions={[
 *     { label: 'Duplicate', icon: 'file-copy', onClick: handleDuplicate },
 *     { label: 'Delete', icon: 'delete-bin', onClick: handleDelete, destructive: true },
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
  const rowClassName = cn(
    'group relative flex items-center rounded-md px-1.5 py-0.5 transition-all duration-200',
    selected
      ? 'bg-interactive-selection'
      : 'hover:bg-interactive-hover',
    className
  );
  const renderActionItems = (Item: typeof DropdownMenuItem | typeof ContextMenuItem) => actions?.map((action) => (
    <Item
      key={action.label}
      onClick={(e: React.MouseEvent) => {
        e.stopPropagation();
        action.onClick();
      }}
      className={cn(action.destructive && 'text-destructive focus:text-destructive')}
    >
      {action.icon && <Icon name={action.icon} className="h-4 w-4 me-px" />}
      {action.label}
    </Item>
  ));

  const content = (
      <div className="flex min-w-0 flex-1 items-center">
        <button
          onClick={onSelect}
          className="flex min-w-0 flex-1 flex-col gap-0 rounded-sm text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          tabIndex={0}
        >
          <div className="flex items-center gap-1.5">
            {icon}
            <span className="typography-ui-label font-normal truncate text-foreground">
              {title}
            </span>
          </div>

          {metadata && (
            <div className="typography-micro text-muted-foreground truncate leading-tight">
              {metadata}
            </div>
          )}
        </button>

        {/* Touch screens only: with a mouse the menu is the row's right
            click (Shift+F10 from the keyboard). */}
        {hasActions && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                className="h-6 w-6 flex-shrink-0 -me-1 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100 pointer-fine:hidden"
              >
                <Icon name="more" className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-fit min-w-20">
              {renderActionItems(DropdownMenuItem)}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
  );

  if (!hasActions) return <div className={rowClassName}>{content}</div>;

  return (
    <ContextMenu>
      <ContextMenuTrigger render={<div className={rowClassName} />}>
        {content}
      </ContextMenuTrigger>
      <ContextMenuContent className="w-fit min-w-20">
        {renderActionItems(ContextMenuItem)}
      </ContextMenuContent>
    </ContextMenu>
  );
};
