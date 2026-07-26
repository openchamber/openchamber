"use client"

import * as React from "react"
import { Select as BaseSelect } from "@base-ui/react/select"
import type { SelectRootChangeEventDetails } from "@base-ui/react/select";

import { cn } from "@/lib/utils"
import { dropdownTriggerVariants } from "@/components/ui/dropdown-trigger"
import { ScrollableOverlay } from "@/components/ui/ScrollableOverlay";
import { Icon } from "@/components/icon/Icon";

type AsChildProps = { asChild?: boolean };
type AsChildRenderProps = {
  render?: React.ReactElement;
  children?: React.ReactNode;
};

type SelectPortalContextValue = {
  portalContainer: HTMLElement | null;
  setPortalContainer: (container: HTMLElement | null) => void;
};

const SelectPortalContext = React.createContext<SelectPortalContextValue | null>(null);

const resolveDialogContainer = (element: HTMLElement | null): HTMLElement | null => {
  if (!element) {
    return null;
  }
  return element.closest('[data-slot="dialog-content"], [role="dialog"]') as HTMLElement | null;
};

type SelectRootProps<Value extends string = string> = Omit<
  React.ComponentProps<typeof BaseSelect.Root>,
  "value" | "defaultValue" | "onValueChange"
> & {
  value?: Value;
  defaultValue?: Value;
  onValueChange?: (value: Value, eventDetails: SelectRootChangeEventDetails) => void;
};

function Select<Value extends string = string>({
  onValueChange,
  modal = false,
  ...props
}: SelectRootProps<Value>) {
  const [portalContainer, setPortalContainer] = React.useState<HTMLElement | null>(null);
  const portalContextValue = React.useMemo<SelectPortalContextValue>(() => ({
    portalContainer,
    setPortalContainer,
  }), [portalContainer]);

  const handleValueChange = React.useCallback(
    (value: unknown, eventDetails: SelectRootChangeEventDetails) => {
      if (typeof value === "string") {
        onValueChange?.(value as Value, eventDetails);
      }
    },
    [onValueChange]
  );

  return (
    <SelectPortalContext.Provider value={portalContextValue}>
      <BaseSelect.Root {...props} modal={modal} onValueChange={handleValueChange} />
    </SelectPortalContext.Provider>
  )
}

function SelectGroup({
  ...props
}: React.ComponentProps<typeof BaseSelect.Group>) {
  return <BaseSelect.Group data-slot="select-group" {...props} />
}

type SelectValueProps = Omit<React.ComponentProps<typeof BaseSelect.Value>, "children"> & {
  placeholder?: React.ReactNode;
  children?: React.ReactNode | ((value: string | undefined) => React.ReactNode);
};

function SelectValue({ placeholder, children, ...props }: SelectValueProps) {
  return (
    <BaseSelect.Value data-slot="select-value" {...props}>
      {(value: unknown) => {
        const resolvedValue =
          typeof value === "string" || value === undefined
            ? value
            : value === null
              ? undefined
              : String(value);

        if (typeof children === "function") {
          return children(resolvedValue);
        }
        if (children !== undefined && children !== null) return children;
        if (resolvedValue === undefined || resolvedValue === "") {
          return placeholder as React.ReactNode;
        }
        return resolvedValue;
      }}
    </BaseSelect.Value>
  )
}

function SelectTrigger({
  className,
  size = "default",
  children,
  asChild,
  onPointerDownCapture,
  onFocusCapture,
  ...props
}: React.ComponentProps<typeof BaseSelect.Trigger> & AsChildProps & {
  size?: "sm" | "default" | "lg" | "chip" | "settings"
}) {
  const portalContext = React.useContext(SelectPortalContext);

  const syncPortalContainer = React.useCallback((target: EventTarget | null) => {
    if (!portalContext) {
      return;
    }
    const element = target instanceof HTMLElement ? target : null;
    portalContext.setPortalContainer(resolveDialogContainer(element));
  }, [portalContext]);

  const asChildRender: AsChildRenderProps | null = asChild && React.isValidElement(children)
    ? { render: children as React.ReactElement }
    : null;
  return (
    <BaseSelect.Trigger
      data-slot="select-trigger"
      data-size={size}
      className={cn(
        // Shared trigger chrome: one source of truth for every dropdown trigger.
        // Legacy sizes map onto the two canonical ones: sm (dense) / default (forms).
        dropdownTriggerVariants({ size: size === 'settings' || size === 'lg' ? 'default' : 'sm' }),
        "w-fit data-[placeholder]:text-muted-foreground aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-2",
        className
      )}
      onPointerDownCapture={(event) => {
        syncPortalContainer(event.currentTarget);
        onPointerDownCapture?.(event);
      }}
      onFocusCapture={(event) => {
        syncPortalContainer(event.currentTarget);
        onFocusCapture?.(event);
      }}
      {...props}
      {...(asChildRender ?? {})}
    >
      {asChildRender ? undefined : (<>
        {children}
        <BaseSelect.Icon>
          <Icon name="arrow-down-s" className="size-4 opacity-50" />
        </BaseSelect.Icon>
      </>)}
    </BaseSelect.Trigger>
  )
}

