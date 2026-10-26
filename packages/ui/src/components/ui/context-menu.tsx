import * as React from "react";
import { ContextMenu as BaseContextMenu } from "@base-ui/react/context-menu";

import { cn } from "@/lib/utils";
import {
  dropdownMenuItemClass,
  dropdownMenuPopupClass,
  dropdownMenuSeparatorClass,
  dropdownMenuSubTriggerClass,
} from "./dropdown-menu.styles";
import { Icon } from "@/components/icon/Icon";
import { GlassRedrawGuard } from "./glass-redraw-guard"
import { handleDropdownNavigationKey } from "./dropdown-navigation";
import { useMenuWindowDismiss } from "./menu-window-dismiss";

// The wrapper owns `actionsRef` to close the menu on window blur.
function ContextMenu({ open, defaultOpen, onOpenChange, ...props }: Omit<React.ComponentProps<typeof BaseContextMenu.Root>, "actionsRef">) {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen ?? false);
  const actionsRef = useMenuWindowDismiss(open ?? uncontrolledOpen);

  const handleOpenChange: NonNullable<React.ComponentProps<typeof BaseContextMenu.Root>["onOpenChange"]> = (nextOpen, eventDetails) => {
    if (open === undefined) setUncontrolledOpen(nextOpen);
    onOpenChange?.(nextOpen, eventDetails);
  };

  return (
    <BaseContextMenu.Root
      {...props}
      actionsRef={actionsRef}
      defaultOpen={defaultOpen}
      open={open}
      onOpenChange={handleOpenChange}
    />
  );
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
          <GlassRedrawGuard />
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

const ContextMenuSub = BaseContextMenu.SubmenuRoot;

function ContextMenuSubTrigger({ className, children, ...props }: React.ComponentProps<typeof BaseContextMenu.SubmenuTrigger>) {
  return (
    <BaseContextMenu.SubmenuTrigger className={cn(dropdownMenuSubTriggerClass, className)} {...props}>
      {children}
      <Icon name="arrow-right-s" className="ms-auto size-3.5" />
    </BaseContextMenu.SubmenuTrigger>
  );
}

function ContextMenuSubContent({ className, children, style, ...props }: React.ComponentProps<typeof BaseContextMenu.Popup>) {
  return (
    <BaseContextMenu.Portal>
      <BaseContextMenu.Positioner className="app-region-no-drag z-50">
        <BaseContextMenu.Popup
          data-slot="dropdown-menu-sub-content"
          style={{
            color: "var(--surface-elevated-foreground)",
            ...style,
          }}
          className={cn(dropdownMenuPopupClass, className)}
          {...props}
        >
          {children}
          <GlassRedrawGuard />
        </BaseContextMenu.Popup>
      </BaseContextMenu.Positioner>
    </BaseContextMenu.Portal>
  );
}

export {
  ContextMenu,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
};
