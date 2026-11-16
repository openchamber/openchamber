import { useEffect, useRef, useState } from 'react';

import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { SourceControlReadContext } from '@/lib/source-control/types';

export function useRepoCapabilities(context: SourceControlReadContext | null): { lock: boolean | null } | null {
  const { sourceControl } = useRuntimeAPIs();
  const [capabilities, setCapabilities] = useState<{ lock: boolean | null } | null>(null);
  const latest = useRef(context);
  latest.current = context;
  const key = context ? `${context.instance}\u0000${context.accountId}\u0000${context.directory}` : null;
  useEffect(() => {
    setCapabilities(null);
    if (key === null) return undefined;
    let cancelled = false;
    const current = latest.current;
    if (!current) return undefined;
    sourceControl.repoCapabilities(current).then(
      (value) => { if (!cancelled) setCapabilities(value); },
      () => { if (!cancelled) setCapabilities(null); },
    );
    return () => { cancelled = true; };
  }, [key, sourceControl]);
  return capabilities;
}
