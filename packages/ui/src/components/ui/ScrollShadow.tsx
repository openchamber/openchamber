import React from "react";

import { useScrollShadow, type ScrollShadowOrientation, type ScrollShadowVisibility } from "./useScrollShadow";

export type ScrollShadowProps = React.HTMLAttributes<HTMLElement> & {
  as?: React.ElementType;
  orientation?: ScrollShadowOrientation;
  offset?: number;
  size?: number;
  isEnabled?: boolean;
  hideTopShadow?: boolean;
  hideBottomShadow?: boolean;
  observeMutations?: boolean;
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
        style={mergedStyle}
      >
        {children}
      </Component>
    );
  },
);

ScrollShadow.displayName = "ScrollShadow";
