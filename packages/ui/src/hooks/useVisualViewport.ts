import React from 'react';

export interface VisualViewportState {
  height: number;
  keyboardHeight: number;
}

const getInitialHeight = (): number => {
  if (typeof window === 'undefined') return 0;
  return window.visualViewport?.height ?? window.innerHeight;
};

export const useVisualViewport = (): VisualViewportState => {
  const [state, setState] = React.useState<VisualViewportState>(() => ({
    height: getInitialHeight(),
    keyboardHeight: 0,
  }));

  const rafIdRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    if (typeof window === 'undefined' || !window.visualViewport) return;

    const handleChange = () => {
      if (rafIdRef.current !== null) return;
      rafIdRef.current = requestAnimationFrame(() => {
        rafIdRef.current = null;
        const vv = window.visualViewport!;
        setState({
          height: vv.height,
          keyboardHeight: Math.max(0, window.innerHeight - vv.height),
        });
      });
    };

    window.visualViewport.addEventListener('resize', handleChange);
    window.visualViewport.addEventListener('scroll', handleChange, { passive: true });
    handleChange();

    return () => {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
      }
      window.visualViewport?.removeEventListener('resize', handleChange);
      window.visualViewport?.removeEventListener('scroll', handleChange);
    };
  }, []);

  return state;
};
