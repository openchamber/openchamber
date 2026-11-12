import * as React from "react"
import { Menu as BaseMenu } from "@base-ui/react/menu"

import { cn } from "@/lib/utils"
import { useHeightMorphRef } from "@/lib/motion/useSizeMorph"
import { Icon } from "@/components/icon/Icon";
import { shortcutRegistry } from "@/lib/shortcuts";
import { handleDropdownNavigationKey } from "./dropdown-navigation";
import { useMenuWindowDismiss } from "./menu-window-dismiss";
import { dropdownMenuItemClass, dropdownMenuPopupClass, dropdownMenuSeparatorClass, dropdownMenuSubTriggerClass } from "./dropdown-menu.styles";
import { GlassRedrawGuard } from "./glass-redraw-guard"
import { PopupOverlayScrollbar } from "./AttachedOverlayScrollbar"

type AsChildProps = { asChild?: boolean };
type AsChildRenderProps = {
  render?: React.ReactElement;
  children?: React.ReactNode;
};

type DropdownPortalContextValue = {
  portalContainer: HTMLElement | null;
  collisionBoundary: Element | null;
  setPortalContainer: (container: HTMLElement | null) => void;
  setCollisionBoundary: (boundary: Element | null) => void;
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

// The wrapper owns `actionsRef` to close the menu on window blur.
type DropdownMenuProps = Omit<React.ComponentProps<typeof BaseMenu.Root>, "actionsRef"> & {
  disableGlobalShortcuts?: boolean;
};

function DropdownMenu({
  disableGlobalShortcuts = false,
  open,
  defaultOpen,
  onOpenChange,
  ...props
}: DropdownMenuProps) {
  const [portalContainer, setPortalContainer] = React.useState<HTMLElement | null>(null);
  const [collisionBoundary, setCollisionBoundary] = React.useState<Element | null>(null);
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen ?? false);
  const isOpen = open ?? uncontrolledOpen;
  const openedOnHoverRef = React.useRef(false);
  const actionsRef = useMenuWindowDismiss(isOpen);
  const portalContextValue = React.useMemo<DropdownPortalContextValue>(() => ({
    portalContainer,
    collisionBoundary,
    setPortalContainer,
    setCollisionBoundary,
  }), [collisionBoundary, portalContainer]);

  React.useLayoutEffect(() => {
    if (!disableGlobalShortcuts || !isOpen) return;
    return shortcutRegistry.suspend();
  }, [disableGlobalShortcuts, isOpen]);

  React.useLayoutEffect(() => {
    if (!isOpen) openedOnHoverRef.current = false;
  }, [isOpen]);

  const handleOpenChange: NonNullable<React.ComponentProps<typeof BaseMenu.Root>['onOpenChange']> = (nextOpen, eventDetails) => {
    // Base UI treats a state-driven opening as hover-dismissible because it has
    // no opening DOM event. Filtering can move the popup off a stationary mouse.
    if (!nextOpen && eventDetails.reason === 'trigger-hover' && !openedOnHoverRef.current) {
      eventDetails.cancel();
      return;
    }
    onOpenChange?.(nextOpen, eventDetails);
    if (eventDetails.isCanceled) return;
    if (nextOpen) openedOnHoverRef.current = eventDetails.reason === 'trigger-hover';
    if (open === undefined) setUncontrolledOpen(nextOpen);
  };

  return (
    <DropdownPortalContext.Provider value={portalContextValue}>
      <BaseMenu.Root
        {...props}
        actionsRef={actionsRef}
        defaultOpen={defaultOpen}
        open={open}
        onOpenChange={handleOpenChange}
      />
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
    portalContext.setCollisionBoundary(element?.closest('main') ?? null);
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
  constrainToMain?: boolean;
  collisionAvoidance?: React.ComponentProps<typeof BaseMenu.Positioner>["collisionAvoidance"];
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
  constrainToMain = false,
  collisionAvoidance,
  style,
  children,
  onCloseAutoFocus,
  onKeyDown,
  ref,
  ...props
}: ContentProps) {
  const portalContext = React.useContext(DropdownPortalContext);
  void onCloseAutoFocus
  // Content that changes while the menu is open (a filtered picker list,
  // items that arrive late) eases the popup into its new height.
  const morphHeight = useHeightMorphRef();
  const [popup, setPopup] = React.useState<HTMLDivElement | null>(null);
  // Returns its cleanup (React 19), so a caller's ref keeps its own: a
  // cleanup it returned runs, else it gets null as before.
  const setPopupRef = React.useCallback((node: HTMLDivElement | null) => {
    morphHeight(node);
    setPopup(node);
    const cleanup = typeof ref === 'function' ? ref(node) : undefined;
    if (ref && typeof ref !== 'function') ref.current = node;
    return () => {
      morphHeight(null);
      setPopup(null);
      if (typeof cleanup === 'function') cleanup();
      else if (typeof ref === 'function') ref(null);
      else if (ref) ref.current = null;
    };
  }, [morphHeight, ref]);

  const handleKeyDown: NonNullable<React.ComponentProps<typeof BaseMenu.Popup>['onKeyDown']> = (event) => {
    onKeyDown?.(event);
    handleDropdownNavigationKey(event, (navigationKey) => {
      event.currentTarget.dispatchEvent(new KeyboardEvent('keydown', {
        key: navigationKey,
        bubbles: true,
        cancelable: true,
      }));
    });
  };

  return (
    <BaseMenu.Portal className="contents" container={portalToBody ? undefined : portalContext?.portalContainer || undefined}>
      <BaseMenu.Positioner
        sideOffset={sideOffset}
        align={align}
        side={side}
        alignOffset={alignOffset}
        collisionBoundary={constrainToMain ? portalContext?.collisionBoundary ?? undefined : undefined}
        collisionAvoidance={collisionAvoidance}
        className={cn("app-region-no-drag z-50", positionerClassName)}
      >
        <BaseMenu.Popup
          ref={setPopupRef}
          data-slot="dropdown-menu-content"
          style={{
            color: 'var(--surface-elevated-foreground)',
            ...style,
          }}
          className={cn(
            dropdownMenuPopupClass,
            "overlay-scrollbar-target",
            className
          )}
          {...props}
          onKeyDown={handleKeyDown}
        >
          {children}
          <GlassRedrawGuard />
        </BaseMenu.Popup>
        {/* A menu scrolls only where its caller gave it overflow; the thumb
            shows only then. */}
        <PopupOverlayScrollbar scroller={popup} />
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
        "data-[highlighted]:bg-interactive-hover hover:bg-interactive-hover relative flex cursor-pointer items-start gap-2 rounded-lg py-1 ps-2 pe-8 typography-ui-label outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
        className
      )}
      {...props}
    >
      <span className="pointer-events-none absolute inset-e-2 flex size-3.5 items-center justify-center text-foreground">
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
        "px-2 py-1 typography-ui-label font-medium text-muted-foreground data-[inset]:ps-8",
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
      <Icon name="arrow-right-s" className="ms-auto size-3.5" />
    </BaseMenu.SubmenuTrigger>
  )
}

