import * as React from 'react';

interface FireworksOptions {
  durationMs?: number;
}

interface FireworksState {
  isActive: boolean;
  cycle: number;
}

export interface UseFireworksResult {
  isActive: boolean;
  burstKey: number;
  triggerFireworks: () => void;
  dismissFireworks: () => void;
}

export const useFireworks = ({ durationMs = 3400 }: FireworksOptions = {}): UseFireworksResult => {
  const [state, setState] = React.useState<FireworksState>({ isActive: false, cycle: 0 });
  const timeoutRef = React.useRef<number | null>(null);

  const clearTimer = React.useCallback(() => {
    if (timeoutRef.current) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const dismissFireworks = React.useCallback(() => {
    clearTimer();
    setState((prev) => (prev.isActive ? { ...prev, isActive: false } : prev));
  }, [clearTimer]);

  const triggerFireworks = React.useCallback(() => {
    clearTimer();
    setState((prev) => ({ isActive: true, cycle: prev.cycle + 1 }));

    timeoutRef.current = window.setTimeout(() => {
      setState((prev) => (prev.isActive ? { ...prev, isActive: false } : prev));
      timeoutRef.current = null;
    }, durationMs);
  }, [clearTimer, durationMs]);

  React.useEffect(() => () => clearTimer(), [clearTimer]);

  return {
    isActive: state.isActive,
    burstKey: state.cycle,
    triggerFireworks,
    dismissFireworks,
  };
};
