import React from 'react';

export interface VisualViewportState {
  height: number;
  keyboardHeight: number;
}

const getInitialHeight = (): number => {
  if (typeof window === 'undefined') return 0;
  return window.visualViewport?.height ?? window.innerHeight;
};

export const getVisualViewportState = (): VisualViewportState => {
  if (typeof window === 'undefined') {
    return { height: 0, keyboardHeight: 0 };
  }

  const height = window.visualViewport?.height ?? window.innerHeight;
  const keyboardHeight = window.visualViewport
    ? Math.max(0, window.innerHeight - height)
    : 0;

  return { height, keyboardHeight };
};

export const useVisualViewport = (): VisualViewportState => {
  const [state, setState] = React.useState<VisualViewportState>(() => ({
    height: getInitialHeight(),
    keyboardHeight: 0,
  }));

  const rafIdRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;

    const visualViewport = window.visualViewport;

    const handleChange = () => {
      if (rafIdRef.current !== null) return;
      rafIdRef.current = requestAnimationFrame(() => {
        rafIdRef.current = null;
        const nextState = getVisualViewportState();
        setState((prev) => {
          if (prev.height === nextState.height && prev.keyboardHeight === nextState.keyboardHeight) return prev;
          return nextState;
        });
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
