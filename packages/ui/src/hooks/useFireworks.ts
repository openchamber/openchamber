import * as React from 'react';

import { burstOriginOf, fireworksShowDurationMs, fireworksShowFor, type CelebrationOptions, type FireworksShow } from '@/components/ui/fireworksShows';
import { celebrationOf } from '@/lib/easter-eggs/calendar';

interface FireworksState {
  isActive: boolean;
  cycle: number;
  show: FireworksShow;
}

interface UseFireworksResult {
  isActive: boolean;
  burstKey: number;
  show: FireworksShow;
  triggerFireworks: (options?: CelebrationOptions) => void;
  dismissFireworks: () => void;
}

const INITIAL_SHOW = fireworksShowFor({}, null);

export const useFireworks = (): UseFireworksResult => {
  const [state, setState] = React.useState<FireworksState>({ isActive: false, cycle: 0, show: INITIAL_SHOW });
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

  const triggerFireworks = React.useCallback((options: CelebrationOptions = {}) => {
    clearTimer();
    // The calendar is read when the celebration fires, so a push at 23:59 on
    // Halloween still gets ghosts however long the app has been open.
    // The button is measured now: a push takes a while, and the panel may have scrolled.
    const show = fireworksShowFor(options, celebrationOf(new Date()), burstOriginOf(options.origin));
    setState((prev) => ({ isActive: true, cycle: prev.cycle + 1, show }));

    timeoutRef.current = window.setTimeout(() => {
      setState((prev) => (prev.isActive ? { ...prev, isActive: false } : prev));
      timeoutRef.current = null;
    }, fireworksShowDurationMs(show));
  }, [clearTimer]);

  React.useEffect(() => () => clearTimer(), [clearTimer]);

  return {
    isActive: state.isActive,
    burstKey: state.cycle,
    show: state.show,
    triggerFireworks,
    dismissFireworks,
  };
};