type SelectContentExtra = {
  position?: "popper" | "item-aligned";
  fitContent?: boolean;
  portalToBody?: boolean;
  sideOffset?: number;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
};

function SelectContent({
  className,
  children,
  position = "popper",
  fitContent = false,
  portalToBody = false,
  sideOffset,
  side,
  align,
  ...props
}: React.ComponentProps<typeof BaseSelect.Popup> & SelectContentExtra) {
  const portalContext = React.useContext(SelectPortalContext);
  const alignItemWithTrigger = position === "item-aligned";
  const portalContainer = portalContext?.portalContainer ?? null;

  return (
    <BaseSelect.Portal container={portalToBody ? undefined : portalContainer || undefined}>
      <BaseSelect.Positioner
        alignItemWithTrigger={alignItemWithTrigger}
        sideOffset={sideOffset}
        side={side}
        align={align}
        className="absolute z-[120] pointer-events-auto"
      >
        <BaseSelect.Popup
          data-slot="select-content"
          style={{
            backgroundColor: 'var(--surface-elevated)',
            color: 'var(--surface-elevated-foreground)',
          }}
          className={cn(
            "pointer-events-auto transition-all duration-150 ease-out data-[starting-style]:opacity-0 data-[starting-style]:scale-95 data-[ending-style]:opacity-0 data-[ending-style]:scale-95 relative z-[120] max-h-[var(--available-height)] min-w-[8rem] origin-[var(--transform-origin)] overflow-x-hidden rounded-xl shadow-[inset_0_1px_0_0_rgba(255,255,255,0.8),inset_0_0_0_1px_rgba(0,0,0,0.04),0_0_0_1px_rgba(0,0,0,0.10),0_1px_2px_-0.5px_rgba(0,0,0,0.08),0_4px_8px_-2px_rgba(0,0,0,0.08),0_12px_20px_-4px_rgba(0,0,0,0.08)] dark:shadow-[inset_0_1px_0_0_rgba(255,255,255,0.12),inset_0_0_0_1px_rgba(255,255,255,0.08),0_0_0_1px_rgba(0,0,0,0.36),0_1px_1px_-0.5px_rgba(0,0,0,0.22),0_3px_3px_-1.5px_rgba(0,0,0,0.20),0_6px_6px_-3px_rgba(0,0,0,0.16)]",
            !alignItemWithTrigger &&
              "data-[side=bottom]:translate-y-1 data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=top]:-translate-y-1",
            fitContent && "w-max min-w-0",
            className
          )}
          {...props}
        >
          <ScrollableOverlay
            outerClassName={cn(
              "max-h-[var(--available-height)]",
              fitContent ? "w-max" : "w-full"
            )}
            className={cn(
              "p-1",
              !alignItemWithTrigger &&
                (fitContent
                  ? "w-max min-w-0 scroll-my-1"
                  : "w-full min-w-[var(--anchor-width)] scroll-my-1")
            )}
            preventOverscroll
          >
            {children}
          </ScrollableOverlay>
        </BaseSelect.Popup>
      </BaseSelect.Positioner>
    </BaseSelect.Portal>
  )
}

function SelectLabel({
  className,
  ...props
}: React.ComponentProps<typeof BaseSelect.GroupLabel>) {
  return (
    <BaseSelect.GroupLabel
      data-slot="select-label"
      className={cn("text-muted-foreground px-2 py-1.5 typography-meta", className)}
      {...props}
    />
  )
}

function SelectItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof BaseSelect.Item>) {
  return (
    <BaseSelect.Item
      data-slot="select-item"
      className={cn(
        "data-[highlighted]:bg-interactive-hover hover:bg-interactive-hover data-[selected]:bg-interactive-selection data-[selected]:text-interactive-selection-foreground [&_svg:not([class*='text-'])]:text-muted-foreground relative flex w-full cursor-pointer items-center gap-2 rounded-lg py-1.5 pr-8 pl-2 typography-ui-label outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 *:[span]:last:flex *:[span]:last:items-center *:[span]:last:gap-2",
        className
      )}
      {...props}
    >
      <span className="absolute right-2 flex size-3.5 items-center justify-center">
        <BaseSelect.ItemIndicator>
          <Icon name="check" className="size-4" />
        </BaseSelect.ItemIndicator>
      </span>
      <BaseSelect.ItemText>{children}</BaseSelect.ItemText>
    </BaseSelect.Item>
  )
}

function SelectSeparator({
  className,
  ...props
}: React.ComponentProps<typeof BaseSelect.Separator>) {
  return (
    <BaseSelect.Separator
      data-slot="select-separator"
      className={cn("bg-border pointer-events-none -mx-1 my-1 h-px", className)}
      {...props}
    />
  )
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
}
