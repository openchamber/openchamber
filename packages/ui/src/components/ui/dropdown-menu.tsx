import * as React from "react"
import { Menu as BaseMenu } from "@base-ui/react/menu"

import { cn } from "@/lib/utils"
import { Icon } from "@/components/icon/Icon";
import { dropdownMenuItemClass, dropdownMenuPopupClass, dropdownMenuSeparatorClass, dropdownMenuSubTriggerClass } from "./dropdown-menu.styles";

type AsChildProps = { asChild?: boolean };
type AsChildRenderProps = {
  render?: React.ReactElement;
  children?: React.ReactNode;
};

type DropdownPortalContextValue = {
  portalContainer: HTMLElement | null;
  setPortalContainer: (container: HTMLElement | null) => void;
};

const DropdownPortalContext = React.createContext<DropdownPortalContextValue | null>(null);

const resolveDialogContainer = (element: HTMLElement | null): HTMLElement | null => {
  if (!element) {
    return null;
  }
  return element.closest('[data-slot="dialog-content"], [role="dialog"]') as HTMLElement | null;
};

function renderFromAsChild(asChild: boolean | undefined, children: React.ReactNode) {
  if (asChild && React.isValidElement(children)) {
    return { render: children as React.ReactElement } satisfies AsChildRenderProps;
  }
  return { children };
}

function DropdownMenu({
  ...props
}: React.ComponentProps<typeof BaseMenu.Root>) {
  const [portalContainer, setPortalContainer] = React.useState<HTMLElement | null>(null);
  const portalContextValue = React.useMemo<DropdownPortalContextValue>(() => ({
    portalContainer,
    setPortalContainer,
  }), [portalContainer]);

  return (
    <DropdownPortalContext.Provider value={portalContextValue}>
      <BaseMenu.Root {...props} />
    </DropdownPortalContext.Provider>
  )
}

function DropdownMenuTrigger({
  asChild,
  children,
  onPointerDownCapture,
  onFocusCapture,
  ...props
}: React.ComponentProps<typeof BaseMenu.Trigger> & AsChildProps) {
  const portalContext = React.useContext(DropdownPortalContext);
  const syncPortalContainer = React.useCallback((target: EventTarget | null) => {
    if (!portalContext) {
      return;
    }
    const element = target instanceof HTMLElement ? target : null;
    portalContext.setPortalContainer(resolveDialogContainer(element));
  }, [portalContext]);

  const r = renderFromAsChild(asChild, children);
  return (
    <BaseMenu.Trigger
      data-slot="dropdown-menu-trigger"
      onPointerDownCapture={(event) => {
        syncPortalContainer(event.currentTarget);
        onPointerDownCapture?.(event);
      }}
      onFocusCapture={(event) => {
        syncPortalContainer(event.currentTarget);
        onFocusCapture?.(event);
      }}
      {...props}
      {...r}
    />
  )
}

type ContentProps = {
  sideOffset?: number;
  align?: "start" | "center" | "end";
  side?: "top" | "right" | "bottom" | "left";
  alignOffset?: number;
  portalToBody?: boolean;
  positionerClassName?: string;
  style?: React.CSSProperties;
  className?: string;
  children?: React.ReactNode;
  onCloseAutoFocus?: (event: Event) => void;
} & Omit<React.ComponentProps<typeof BaseMenu.Popup>, "style" | "className" | "children">

function DropdownMenuContent({
  className,
  sideOffset = 4,
  align,
  side,
  alignOffset,
  portalToBody = false,
  positionerClassName,
  style,
  children,
  onCloseAutoFocus,
  ...props
}: ContentProps) {
  const portalContext = React.useContext(DropdownPortalContext);
  void onCloseAutoFocus

  return (
    <BaseMenu.Portal container={portalToBody ? undefined : portalContext?.portalContainer || undefined}>
      <BaseMenu.Positioner
        sideOffset={sideOffset}
        align={align}
        side={side}
        alignOffset={alignOffset}
        className={cn("app-region-no-drag z-50", positionerClassName)}
      >
        <BaseMenu.Popup
          data-slot="dropdown-menu-content"
          style={{
            backgroundColor: 'var(--surface-elevated)',
            color: 'var(--surface-elevated-foreground)',
            ...style,
          }}
          className={cn(
            dropdownMenuPopupClass,
            className
          )}
          {...props}
        >
          {children}
        </BaseMenu.Popup>
      </BaseMenu.Positioner>
    </BaseMenu.Portal>
  )
}

