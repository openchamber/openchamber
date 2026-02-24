import React from "react";

export type ScrollShadowProps = React.HTMLAttributes<HTMLDivElement> & {
  orientation?: "vertical" | "horizontal";
  offset?: number;
  size?: number;
  isEnabled?: boolean;
  hideTopShadow?: boolean;
  hideBottomShadow?: boolean;
  observeMutations?: boolean;
  onVisibilityChange?: (state: "both" | "none" | "top" | "bottom" | "left" | "right") => void;
};

function mergeRefs<T>(...refs: Array<React.Ref<T>>): React.RefCallback<T> {
  return (value) => {
    refs.forEach((ref) => {
      if (typeof ref === "function") {
        ref(value);
      } else if (ref && typeof ref === "object") {
        (ref as React.MutableRefObject<T | null>).current = value;
      }
    });
  };
}

export const ScrollShadow = React.forwardRef<HTMLDivElement, ScrollShadowProps>(
      (
      {
        orientation = "vertical",
        offset = 0,
        size = 48,
        isEnabled = true,
        hideTopShadow = false,
        hideBottomShadow = false,
        observeMutations = true,
        onVisibilityChange,
        style,
        className,
        children,
        ...rest
    },
    ref,
  ) => {
    const internalRef = React.useRef<HTMLDivElement>(null);
    const visibleRef = React.useRef<"both" | "none" | "top" | "bottom" | "left" | "right">("none");

    const dataScrollShadow = (rest as Record<string, unknown>)["data-scroll-shadow"];
    delete (rest as Record<string, unknown>)["data-scroll-shadow"];

    const mergedStyle = React.useMemo<React.CSSProperties>(() => {
      const next: React.CSSProperties = {
        ...(style as React.CSSProperties),
      };
      (next as Record<string, string>)["--scroll-shadow-size"] = `${size}px`;
      return next;
    }, [size, style]);

    const setAttributes = React.useCallback(
      (el: HTMLElement, hasBefore: boolean, hasAfter: boolean, prefix: "top" | "left", suffix: "bottom" | "right") => {
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
      },
      [],
    );

    const clearAttributes = React.useCallback((el: HTMLElement) => {
      ["top", "bottom", "top-bottom", "left", "right", "left-right"].forEach((attr) => {
        el.removeAttribute(`data-${attr}-scroll`);
      });
    }, []);

    const checkOverflow = React.useCallback(() => {
      const el = internalRef.current;
      if (!el) return;

      if (!isEnabled) {
        clearAttributes(el);
        return;
      }

      const hasBefore = orientation === "vertical" ? el.scrollTop > offset : el.scrollLeft > offset;
      let hasAfter =
        orientation === "vertical"
          ? el.scrollTop + el.clientHeight + offset < el.scrollHeight
          : el.scrollLeft + el.clientWidth + offset < el.scrollWidth;

      const effectiveHasBefore = hideTopShadow && orientation === "vertical" ? false : hasBefore;

      if (hideBottomShadow && orientation === "vertical") {
        hasAfter = false;
      }

      setAttributes(el, effectiveHasBefore, hasAfter, orientation === "vertical" ? "top" : "left", orientation === "vertical" ? "bottom" : "right");

      const next = effectiveHasBefore && hasAfter ? "both" : effectiveHasBefore ? (orientation === "vertical" ? "top" : "left") : hasAfter ? (orientation === "vertical" ? "bottom" : "right") : "none";
      if (next !== visibleRef.current) {
        visibleRef.current = next;
        onVisibilityChange?.(next);
      }
    }, [clearAttributes, hideTopShadow, hideBottomShadow, isEnabled, offset, onVisibilityChange, orientation, setAttributes]);

    React.useEffect(() => {
      const el = internalRef.current;
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
      mutationObserver?.observe(el, { childList: true, subtree: true });

      return () => {
        if (rafId !== null) cancelAnimationFrame(rafId);
        el.removeEventListener("scroll", handleScroll);
        resizeObserver?.disconnect();
        mutationObserver?.disconnect();
      };
    }, [checkOverflow, observeMutations]);

    return (
      <div
        {...rest}
        ref={mergeRefs(internalRef, ref)}
        className={className}
        data-orientation={orientation}
        data-scroll-shadow={dataScrollShadow ?? true}
        style={mergedStyle}
      >
        {children}
      </div>
    );
  },
);

ScrollShadow.displayName = "ScrollShadow";
