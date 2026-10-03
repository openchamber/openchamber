import React from 'react';
import { importWithChunkRecovery } from '@/lib/chunkLoadRecovery';

/**
 * Loads a code-split component the first time `needed` becomes true and
 * returns it once its module has arrived; null until then.
 *
 * Use this instead of `React.lazy` + `Suspense` for surfaces the user opens on
 * demand. A lazy component suspends into its fallback, and React keeps content
 * that replaces a fallback hidden for at least 300 ms, so the first open waited
 * that long even when the chunk arrived in a few milliseconds. Loading the
 * module before rendering never shows a fallback, so nothing is held back.
 *
 * `load` must be a stable (module-level) function. `onFailure` runs when the
 * import fails; chunk-load failures also schedule the usual one-time reload.
 */
export function useOnDemandComponent<Props extends object>(
  needed: boolean,
  load: () => Promise<React.ComponentType<Props>>,
  onFailure: () => void,
): React.ComponentType<Props> | null {
  const [component, setComponent] = React.useState<React.ComponentType<Props> | null>(null);
  const onFailureRef = React.useRef(onFailure);
  onFailureRef.current = onFailure;

  React.useEffect(() => {
    if (!needed || component) {
      return;
    }
    let cancelled = false;
    importWithChunkRecovery(load).then(
      (loaded) => {
        if (!cancelled) setComponent(() => loaded);
      },
      (error) => {
        console.error('[on-demand] failed to load component', error);
        if (!cancelled) onFailureRef.current();
      },
    );
    return () => {
      cancelled = true;
    };
  }, [component, load, needed]);

  return component;
}