function DropdownMenuItem({
  className,
  inset,
  variant = "default",
  asChild,
  children,
  onSelect,
  onClick,
  ...props
}: React.ComponentProps<typeof BaseMenu.Item> & AsChildProps & {
  inset?: boolean
  variant?: "default" | "destructive"
  onSelect?: React.ComponentProps<typeof BaseMenu.Item>["onClick"]
}) {
  const r = renderFromAsChild(asChild, children);
  const handleClick: NonNullable<React.ComponentProps<typeof BaseMenu.Item>["onClick"]> = (event) => {
    onClick?.(event);
    if (!event.defaultPrevented) onSelect?.(event);
  };
  return (
    <BaseMenu.Item
      data-slot="dropdown-menu-item"
      data-inset={inset}
      data-variant={variant}
      className={cn(
        dropdownMenuItemClass,
        className
      )}
      {...props}
      onClick={handleClick}
      {...r}
    />
  )
}

function DropdownMenuRadioGroup({
  ...props
}: React.ComponentProps<typeof BaseMenu.RadioGroup>) {
  return <BaseMenu.RadioGroup data-slot="dropdown-menu-radio-group" {...props} />
}

function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof BaseMenu.RadioItem>) {
  return (
    <BaseMenu.RadioItem
      data-slot="dropdown-menu-radio-item"
      className={cn(
        "data-[highlighted]:bg-interactive-hover hover:bg-interactive-hover data-[checked]:bg-interactive-selection data-[checked]:text-interactive-selection-foreground relative flex cursor-pointer items-start gap-2 rounded-lg py-1 pl-2 pr-8 typography-ui-label outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
        className
      )}
      {...props}
    >
      <span className="pointer-events-none absolute right-2 flex size-3.5 items-center justify-center text-primary">
        <BaseMenu.RadioItemIndicator>
          <Icon name="check" className="size-3" />
        </BaseMenu.RadioItemIndicator>
      </span>
      {children}
    </BaseMenu.RadioItem>
  )
}

function DropdownMenuLabel({
  className,
  inset,
  ...props
}: React.ComponentProps<"div"> & {
  inset?: boolean
}) {
  return (
    <div
      data-slot="dropdown-menu-label"
      data-inset={inset}
      className={cn(
        "px-2 py-1 typography-ui-label font-medium data-[inset]:pl-8",
        className
      )}
      {...props}
    />
  )
}

function DropdownMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof BaseMenu.Separator>) {
  return (
    <BaseMenu.Separator
      data-slot="dropdown-menu-separator"
      className={cn(dropdownMenuSeparatorClass, className)}
      {...props}
    />
  )
}

function DropdownMenuSub({
  ...props
}: React.ComponentProps<typeof BaseMenu.SubmenuRoot>) {
  return <BaseMenu.SubmenuRoot {...props} />
}

function DropdownMenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: React.ComponentProps<typeof BaseMenu.SubmenuTrigger> & {
  inset?: boolean
}) {
  return (
    <BaseMenu.SubmenuTrigger
      data-slot="dropdown-menu-sub-trigger"
      data-inset={inset}
      className={cn(
        dropdownMenuSubTriggerClass,
        className
      )}
      {...props}
    >
      {children}
      <Icon name="arrow-right-s" className="ml-auto size-3.5" />
    </BaseMenu.SubmenuTrigger>
  )
}

function DropdownMenuSubContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof BaseMenu.Popup>) {
  const portalContext = React.useContext(DropdownPortalContext);
  return (
    <BaseMenu.Portal container={portalContext?.portalContainer || undefined}>
      <BaseMenu.Positioner className="z-50">
        <BaseMenu.Popup
          data-slot="dropdown-menu-sub-content"
          style={{
            backgroundColor: 'var(--surface-elevated)',
            color: 'var(--surface-elevated-foreground)',
          }}
          className={cn(
            dropdownMenuPopupClass,
            className
          )}
          {...props}
        >
          {children}
        </BaseMenu.Popup>
      </BaseMenu.Positioner>
    </BaseMenu.Portal>
  )
}

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
}
