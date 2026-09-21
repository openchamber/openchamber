import * as React from "react";
import { ContextMenu as BaseContextMenu } from "@base-ui/react/context-menu";

import { cn } from "@/lib/utils";
import {
  dropdownMenuItemClass,
  dropdownMenuPopupClass,
  dropdownMenuSeparatorClass,
} from "./dropdown-menu.styles";
import { handleDropdownNavigationKey } from "./dropdown-navigation";

function ContextMenu({ ...props }: React.ComponentProps<typeof BaseContextMenu.Root>) {
  return <BaseContextMenu.Root {...props} />;
}

function ContextMenuTrigger({ ...props }: React.ComponentProps<typeof BaseContextMenu.Trigger>) {
  return <BaseContextMenu.Trigger {...props} />;
}

type ContentProps = {
  className?: string;
  positionerClassName?: string;
  children?: React.ReactNode;
} & React.ComponentProps<typeof BaseContextMenu.Popup>;

function ContextMenuContent({ className, positionerClassName, children, style, onKeyDown, ...props }: ContentProps) {
  const handleKeyDown: NonNullable<React.ComponentProps<typeof BaseContextMenu.Popup>["onKeyDown"]> = (event) => {
    onKeyDown?.(event);
    handleDropdownNavigationKey(event, (navigationKey) => {
      event.currentTarget.dispatchEvent(new KeyboardEvent("keydown", {
        key: navigationKey,
        bubbles: true,
        cancelable: true,
      }));
    });
  };

  return (
    <BaseContextMenu.Portal>
      <BaseContextMenu.Positioner className={cn("app-region-no-drag z-50", positionerClassName)}>
        <BaseContextMenu.Popup
          data-slot="dropdown-menu-content"
          style={{
            color: "var(--surface-elevated-foreground)",
            ...style,
          }}
          className={cn(dropdownMenuPopupClass, className)}
          {...props}
          onKeyDown={handleKeyDown}
        >
          {children}
        </BaseContextMenu.Popup>
      </BaseContextMenu.Positioner>
    </BaseContextMenu.Portal>
  );
}

function ContextMenuItem({ className, ...props }: React.ComponentProps<typeof BaseContextMenu.Item>) {
  return <BaseContextMenu.Item className={cn(dropdownMenuItemClass, className)} {...props} />;
}

function ContextMenuSeparator({ className, ...props }: React.ComponentProps<typeof BaseContextMenu.Separator>) {
  return <BaseContextMenu.Separator className={cn(dropdownMenuSeparatorClass, className)} {...props} />;
}

export {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
};
