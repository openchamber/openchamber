import React from 'react';

export interface VisualViewportState {
  height: number;
  keyboardHeight: number;
  offsetTop: number;
  pageTop: number;
}

export const getVisualViewportState = (): VisualViewportState => {
  if (typeof window === 'undefined') {
    return { height: 0, keyboardHeight: 0, offsetTop: 0, pageTop: 0 };
  }

  const height = window.visualViewport?.height ?? window.innerHeight;
  const keyboardHeight = window.visualViewport
    ? Math.max(0, window.innerHeight - height)
    : 0;
  const offsetTop = window.visualViewport?.offsetTop ?? 0;
  const pageTop = window.visualViewport?.pageTop ?? 0;

  return { height, keyboardHeight, offsetTop, pageTop };
};

export const visualViewportStateEqual = (
  prev: VisualViewportState,
  next: VisualViewportState,
): boolean =>
  prev.height === next.height &&
  prev.keyboardHeight === next.keyboardHeight &&
  prev.offsetTop === next.offsetTop &&
  prev.pageTop === next.pageTop;

/** Derive the mobile root inline style from visual viewport geometry.
 *  Returns undefined for non-mobile or non-positive height.
 *
 *  Origin normalization:
 *  - Primary: offsetTop (viewport-relative position of the visual viewport top).
 *  - Fallback: pageTop - scrollY when offsetTop is zero but pageTop is available.
 *
 *  When the visual viewport origin is non-zero (iOS keyboard pan), the style
 *  includes position:fixed to anchor the root to the visual viewport rectangle.
 *  When origin is zero (no pan, resize-only), only height is set to preserve
 *  normal flow layout. */
export const deriveMobileRootStyle = (input: {
  isMobile: boolean;
  viewport: VisualViewportState;
  scrollY: number;
}): React.CSSProperties | undefined => {
  if (!input.isMobile || input.viewport.height <= 0) {
    return undefined;
  }

  const origin =
    input.viewport.offsetTop > 0
      ? input.viewport.offsetTop
      : input.viewport.pageTop > 0
        ? input.viewport.pageTop - input.scrollY
        : 0;

  if (origin > 0) {
    return {
      position: 'fixed',
      top: origin,
      height: input.viewport.height,
      left: 0,
      right: 0,
    };
  }

  return {
    height: input.viewport.height,
  };
};

export const useVisualViewport = (): VisualViewportState => {
  const [state, setState] = React.useState<VisualViewportState>(getVisualViewportState);

  const rafIdRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;

    const visualViewport = window.visualViewport;

    const handleChange = () => {
      if (rafIdRef.current !== null) return;
      rafIdRef.current = requestAnimationFrame(() => {
        rafIdRef.current = null;
        const nextState = getVisualViewportState();
        setState((prev) =>
          visualViewportStateEqual(prev, nextState) ? prev : nextState,
        );
      });
    };

    if (visualViewport) {
      visualViewport.addEventListener('resize', handleChange);
      visualViewport.addEventListener('scroll', handleChange, { passive: true });
    } else {
      window.addEventListener('resize', handleChange);
    }
    handleChange();

    return () => {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
      }
      if (visualViewport) {
        visualViewport.removeEventListener('resize', handleChange);
        visualViewport.removeEventListener('scroll', handleChange);
      } else {
        window.removeEventListener('resize', handleChange);
      }
    };
  }, []);

  return state;
};
