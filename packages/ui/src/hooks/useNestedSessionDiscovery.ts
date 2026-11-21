import { useCallback, useEffect, useRef } from 'react';
import { startNestedSessionOwnerDiscovery } from '@/components/session/sidebar/sessions/nestedSessionOwnerDiscovery';

export function useNestedSessionDiscovery(enabled: boolean) {
  const service = useRef<ReturnType<typeof startNestedSessionOwnerDiscovery> | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const discovery = startNestedSessionOwnerDiscovery();
    service.current = discovery;
    return () => { discovery.dispose(); service.current = null; };
  }, [enabled]);
  return useCallback((projectIds: ReadonlySet<string>) => service.current?.setNonGitProjectIds(projectIds), []);
}
