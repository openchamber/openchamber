import React from "react";
import { cn } from "@/lib/utils";
import { OverlayScrollbar } from "./OverlayScrollbar";
import { ScrollShadow } from "./ScrollShadow";

type ScrollableOverlayProps = React.HTMLAttributes<HTMLElement> & {
  minThumbSize?: number;
  hideDelayMs?: number;
  as?: React.ElementType;
  outerClassName?: string;
  scrollbarClassName?: string;
  disableHorizontal?: boolean;
  observeMutations?: boolean;
  fillContainer?: boolean;
  /** Prevent scroll from propagating to parent when at boundaries */
  preventOverscroll?: boolean;
  useScrollShadow?: boolean;
  scrollShadowSize?: number;
  userIntentOnly?: boolean;
  /** Forwarded to the inner element (e.g. textarea). */
  disabled?: boolean;
};

export const ScrollableOverlay = React.forwardRef<HTMLElement, ScrollableOverlayProps>(
  ({
    className,
    outerClassName,
    children,
    style,
    minThumbSize,
    hideDelayMs,
    as: Component = "div",
    scrollbarClassName,
    disableHorizontal = false,
    observeMutations = true,
    fillContainer = true,
    preventOverscroll = false,
    useScrollShadow = false,
    scrollShadowSize,
    userIntentOnly = false,
    ...rest
  }, ref) => {
    const containerRef = React.useRef<HTMLElement | null>(null);

    React.useImperativeHandle(ref, () => containerRef.current as HTMLElement, []);

    return (
      <div
        className={cn(
          "relative flex flex-col min-h-0 w-full overflow-hidden",
          preventOverscroll && "overscroll-none",
          outerClassName
        )}
      >
        {useScrollShadow ? (
          <ScrollShadow
            as={Component}
            ref={containerRef as React.Ref<HTMLElement>}
            size={scrollShadowSize}
            className={cn(
              "overlay-scrollbar-target overlay-scrollbar-container",
              preventOverscroll && "overscroll-none",
              fillContainer ? "flex-1 min-h-0 w-full" : "flex-none w-full h-auto",
              disableHorizontal ? "overflow-y-auto overflow-x-hidden" : "overflow-auto",
              className
            )}
            style={style as React.CSSProperties}
            observeMutations={observeMutations}
            {...rest}
          >
            {children}
          </ScrollShadow>
        ) : (
          <Component
            ref={containerRef as React.Ref<HTMLElement>}
            className={cn(
              "overlay-scrollbar-target overlay-scrollbar-container",
              preventOverscroll && "overscroll-none",
              fillContainer ? "flex-1 min-h-0 w-full" : "flex-none w-full h-auto",
              disableHorizontal ? "overflow-y-auto overflow-x-hidden" : "overflow-auto",
              className
            )}
            style={style}
            {...rest}
          >
            {children}
          </Component>
        )}
        <OverlayScrollbar
          containerRef={containerRef}
          minThumbSize={minThumbSize}
          hideDelayMs={hideDelayMs}
          className={scrollbarClassName}
          disableHorizontal={disableHorizontal}
          observeMutations={observeMutations}
          userIntentOnly={userIntentOnly}
        />
      </div>
    );
  }
);

ScrollableOverlay.displayName = "ScrollableOverlay";
