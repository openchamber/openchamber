import * as React from "react"
import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip"

import { cn } from "@/lib/utils"

type ProviderProps = React.ComponentProps<typeof BaseTooltip.Provider> & {
  delayDuration?: number;
  skipDelayDuration?: number;
};

function TooltipProvider({
  delayDuration = 0,
  skipDelayDuration,
  delay,
  closeDelay,
  ...props
}: ProviderProps) {
  return (
    <BaseTooltip.Provider
      delay={delay ?? delayDuration}
      closeDelay={closeDelay ?? skipDelayDuration}
      {...props}
    />
  )
}

type TooltipRootProps = React.ComponentProps<typeof BaseTooltip.Root> & {
  delayDuration?: number
}

function Tooltip({
  delayDuration,
  ...props
}: TooltipRootProps) {
  const merged = delayDuration !== undefined && (props as any).delay === undefined
    ? { ...props, delay: delayDuration }
    : props;
  return <BaseTooltip.Root {...(merged as any)} />
}

function TooltipTrigger({
  asChild,
  children,
  ...props
}: React.ComponentProps<typeof BaseTooltip.Trigger> & { asChild?: boolean }) {
  const renderProps: any = asChild && React.isValidElement(children)
    ? { render: children as React.ReactElement }
    : { children };
  return <BaseTooltip.Trigger data-slot="tooltip-trigger" {...(props as any)} {...renderProps} />
}

type ContentProps = React.ComponentProps<typeof BaseTooltip.Popup> & {
  sideOffset?: number;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
};

function TooltipContent({
  className,
  sideOffset = 0,
  side,
  align,
  children,
  style,
  ...props
}: ContentProps) {
  return (
    <BaseTooltip.Portal>
      <BaseTooltip.Positioner sideOffset={sideOffset} side={side} align={align} className="z-50">
        <BaseTooltip.Popup
          data-slot="tooltip-content"
          className={cn(
            "bg-muted text-muted-foreground animate-in fade-in-0 zoom-in-95 data-[closed]:animate-out data-[closed]:fade-out-0 data-[closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 w-fit origin-[var(--transform-origin)] rounded-xl px-3 py-1.5 typography-meta text-balance overflow-hidden transform-gpu will-change-transform",
            className
          )}
          style={{ ...style }}
          {...props}
        >
          {children}
          <BaseTooltip.Arrow className="fill-muted z-50 size-2" />
        </BaseTooltip.Popup>
      </BaseTooltip.Positioner>
    </BaseTooltip.Portal>
  )
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
