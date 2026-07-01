import React from 'react';

import { useFontPreferences } from '@/hooks/useFontPreferences';
import { loadUiFont } from '@/lib/fontLoader';
import { appBootReadyPromise } from './appBootReady';

/**
 * Resolves to `true` once the first UI paint can be final — i.e. the selected UI web
 * font has loaded AND one-time appearance/typography boot work has been applied (or a
 * safety timeout elapses, so a slow/offline CDN can never block the app forever).
 *
 * Without this, the app paints immediately in the fallback font / default typography and
 * then reflows once the real font and persisted appearance prefs arrive — a visible flash
 * and micro layout shift. Hold a logo splash until this is `true` so the first UI the user
 * sees is already at its final font and sizes.
 */
export function useFontsReady(timeoutMs = 2500): boolean {
  const { uiFont } = useFontPreferences();
  const [ready, setReady] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    const markReady = () => {
      if (!cancelled) setReady(true);
    };

    // Wait one paint after everything settles so the applied styles are committed before
    // we reveal the UI (avoids revealing on the same frame a size/font change lands).
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
