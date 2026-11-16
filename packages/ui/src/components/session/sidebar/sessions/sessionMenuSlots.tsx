import React from 'react';
import { ContextMenu } from '@base-ui/react/context-menu';
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu';
import { dropdownMenuItemClass, dropdownMenuPopupClass, dropdownMenuSeparatorClass, dropdownMenuSubTriggerClass } from '@/components/ui/dropdown-menu.styles';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';

/** Menu primitives of the surface a session menu opens in. */
export type SessionMenuSlots = {
  Item: React.ElementType;
  Separator: React.ElementType;
  Sub: React.ElementType;
  SubTrigger: React.ElementType;
  SubContent: React.ElementType;
};

export const dropdownSessionMenuSlots: SessionMenuSlots = {
  Item: DropdownMenuItem,
  Separator: DropdownMenuSeparator,
  Sub: DropdownMenuSub,
  SubTrigger: DropdownMenuSubTrigger,
  SubContent: DropdownMenuSubContent,
};

export const contextSessionMenuSlots: SessionMenuSlots = {
  Item: ({ className, ...props }: React.ComponentProps<typeof ContextMenu.Item>) => (
    <ContextMenu.Item className={cn(dropdownMenuItemClass, className)} {...props} />
  ),
  Separator: ({ className, ...props }: React.ComponentProps<typeof ContextMenu.Separator>) => (
    <ContextMenu.Separator className={cn(dropdownMenuSeparatorClass, className)} {...props} />
  ),
  Sub: ContextMenu.SubmenuRoot,
  SubTrigger: ({ className, children, ...props }: React.ComponentProps<typeof ContextMenu.SubmenuTrigger>) => (
    <ContextMenu.SubmenuTrigger className={cn(dropdownMenuSubTriggerClass, className)} {...props}>
      {children}
      <Icon name="arrow-right-s" className="ms-auto size-3.5" />
    </ContextMenu.SubmenuTrigger>
  ),
  SubContent: ({ className, children, ...props }: React.ComponentProps<typeof ContextMenu.Popup>) => (
    <ContextMenu.Portal>
      <ContextMenu.Positioner className="app-region-no-drag z-50">
        <ContextMenu.Popup
          data-slot="dropdown-menu-sub-content"
          style={{
            backgroundColor: 'var(--surface-elevated)',
            color: 'var(--surface-elevated-foreground)',
          }}
          className={cn(dropdownMenuPopupClass, className)}
          {...props}
        >
          {children}
        </ContextMenu.Popup>
      </ContextMenu.Positioner>
    </ContextMenu.Portal>
  ),
};
