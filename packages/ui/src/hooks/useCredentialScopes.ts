import { useEffect, useRef, useState } from 'react';

import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { SourceControlReadContext } from '@/lib/source-control/types';

export function useCredentialScopes(context: SourceControlReadContext | null): string[] | null {
  const { sourceControl } = useRuntimeAPIs();
  const [scopes, setScopes] = useState<string[] | null>(null);
  const latest = useRef(context);
  latest.current = context;
  const key = context ? `${context.instance}\u0000${context.accountId}\u0000${context.directory}` : null;
  useEffect(() => {
    setScopes(null);
    if (key === null) return undefined;
    let cancelled = false;
    const current = latest.current;
    if (!current) return undefined;
    sourceControl.credentialScopes(current).then(
      (value) => { if (!cancelled) setScopes(value); },
      () => { if (!cancelled) setScopes(null); },
    );
    return () => { cancelled = true; };
  }, [key, sourceControl]);
  return scopes;
}
