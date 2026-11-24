import { useEffect } from 'react';
import { startNestedSessionOwnerDiscovery } from '@/components/session/sidebar/sessions/nestedSessionOwnerDiscovery';

export function useNestedSessionDiscovery(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const discovery = startNestedSessionOwnerDiscovery();
    return () => discovery.dispose();
  }, [enabled]);
}
