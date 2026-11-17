import React from 'react';
import { importWithChunkRecovery } from '@/lib/chunkLoadRecovery';

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
