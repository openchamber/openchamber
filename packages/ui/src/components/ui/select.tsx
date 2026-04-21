"use client"

import * as React from "react"
import { Select as BaseSelect } from "@base-ui/react/select"
import type { SelectRootChangeEventDetails } from "@base-ui/react/select";
import { RiArrowDownSLine, RiArrowUpSLine, RiCheckLine } from '@remixicon/react';

import { cn } from "@/lib/utils"
import { ScrollableOverlay } from "@/components/ui/ScrollableOverlay";

type AsChildProps = { asChild?: boolean };
type AsChildRenderProps = {
  render?: React.ReactElement;
  children?: React.ReactNode;
};

type SelectRootProps<Value extends string = string> = Omit<
  React.ComponentProps<typeof BaseSelect.Root>,
  "value" | "defaultValue" | "onValueChange"
> & {
  value?: Value;
  defaultValue?: Value;
  onValueChange?: (value: Value, eventDetails: SelectRootChangeEventDetails) => void;
};

function Select<Value extends string = string>({ onValueChange, ...props }: SelectRootProps<Value>) {
  const handleValueChange = React.useCallback(
    (value: unknown, eventDetails: SelectRootChangeEventDetails) => {
      if (typeof value === "string") {
        onValueChange?.(value as Value, eventDetails);
      }
    },
    [onValueChange]
  );

  return <BaseSelect.Root {...props} onValueChange={handleValueChange} />
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
  ...props
}: React.ComponentProps<typeof BaseSelect.Trigger> & AsChildProps & {
  size?: "sm" | "default" | "lg" | "chip"
}) {
  const asChildRender: AsChildRenderProps | null = asChild && React.isValidElement(children)
    ? { render: children as React.ReactElement }
    : null;
  return (
    <BaseSelect.Trigger
      data-slot="select-trigger"
      data-size={size}
      className={cn(
        "border-input data-[placeholder]:text-muted-foreground [&_svg:not([class*='text-'])]:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive flex w-fit items-center justify-between gap-2 rounded-lg border bg-transparent px-2 py-2 typography-ui-label whitespace-nowrap shadow-none outline-none focus-visible:outline-none hover:bg-interactive-hover data-[popup-open]:bg-interactive-active focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50 data-[size=default]:h-6 data-[size=sm]:h-6 data-[size=lg]:h-8 data-[size=lg]:py-1.5 data-[size=chip]:h-7 data-[size=chip]:py-1 *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-2 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
      {...(asChildRender ?? {})}
    >
      {asChildRender ? undefined : (<>
        {children}
        <BaseSelect.Icon>
          <RiArrowDownSLine className="size-4 opacity-50" />
        </BaseSelect.Icon>
      </>)}
    </BaseSelect.Trigger>
  )
}

type SelectContentExtra = {
  position?: "popper" | "item-aligned";
  fitContent?: boolean;
  sideOffset?: number;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
};

function SelectContent({
  className,
  children,
  position = "popper",
  fitContent = false,
  sideOffset,
  side,
  align,
  ...props
}: React.ComponentProps<typeof BaseSelect.Popup> & SelectContentExtra) {
  const alignItemWithTrigger = position === "item-aligned";
  return (
    <BaseSelect.Portal>
      <BaseSelect.Positioner
        alignItemWithTrigger={alignItemWithTrigger}
        sideOffset={sideOffset}
        side={side}
        align={align}
        className="z-50"
      >
        <BaseSelect.Popup
          data-slot="select-content"
          style={{
            backgroundColor: 'var(--surface-elevated)',
            color: 'var(--surface-elevated-foreground)',
          }}
          className={cn(
            "data-[open]:animate-in data-[closed]:animate-out data-[closed]:fade-out-0 data-[open]:fade-in-0 data-[closed]:zoom-out-95 data-[open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 relative z-50 max-h-[var(--available-height)] min-w-[8rem] origin-[var(--transform-origin)] overflow-x-hidden rounded-xl transform-gpu will-change-transform shadow-[inset_0_1px_0_0_rgba(255,255,255,0.8),inset_0_0_0_1px_rgba(0,0,0,0.04),0_0_0_1px_rgba(0,0,0,0.10),0_1px_2px_-0.5px_rgba(0,0,0,0.08),0_4px_8px_-2px_rgba(0,0,0,0.08),0_12px_20px_-4px_rgba(0,0,0,0.08)] dark:shadow-[inset_0_1px_0_0_rgba(255,255,255,0.12),inset_0_0_0_1px_rgba(255,255,255,0.08),0_0_0_1px_rgba(0,0,0,0.36),0_1px_1px_-0.5px_rgba(0,0,0,0.22),0_3px_3px_-1.5px_rgba(0,0,0,0.20),0_6px_6px_-3px_rgba(0,0,0,0.16)]",
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
          <RiCheckLine className="size-4"/>
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

function SelectScrollUpButton({
  className,
  ...props
}: React.ComponentProps<typeof BaseSelect.ScrollUpArrow>) {
  return (
    <BaseSelect.ScrollUpArrow
      data-slot="select-scroll-up-button"
      className={cn(
        "flex cursor-pointer items-center justify-center py-1",
        className
      )}
      {...props}
    >
      <RiArrowUpSLine className="size-4" />
    </BaseSelect.ScrollUpArrow>
  )
}

function SelectScrollDownButton({
  className,
  ...props
}: React.ComponentProps<typeof BaseSelect.ScrollDownArrow>) {
  return (
    <BaseSelect.ScrollDownArrow
      data-slot="select-scroll-down-button"
      className={cn(
        "flex cursor-pointer items-center justify-center py-1",
        className
      )}
      {...props}
    >
      <RiArrowDownSLine className="size-4" />
    </BaseSelect.ScrollDownArrow>
  )
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
}
