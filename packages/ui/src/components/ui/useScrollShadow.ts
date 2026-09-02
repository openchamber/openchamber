import React from "react";

// Scroll-shadow state as data attributes on a scroll container.
//
// The logic lives in a hook rather than only inside <ScrollShadow> because the
// chat timeline's scroll container is owned by the virtualized list component,
// which renders its own element — there is no wrapper to hand the styling to.
// <ScrollShadow> is a thin wrapper over this hook, so both paths stay in sync.

export type ScrollShadowOrientation = "vertical" | "horizontal";
export type ScrollShadowVisibility = "both" | "none" | "top" | "bottom" | "left" | "right";

export type UseScrollShadowOptions = {
  orientation?: ScrollShadowOrientation;
  offset?: number;
  isEnabled?: boolean;
  hideTopShadow?: boolean;
  hideBottomShadow?: boolean;
  observeMutations?: boolean;
  onVisibilityChange?: (state: ScrollShadowVisibility) => void;
};

const SCROLL_SHADOW_ATTRIBUTES = [
  "top",
  "bottom",
  "top-bottom",
  "left",
  "right",
  "left-right",
] as const;

const clearScrollShadowAttributes = (el: HTMLElement): void => {
  SCROLL_SHADOW_ATTRIBUTES.forEach((attr) => {
    el.removeAttribute(`data-${attr}-scroll`);
  });
};

const setScrollShadowAttributes = (
  el: HTMLElement,
  hasBefore: boolean,
  hasAfter: boolean,
  prefix: "top" | "left",
  suffix: "bottom" | "right",
): void => {
  const bothKey = `${prefix}${suffix.charAt(0).toUpperCase()}${suffix.slice(1)}Scroll` as const;

  if (hasBefore && hasAfter) {
    (el.dataset as Record<string, string>)[bothKey] = "true";
    el.removeAttribute(`data-${prefix}-scroll`);
    el.removeAttribute(`data-${suffix}-scroll`);
  } else {
    el.dataset[`${prefix}Scroll`] = String(hasBefore);
    el.dataset[`${suffix}Scroll`] = String(hasAfter);
    el.removeAttribute(`data-${prefix}-${suffix}-scroll`);
  }
};

export const useScrollShadow = (
  elementRef: React.RefObject<HTMLElement | null>,
  {
    orientation = "vertical",
    offset = 0,
    isEnabled = true,
    hideTopShadow = false,
    hideBottomShadow = false,
    observeMutations = true,
    onVisibilityChange,
  }: UseScrollShadowOptions = {},
): void => {
  const visibleRef = React.useRef<ScrollShadowVisibility>("none");

  const checkOverflow = React.useCallback(() => {
    const el = elementRef.current;
    if (!el) return;

    if (!isEnabled) {
      clearScrollShadowAttributes(el);
      return;
    }

    // Subpixel tolerance: on hi-DPI (Retina) and with fractional scrollTop,
    // scrollTop+clientHeight can fall ~0.5px short of scrollHeight at the very end,
    // which would otherwise keep the bottom fade visible after fully scrolling.
    const SUBPIXEL_TOLERANCE = 1;
    const hasBefore =
      orientation === "vertical"
        ? el.scrollTop > offset + SUBPIXEL_TOLERANCE
        : el.scrollLeft > offset + SUBPIXEL_TOLERANCE;
    let hasAfter =
      orientation === "vertical"
        ? el.scrollHeight - (el.scrollTop + el.clientHeight) > offset + SUBPIXEL_TOLERANCE
        : el.scrollWidth - (el.scrollLeft + el.clientWidth) > offset + SUBPIXEL_TOLERANCE;

    const effectiveHasBefore = hideTopShadow && orientation === "vertical" ? false : hasBefore;

    if (hideBottomShadow && orientation === "vertical") {
      hasAfter = false;
    }

    setScrollShadowAttributes(
      el,
      effectiveHasBefore,
      hasAfter,
      orientation === "vertical" ? "top" : "left",
      orientation === "vertical" ? "bottom" : "right",
    );

    const next: ScrollShadowVisibility = effectiveHasBefore && hasAfter
      ? "both"
      : effectiveHasBefore
        ? (orientation === "vertical" ? "top" : "left")
        : hasAfter
          ? (orientation === "vertical" ? "bottom" : "right")
          : "none";
    if (next !== visibleRef.current) {
      visibleRef.current = next;
      onVisibilityChange?.(next);
    }
  }, [elementRef, hideTopShadow, hideBottomShadow, isEnabled, offset, onVisibilityChange, orientation]);

  React.useEffect(() => {
    const el = elementRef.current;
    if (!el) return;

    // Throttle with RAF to avoid excessive calls during rapid DOM changes
    let rafId: number | null = null;
    const throttledCheck = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        checkOverflow();
      });
    };

    const handleScroll = () => checkOverflow(); // Scroll should be immediate
    const resizeObserver = typeof ResizeObserver !== "undefined" ? new ResizeObserver(throttledCheck) : null;
    const mutationObserver =
      observeMutations && typeof MutationObserver !== "undefined" ? new MutationObserver(throttledCheck) : null;

    checkOverflow();

    el.addEventListener("scroll", handleScroll, { passive: true });
    resizeObserver?.observe(el);
    // checkOverflow mutates our data-scroll attributes; observing attributes
    // would make the hook trigger its own observer indefinitely.
    mutationObserver?.observe(el, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      el.removeEventListener("scroll", handleScroll);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
    };
  }, [checkOverflow, elementRef, observeMutations]);
};
