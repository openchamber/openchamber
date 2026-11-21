import React from 'react';
import { importWithChunkRecovery } from '@/lib/chunkLoadRecovery';

export function useOnDemandValue<T extends NonNullable<unknown>>(
  needed: boolean,
  load: () => Promise<T>,
  onFailure: () => void,
): T | null {
  const [value, setValue] = React.useState<T | null>(null);
  const onFailureRef = React.useRef(onFailure);
  onFailureRef.current = onFailure;

  React.useEffect(() => {
    if (!needed || value) {
      return;
    }
    let cancelled = false;
    importWithChunkRecovery(load).then(
      (loaded) => {
        if (!cancelled) setValue(() => loaded);
      },
      (error) => {
        console.error('[on-demand] failed to load component', error);
        if (!cancelled) onFailureRef.current();
      },
    );
    return () => {
      cancelled = true;
    };
  }, [value, load, needed]);

  return value;
}

export function useOnDemandComponent<Props extends object>(
  needed: boolean,
  load: () => Promise<React.ComponentType<Props>>,
  onFailure: () => void,
): React.ComponentType<Props> | null {
  return useOnDemandValue(needed, load, onFailure);
}
