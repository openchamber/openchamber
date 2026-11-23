import React from 'react';

import { useFontPreferences } from '@/hooks/useFontPreferences';
import { loadUiFont } from '@/lib/fontLoader';
import { appBootReadyPromise } from './appBootReady';

export function useFontsReady(timeoutMs = 2500): boolean {
  const { uiFont } = useFontPreferences();
  const [ready, setReady] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    const markReady = () => {
      if (!cancelled) setReady(true);
    };

    const settleThenReady = () => {
      requestAnimationFrame(() => requestAnimationFrame(markReady));
    };

    const ready = Promise.all([
      loadUiFont(uiFont).catch(() => undefined),
      document.fonts?.ready?.then(() => undefined).catch(() => undefined) ?? Promise.resolve(),
      appBootReadyPromise.catch(() => undefined),
    ]).then(() => undefined);

    const timeout = new Promise<void>((resolve) => {
      window.setTimeout(resolve, timeoutMs);
    });

    void Promise.race([ready, timeout]).then(settleThenReady);

    return () => {
      cancelled = true;
    };
  }, [uiFont, timeoutMs]);

  return ready;
}
