"use client"

import * as React from "react"
import { Command as CommandPrimitive } from "cmdk"

import { cn } from "@/lib/utils"
import { ScrollableOverlay } from "@/components/ui/ScrollableOverlay";
import { Icon } from "@/components/icon/Icon";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

function Command({
  className,
  style,
  ...props
}: React.ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      data-slot="command"
      // Let the parent (DropdownMenuContent, DialogContent, etc.) paint the
      // background and provide elevation. Overriding bg here would cover the
      // parent's inset shadows (our inner light ring) and flatten the edge.
      style={{
        color: 'var(--surface-elevated-foreground)',
        ...style,
      }}
      className={cn(
        "flex h-full w-full flex-col overflow-hidden rounded-xl",
        className
      )}
      {...props}
    />
  )
}

function CommandDialog({
  title = "Command Palette",
  description = "Search for a command to run...",
  children,
  className,
  showCloseButton = true,
  ...props
}: Omit<React.ComponentProps<typeof Dialog>, "children"> & {
  title?: string
  description?: string
  className?: string
  showCloseButton?: boolean
  children?: React.ReactNode
}) {
  return (
    <Dialog {...props}>
      <DialogHeader className="sr-only">
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      <DialogContent
        className={cn("overflow-hidden p-0 transform-gpu will-change-transform", className)}
        showCloseButton={showCloseButton}
      >
        <Command className="[&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group]]:px-2 [&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0 [&_[cmdk-input-wrapper]_svg]:h-4 [&_[cmdk-input-wrapper]_svg]:w-4 [&_[cmdk-input]]:h-8 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-1.5 [&_[cmdk-item]_svg]:h-4 [&_[cmdk-item]_svg]:w-4 [&_[cmdk-item]]:typography-meta">
          {children}
        </Command>
      </DialogContent>
    </Dialog>
  )
}

const CommandInput = React.forwardRef<
  React.ComponentRef<typeof CommandPrimitive.Input>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Input>
>(({ className, ...props }, ref) => {
  return (
    <div
       data-slot="command-input-wrapper"
       className="flex h-8 items-center gap-2 border-b px-3"
     >
       <Icon name="search" className="size-4 shrink-0 opacity-50" />
       <CommandPrimitive.Input
        ref={ref}
        data-slot="command-input"
        className={cn(
          "placeholder:text-muted-foreground flex h-8 w-full rounded-lg bg-transparent py-2 typography-meta outline-none focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
          className
        )}
        {...props}
      />
    </div>
  )
})
CommandInput.displayName = "CommandInput"

function CommandList({
  className,
  children,
  scrollbarClassName,
  disableHorizontal,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.List> & { scrollbarClassName?: string; disableHorizontal?: boolean }) {
  return (
    <ScrollableOverlay
      as={CommandPrimitive.List}
      data-slot="command-list"
      outerClassName="max-h-[min(600px,calc(100vh-10rem))] overflow-x-hidden p-0 w-full h-full min-h-0"
      className={cn("scroll-py-1 overflow-x-hidden h-full min-h-0", className)}
      scrollbarClassName={scrollbarClassName ?? "overlay-scrollbar--flush overlay-scrollbar--dense overlay-scrollbar--zero"}
      disableHorizontal={disableHorizontal ?? true}
      {...props}
    >
      {children}
    </ScrollableOverlay>
  )
}

function CommandEmpty({
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      data-slot="command-empty"
      className="py-6 text-center typography-ui-label"
      {...props}
    />
  )
}

function CommandGroup({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      data-slot="command-group"
      className={cn(
        "text-foreground [&_[cmdk-group-heading]]:text-muted-foreground overflow-hidden p-1 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:typography-meta [&_[cmdk-group-heading]]:font-medium",
        className
      )}
      {...props}
    />
  )
}

function CommandSeparator({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Separator>) {
  return (
    <CommandPrimitive.Separator
      data-slot="command-separator"
      className={cn("bg-border -mx-1 h-px", className)}
      {...props}
    />
  )
}

function CommandItem({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      data-slot="command-item"
      className={cn(
        "data-[selected=true]:bg-interactive-selection data-[selected=true]:text-interactive-selection-foreground data-[highlighted]:bg-interactive-hover hover:bg-interactive-hover [&_svg:not([class*='text-'])]:text-muted-foreground relative flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 typography-meta outline-hidden select-none data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    />
  )
}

function CommandShortcut({
  className,
  ...props
}: React.ComponentProps<"span">) {
  const renderKey = (keyLabel: string) => {
    const normalized = keyLabel.trim().toLowerCase();

    if (normalized === 'ctrl' || normalized === 'control') {
      return (
        <span className="text-xs font-medium">
          ctrl
        </span>
      );
    }

    if (normalized === 'cmd' || normalized === '⌘' || normalized === 'command' || normalized === 'meta') {
      return <Icon name="command" className="size-3.5" />;
    }

    if (normalized === 'shift' || normalized === '⇧') {
      return <Icon name="arrow-up" className="size-3.5" />;
    }

    return (
      <span className="text-xs font-medium">
        {keyLabel}
      </span>
    );
  };

  const shortcutText = typeof props.children === 'string' ? props.children : '';

  const tokens = shortcutText
    ? shortcutText.split('+').map((token) => token.trim()).filter(Boolean)
    : [];

  return (
    <span
      data-slot="command-shortcut"
      className={cn(
        "text-muted-foreground ml-auto flex items-center gap-1 typography-meta",
        className
      )}
      {...props}
    >
      {tokens.length > 0
        ? tokens.map((token, index) => (
            <React.Fragment key={`${token}-${index}`}>
              {index > 0 && <span className="opacity-60 text-xs">+</span>}
              {renderKey(token)}
            </React.Fragment>
          ))
        : props.children}
    </span>
  );
}

export {
  Command,
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
  CommandSeparator,
}