function DropdownMenuSubContent({
  className,
  children,
  onKeyDown,
  ...props
}: Omit<React.ComponentProps<typeof BaseMenu.Popup>, 'ref'>) {
  const portalContext = React.useContext(DropdownPortalContext);
  const [popup, setPopup] = React.useState<HTMLDivElement | null>(null);
  const handleKeyDown: NonNullable<React.ComponentProps<typeof BaseMenu.Popup>['onKeyDown']> = (event) => {
    onKeyDown?.(event);
    handleDropdownNavigationKey(event, (navigationKey) => {
      event.currentTarget.dispatchEvent(new KeyboardEvent('keydown', {
        key: navigationKey,
        bubbles: true,
        cancelable: true,
      }));
    });
  };

  return (
    <BaseMenu.Portal className="contents" container={portalContext?.portalContainer || undefined}>
      <BaseMenu.Positioner className="z-50">
        <BaseMenu.Popup
          ref={setPopup}
          data-slot="dropdown-menu-sub-content"
          style={{
            color: 'var(--surface-elevated-foreground)',
          }}
          className={cn(
            dropdownMenuPopupClass,
            "overlay-scrollbar-target",
            className
          )}
          {...props}
          onKeyDown={handleKeyDown}
        >
          {children}
          <GlassRedrawGuard />
        </BaseMenu.Popup>
        <PopupOverlayScrollbar scroller={popup} />
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
