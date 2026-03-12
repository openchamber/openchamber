import React from 'react';
import { getPWADisplayMode, type PWADisplayMode } from '@/lib/pwa';

type PwaDetectionState = {
  displayMode: PWADisplayMode;
  installed: boolean;
  browserTab: boolean;
};

const getState = (): PwaDetectionState => {
  const displayMode = getPWADisplayMode();
  return {
    displayMode,
    installed: displayMode !== 'browser',
    browserTab: displayMode === 'browser',
  };
};

export const usePwaDetection = (): PwaDetectionState => {
  const [state, setState] = React.useState<PwaDetectionState>(() => getState());

  React.useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }

    const queries = [
      window.matchMedia('(display-mode: standalone)'),
      window.matchMedia('(display-mode: minimal-ui)'),
      window.matchMedia('(display-mode: fullscreen)'),
      window.matchMedia('(display-mode: window-controls-overlay)'),
    ];

    const onChange = () => {
      setState(getState());
    };

    onChange();

    for (const query of queries) {
      query.addEventListener('change', onChange);
    }

    window.addEventListener('appinstalled', onChange);
    window.addEventListener('focus', onChange);

    return () => {
      for (const query of queries) {
        query.removeEventListener('change', onChange);
      }
      window.removeEventListener('appinstalled', onChange);
      window.removeEventListener('focus', onChange);
    };
  }, []);

  return state;
};
