import * as React from "react"
import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip"

import { cn } from "@/lib/utils"

type AsChildRenderProps = {
  render?: React.ReactElement;
  children?: React.ReactNode;
};

class TooltipPartBoundary extends React.Component<{
  children: React.ReactNode;
  fallback?: React.ReactNode;
}, { hasError: boolean }> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback ?? null;
    }

    return this.props.children;
  }
}

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
  const tooltip = <BaseTooltip.Root {...props} />

  if (delayDuration === undefined) {
    return tooltip
  }

  return <TooltipProvider delayDuration={delayDuration}>{tooltip}</TooltipProvider>
}

function TooltipTrigger({
  asChild,
  children,
  ...props
}: React.ComponentProps<typeof BaseTooltip.Trigger> & { asChild?: boolean }) {
  const renderProps: AsChildRenderProps = asChild && React.isValidElement(children)
    ? { render: children as React.ReactElement }
    : { children };
  return (
    <TooltipPartBoundary fallback={children}>
      <BaseTooltip.Trigger data-slot="tooltip-trigger" {...props} {...renderProps} />
    </TooltipPartBoundary>
  )
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
    <TooltipPartBoundary>
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner sideOffset={sideOffset} side={side} align={align} className="z-50">
          <BaseTooltip.Popup
            data-slot="tooltip-content"
            className={cn(
              "bg-muted text-muted-foreground border border-border/60 transition-all duration-150 ease-out data-[starting-style]:opacity-0 data-[starting-style]:scale-95 data-[ending-style]:opacity-0 data-[ending-style]:scale-95 z-50 w-fit origin-[var(--transform-origin)] rounded-xl px-3 py-1.5 typography-meta text-balance overflow-hidden",
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
    </TooltipPartBoundary>
  )
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
