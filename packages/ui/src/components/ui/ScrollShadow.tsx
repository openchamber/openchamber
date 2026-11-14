import React from "react";

import { useScrollShadow, type ScrollShadowOrientation, type ScrollShadowVisibility } from "./useScrollShadow";

type ScrollShadowProps = React.HTMLAttributes<HTMLElement> & {
  as?: React.ElementType;
  orientation?: ScrollShadowOrientation;
  offset?: number;
  size?: number;
  isEnabled?: boolean;
  hideTopShadow?: boolean;
  hideBottomShadow?: boolean;
  observeMutations?: boolean;
  /**
   * The colour behind the scroller, when it is opaque. The edge fades are then
   * drawn by `ScrollShadowBands`, which the caller renders right after this
   * element inside a positioned frame, instead of by a mask on the scroller.
   */
  surface?: string;
  onVisibilityChange?: (state: ScrollShadowVisibility) => void;
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

export const ScrollShadow = React.forwardRef<HTMLElement, ScrollShadowProps>(
      (
      {
        as: Component = "div",
        orientation = "vertical",
        offset = 0,
        size = 48,
        isEnabled = true,
        hideTopShadow = false,
        hideBottomShadow = false,
        observeMutations = true,
        surface,
        onVisibilityChange,
        style,
        className,
        children,
        ...rest
    },
    ref,
  ) => {
    const internalRef = React.useRef<HTMLElement>(null);

    const dataScrollShadow = (rest as Record<string, unknown>)["data-scroll-shadow"];
    delete (rest as Record<string, unknown>)["data-scroll-shadow"];

    const mergedStyle = React.useMemo<React.CSSProperties>(() => {
      const next: React.CSSProperties = {
        ...(style as React.CSSProperties),
      };
      (next as Record<string, string>)["--scroll-shadow-size"] = `${size}px`;
      return next;
    }, [size, style]);

    useScrollShadow(internalRef, {
      orientation,
      offset,
      isEnabled,
      hideTopShadow,
      hideBottomShadow,
      observeMutations,
      onVisibilityChange,
    });

    return (
      <Component
        {...rest}
        ref={mergeRefs(internalRef, ref)}
        className={className}
        data-orientation={orientation}
        data-scroll-shadow={dataScrollShadow ?? true}
        data-scroll-fade-bands={surface ? true : undefined}
        style={mergedStyle}
      >
        {children}
      </Component>
    );
  },
);

ScrollShadow.displayName = "ScrollShadow";

/** The edge fades of a `ScrollShadow` that was given the same `surface`. */
export function ScrollShadowBands({ surface, size = 48 }: { surface: string; size?: number }) {
  // SAFETY: custom properties the band classes read.
  const style = { "--scroll-fade-surface": surface, "--scroll-shadow-size": `${size}px` } as React.CSSProperties;
  return (
    <>
      <div aria-hidden="true" className="scroll-fade-band scroll-fade-band--top" style={style} />
      <div aria-hidden="true" className="scroll-fade-band scroll-fade-band--end" style={style} />
    </>
  );
}
