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
  label: string;
  icon?: IconName;
  onClick: () => void;
  destructive?: boolean;
}

interface SettingsSidebarItemProps {
  title: React.ReactNode;
  metadata?: React.ReactNode;
  selected?: boolean;
  onSelect: () => void;
  icon?: React.ReactNode;
  actions?: SettingsSidebarItemAction[];
  className?: string;
}

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
      ? 'oc-selected'
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
