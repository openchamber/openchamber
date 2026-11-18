import React from 'react';

import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';

/**
 * Whether the server sends this device no push because it was paired for the
 * home network only. Asked once per mount; false until the server answers.
 */
export const usePushDeliveryLocalOnly = (enabled: boolean): boolean => {
  const [localOnly, setLocalOnly] = React.useState(false);

  React.useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void getRegisteredRuntimeAPIs()?.push?.getDeliveryStatus?.().then((status) => {
      if (!cancelled) setLocalOnly(status?.localOnly === true);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return enabled && localOnly;
};
