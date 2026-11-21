import React from "react";
import { cn } from "@/lib/utils";
import { OverlayScrollbar } from "./OverlayScrollbar";
import { ScrollShadow, ScrollShadowBands } from "./ScrollShadow";
import { useListScrollMemory } from "@/hooks/useListScrollMemory";

type ScrollableOverlayProps = React.HTMLAttributes<HTMLElement> & {
  minThumbSize?: number;
  hideDelayMs?: number;
  as?: React.ElementType;
  outerClassName?: string;
  outerStyle?: React.CSSProperties;
  scrollbarClassName?: string;
  disableHorizontal?: boolean;
  observeMutations?: boolean;
  fillContainer?: boolean;
  preventOverscroll?: boolean;
  useScrollShadow?: boolean;
  scrollShadowSize?: number;
  scrollShadowSurface?: string;
  hideTopScrollShadow?: boolean;
  hideBottomScrollShadow?: boolean;
  userIntentOnly?: boolean;
  verticalTrackStart?: number;
  disabled?: boolean;
  memoryKey?: string | null;
  memoryReady?: boolean;
};

export const ScrollableOverlay = React.forwardRef<HTMLElement, ScrollableOverlayProps>(
  ({
    className,
    outerClassName,
    outerStyle,
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
    scrollShadowSurface,
    hideTopScrollShadow = false,
    hideBottomScrollShadow = false,
    userIntentOnly = false,
    verticalTrackStart,
    memoryKey,
    memoryReady = true,
    ...rest
  }, ref) => {
    const containerRef = React.useRef<HTMLElement | null>(null);
    const memoryBind = useListScrollMemory(memoryKey, { ready: memoryReady });
    const attach = React.useCallback((node: HTMLElement | null) => {
      containerRef.current = node;
      memoryBind(node);
    }, [memoryBind]);

    React.useImperativeHandle(ref, () => containerRef.current as HTMLElement, []);

    return (
      <div
        className={cn(
          "overlay-scrollbar-wrapper relative flex flex-col min-h-0 w-full overflow-hidden",
          preventOverscroll && "overscroll-none",
          outerClassName
        )}
        style={outerStyle}
      >
        {useScrollShadow ? (
          <ScrollShadow
            as={Component}
            ref={attach}
            size={scrollShadowSize}
            surface={scrollShadowSurface}
            hideTopShadow={hideTopScrollShadow}
            hideBottomShadow={hideBottomScrollShadow}
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
            ref={attach}
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
        {useScrollShadow && scrollShadowSurface ? (
          <ScrollShadowBands surface={scrollShadowSurface} size={scrollShadowSize} />
        ) : null}
        <OverlayScrollbar
          containerRef={containerRef}
          minThumbSize={minThumbSize}
          hideDelayMs={hideDelayMs}
          className={scrollbarClassName}
          disableHorizontal={disableHorizontal}
          observeMutations={observeMutations}
          userIntentOnly={userIntentOnly}
          verticalTrackStart={verticalTrackStart}
        />
      </div>
    );
  }
);

ScrollableOverlay.displayName = "ScrollableOverlay";
